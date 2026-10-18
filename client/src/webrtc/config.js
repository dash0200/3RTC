/** WebRTC settings shared by the peer connection code. */

export const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

/**
 * Resolves ICE servers with optional TURN relay fallback (L-02).
 * Allows users requiring network privacy or symmetric NAT bypass to provide custom TURN credentials
 * via VITE_ICE_SERVERS or window.__RTC_ICE_SERVERS__.
 */
export function getIceServers() {
    try {
        if (typeof window !== 'undefined' && window.__RTC_ICE_SERVERS__ && Array.isArray(window.__RTC_ICE_SERVERS__)) {
            return window.__RTC_ICE_SERVERS__;
        }
        if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ICE_SERVERS) {
            const parsed = JSON.parse(import.meta.env.VITE_ICE_SERVERS);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch { /* fallback */ }
    return DEFAULT_ICE_SERVERS;
}

export const ICE_SERVERS = getIceServers();

// Second data channel for bulk transfers (P2P video stream, images). Pre-negotiated with a fixed
// id on both sides, so it needs no extra signaling. Chat, reactions and play/pause sync stay on the
// main channel and never queue behind file data. (High id: in-band channels use ids 0, 1, 2...)
export const BULK_CHANNEL_ID = 512;

// Version of the peer-to-peer message format, sent in 'peer-identity'. Bump it only for a change
// older apps can't safely ignore; new message types alone don't need it (see docs/PROTOCOL.md).
export const PROTOCOL_VERSION = 2;

// People per room (the signaling server enforces the same number)
export const MAX_ROOM_SIZE = 4;

// P2P connection recovery (network change, Wi-Fi drop): ICE restart over the signaling socket
export const RECOVERY = {
    disconnectGraceMs: 3000,  // 'disconnected' often recovers by itself; restart if it lasts longer
    retryMs: 8000,            // time given to each ICE restart before trying again
    maxIceRestarts: 4,        // then rebuild the connection from scratch once, then give up
    maxWaitMs: 60000,         // non-initiator side: drop a connection that stays broken this long
    firstConnectMs: 25000     // a first connection not up by then counts as failed (a blocking
                              // network can leave it "connecting" for ever): tell the person, retry
};
