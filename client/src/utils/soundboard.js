/**
 * Synchronized Soundboard (Mini SFX Tray) - Web Audio Synthesis Engine
 * Provides instant, zero-latency, high-fidelity sound clips synthesized natively via Web Audio API.
 * Synchronized across WebRTC DataChannel peers.
 */

export const SOUNDBOARD_CLIPS = [
  {
    id: 'airhorn',
    name: 'Airhorn',
    emoji: '📢',
    color: '#ef4444',
    category: 'Hype',
    description: 'Iconic DJ reggae airhorn triple blast'
  },
  {
    id: 'applause',
    name: 'Applause',
    emoji: '👏',
    color: '#f59e0b',
    category: 'Crowd',
    description: 'Enthusiastic audience clapping and cheers'
  },
  {
    id: 'drumroll',
    name: 'Drumroll',
    emoji: '🥁',
    color: '#8b5cf6',
    category: 'Drama',
    description: 'Suspenseful roll with cymbal crash'
  },
  {
    id: 'badumtss',
    name: 'Ba-Dum-Tss',
    emoji: '💥',
    color: '#ec4899',
    category: 'Comedy',
    description: 'Classic punchline comedy rimshot'
  },
  {
    id: 'tada',
    name: 'Tada Fanfare',
    emoji: '🎺',
    color: '#eab308',
    category: 'Victory',
    description: 'Triumphant brass fanfare victory chords'
  },
  {
    id: 'cheering',
    name: 'Cheering',
    emoji: '🎉',
    color: '#10b981',
    category: 'Crowd',
    description: 'Excited party crowd cheering and whistles'
  },
  {
    id: 'laughter',
    name: 'Laugh Track',
    emoji: '😂',
    color: '#06b6d4',
    category: 'Comedy',
    description: 'Bouncy contagious giggles and laughter'
  },
  {
    id: 'wompwomp',
    name: 'Sad Trombone',
    emoji: '🎺',
    color: '#64748b',
    category: 'Fail',
    description: 'Hilarious fail wah-wah-wah-waaah'
  }
];

const STORAGE_KEY_VOLUME = '3rtc_soundboard_volume';
const STORAGE_KEY_MUTED = '3rtc_soundboard_muted';

export function loadSoundboardSettings() {
  let volume = 0.75;
  let muted = false;
  try {
    const savedVol = localStorage.getItem(STORAGE_KEY_VOLUME);
    if (savedVol !== null) {
      const parsed = parseFloat(savedVol);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) volume = parsed;
    }
    const savedMuted = localStorage.getItem(STORAGE_KEY_MUTED);
    if (savedMuted !== null) {
      muted = savedMuted === 'true';
    }
  } catch {}
  return { volume, muted };
}

export function saveSoundboardSettings(volume, muted) {
  try {
    localStorage.setItem(STORAGE_KEY_VOLUME, String(volume));
    localStorage.setItem(STORAGE_KEY_MUTED, String(muted));
  } catch {}
}

class SoundboardEngine {
  constructor() {
    this.ctx = null;
  }

  getAudioContext() {
    if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state !== 'closed') {
      this.ctx = window.__webrtcAudioCtx;
    } else if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  play(soundId, volumeScale = 1.0) {
    if (volumeScale <= 0) return;
    const ctx = this.getAudioContext();
    if (!ctx) return;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(Math.min(1.0, Math.max(0, volumeScale)), ctx.currentTime);
    masterGain.connect(ctx.destination);

    switch (soundId) {
      case 'airhorn':
        this.synthAirhorn(ctx, masterGain);
        break;
      case 'applause':
        this.synthApplause(ctx, masterGain);
        break;
      case 'drumroll':
        this.synthDrumroll(ctx, masterGain);
        break;
      case 'badumtss':
        this.synthBaDumTss(ctx, masterGain);
        break;
      case 'tada':
        this.synthTada(ctx, masterGain);
        break;
      case 'cheering':
        this.synthCheering(ctx, masterGain);
        break;
      case 'laughter':
        this.synthLaughter(ctx, masterGain);
        break;
      case 'wompwomp':
        this.synthSadTrombone(ctx, masterGain);
        break;
      default:
        break;
    }
  }

