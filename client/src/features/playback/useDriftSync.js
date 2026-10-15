/**
 * Automatic re-sync. Players drift apart over a long video (different devices, a stall, a slow
 * stream). The room's reference app (the host, else the smallest peer id: room.getAuthorityId)
 * says where it is every few seconds; everyone else watching the same thing compares and, if
 * they're more than DRIFT_LIMIT_S off, quietly jumps to the right spot.
 *
 * Works for every source the same way: the position comes from the player's state getter
 * (playback.syncStateGetterRef) and the correction goes through the normal remote-command path
 * (a 'seek' remoteAction marked drift: true), which each player already handles.
 *
 * Left alone: live streams, a player that is paused or buffering, the few seconds after anyone
 * changed playback, and someone whose connection can't keep up (after a few corrections in a row
 * it stops for a while instead of jumping again and again).
 *
 * Wire: 'media-heartbeat' { key, currentTime, isPlaying } from the reference, every HEARTBEAT_MS.
 */
import { useEffect, useRef } from 'react';
import { usePeerMessageOn } from '../../core/RoomContext';
import { driftCorrection, playingKey, HEARTBEAT_MS } from './drift';

const BACKOFF_COUNT = 3;         // this many corrections...
const BACKOFF_WINDOW_MS = 60000; // ...within a minute: stop for a while
const BACKOFF_MS = 120000;

export function useDriftSync({ room, playback, active }) {
    const { bus } = room;
    const correctionsRef = useRef([]);
    const backoffUntilRef = useRef(0);
    // (playback is a new object every render: read it through a ref so the timer isn't restarted)
    const playbackRef = useRef(playback);
    playbackRef.current = playback;

    // The reference says where it is
    useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => {
            if (room.getAuthorityId() !== room.getSelfId()) return;
            const state = playbackRef.current.syncStateGetterRef.current?.();
            const key = playingKey(state);
            if (!key || state.live) return;
            bus.broadcast('media-heartbeat', { key, currentTime: state.currentTime, isPlaying: Boolean(state.isPlaying && !state.isBuffering) });
        }, HEARTBEAT_MS);
        return () => clearInterval(timer);
    }, [active, bus, room]);

    // Everyone else compares
    usePeerMessageOn(bus, 'media-heartbeat', (data, from) => {
        if (from !== room.getAuthorityId()) return;
        const mine = playback.syncStateGetterRef.current?.();
        const now = Date.now();
        const target = driftCorrection(data, mine, { now, lastChangeAt: playback.lastChangeAtRef.current, backoffUntil: backoffUntilRef.current });
        if (import.meta.env?.DEV && typeof window !== 'undefined') {
            // For tests and debugging: what the last heartbeat led to
            window.__3rtcDrift = { heartbeat: data, mine, target, sinceChange: now - playback.lastChangeAtRef.current, backoffUntil: backoffUntilRef.current };
        }
        if (target === null) return;

        correctionsRef.current = correctionsRef.current.filter((t) => now - t < BACKOFF_WINDOW_MS).concat(now);
        if (correctionsRef.current.length >= BACKOFF_COUNT) {
            // Keeps falling behind (a slow stream): jumping again would only stall it more
            correctionsRef.current = [];
            backoffUntilRef.current = now + BACKOFF_MS;
            room.log('🔄 This device keeps falling behind the room (slow connection?). Auto re-sync paused for 2 minutes.');
        }
        const type = mine.mediaType === 'link' ? 'media-action' : mine.mediaType === 'local' ? 'local-video-action' : 'yt-action';
        playback.setRemoteAction({ type, action: 'seek', currentTime: target, drift: true, sender: 'Auto-sync', timestamp: now });
        room.log(`🔄 Re-synced with the room (was ${(Number(mine.currentTime) - Number(data.currentTime)).toFixed(1)} s off)`);
    });

    useEffect(() => bus.onEvent('room-left', () => {
        correctionsRef.current = [];
        backoffUntilRef.current = 0;
    }), [bus]);
}
