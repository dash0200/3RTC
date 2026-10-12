/**
 * Microphone send pipeline: everything that happens to your voice on this device before it is
 * sent to peers. Runs entirely in the browser, no server involved.
 *
 *   mic (AEC + NS + AGC from getUserMedia)
 *     -> RNNoise neural noise removal   (only with Voice Isolation on and no native browser/OS support)
 *     -> voice gate                     (lookahead + smooth gain, see voiceGate.js)
 *     -> persistent mono track sent to every peer
 *
 * The output track is persistent, so switching microphones or toggling isolation only rewires
 * the graph and senders keep the same track. If the pipeline can't run (no AudioWorklet, the
 * audio context won't start), build() returns the raw mic track so voice still works ungated.
 */
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import { voiceGate } from './voiceGate';

const SAMPLE_RATE = 48000; // Opus and RNNoise both work at 48 kHz: no resampling in the path
const RESUME_TIMEOUT_MS = 400;

class MicPipeline {
  constructor() {
    this.ctx = null;
    this.destination = null;
    this.source = null;
    this.rnnoise = null;
    this.gateNode = null;
    this.stream = null;
    this.isolationActive = false;
    this.rnnoisePromise = null;
    this.wasmBinary = null;
    this.buildId = 0;
  }

  /** True when this browser can run the in-app pipeline (gate, and RNNoise with WebAssembly). */
  get isSupported() {
    return typeof AudioWorkletNode !== 'undefined';
  }

  /** True when this browser can run the in-app RNNoise noise removal. */
  get isolationSupported() {
    return this.isSupported && typeof WebAssembly !== 'undefined';
  }

  getContext() {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      const destination = this.ctx.createMediaStreamDestination();
      destination.channelCount = 1;
      destination.channelCountMode = 'explicit';
      this.destination = destination;
      this.rnnoisePromise = null;
      this.wasmBinary = null;
    }
    return this.ctx;
  }

  async ensureRunning(ctx) {
    if (ctx.state !== 'running') {
      await Promise.race([
        ctx.resume().catch(() => { }),
        new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))
      ]);
    }
    return ctx.state === 'running';
  }

  ensureRnnoise(ctx) {
    if (!this.rnnoisePromise) {
      this.rnnoisePromise = Promise.all([
        loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }),
        ctx.audioWorklet.addModule(rnnoiseWorkletUrl)
      ]).then(([wasmBinary]) => {
        this.wasmBinary = wasmBinary;
        return wasmBinary;
      });
      this.rnnoisePromise.catch(() => {
        this.rnnoisePromise = null;
      });
    }
    return this.rnnoisePromise;
  }

  /**
   * Route a mic stream through the pipeline. Returns { track, isolationActive }: `track` is the
   * one to send to peers (the raw mic track if the pipeline can't run).
   */
  async build(stream, { isolation = false } = {}) {
    const rawTrack = stream?.getAudioTracks()[0] || null;
    if (!rawTrack) {
      this.teardown();
      return { track: null, isolationActive: false };
    }
    // Same mic, same choice, still running: keep the graph (no re-learning the room on each unmute)
    if (this.stream === stream && this.source && this.isolationActive === Boolean(isolation) &&
      this.ctx?.state === 'running') {
      return { track: this.getOutputTrack(), isolationActive: this.isolationActive };
    }

    const id = ++this.buildId;
    this.teardown();
    if (!this.isSupported) return { track: rawTrack, isolationActive: false };

    try {
      const ctx = this.getContext();
      // A suspended context would send silence to peers; better to send the raw mic
      if (!(await this.ensureRunning(ctx))) return { track: rawTrack, isolationActive: false };

      let wasmBinary = null;
      if (isolation && this.isolationSupported) {
        try { wasmBinary = await this.ensureRnnoise(ctx); } catch { wasmBinary = null; }
      }
      const gateNode = await voiceGate.attach(ctx);
      if (id !== this.buildId) {
        // A newer build started while this one was loading
        if (gateNode && voiceGate.node === gateNode) voiceGate.detach();
        return { track: this.getOutputTrack() || rawTrack, isolationActive: this.isolationActive };
      }
      if (!gateNode && !wasmBinary) return { track: rawTrack, isolationActive: false };

      const source = ctx.createMediaStreamSource(stream);
      let tail = source;
      if (wasmBinary) {
        const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
        // Force mono in and out: otherwise the node outputs stereo with only one channel cleaned,
        // and the mono downmix to the sent track halves the voice level (-6 dB)
        rnnoise.channelCount = 1;
        rnnoise.channelCountMode = 'explicit';
        tail.connect(rnnoise);
        tail = rnnoise;
        this.rnnoise = rnnoise;
      }
      if (gateNode) {
        tail.connect(gateNode);
        tail = gateNode;
        this.gateNode = gateNode;
      }
      tail.connect(this.destination);

      this.source = source;
      this.stream = stream;
      this.isolationActive = Boolean(wasmBinary);
      return { track: this.getOutputTrack() || rawTrack, isolationActive: this.isolationActive };
    } catch {
      this.teardown();
      return { track: rawTrack, isolationActive: false };
    }
  }

  /** Disconnect the graph (call whenever the mic stream is stopped). The output track stays. */
  teardown() {
    if (this.source) {
      try { this.source.disconnect(); } catch { }
    }
    if (this.rnnoise) {
      try { this.rnnoise.disconnect(); } catch { }
      try { this.rnnoise.destroy(); } catch { }
    }
    voiceGate.detach();
    this.source = null;
    this.rnnoise = null;
    this.gateNode = null;
    this.stream = null;
    this.isolationActive = false;
  }

  /** The pipeline's output track if it is currently running, else null. */
  getOutputTrack() {
    if (!this.source || !this.destination) return null;
    return this.destination.stream.getAudioTracks()[0] || null;
  }
}

export const micPipeline = new MicPipeline();
