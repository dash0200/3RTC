/**
 * Host controls lock: when the host turns it on, only the host can play, pause, seek or change
 * what everyone watches. A guest's attempt is stopped here (with a toast) and their player is put
 * back to the host's state; messages from guests that ignore the lock (older apps) are dropped.
 *
 * Wire: 'room-settings' { playbackLock } from the host; the host's 'peer-identity' carries it too
 * (identityFields), so people joining later get it.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { usePeerMessageOn } from '../../core/RoomContext';

// Changes to what everyone watches; with the lock on, only the host sends these
const LOCKED_PLAYBACK_ACTIONS = new Set(['play', 'pause', 'seek', 'load', 'close', 'unload']);
export const isLockedPlaybackAction = (type, action, _payload = {}) =>
    (type === 'yt-action' || type === 'local-video-action' || type === 'media-action') && LOCKED_PLAYBACK_ACTIONS.has(action);

const HOST_RETURN_GRACE_MS = 4000; // a host that is only reconnecting comes back within this
const BLOCKED_TOAST_GAP_MS = 3000;

export function useHostControls({ room, isHost, peerMetadata }) {
    const { bus } = room;
    const [playbackLock, setPlaybackLockState] = useState(false);
    const playbackLockRef = useRef(false);
    // Set when we asked the host for its state to undo a blocked change (see useMediaSync)
    const lockRevertPendingRef = useRef(false);
    const lastBlockedToastRef = useRef(0);
    const revertTimerRef = useRef(null);

    const setPlaybackLock = useCallback((on) => {
        playbackLockRef.current = Boolean(on);
        setPlaybackLockState(Boolean(on));
    }, []);

    /** True when this app may not change playback right now. */
    const isLockedForMe = useCallback(() => playbackLockRef.current && !room.getSelf().isHost, [room]);

    /** A guest tried to change playback: tell them, and put their player back to the host's state. */
    const onBlocked = useCallback(() => {
        if (Date.now() - lastBlockedToastRef.current > BLOCKED_TOAST_GAP_MS) {
            lastBlockedToastRef.current = Date.now();
            room.notify('🔒 Only the host can control playback right now');
        }
        clearTimeout(revertTimerRef.current);
        revertTimerRef.current = setTimeout(() => {
            const hostId = room.getHostPeerId();
            if (hostId && bus.send(hostId, 'yt-request-sync', {})) lockRevertPendingRef.current = true;
        }, 350);
    }, [bus, room]);

    /** Check before acting locally. Returns false (and handles the block) when not allowed. */
    const allowPlaybackChange = useCallback((type, action, payload) => {
        if (type && !isLockedPlaybackAction(type, action, payload)) return true;
        if (!isLockedForMe()) return true;
        onBlocked();
        return false;
    }, [isLockedForMe, onBlocked]);

    /** Remote playback messages: drop a guest's change while the lock is on. */
    const acceptRemotePlayback = useCallback((data) =>
        !(playbackLockRef.current && !data.fromHost && isLockedPlaybackAction(data.type, data.action, data)), []);

    const toggle = useCallback(() => {
        if (!room.getSelf().isHost) return;
        const next = !playbackLockRef.current;
        setPlaybackLock(next);
        bus.broadcast('room-settings', { playbackLock: next });
        room.log(next ? '🔒 You turned on host controls: only you can control playback.' : '🔓 Everyone can control playback again.');
        room.notify(next ? '🔒 Only you can control playback' : '🔓 Everyone can control playback');
    }, [bus, room, setPlaybackLock]);

    const applyFromHost = useCallback((data, fromPeerId, announce) => {
        if (typeof data.playbackLock !== 'boolean') return;
        const fromHost = data.type === 'peer-identity' ? Boolean(data.isHost) : room.isPeerHost(fromPeerId);
        if (!fromHost || data.playbackLock === playbackLockRef.current) return;
        setPlaybackLock(data.playbackLock);
        if (announce) {
            const who = room.peerName(fromPeerId) || 'The host';
            room.log(data.playbackLock ? `🔒 ${who} turned on host controls: only the host can control playback.` : `🔓 ${who} turned off host controls.`);
            room.notify(data.playbackLock ? '🔒 Only the host can control playback' : '🔓 Everyone can control playback');
        }
    }, [room, setPlaybackLock]);

    usePeerMessageOn(bus, 'room-settings', (data, from) => applyFromHost(data, from, true));
    usePeerMessageOn(bus, 'peer-identity', (data, from) => applyFromHost(data, from, false));

    /** True once after we asked the host for its state to undo a blocked change (then cleared). */
    const consumeLockRevert = useCallback(() => {
        const pending = lockRevertPendingRef.current;
        lockRevertPendingRef.current = false;
        return pending;
    }, []);

    /** Extra fields for our 'peer-identity' message. */
    const identityFields = useCallback(() => (room.getSelf().isHost ? { playbackLock: playbackLockRef.current } : {}), [room]);

    // The host left: nobody could control playback, so the lock goes away
    useEffect(() => {
        if (!playbackLock || isHost) return undefined;
        if (Object.values(peerMetadata).some((m) => m?.isHost)) return undefined;
        const t = setTimeout(() => {
            if (playbackLockRef.current && !room.getHostPeerId()) {
                setPlaybackLock(false);
                room.notify('🔓 The host left: everyone can control playback');
            }
        }, HOST_RETURN_GRACE_MS);
        return () => clearTimeout(t);
    }, [peerMetadata, playbackLock, isHost, room, setPlaybackLock]);

    useEffect(() => bus.onEvent('room-left', () => setPlaybackLock(false)), [bus, setPlaybackLock]);

    return {
        playbackLock,
        playbackLockRef,
        consumeLockRevert,
        toggle,
        allowPlaybackChange,
        acceptRemotePlayback,
        onBlocked,
        isLockedForMe,
        identityFields
    };
}
