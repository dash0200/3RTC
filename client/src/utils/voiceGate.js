/**
 * Discord-style "Voice Activity" gate with automatic input sensitivity, without clipping speech.
 *
 * The gate runs IN the audio path (an AudioWorklet node on the send pipeline, see micPipeline.js):
 *
 *   mic -> [RNNoise] -> voice gate (lookahead delay + smooth gain) -> track sent to peers
 *
 * Why in-path instead of toggling `track.enabled` from the page:
 * - Lookahead: the audio is delayed by LOOKAHEAD_SEC while the detector listens ahead, so by the
 *   time speech has been confirmed the first syllable hasn't been sent yet and goes out intact.
 * - Smooth gain ramps instead of hard on/off switching: no clicks, no "pumping" background.
 * - Decisions take effect on the audio thread, so a busy page (video playback, React renders)
 *   can't delay the gate opening.
 *
 * Detection measures the speech band only, learns the room noise's peak (90th percentile) level
 * from silent stretches, and needs speech to stay clearly above that before opening, so
 * fluctuating fan/air noise left over after noise suppression can't flutter the mic open.
 */

const VOICE_GATE_WORKLET_SOURCE = `
// Levels are measured in the speech band only (fan hum / rumble below, hiss above count less)
const BAND_LOW_HZ = 200;
const BAND_HIGH_HZ = 4000;
const LEVEL_SMOOTH_SEC = 0.025;    // power averaging so momentary noise blips don't register

// Gate decisions, relative to the room noise's PEAK level (90th percentile), so ordinary
// noise swings and bursts stay below the threshold and only real speech opens the gate
const OPEN_ABOVE_NOISE_DB = 8;     // speech must be this far above the noise peaks...
const OPEN_SUSTAIN_SEC = 0.03;     // ...for this long (rejects short noise bursts)
const CLOSE_ABOVE_NOISE_DB = 3;    // below this counts as silence again
const HOLD_SEC = 0.5;              // keep open after speech so word endings aren't cut
const MIN_OPEN_DB = -60;           // never open for anything quieter than this (dBFS)
const DIGITAL_SILENCE_DB = -100;   // muted mic (track disabled): not room noise, don't learn it

// Output shaping
const LOOKAHEAD_SEC = 0.04;        // > sustain + detection time, so speech onsets are never cut
const ATTACK_SEC = 0.003;          // fade-in once open (fast, but click-free)
const RELEASE_SEC = 0.06;          // fade-out after the hold expires

// Noise learning (only from silence)
const NOISE_PERCENTILE = 0.9;
const NOISE_WINDOW_SEC = 3;        // recent silent audio the noise level is learned from
const FRAME_SEC = 0.01;
const RELEARN_WINDOW_SEC = 4;      // speech always has pauses: if the gate has had none for this
                                   // long, the "speech" is really new steady noise (fan switched on)
const LEARN_SEC = 0.6;             // at start: learn the room (gate stays open meanwhile)
const LEARN_SPEECH_REJECT_DB = 6;  // startup frames this far above the quiet ones are speech, not noise

const DB_EPS = 1e-12;
const percentile = (values, q) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};
const toDb = (power) => 10 * Math.log10(power + DB_EPS);

// RBJ biquad coefficients
function biquad(type, freq) {
  const w = 2 * Math.PI * freq / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
  const b0 = type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function runBiquad(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
}

class VoiceGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.highpass = biquad('highpass', BAND_LOW_HZ);
    this.lowpass = biquad('lowpass', BAND_HIGH_HZ);
    this.power = null;
    this.noiseDb = null;
    this.elapsed = 0;
    this.noiseFrames = [];
    this.frameElapsed = 0;
    this.isOpen = true;
    this.aboveSamples = 0;
    this.holdTotal = Math.round(HOLD_SEC * sampleRate);
    this.holdSamples = this.holdTotal;
    this.sustainTotal = Math.round(OPEN_SUSTAIN_SEC * sampleRate);
    this.recentFrames = [];
    this.wasLearning = true;

    this.delay = new Float32Array(Math.max(1, Math.round(LOOKAHEAD_SEC * sampleRate)));
    this.delayIndex = 0;
    this.gain = 1;
    this.attackCoef = 1 - Math.exp(-1 / (ATTACK_SEC * sampleRate));
    this.releaseCoef = 1 - Math.exp(-1 / (RELEASE_SEC * sampleRate));
    this.bypass = false;

    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.bypass === 'boolean') this.bypass = event.data.bypass;
    };
  }

  detect(channel) {
    const frames = channel.length;
    const dt = frames / sampleRate;
    let sum = 0;
    for (let i = 0; i < frames; i++) {
      const v = runBiquad(this.lowpass, runBiquad(this.highpass, channel[i]));
      sum += v * v;
    }
    const blockPower = sum / frames;
    this.power = this.power === null
      ? blockPower
      : this.power + (blockPower - this.power) * (1 - Math.exp(-dt / LEVEL_SMOOTH_SEC));
    const levelDb = toDb(this.power);
    this.elapsed += dt;
    const learning = this.elapsed < LEARN_SEC;
    const isDigitalSilence = levelDb < DIGITAL_SILENCE_DB;

    // Learn the noise level from silent stretches (and the startup learning window)
    this.frameElapsed += dt;
    if (this.frameElapsed >= FRAME_SEC && !isDigitalSilence) {
      this.frameElapsed = 0;
      this.recentFrames.push(levelDb);
      if (this.recentFrames.length > RELEARN_WINDOW_SEC / FRAME_SEC) this.recentFrames.shift();

      if (this.wasLearning && !learning && this.noiseFrames.length) {
        // Drop startup frames that were the user talking, keep the room noise
        const quiet = percentile(this.noiseFrames, 0.2);
        this.noiseFrames = this.noiseFrames.filter((v) => v <= quiet + LEARN_SPEECH_REJECT_DB);
        this.noiseDb = percentile(this.noiseFrames, NOISE_PERCENTILE);
      }
      this.wasLearning = learning;

      if (learning || !this.isOpen) {
        this.noiseFrames.push(levelDb);
        if (this.noiseFrames.length > NOISE_WINDOW_SEC / FRAME_SEC) this.noiseFrames.shift();
        this.noiseDb = percentile(this.noiseFrames, NOISE_PERCENTILE);
      } else if (this.recentFrames.length >= RELEARN_WINDOW_SEC / FRAME_SEC) {
        let recentMin = Infinity;
        for (const v of this.recentFrames) if (v < recentMin) recentMin = v;
        if (recentMin > this.noiseDb + CLOSE_ABOVE_NOISE_DB) {
          this.noiseFrames = this.recentFrames.slice(-NOISE_WINDOW_SEC / FRAME_SEC);
          this.noiseDb = percentile(this.noiseFrames, NOISE_PERCENTILE);
        }
      }
    }
    if (this.noiseDb === null && !isDigitalSilence) this.noiseDb = levelDb;
    const noiseDb = this.noiseDb === null ? MIN_OPEN_DB : this.noiseDb;

    const openDb = Math.max(noiseDb + OPEN_ABOVE_NOISE_DB, MIN_OPEN_DB);
    const closeDb = Math.max(noiseDb + CLOSE_ABOVE_NOISE_DB, MIN_OPEN_DB - 6);
    const wasOpen = this.isOpen;

    if (levelDb > openDb) {
      this.aboveSamples += frames;
    } else {
      this.aboveSamples = 0;
    }

    if (learning) {
      // fail-open until the room is learned
    } else if (this.isOpen) {
      if (levelDb > closeDb) {
        this.holdSamples = this.holdTotal;
      } else {
        this.holdSamples -= frames;
        if (this.holdSamples <= 0) this.isOpen = false;
      }
    } else if (this.aboveSamples >= this.sustainTotal) {
      this.isOpen = true;
      this.holdSamples = this.holdTotal;
    }

    if (this.isOpen !== wasOpen) {
      this.port.postMessage({ open: this.isOpen, levelDb, noiseDb });
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }

    this.detect(input);

    const target = this.bypass || this.isOpen ? 1 : 0;
    const coef = target > this.gain ? this.attackCoef : this.releaseCoef;
    const delay = this.delay;
    const size = delay.length;
    let index = this.delayIndex;
    let gain = this.gain;
    for (let i = 0; i < input.length; i++) {
      const delayed = delay[index];
      delay[index] = input[i];
      index = index + 1 === size ? 0 : index + 1;
      gain += (target - gain) * coef;
      output[i] = delayed * gain;
    }
    this.delayIndex = index;
    this.gain = gain;
    return true;
  }
}

registerProcessor('voice-gate', VoiceGateProcessor);
`;

