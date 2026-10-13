/** WebRTC settings shared by the peer connection code. */

export const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

// Second data channel for bulk transfers (P2P video stream, images). Pre-negotiated with a fixed
// id on both sides, so it needs no extra signaling. Chat, reactions and play/pause sync stay on the
// main channel and never queue behind file data. (High id: in-band channels use ids 0, 1, 2...)
export const BULK_CHANNEL_ID = 512;

// P2P connection recovery (network change, Wi-Fi drop): ICE restart over the signaling socket
export const RECOVERY = {
    disconnectGraceMs: 3000,  // 'disconnected' often recovers by itself; restart if it lasts longer
    retryMs: 8000,            // time given to each ICE restart before trying again
    maxIceRestarts: 4,        // then rebuild the connection from scratch once, then give up
    maxWaitMs: 60000          // non-initiator side: drop a connection that stays broken this long
};
