import { routeAudioContext } from './audioDevices';

/**
 * Synchronized Soundboard (Mini SFX Tray) - Web Audio Engine
 * Plays authentic, high-fidelity Discord soundboard audio clips and classic Discord SFX.
 * Preloads and decodes into Web Audio buffers for instant 0-latency playback.
 * Synchronized across WebRTC DataChannel peers.
 */

export interface SoundboardClip {
  id: string;
  name: string;
  emoji: string;
  color: string;
  category: string;
  url: string;
  description: string;
}

export const SOUNDBOARD_CLIPS: SoundboardClip[] = [
  // --- Discord Official Soundboard Defaults ---
  {
    id: 'quack',
    name: 'Quack',
    emoji: '🦆',
    color: '#eab308',
    category: 'Soundboard',
    url: '/sounds/quack.mp3',
    description: 'Official Discord rubber duck quack'
  },
  {
    id: 'airhorn',
    name: 'Airhorn',
    emoji: '📢',
    color: '#ef4444',
    category: 'Soundboard',
    url: '/sounds/airhorn.mp3',
    description: 'Official Discord DJ reggae airhorn blast'
  },
  {
    id: 'cricket',
    name: 'Crickets',
    emoji: '🦗',
    color: '#10b981',
    category: 'Soundboard',
    url: '/sounds/cricket.mp3',
    description: 'Official Discord awkward silence crickets'
  },
  {
    id: 'golfclap',
    name: 'Golf Clap',
    emoji: '👏',
    color: '#f59e0b',
    category: 'Soundboard',
    url: '/sounds/golfclap.mp3',
    description: 'Official Discord polite golf clapping'
  },
  {
    id: 'sadhorn',
    name: 'Sad Horn',
    emoji: '🎺',
    color: '#64748b',
    category: 'Soundboard',
    url: '/sounds/sadhorn.mp3',
    description: 'Official Discord fail sad horn (womp womp)'
  },
  {
    id: 'badumtss',
    name: 'Ba-Dum-Tss',
    emoji: '🥁',
    color: '#ec4899',
    category: 'Soundboard',
    url: '/sounds/badumtss.mp3',
    description: 'Official Discord punchline comedy rimshot'
  },

  // --- Discord Signature SFX ---
  {
    id: 'discord_ping',
    name: 'Discord Ping',
    emoji: '🔔',
    color: '#5865f2',
    category: 'Discord SFX',
    url: '/sounds/discord_ping.mp3',
    description: 'Official Discord message ping notification'
  },

  // --- Synthesised in 3RTC (desktop/packaging/make-sounds.py, CC0); the desktop app has the same ---
  {
    id: 'boing',
    name: 'Boing',
    emoji: '🦘',
    color: '#f97316',
    category: 'Synth',
    url: '/sounds/boing.mp3',
    description: 'A springy boing'
  },
  {
    id: 'laser',
    name: 'Laser',
    emoji: '🛸',
    color: '#22d3ee',
    category: 'Synth',
    url: '/sounds/laser.mp3',
    description: 'Pew! A sci-fi laser zap'
  },
  {
    id: 'tada',
    name: 'Ta-da',
    emoji: '🎉',
    color: '#f43f5e',
    category: 'Synth',
    url: '/sounds/tada.mp3',
    description: 'Ta-da! A little fanfare'
  },
  {
    id: 'ding',
    name: 'Ding',
    emoji: '🛎️',
    color: '#facc15',
    category: 'Synth',
    url: '/sounds/ding.mp3',
    description: 'A service bell ding'
  },
  {
    id: 'whoosh',
    name: 'Whoosh',
    emoji: '💨',
    color: '#94a3b8',
    category: 'Synth',
    url: '/sounds/whoosh.mp3',
    description: 'Something flies past'
  },
  {
    id: 'bubble',
    name: 'Bubble Pop',
    emoji: '🫧',
    color: '#38bdf8',
    category: 'Synth',
    url: '/sounds/bubble.mp3',
    description: 'Pop, pop, pop'
  },
  {
    id: 'coin',
    name: 'Coin',
    emoji: '🪙',
    color: '#eab308',
    category: 'Synth',
    url: '/sounds/coin.mp3',
    description: 'A coin picked up'
  },
  {
    id: 'levelup',
    name: 'Level Up',
    emoji: '⭐',
    color: '#a855f7',
    category: 'Synth',
    url: '/sounds/levelup.mp3',
    description: 'A rising level-up arpeggio'
  },
  {
    id: 'buzzer',
    name: 'Wrong',
    emoji: '❌',
    color: '#dc2626',
    category: 'Synth',
    url: '/sounds/buzzer.mp3',
    description: 'Wrong answer buzzer'
  },
  {
    id: 'correct',
    name: 'Correct',
    emoji: '✅',
    color: '#22c55e',
    category: 'Synth',
    url: '/sounds/correct.mp3',
    description: 'Right answer chime'
  },
  {
    id: 'slidewhistle',
    name: 'Slide Whistle',
    emoji: '🎶',
    color: '#ec4899',
    category: 'Synth',
    url: '/sounds/slidewhistle.mp3',
    description: 'Wheee, up and down'
  },
  {
    id: 'heartbeat',
    name: 'Heartbeat',
    emoji: '💓',
    color: '#e11d48',
    category: 'Synth',
    url: '/sounds/heartbeat.mp3',
    description: 'Lub-dub: the suspense'
  },
  {
    id: 'siren',
    name: 'Siren',
    emoji: '🚨',
    color: '#ef4444',
    category: 'Synth',
    url: '/sounds/siren.mp3',
    description: 'Nee-naw alarm'
  },
  {
    id: 'ticktock',
    name: 'Tick Tock',
    emoji: '⏰',
    color: '#64748b',
    category: 'Synth',
    url: '/sounds/ticktock.mp3',
    description: 'The clock is ticking'
  },
  {
    id: 'doorbell',
    name: 'Doorbell',
    emoji: '🚪',
    color: '#14b8a6',
    category: 'Synth',
    url: '/sounds/doorbell.mp3',
    description: 'Ding-dong, who's there?'
  },
  {
    id: 'thunder',
    name: 'Thunder',
    emoji: '⛈️',
    color: '#6366f1',
    category: 'Synth',
    url: '/sounds/thunder.mp3',
    description: 'A dramatic thunderclap'
  }
];

