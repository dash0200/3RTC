/**
 * Discord-style "Voice Activity" gate with automatic input sensitivity.
 *
 * The audio sent to peers is never processed: the gate listens to a clone of the mic track
 * and only switches the real track on (talking) or off (silence), so background air/fan
 * noise isn't transmitted between words.
 *
 * Detection runs in an AudioWorklet (audio thread), so it keeps reacting instantly even when
 * the tab is in the background, where main-thread timers get throttled.
 */

const VAD_WORKLET_SOURCE = `
const OPEN_ABOVE_FLOOR_DB = 10;  // open when this far above the room's noise floor
const CLOSE_ABOVE_FLOOR_DB = 6;  // start closing when back down to this
const MIN_OPEN_DB = -60;         // never open for anything quieter than this (dBFS)
const HOLD_SEC = 0.45;           // keep open after speech so word endings aren't cut
const ENVELOPE_RELEASE_SEC = 0.05;
const FLOOR_WINDOW_SEC = 5;      // noise floor = quietest level seen in this window
const BUCKET_SEC = 0.1;

class VoiceActivityProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.envelope = -100;
    this.isOpen = true;
    this.holdTotal = Math.round(HOLD_SEC * sampleRate);
    this.holdSamples = this.holdTotal;
    this.buckets = [];
    this.bucketMin = Infinity;
    this.bucketElapsed = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    const frames = channel.length;
    const dt = frames / sampleRate;
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += channel[i] * channel[i];
    const levelDb = 20 * Math.log10(Math.sqrt(sum / frames) + 1e-10);

    // Fast attack so the first syllable opens the gate immediately
    this.envelope = levelDb > this.envelope
      ? levelDb
      : this.envelope + (levelDb - this.envelope) * (1 - Math.exp(-dt / ENVELOPE_RELEASE_SEC));

    // Minimum-statistics noise floor: speech always has gaps, so the minimum is the room noise
    this.bucketMin = Math.min(this.bucketMin, this.envelope);
    this.bucketElapsed += dt;
    if (this.bucketElapsed >= BUCKET_SEC) {
      this.buckets.push(this.bucketMin);
      if (this.buckets.length > FLOOR_WINDOW_SEC / BUCKET_SEC) this.buckets.shift();
      this.bucketMin = Infinity;
      this.bucketElapsed = 0;
    }
    let floorDb = this.bucketMin;
    for (const b of this.buckets) if (b < floorDb) floorDb = b;

    const openDb = Math.max(floorDb + OPEN_ABOVE_FLOOR_DB, MIN_OPEN_DB);
    const closeDb = Math.max(floorDb + CLOSE_ABOVE_FLOOR_DB, MIN_OPEN_DB - 4);
    const wasOpen = this.isOpen;

    if (this.envelope > openDb) {
      this.isOpen = true;
      this.holdSamples = this.holdTotal;
    } else if (this.isOpen && this.envelope > closeDb) {
      this.holdSamples = this.holdTotal;
    } else if (this.isOpen) {
      this.holdSamples -= frames;
      if (this.holdSamples <= 0) this.isOpen = false;
    }

    if (this.isOpen !== wasOpen) this.port.postMessage({ open: this.isOpen });
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
        this.setOpen(Boolean(event.data?.open));
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
