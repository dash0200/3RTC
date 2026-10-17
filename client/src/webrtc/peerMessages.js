/**
 * Everything that arrives on a peer's data channels (main and bulk share this handler).
 *
 * The connection layer handles only what belongs to the connection itself: 'peer-bye' (they left
 * on purpose), 'peer-identity' (name, host flag) and 'peer-voice-status' (mic muted). Every message,
 * including those, is then handed to the room bus, where features subscribe to their own types
 * (core/roomBus.js). Binary frames go to the bus's binary handlers (chat images, video stream).
 */

import { cleanName } from '../utils/names';

/**
 * What a peer's message says about who sent it is checked here, once for every feature: `isHost`
 * comes from the signaling server (who made the room), not the sender; names are cleaned.
 */
export function normalizeSender(data, fromPeerId, hostPeerIdRef) {
    if ('isHost' in data) {
        const hostId = hostPeerIdRef?.current;
        data.isHost = Boolean(hostId && fromPeerId === hostId);
    }
    if ('sender' in data) data.sender = cleanName(data.sender) || undefined;
    if (data.type === 'peer-identity' || data.type === 'peer-voice-status') {
        if ('username' in data) data.username = cleanName(data.username) || undefined;
    }
}

export function createPeerMessageHandler(ctx) {
    const { bus, cleanupPeer, dc, getIdentity, hostPeerIdRef, isAudioBlockedRef, isStillCurrent, peerEntry, peersRef, setPeerCount, setPeerMetadata, setPeerVoiceStates, targetPeerId } = ctx;

    const handleCore = (data) => {
        if (data.type === 'peer-bye') {
            // Peer is leaving the room on purpose
            if (isStillCurrent()) {
                peerEntry.byeReceived = true;
                cleanupPeer(targetPeerId);
                setPeerCount(peersRef.current.size + 1);
            }
            return false; // nothing else to do with it
        }
        if (data.type === 'peer-identity') {
            setPeerMetadata((prev) => ({
                ...prev,
                [targetPeerId]: {
                    username: data.username || `User_${targetPeerId.slice(0, 4)}`,
                    isHost: Boolean(data.isHost),
                    isMuted: Boolean(data.isMuted),
                    ...(data.proto ? { proto: data.proto } : {}),
                    ...(typeof data.build === 'string' ? { build: data.build.slice(0, 20) } : {}),
                    ...(typeof data.clientId === 'string' ? { clientId: data.clientId.slice(0, 64) } : {})
                }
            }));
            if (!data.isReply) {
                try {
                    dc.send(JSON.stringify({ ...getIdentity(), isReply: true }));
                } catch { }
            }
        } else if (data.type === 'peer-voice-status') {
            setPeerVoiceStates((prev) => ({ ...prev, [data.sender]: { isMuted: data.isMuted } }));
            setPeerMetadata((prev) => ({
                ...prev,
                [targetPeerId]: {
                    ...(prev[targetPeerId] || {}),
                    username: data.sender || prev[targetPeerId]?.username || `User_${targetPeerId.slice(0, 4)}`,
                    isMuted: data.isMuted
                }
            }));
            // When a remote peer un-mutes, make sure their audio element is playing
            if (!data.isMuted) {
                for (const peer of peersRef.current.values()) {
                    if (peer.audioElement && !isAudioBlockedRef.current) peer.audioElement.play().catch(() => { });
                }
            }
        }
        return true;
    };

    return async (event) => {
        let arrayBuffer = null;
        if (event.data instanceof ArrayBuffer) {
            arrayBuffer = event.data;
        } else if (event.data instanceof Blob) {
            try {
                arrayBuffer = await event.data.arrayBuffer();
            } catch { }
        }
        if (arrayBuffer) {
            bus.dispatchBinary(arrayBuffer, targetPeerId);
            return;
        }

        let data;
        try {
            data = JSON.parse(event.data);
        } catch {
            return; // not ours
        }
        if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
        normalizeSender(data, targetPeerId, hostPeerIdRef);
        if (handleCore(data)) bus.dispatch(data, targetPeerId);
    };
}