export const SOUND_URL_MAP: Record<string, string> = {
  quack: '/sounds/quack.mp3',
  airhorn: '/sounds/airhorn.mp3',
  cricket: '/sounds/cricket.mp3',
  golfclap: '/sounds/golfclap.mp3',
  sadhorn: '/sounds/sadhorn.mp3',
  badumtss: '/sounds/badumtss.mp3',
  discord_ping: '/sounds/discord_ping.mp3',
  boing: '/sounds/boing.mp3',
  laser: '/sounds/laser.mp3',
  tada: '/sounds/tada.mp3',
  ding: '/sounds/ding.mp3',
  whoosh: '/sounds/whoosh.mp3',
  bubble: '/sounds/bubble.mp3',
  coin: '/sounds/coin.mp3',
  levelup: '/sounds/levelup.mp3',
  buzzer: '/sounds/buzzer.mp3',
  correct: '/sounds/correct.mp3',
  slidewhistle: '/sounds/slidewhistle.mp3',
  heartbeat: '/sounds/heartbeat.mp3',
  siren: '/sounds/siren.mp3',
  ticktock: '/sounds/ticktock.mp3',
  doorbell: '/sounds/doorbell.mp3',
  thunder: '/sounds/thunder.mp3',
  // Backwards compatibility aliases
  wompwomp: '/sounds/sadhorn.mp3',
  applause: '/sounds/golfclap.mp3',
  drumroll: '/sounds/badumtss.mp3'
};

const STORAGE_KEY_VOLUME = '3rtc_soundboard_volume';
const STORAGE_KEY_MUTED = '3rtc_soundboard_muted';

export interface SoundboardSettings {
  volume: number;
  muted: boolean;
}

export function loadSoundboardSettings(): SoundboardSettings {
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
  } catch { /* storage blocked */ }
  return { volume, muted };
}

export function saveSoundboardSettings(volume: number, muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY_VOLUME, String(volume));
    localStorage.setItem(STORAGE_KEY_MUTED, String(muted));
  } catch { /* storage blocked */ }
}

export class SoundboardEngine {
  public ctx: AudioContext | null = null;
  public audioBufferCache = new Map<string, AudioBuffer>();
  public loadingPromises = new Map<string, Promise<AudioBuffer | null>>();
  public hasInitPreload = false;
  public activeSourceNode: AudioBufferSourceNode | null = null;
  public activeAudioElement: HTMLAudioElement | null = null;

  constructor() {
    // Auto-setup interaction listeners to unlock AudioContext and preload assets
    if (typeof window !== 'undefined') {
      const unlockAudio = (): void => {
        this.getAudioContext();
        if (!this.hasInitPreload) {
          this.preloadAll();
        }
        window.removeEventListener('click', unlockAudio);
        window.removeEventListener('keydown', unlockAudio);
        window.removeEventListener('touchstart', unlockAudio);
      };
      window.addEventListener('click', unlockAudio, { passive: true });
      window.addEventListener('keydown', unlockAudio, { passive: true });
      window.addEventListener('touchstart', unlockAudio, { passive: true });

      // Preload early when browser is idle or shortly after load
      if ('requestIdleCallback' in window) {
        (window as Window).requestIdleCallback(() => this.preloadAll());
      } else {
        setTimeout(() => this.preloadAll(), 1000);
      }
    }
  }