const loadedContexts = new WeakMap();

function loadWorklet(ctx) {
  if (!loadedContexts.has(ctx)) {
    const url = URL.createObjectURL(new Blob([VOICE_GATE_WORKLET_SOURCE], { type: 'application/javascript' }));
    const promise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    promise.catch(() => loadedContexts.delete(ctx));
    loadedContexts.set(ctx, promise);
  }
  return loadedContexts.get(ctx);
}

class VoiceGate {
  constructor() {
    this.isOpen = true;     // speech detected (also drives the local speaking indicator)
    this.onChange = null;
    this.bypass = false;    // push-to-talk: pass everything through, PTT decides when you talk
    this.ctx = null;
    this.node = null;
    this.handleStateChange = null;
  }

  /** True when the gate node is actually running and making open/close decisions. */
  get isDetecting() {
    return Boolean(this.node && this.ctx && this.ctx.state === 'running');
  }

  /**
   * Create the in-path gate node on `ctx` (mono in, mono out). Returns the node, or null if this
   * browser can't run it (caller then sends audio ungated).
   */
  async attach(ctx) {
    this.detach();
    if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;
    try {
      await loadWorklet(ctx);
      const node = new AudioWorkletNode(ctx, 'voice-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit'
      });
      node.port.onmessage = (event) => {
        if (this.node !== node) return;
        const { open, levelDb, noiseDb } = event.data || {};
        // Verbose level in DevTools: shows why the gate opened/closed when tuning
        console.debug(`[3RTC] voice gate ${open ? 'OPEN ' : 'closed'} level ${levelDb?.toFixed(1)} dB, room noise ${noiseDb?.toFixed(1)} dB`);
        this.setOpen(Boolean(open));
      };
      node.port.postMessage({ bypass: this.bypass });

      // If audio processing stops (context suspended), try to get it going again and never
      // leave the speaking indicator stuck closed
      this.handleStateChange = () => {
        if (ctx.state === 'suspended') ctx.resume().catch(() => { });
        if (ctx.state !== 'running') this.setOpen(true);
      };
      ctx.addEventListener('statechange', this.handleStateChange);

      this.ctx = ctx;
      this.node = node;
      this.setOpen(true); // starts open while it learns the room
      return node;
    } catch {
      this.detach();
      return null;
    }
  }

  /** Push-to-talk mode passes all audio through; open mic mode gates it. */
  setBypass(bypass) {
    this.bypass = Boolean(bypass);
    if (this.node) {
      try { this.node.port.postMessage({ bypass: this.bypass }); } catch { }
    }
  }

  setOpen(open) {
    if (this.isOpen === open) return;
    this.isOpen = open;
    if (this.onChange) this.onChange(open);
  }

  detach() {
    if (this.node) {
      this.node.port.onmessage = null;
      try { this.node.disconnect(); } catch { }
    }
    if (this.ctx && this.handleStateChange) {
      this.ctx.removeEventListener('statechange', this.handleStateChange);
    }
    this.node = null;
    this.ctx = null;
    this.handleStateChange = null;
    this.isOpen = true;
  }
}

export const voiceGate = new VoiceGate();
