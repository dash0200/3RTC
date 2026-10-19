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

const SAMPLE_RATE = 48000;
const RESUME_TIMEOUT_MS = 400;

export interface MicBuildResult {
  track: MediaStreamTrack | null;
  isolationActive: boolean;
}

class MicPipeline {
  private ctx: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rnnoise: any = null;
  private stream: MediaStream | null = null;
  public isolationActive: boolean = false;
  private rnnoisePromise: Promise<ArrayBuffer> | null = null;
  private buildId: number = 0;

  get isSupported(): boolean {
    return typeof AudioWorkletNode !== 'undefined';
  }

  get isolationSupported(): boolean {
    return this.isSupported && typeof WebAssembly !== 'undefined';
  }

  getContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioContextClass({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      const destination = this.ctx.createMediaStreamDestination();
      destination.channelCount = 1;
      destination.channelCountMode = 'explicit';
      this.destination = destination;
      this.rnnoisePromise = null;
    }
    return this.ctx;
  }

  async ensureRunning(ctx: AudioContext): Promise<boolean> {
    if (ctx.state !== 'running') {
      await Promise.race([
        ctx.resume().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))
      ]);
    }
    return ctx.state === 'running';
  }

  ensureRnnoise(ctx: AudioContext): Promise<ArrayBuffer> {
    if (!this.rnnoisePromise) {
      this.rnnoisePromise = Promise.all([
        loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }),
        ctx.audioWorklet.addModule(rnnoiseWorkletUrl)
      ]).then(([wasmBinary]) => {
        return wasmBinary as ArrayBuffer;
      });
      this.rnnoisePromise.catch(() => {
        this.rnnoisePromise = null;
      });
    }
    return this.rnnoisePromise;
  }

  async build(
    stream: MediaStream | null | undefined,
    { isolation = false }: { isolation?: boolean } = {}
  ): Promise<MicBuildResult> {
    const rawTrack = stream?.getAudioTracks()[0] || null;
    if (!rawTrack) {
      this.teardown();
      return { track: null, isolationActive: false };
    }

    if (
      isolation &&
      this.stream === stream &&
      this.source &&
      this.isolationActive &&
      this.ctx?.state === 'running'
    ) {
      return { track: this.getOutputTrack(), isolationActive: true };
    }

    const id = ++this.buildId;
    this.teardown();

    if (!isolation || !this.isolationSupported) {
      return { track: rawTrack, isolationActive: false };
    }

    try {
      const ctx = this.getContext();
      if (!(await this.ensureRunning(ctx))) {
        return { track: rawTrack, isolationActive: false };
      }

      let wasmBinary: ArrayBuffer | null = null;
      try {
        wasmBinary = await this.ensureRnnoise(ctx);
      } catch {
        wasmBinary = null;
      }

      if (id !== this.buildId) {
        return { track: this.getOutputTrack() || rawTrack, isolationActive: this.isolationActive };
      }
      if (!wasmBinary) return { track: rawTrack, isolationActive: false };

      const source = ctx.createMediaStreamSource(stream!);
      const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
      rnnoise.channelCount = 1;
      rnnoise.channelCountMode = 'explicit';
      source.connect(rnnoise);
      rnnoise.connect(this.destination!);
      this.rnnoise = rnnoise;

      this.source = source;
      this.stream = stream!;
      this.isolationActive = true;
      return { track: this.getOutputTrack() || rawTrack, isolationActive: this.isolationActive };
    } catch {
      this.teardown();
      return { track: rawTrack, isolationActive: false };
    }
  }

  teardown(): void {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // ignore
      }
    }
    if (this.rnnoise) {
      try {
        this.rnnoise.disconnect();
      } catch {
        // ignore
      }
      try {
        this.rnnoise.destroy();
      } catch {
        // ignore
      }
    }
    this.source = null;
    this.rnnoise = null;
    this.stream = null;
    this.isolationActive = false;
  }

  getOutputTrack(): MediaStreamTrack | null {
    if (!this.source || !this.destination) return null;
    return this.destination.stream.getAudioTracks()[0] || null;
  }
}

export const micPipeline = new MicPipeline();