  getAudioContext(): AudioContext | null {
    if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state !== 'closed') {
      this.ctx = window.__webrtcAudioCtx;
    } else if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (this.ctx) {
      routeAudioContext(this.ctx); // plays through the chosen speaker
    }
    return this.ctx;
  }

  stopCurrent(): void {
    if (this.activeSourceNode) {
      try {
        this.activeSourceNode.stop();
        this.activeSourceNode.disconnect();
      } catch { /* ignore stop errors */ }
      this.activeSourceNode = null;
    }
    if (this.activeAudioElement) {
      try {
        this.activeAudioElement.pause();
        this.activeAudioElement.currentTime = 0;
      } catch { /* ignore audio errors */ }
      this.activeAudioElement = null;
    }
  }

  async loadAudioBuffer(soundId: string, url: string): Promise<AudioBuffer | null> {
    if (this.audioBufferCache.has(soundId)) {
      return this.audioBufferCache.get(soundId)!;
    }
    if (this.loadingPromises.has(soundId)) {
      return this.loadingPromises.get(soundId)!;
    }

    const loadPromise = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        const ctx = this.getAudioContext();
        if (!ctx) throw new Error('No AudioContext');
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        this.audioBufferCache.set(soundId, audioBuffer);
        return audioBuffer;
      } catch (err) {
        console.warn(`[Soundboard] Could not decode audio for ${soundId}:`, err);
        return null;
      } finally {
        this.loadingPromises.delete(soundId);
      }
    })();

    this.loadingPromises.set(soundId, loadPromise);
    return loadPromise;
  }

  preloadAll(): void {
    this.hasInitPreload = true;
    for (const [id, url] of Object.entries(SOUND_URL_MAP)) {
      if (!this.audioBufferCache.has(id)) {
        this.loadAudioBuffer(id, url).catch(() => {});
      }
    }
  }

  play(soundId?: string | null, volumeScale = 1.0): void {
    if (volumeScale <= 0) return;

    // Immediately stop and cancel any currently playing sound on every click (Discord spam behavior)
    this.stopCurrent();

    const resolvedId = (soundId || '').toLowerCase();
    const url = SOUND_URL_MAP[resolvedId];
    const ctx = this.getAudioContext();

    // 1. Instant 0-latency playback from cached Web Audio buffer
    if (ctx && this.audioBufferCache.has(resolvedId)) {
      try {
        const buffer = this.audioBufferCache.get(resolvedId)!;
        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(Math.min(1.0, Math.max(0, volumeScale)), ctx.currentTime);

        source.connect(gainNode);
        gainNode.connect(ctx.destination);

        source.onended = () => {
          if (this.activeSourceNode === source) {
            this.activeSourceNode = null;
          }
        };

        this.activeSourceNode = source;
        source.start(0);
        return;
      } catch (err) {
        console.warn(`[Soundboard] Error playing cached buffer ${resolvedId}:`, err);
      }
    }

    // 2. If sound has a dedicated URL, play with HTMLAudio and trigger background buffer decode
    if (url) {
      try {
        const audio = new Audio(url);
        audio.volume = Math.min(1.0, Math.max(0, volumeScale));
        this.activeAudioElement = audio;

        audio.onended = () => {
          if (this.activeAudioElement === audio) {
            this.activeAudioElement = null;
          }
        };

        audio.play().catch((err) => {
          console.warn(`[Soundboard] HTMLAudioElement error for ${resolvedId}:`, err);
          this.playSynthFallback(resolvedId, volumeScale);
        });

        // Preload into buffer cache for instantaneous subsequent plays
        if (ctx && !this.audioBufferCache.has(resolvedId)) {
          this.loadAudioBuffer(resolvedId, url).catch(() => {});
        }
        return;
      } catch (e) {
        console.warn(`[Soundboard] Audio element failed for ${resolvedId}:`, e);
      }
    }

    // 3. Synthesis fallback if no file or audio playback fails
    this.playSynthFallback(resolvedId, volumeScale);
  }

  playSynthFallback(soundId: string, volumeScale: number): void {
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
      case 'golfclap':
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
      case 'sadhorn':
        this.synthSadTrombone(ctx, masterGain);
        break;
      default:
        break;
    }
  }

  // 1. DJ Airhorn (Reggae 3-blast horn)
  synthAirhorn(ctx: AudioContext, dest: AudioNode): void {
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
  synthApplause(ctx: AudioContext, dest: AudioNode): void {
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
  synthDrumroll(ctx: AudioContext, dest: AudioNode): void {
    const now = ctx.currentTime;
    const rollDuration = 1.6;

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
  synthBaDumTss(ctx: AudioContext, dest: AudioNode): void {
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
  synthTada(ctx: AudioContext, dest: AudioNode): void {
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
  synthCheering(ctx: AudioContext, dest: AudioNode): void {
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
  synthLaughter(ctx: AudioContext, dest: AudioNode): void {
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
  synthSadTrombone(ctx: AudioContext, dest: AudioNode): void {
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
