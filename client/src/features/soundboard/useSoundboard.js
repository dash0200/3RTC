/**
 * Soundboard: short clips everyone hears at once. Wire message: 'soundboard-sfx' { soundId, soundName, emoji }.
 */
import { useState, useCallback, useRef } from 'react';
import { soundboard, loadSoundboardSettings, saveSoundboardSettings } from '../../utils/soundboard';
import { usePeerMessageOn } from '../../core/RoomContext';

const BANNER_MS = 1800;
const LOCAL_MIN_GAP_MS = 30;   // rapid clicks are fine; this only drops accidental double events
const REMOTE_MIN_GAP_MS = 40;  // guards against message loops
const REMOTE_NOTICE_GAP_MS = 1200; // toast/log at most this often so spam doesn't flood the log

export function useSoundboard({ room, isAudioBlockedRef }) {
    const { bus } = room;
    const [soundboardSettings, setSoundboardSettings] = useState(() => loadSoundboardSettings());
    const settingsRef = useRef(soundboardSettings);
    settingsRef.current = soundboardSettings;
    const [activeSoundboardSfx, setActiveSoundboardSfx] = useState(null);
    const bannerTimerRef = useRef(null);
    const lastLocalRef = useRef(0);
    const lastRemoteRef = useRef(0);
    const lastRemoteNoticeRef = useRef(0);

    const playLocally = useCallback((soundId) => {
        const volume = settingsRef.current?.muted ? 0 : (settingsRef.current?.volume ?? 0.75);
        if (!isAudioBlockedRef.current && volume > 0) soundboard.play(soundId, volume);
    }, [isAudioBlockedRef]);

    const showBanner = useCallback((info) => {
        setActiveSoundboardSfx(info);
        clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = setTimeout(() => setActiveSoundboardSfx(null), BANNER_MS);
    }, []);

    usePeerMessageOn(bus, 'soundboard-sfx', (data, from) => {
        if (!data?.soundId) return;
        const now = Date.now();
        if (now - lastRemoteRef.current < REMOTE_MIN_GAP_MS) return;
        lastRemoteRef.current = now;
        const sender = room.peerName(from) || data.sender || 'Peer';
        playLocally(data.soundId);
        showBanner({ soundId: data.soundId, soundName: data.soundName || data.soundId, emoji: data.emoji || '🎵', sender, timestamp: now });
        if (now - lastRemoteNoticeRef.current > REMOTE_NOTICE_GAP_MS) {
            lastRemoteNoticeRef.current = now;
            room.notify(`🔊 ${sender} played ${data.soundName || 'Sound'} ${data.emoji || ''}`);
            room.log(`🔊 ${sender} played soundboard clip: "${data.soundName || data.soundId}"`);
        }
    });

    const playClip = useCallback((clip) => {
        if (!clip?.id) return;
        const now = Date.now();
        if (now - lastLocalRef.current < LOCAL_MIN_GAP_MS) return;
        lastLocalRef.current = now;
        playLocally(clip.id);
        showBanner({ soundId: clip.id, soundName: clip.name, emoji: clip.emoji, sender: room.getSelf().username, timestamp: now });
        bus.broadcast('soundboard-sfx', { soundId: clip.id, soundName: clip.name, emoji: clip.emoji, timestamp: now });
    }, [bus, room, playLocally, showBanner]);

    const update = useCallback((change) => {
        setSoundboardSettings((prev) => {
            const next = { ...prev, ...change(prev) };
            settingsRef.current = next;
            saveSoundboardSettings(next.volume, next.muted);
            return next;
        });
    }, []);
    const setVolume = useCallback((volume) => update(() => ({ volume })), [update]);
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

const NO_COOLDOWNS = {};
