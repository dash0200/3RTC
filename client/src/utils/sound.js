import { routeAudioContext } from './audioDevices';

// Web Audio Synthesizer (Sweet Sound Effects for Messages & Connect)
class SoundFx {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
      routeAudioContext(this.ctx);
    }
  }

  playPop() {
    try {
      this.init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, this.ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.08);
    } catch {}
  }

  // A soft bubble pop. pitch > 1 raises it (combos climb), volume scales it.
  playReactionPop({ pitch = 1, volume = 1 } = {}) {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520 * pitch, now);
      osc.frequency.exponentialRampToValueAtTime(1040 * pitch, now + 0.08);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.045 * volume, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.09);
    } catch {}
  }

  playChime() {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.07);
        gain.gain.setValueAtTime(0.1, now + idx * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.25);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + idx * 0.07);
        osc.stop(now + idx * 0.07 + 0.25);
      });
    } catch {}
  }

  playPttOn() {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(680, now);
      osc.frequency.exponentialRampToValueAtTime(1020, now + 0.045);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.045);
    } catch {}
  }

  playPttOff() {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(920, now);
      osc.frequency.exponentialRampToValueAtTime(540, now + 0.05);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    } catch {}
  }
}

export const sound = new SoundFx();

export const PEER_AVATAR_COLORS = [
  '#6aa8ff', // 1. Sky Blue (--rd-focus, 'P' in UI/UX design)
  '#f5b544', // 2. Warm Amber (--rd-warn, 'A' in UI/UX design)
  '#c79bff', // 3. Lavender Violet ('M' in UI/UX design)
  '#36d399', // 4. Mint Green (--rd-live)
  '#ff8a9c', // 5. Coral Rose (--rd-danger-text)
  '#f4f4f6', // 6. Cloud Off-White (--rd-text, 'D' in UI/UX design)
];

export function getAvatarColor(name, index) {
  if (typeof name === 'string' && name.trim().length > 0) {
    // Strip trailing suffixes like " (you)" or " (host)" if present in display names
    const clean = name.replace(/\s*\((you|host).*?\)\s*/gi, '').trim().toLowerCase();
    let hash = 0;
    for (let i = 0; i < clean.length; i++) {
      hash = (hash * 31 + clean.charCodeAt(i)) | 0;
    }
    return PEER_AVATAR_COLORS[Math.abs(hash) % PEER_AVATAR_COLORS.length];
  }
  if (typeof index === 'number' && Number.isFinite(index)) {
    return PEER_AVATAR_COLORS[Math.abs(Math.floor(index)) % PEER_AVATAR_COLORS.length];
  }
  if (typeof name === 'number' && Number.isFinite(name)) {
    return PEER_AVATAR_COLORS[Math.abs(Math.floor(name)) % PEER_AVATAR_COLORS.length];
  }
  return PEER_AVATAR_COLORS[0];
}