  // 1. DJ Airhorn (Reggae 3-blast horn)
  synthAirhorn(ctx, dest) {
    const now = ctx.currentTime;
    const blasts = [
      { start: 0.00, dur: 0.16 },
      { start: 0.20, dur: 0.16 },
      { start: 0.40, dur: 0.38 }
    ];

    blasts.forEach(({ start, dur }) => {
      const t = now + start;
      const hornGain = ctx.createGain();
      hornGain.gain.setValueAtTime(0.001, t);
      hornGain.gain.linearRampToValueAtTime(0.32, t + 0.02);
      hornGain.gain.setValueAtTime(0.32, t + dur - 0.04);
      hornGain.gain.exponentialRampToValueAtTime(0.001, t + dur);

      // Distorted Megaphone Bandpass Filter
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1100, t);
      filter.Q.setValueAtTime(2.2, t);

      // Frequencies for iconic fourth chord (F#5: 740Hz, B5: 987Hz)
      const freqs = [740, 746, 987, 992];
      freqs.forEach((f) => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f * 0.94, t);
        osc.frequency.exponentialRampToValueAtTime(f, t + 0.04);
        if (dur > 0.25) {
          osc.frequency.setValueAtTime(f, t + dur - 0.08);
          osc.frequency.exponentialRampToValueAtTime(f * 0.88, t + dur);
        }
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + dur);
      });

      filter.connect(hornGain);
      hornGain.connect(dest);
    });
  }

  // 2. Applause & Clapping
  synthApplause(ctx, dest) {
    const now = ctx.currentTime;
    const duration = 2.2;
    const sampleRate = ctx.sampleRate;
    const bufferSize = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);

    // Multi-layered rhythmic clapping impulses
    for (let i = 0; i < bufferSize; i++) {
      const progress = i / bufferSize;
      const env = progress < 0.18
        ? progress / 0.18
        : Math.pow(1 - (progress - 0.18) / 0.82, 1.8);

      const rawNoise = (Math.random() * 2 - 1);
      // Density modulation for individual claps
      const clapMod = Math.sin(i * 0.018) * Math.sin(i * 0.035) * Math.sin(i * 0.008);
      const isClap = Math.abs(clapMod) > 0.45 ? 1.6 : 0.4;
      data[i] = rawNoise * env * isClap * 0.25;
    }

    const noiseNode = ctx.createBufferSource();
    noiseNode.buffer = buffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(1400, now);
    bandpass.Q.setValueAtTime(1.5, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.55, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

    noiseNode.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(dest);

    noiseNode.start(now);
    noiseNode.stop(now + duration);
  }

  // 3. Drumroll with Cymbal Crash
  synthDrumroll(ctx, dest) {
    const now = ctx.currentTime;
    const rollDuration = 1.6;
    const totalDuration = 2.4;

    // Accelerating snare drum rolls
    const rollGain = ctx.createGain();
    rollGain.gain.setValueAtTime(0.08, now);
    rollGain.gain.linearRampToValueAtTime(0.45, now + rollDuration);
    rollGain.gain.setValueAtTime(0.001, now + rollDuration + 0.02);

    const snareFilter = ctx.createBiquadFilter();
    snareFilter.type = 'bandpass';
    snareFilter.frequency.setValueAtTime(450, now);
    snareFilter.Q.setValueAtTime(2.0, now);

    // Rapid snare hits
    const hitCount = 38;
    for (let i = 0; i < hitCount; i++) {
      const t = now + Math.pow(i / hitCount, 1.3) * rollDuration;
      const hitOsc = ctx.createOscillator();
      const hitGain = ctx.createGain();
      hitOsc.type = 'triangle';
      hitOsc.frequency.setValueAtTime(180, t);
      hitOsc.frequency.exponentialRampToValueAtTime(90, t + 0.035);

      hitGain.gain.setValueAtTime(0.2, t);
      hitGain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);

      hitOsc.connect(hitGain);
      hitGain.connect(snareFilter);
      hitOsc.start(t);
      hitOsc.stop(t + 0.035);
    }

    snareFilter.connect(rollGain);
    rollGain.connect(dest);

    // Cymbal Crash at the end
    const crashTime = now + rollDuration;
    const crashBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.0), ctx.sampleRate);
    const crashData = crashBuffer.getChannelData(0);
    for (let i = 0; i < crashData.length; i++) {
      crashData[i] = (Math.random() * 2 - 1);
    }
    const crashSource = ctx.createBufferSource();
    crashSource.buffer = crashBuffer;

    const crashHighpass = ctx.createBiquadFilter();
    crashHighpass.type = 'highpass';
    crashHighpass.frequency.setValueAtTime(5500, crashTime);

    const crashGain = ctx.createGain();
    crashGain.gain.setValueAtTime(0.4, crashTime);
    crashGain.gain.exponentialRampToValueAtTime(0.001, crashTime + 0.9);

    crashSource.connect(crashHighpass);
    crashHighpass.connect(crashGain);
    crashGain.connect(dest);

    crashSource.start(crashTime);
    crashSource.stop(crashTime + 0.9);
  }

  // 4. Ba-Dum-Tss (Comedy Rimshot)
  synthBaDumTss(ctx, dest) {
    const now = ctx.currentTime;

    // "Ba" (Kick) at 0.0s
    const kickOsc = ctx.createOscillator();
    const kickGain = ctx.createGain();
    kickOsc.frequency.setValueAtTime(140, now);
    kickOsc.frequency.exponentialRampToValueAtTime(45, now + 0.12);
    kickGain.gain.setValueAtTime(0.45, now);
    kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    kickOsc.connect(kickGain);
    kickGain.connect(dest);
    kickOsc.start(now);
    kickOsc.stop(now + 0.14);

    // "Dum" (Snare) at 0.22s
    const snareTime = now + 0.22;
    const snareOsc = ctx.createOscillator();
    const snareGain = ctx.createGain();
    snareOsc.type = 'triangle';
    snareOsc.frequency.setValueAtTime(220, snareTime);
    snareOsc.frequency.exponentialRampToValueAtTime(110, snareTime + 0.1);
    snareGain.gain.setValueAtTime(0.35, snareTime);
    snareGain.gain.exponentialRampToValueAtTime(0.001, snareTime + 0.12);
    snareOsc.connect(snareGain);
    snareGain.connect(dest);
    snareOsc.start(snareTime);
    snareOsc.stop(snareTime + 0.12);

    // "Tss" (Cymbal rimshot) at 0.44s
    const cymbalTime = now + 0.44;
    const cymbalBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.7), ctx.sampleRate);
    const cymbalData = cymbalBuffer.getChannelData(0);
    for (let i = 0; i < cymbalData.length; i++) {
      cymbalData[i] = (Math.random() * 2 - 1);
    }
    const cymbalSource = ctx.createBufferSource();
    cymbalSource.buffer = cymbalBuffer;

    const cymbalFilter = ctx.createBiquadFilter();
    cymbalFilter.type = 'highpass';
    cymbalFilter.frequency.setValueAtTime(6500, cymbalTime);

    const cymbalGain = ctx.createGain();
    cymbalGain.gain.setValueAtTime(0.38, cymbalTime);
    cymbalGain.gain.exponentialRampToValueAtTime(0.001, cymbalTime + 0.65);

    cymbalSource.connect(cymbalFilter);
    cymbalFilter.connect(cymbalGain);
    cymbalGain.connect(dest);

    cymbalSource.start(cymbalTime);
    cymbalSource.stop(cymbalTime + 0.65);
  }

  // 5. Tada Fanfare (Triumphant victory chords)
  synthTada(ctx, dest) {
    const now = ctx.currentTime;
    const notes = [
      // Pre-flourish arpeggios
      { freq: 392.00, start: 0.00, dur: 0.12 }, // G4
      { freq: 523.25, start: 0.10, dur: 0.12 }, // C5
      { freq: 659.25, start: 0.20, dur: 0.14 }, // E5
      // Final glorious triumphant chord (C5 + E5 + G5 + C6)
      { freq: 523.25, start: 0.35, dur: 0.95 },
      { freq: 659.25, start: 0.35, dur: 0.95 },
      { freq: 783.99, start: 0.35, dur: 0.95 },
      { freq: 1046.50, start: 0.35, dur: 0.95 }
    ];

    notes.forEach(({ freq, start, dur }) => {
      const t = now + start;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);

      // Lowpass to give warm brass trumpet character
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1800, t);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(start >= 0.35 ? 0.14 : 0.12, t + 0.03);
      gain.gain.setValueAtTime(start >= 0.35 ? 0.14 : 0.12, t + dur - 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(dest);

      osc.start(t);
      osc.stop(t + dur);
    });
  }

  // 6. Crowd Cheering & Whistle
  synthCheering(ctx, dest) {
    const now = ctx.currentTime;
    const duration = 2.2;

    // Crowd roar swell
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const p = i / data.length;
      const env = p < 0.25 ? p / 0.25 : Math.pow(1 - (p - 0.25) / 0.75, 1.4);
      data[i] = (Math.random() * 2 - 1) * env * 0.28;
    }
    const roar = ctx.createBufferSource();
    roar.buffer = buffer;

    const roarFilter = ctx.createBiquadFilter();
    roarFilter.type = 'bandpass';
    roarFilter.frequency.setValueAtTime(1100, now);
    roarFilter.frequency.exponentialRampToValueAtTime(1600, now + 1.2);
    roarFilter.Q.setValueAtTime(1.8, now);

    const roarGain = ctx.createGain();
    roarGain.gain.setValueAtTime(0.45, now);
    roarGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    roar.connect(roarFilter);
    roarFilter.connect(roarGain);
    roarGain.connect(dest);
    roar.start(now);
    roar.stop(now + duration);

    // Celebratory party whistle at 0.3s
    const whistleTime = now + 0.3;
    const whistleOsc = ctx.createOscillator();
    const whistleGain = ctx.createGain();
    whistleOsc.type = 'sine';
    whistleOsc.frequency.setValueAtTime(1800, whistleTime);
    whistleOsc.frequency.linearRampToValueAtTime(2600, whistleTime + 0.28);
    whistleOsc.frequency.exponentialRampToValueAtTime(2200, whistleTime + 0.55);

    whistleGain.gain.setValueAtTime(0.001, whistleTime);
    whistleGain.gain.linearRampToValueAtTime(0.12, whistleTime + 0.05);
    whistleGain.gain.exponentialRampToValueAtTime(0.001, whistleTime + 0.55);

    whistleOsc.connect(whistleGain);
    whistleGain.connect(dest);
    whistleOsc.start(whistleTime);
    whistleOsc.stop(whistleTime + 0.55);
  }

  // 7. Laugh Track (Chuckle & Giggles)
  synthLaughter(ctx, dest) {
    const now = ctx.currentTime;
    const chuckles = [
      { start: 0.00, freq: 520, dur: 0.12 },
      { start: 0.15, freq: 560, dur: 0.13 },
      { start: 0.32, freq: 510, dur: 0.14 },
      { start: 0.50, freq: 480, dur: 0.15 },
      { start: 0.70, freq: 440, dur: 0.20 },
      { start: 0.95, freq: 390, dur: 0.26 }
    ];

    chuckles.forEach(({ start, freq, dur }) => {
      const t = now + start;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.82, t + dur);

      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(freq * 1.5, t);
      filter.Q.setValueAtTime(3.0, t);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(dest);

      osc.start(t);
      osc.stop(t + dur);
    });
  }

  // 8. Sad Trombone (Womp Womp Womp Waaah)
  synthSadTrombone(ctx, dest) {
    const now = ctx.currentTime;
    const notes = [
      { freq: 293.66, start: 0.00, dur: 0.35 }, // D4
      { freq: 277.18, start: 0.38, dur: 0.35 }, // C#4
      { freq: 261.63, start: 0.76, dur: 0.38 }, // C4
      { freq: 246.94, start: 1.18, dur: 0.95, vibrato: true }  // B3 with waaaah slide
    ];

    notes.forEach(({ freq, start, dur, vibrato }) => {
      const t = now + start;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);

      if (vibrato) {
        // Comic pitch slide down
        osc.frequency.setValueAtTime(freq, t + 0.3);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.88, t + dur);

        // Plunger mute "wah-wah" LFO
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.setValueAtTime(6.5, t);
        lfoGain.gain.setValueAtTime(7.0, t);
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        lfo.start(t + 0.2);
        lfo.stop(t + dur);
      }

      // "Wah" plunger filter envelope
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(380, t);
      filter.frequency.linearRampToValueAtTime(950, t + 0.08);
      filter.frequency.exponentialRampToValueAtTime(420, t + dur);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.26, t + 0.04);
      gain.gain.setValueAtTime(0.26, t + dur - 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(dest);

      osc.start(t);
      osc.stop(t + dur);
    });
  }
}

export const soundboard = new SoundboardEngine();
