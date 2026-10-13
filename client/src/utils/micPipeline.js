/**
 * Microphone send pipeline: in-app noise removal for your voice before it is sent to peers.
 * Runs entirely in the browser, no server involved.
 *
 *   mic (AEC + NS + AGC from getUserMedia)
 *     -> RNNoise neural noise removal   (Voice Isolation on, and no native browser/OS isolation)
 *     -> persistent mono track sent to every peer
 *
 * Open mic sends continuously (like Teams): background noise is removed, the mic isn't cut
 * between words. Without in-app noise removal the raw mic track is sent and no graph is built.
 * The output track is persistent, so switching microphones only rewires the graph and senders
 * keep the same track. If RNNoise can't run, build() returns the raw mic track.
 */
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

const SAMPLE_RATE = 48000; // Opus and RNNoise both work at 48 kHz: no resampling in the path
const RESUME_TIMEOUT_MS = 400;

class MicPipeline {
  constructor() {
    this.ctx = null;
    this.destination = null;
    this.source = null;
    this.rnnoise = null;
    this.stream = null;
    this.isolationActive = false;
    this.rnnoisePromise = null;
    this.wasmBinary = null;
    this.buildId = 0;
  }

  /** True when this browser can run AudioWorklet processing. */
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
    // Same mic, still running: keep the graph
    if (isolation && this.stream === stream && this.source && this.isolationActive &&
      this.ctx?.state === 'running') {
      return { track: this.getOutputTrack(), isolationActive: true };
    }

    const id = ++this.buildId;
    this.teardown();
    // Nothing to do in-app: send the mic as-is
    if (!isolation || !this.isolationSupported) return { track: rawTrack, isolationActive: false };

    try {
      const ctx = this.getContext();
      // A suspended context would send silence to peers; better to send the raw mic
      if (!(await this.ensureRunning(ctx))) return { track: rawTrack, isolationActive: false };

      let wasmBinary = null;
      try { wasmBinary = await this.ensureRnnoise(ctx); } catch { wasmBinary = null; }
      if (id !== this.buildId) {
        // A newer build started while this one was loading
        return { track: this.getOutputTrack() || rawTrack, isolationActive: this.isolationActive };
      }
      if (!wasmBinary) return { track: rawTrack, isolationActive: false };

      const source = ctx.createMediaStreamSource(stream);
      const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
      // Force mono in and out: otherwise the node outputs stereo with only one channel cleaned,
      // and the mono downmix to the sent track halves the voice level (-6 dB)
      rnnoise.channelCount = 1;
      rnnoise.channelCountMode = 'explicit';
      source.connect(rnnoise);
      rnnoise.connect(this.destination);
      this.rnnoise = rnnoise;

      this.source = source;
      this.stream = stream;
      this.isolationActive = true;
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
    this.source = null;
    this.rnnoise = null;
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
