/**
 * Soundboard: short clips everyone hears at once. Wire message: 'soundboard-sfx' { soundId, soundName, emoji }.
 */

import { useState, useCallback, useRef, type RefObject } from 'react';
import {
  soundboard,
  loadSoundboardSettings,
  saveSoundboardSettings,
  SOUNDBOARD_CLIPS,
  type SoundboardSettings,
  type SoundboardClip
} from '../../utils/soundboard';
import type { Room } from '../../types';
import { usePeerMessageOn } from '../../core/RoomContext';

const BANNER_MS = 1800;
const LOCAL_MIN_GAP_MS = 30; // rapid clicks are fine; this only drops accidental double events
const REMOTE_MIN_GAP_MS = 40; // guards against message loops
const REMOTE_NOTICE_GAP_MS = 1200; // toast/log at most this often so spam doesn't flood the log

const NO_COOLDOWNS: Record<string, never> = {};

export interface ActiveSoundboardSfx {
  soundId: string;
  soundName: string;
  emoji: string;
  sender: string;
  timestamp: number;
}

export interface SoundboardClipPlayable {
  id: string;
  name?: string;
  emoji?: string;
  [key: string]: unknown;
}

export interface UseSoundboardOptions {
  room: Room;
  isAudioBlockedRef: RefObject<boolean> | { current: boolean };
}

export interface UseSoundboardReturn {
  soundboardSettings: SoundboardSettings;
  activeSoundboardSfx: ActiveSoundboardSfx | null;
  activeSfxCooldowns: Record<string, never>;
  playClip: (clip: string | SoundboardClip) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
}

export function useSoundboard({
  room,
  isAudioBlockedRef
}: UseSoundboardOptions): UseSoundboardReturn {
  const { bus } = room;
  const [soundboardSettings, setSoundboardSettings] = useState<SoundboardSettings>(() =>
    loadSoundboardSettings()
  );
  const settingsRef = useRef<SoundboardSettings>(soundboardSettings);
  settingsRef.current = soundboardSettings;
  const [activeSoundboardSfx, setActiveSoundboardSfx] = useState<ActiveSoundboardSfx | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLocalRef = useRef<number>(0);
  const lastRemoteRef = useRef<number>(0);
  const lastRemoteNoticeRef = useRef<number>(0);

  const playLocally = useCallback(
    (soundId: string) => {
      const volume = settingsRef.current?.muted ? 0 : (settingsRef.current?.volume ?? 0.75);
      if (!isAudioBlockedRef.current && volume > 0) {
        soundboard.play(soundId, volume);
      }
    },
    [isAudioBlockedRef]
  );

  const showBanner = useCallback((info: ActiveSoundboardSfx) => {
    setActiveSoundboardSfx(info);
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = setTimeout(() => setActiveSoundboardSfx(null), BANNER_MS);
  }, []);

  usePeerMessageOn<{
    soundId?: string;
    soundName?: string;
    emoji?: string;
    sender?: string;
  }>(bus, 'soundboard-sfx', (data, from) => {
    if (!data?.soundId) return;
    const now = Date.now();
    if (now - lastRemoteRef.current < REMOTE_MIN_GAP_MS) return;
    lastRemoteRef.current = now;
    const sender = room.peerName(from) || data.sender || 'Peer';
    playLocally(data.soundId);
    showBanner({
      soundId: data.soundId,
      soundName: data.soundName || data.soundId,
      emoji: data.emoji || '🎵',
      sender,
      timestamp: now
    });
    if (now - lastRemoteNoticeRef.current > REMOTE_NOTICE_GAP_MS) {
      lastRemoteNoticeRef.current = now;
      room.notify(`🔊 ${sender} played ${data.soundName || 'Sound'} ${data.emoji || ''}`);
      room.log(`🔊 ${sender} played soundboard clip: "${data.soundName || data.soundId}"`);
    }
  });

  const playClip = useCallback(
    (clip: string | SoundboardClip) => {
      const clipObj: SoundboardClip | { id: string; name?: string; emoji?: string } =
        typeof clip === 'string'
          ? (SOUNDBOARD_CLIPS.find((c) => c.id === clip) || { id: clip, name: clip, emoji: '🎵' })
          : clip;
      if (!clipObj?.id) return;
      const now = Date.now();
      if (now - lastLocalRef.current < LOCAL_MIN_GAP_MS) return;
      lastLocalRef.current = now;
      playLocally(clipObj.id);
      showBanner({
        soundId: clipObj.id,
        soundName: clipObj.name || clipObj.id,
        emoji: clipObj.emoji || '🎵',
        sender: room.getSelf().username,
        timestamp: now
      });
      bus.broadcast('soundboard-sfx', {
        soundId: clipObj.id,
        soundName: clipObj.name,
        emoji: clipObj.emoji,
        timestamp: now
      });
    },
    [bus, room, playLocally, showBanner]
  );

  const update = useCallback(
    (change: (prev: SoundboardSettings) => Partial<SoundboardSettings>) => {
      setSoundboardSettings((prev) => {
        const next: SoundboardSettings = { ...prev, ...change(prev) };
        settingsRef.current = next;
        saveSoundboardSettings(next.volume, next.muted);
        return next;
      });
    },
    []
  );

  const setVolume = useCallback((volume: number) => update(() => ({ volume })), [update]);
  const toggleMute = useCallback(() => update((prev) => ({ muted: !prev.muted })), [update]);

  return {
    soundboardSettings,
    activeSoundboardSfx,
    activeSfxCooldowns: NO_COOLDOWNS,
    playClip,
    setVolume,
    toggleMute
  };
}
