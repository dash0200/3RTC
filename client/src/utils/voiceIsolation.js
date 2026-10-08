/**
 * In-app voice isolation (RNNoise neural noise removal) for devices whose browser/OS doesn't
 * provide native `voiceIsolation` (e.g. Chrome on Windows).
 *
 * mic (AEC + NS + AGC from getUserMedia) -> RNNoise (AudioWorklet, 48 kHz) -> track sent to peers
 *
 * Only used while the user's Voice Isolation toggle is on; otherwise the raw mic track is sent.
 * Runs entirely on this device. The output track is persistent, so switching microphones only
 * reconnects the source and senders keep the same track.
 */
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

const SAMPLE_RATE = 48000; // RNNoise works on 48 kHz audio
const RESUME_TIMEOUT_MS = 400;

class VoiceIsolation {
  constructor() {
    this.ctx = null;
    this.destination = null;
    this.source = null;
    this.node = null;
    this.stream = null;
    this.readyPromise = null;
  }

  /** True when this browser can run the in-app noise removal. */
  get isSupported() {
    return typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined';
  }

  async ensureReady() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContextClass({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
        const [wasmBinary] = await Promise.all([
          loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }),
          ctx.audioWorklet.addModule(rnnoiseWorkletUrl)
        ]);
        const destination = ctx.createMediaStreamDestination();
        destination.channelCount = 1;
        destination.channelCountMode = 'explicit';
        this.ctx = ctx;
        this.destination = destination;
        this.wasmBinary = wasmBinary;
      })();
      this.readyPromise.catch(() => {
        this.readyPromise = null;
      });
    }
    return this.readyPromise;
  }

  /**
   * Route a raw mic stream through RNNoise. Returns the cleaned track to send to peers,
   * or null if it can't run (caller should then send the raw mic track).
   */
  async attach(stream) {
    if (!this.isSupported || !stream?.getAudioTracks()[0]) return null;
    try {
      await this.ensureReady();
      const ctx = this.ctx;
      if (ctx.state !== 'running') {
        await Promise.race([
          ctx.resume().catch(() => { }),
          new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))
        ]);
      }
      // A suspended context would send silence to peers; better to send the raw mic
      if (ctx.state !== 'running') return null;

      if (this.stream !== stream || !this.node) {
        this.detach();
        this.source = ctx.createMediaStreamSource(stream);
        this.node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: this.wasmBinary });
        // Force mono in and out: otherwise the node outputs stereo with only one channel cleaned,
        // and the mono downmix to the sent track halves the voice level (-6 dB)
        this.node.channelCount = 1;
        this.node.channelCountMode = 'explicit';
        this.source.connect(this.node);
        this.node.connect(this.destination);
        this.stream = stream;
      }
      return this.destination.stream.getAudioTracks()[0] || null;
    } catch {
      this.detach();
      return null;
    }
  }

  detach() {
    if (this.source) {
      try { this.source.disconnect(); } catch { }
    }
    if (this.node) {
      try { this.node.disconnect(); } catch { }
      try { this.node.destroy(); } catch { }
    }
    this.source = null;
    this.node = null;
    this.stream = null;
  }

  /** The cleaned track if noise removal is currently running, else null. */
  getOutputTrack() {
    if (!this.node || !this.destination) return null;
    return this.destination.stream.getAudioTracks()[0] || null;
  }
}

export const voiceIsolation = new VoiceIsolation();
