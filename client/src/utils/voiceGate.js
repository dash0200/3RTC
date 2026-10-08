/**
 * Discord-style "Voice Activity" gate with automatic input sensitivity.
 *
 * The audio sent to peers is never processed: the gate listens to a clone of the mic track
 * and only switches the real track on (talking) or off (silence), so background air/fan
 * noise isn't transmitted between words.
 *
 * Detection runs in an AudioWorklet (audio thread), so it keeps reacting instantly even when
 * the tab is in the background, where main-thread timers get throttled.
 *
 * It measures the speech band only, learns the room noise's peak (90th percentile) level from
 * silent stretches, and needs speech to stay clearly above that for 40 ms before opening, so
 * fluctuating fan/air noise left over after noise suppression can't flutter the mic open.
 */

const VAD_WORKLET_SOURCE = `
// Levels are measured in the speech band only (fan hum / rumble below, hiss above count less)
const BAND_LOW_HZ = 200;
const BAND_HIGH_HZ = 4000;
const LEVEL_SMOOTH_SEC = 0.025;    // power averaging so momentary noise blips don't register

// Gate decisions, relative to the room noise's PEAK level (90th percentile), so ordinary
// noise swings and bursts stay below the threshold and only real speech opens the gate
const OPEN_ABOVE_NOISE_DB = 8;     // speech must be this far above the noise peaks...
const OPEN_SUSTAIN_SEC = 0.04;     // ...for this long (rejects short noise bursts)
const CLOSE_ABOVE_NOISE_DB = 3;   // below this counts as silence again
const HOLD_SEC = 0.5;              // keep open after speech so word endings aren't cut
const MIN_OPEN_DB = -60;           // never open for anything quieter than this (dBFS)

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

class VoiceActivityProcessor extends AudioWorkletProcessor {
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
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

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

    // Learn the noise level from silent stretches (and the startup learning window)
    this.frameElapsed += dt;
    if (this.frameElapsed >= FRAME_SEC) {
      this.frameElapsed = 0;
      this.recentFrames.push(levelDb);
      if (this.recentFrames.length > RELEARN_WINDOW_SEC / FRAME_SEC) this.recentFrames.shift();

      if (this.wasLearning && !learning) {
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
    if (this.noiseDb === null) this.noiseDb = levelDb;

    const openDb = Math.max(this.noiseDb + OPEN_ABOVE_NOISE_DB, MIN_OPEN_DB);
    const closeDb = Math.max(this.noiseDb + CLOSE_ABOVE_NOISE_DB, MIN_OPEN_DB - 6);
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
      this.port.postMessage({ open: this.isOpen, levelDb, noiseDb: this.noiseDb });
    }
    return true;
  }
}

registerProcessor('voice-activity', VoiceActivityProcessor);
`;

const loadedContexts = new WeakMap();

function loadWorklet(ctx) {
  if (!loadedContexts.has(ctx)) {
    const url = URL.createObjectURL(new Blob([VAD_WORKLET_SOURCE], { type: 'application/javascript' }));
    const promise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    promise.catch(() => loadedContexts.delete(ctx));
    loadedContexts.set(ctx, promise);
  }
  return loadedContexts.get(ctx);
}

class VoiceGate {
  constructor() {
    this.track = null;           // the real mic track being gated
    this.analysisStream = null;  // clone of the mic, always enabled (use for meters)
    this.isOpen = true;
    this.onChange = null;
    this.ctx = null;
    this.clone = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.handleStateChange = null;
  }

  /** True when the worklet is actually running and making open/close decisions. */
  get isDetecting() {
    return Boolean(this.node && this.ctx && this.ctx.state === 'running');
  }

  async start(ctx, track) {
    this.stop();
    if (!track) return;
    this.track = track;
    this.clone = track.clone();
    this.clone.enabled = true;
    this.analysisStream = new MediaStream([this.clone]);

    if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return;
    try {
      await loadWorklet(ctx);
      if (this.track !== track) return; // stopped or restarted while loading

      this.ctx = ctx;
      this.source = ctx.createMediaStreamSource(this.analysisStream);
      this.node = new AudioWorkletNode(ctx, 'voice-activity', { numberOfInputs: 1, numberOfOutputs: 1 });
      // Silent sink so the browser keeps pulling audio through the detector
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);

      this.node.port.onmessage = (event) => {
        if (this.track !== track) return;
        const { open, levelDb, noiseDb } = event.data || {};
        // Verbose level in DevTools: shows why the gate opened/closed when tuning
        console.debug(`[3RTC] voice gate ${open ? 'OPEN ' : 'closed'} level ${levelDb?.toFixed(1)} dB, room noise ${noiseDb?.toFixed(1)} dB`);
        this.setOpen(Boolean(open));
      };
      // If audio processing stops (context suspended), never leave the mic stuck closed
      this.handleStateChange = () => {
        if (ctx.state !== 'running') this.setOpen(true);
      };
      ctx.addEventListener('statechange', this.handleStateChange);
    } catch {
      this.teardownNodes();
      this.setOpen(true);
    }
  }

  setOpen(open) {
    if (this.isOpen === open) return;
    this.isOpen = open;
    if (this.onChange) this.onChange(open);
  }

  teardownNodes() {
    if (this.node) {
      this.node.port.onmessage = null;
      try { this.node.disconnect(); } catch { }
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { }
    }
    if (this.sink) {
      try { this.sink.disconnect(); } catch { }
    }
    if (this.ctx && this.handleStateChange) {
      this.ctx.removeEventListener('statechange', this.handleStateChange);
    }
    this.node = null;
    this.source = null;
    this.sink = null;
    this.ctx = null;
    this.handleStateChange = null;
  }

  /** Stop detecting and release the cloned mic track (call whenever the real mic is stopped). */
  stop() {
    this.teardownNodes();
    if (this.clone) {
      try { this.clone.stop(); } catch { }
    }
    this.clone = null;
    this.analysisStream = null;
    this.track = null;
    this.isOpen = true;
  }
}

export const voiceGate = new VoiceGate();
