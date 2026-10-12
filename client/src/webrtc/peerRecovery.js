/**
 * Automatic recovery for one peer connection (network change, Wi-Fi drop).
 * The initiator runs an ICE restart over the signaling socket; if that keeps failing it rebuilds
 * the connection from scratch once. The other side just answers the offers it receives.
 */
import { RECOVERY } from './config';
import { tuneSdpForDiscordAudio } from './sdp';

export function attachPeerRecovery(pc, ctx) {
    const { addSystemMessage, cleanupPeer, getOrCreatePeerConnectionRef, logLocalDebug, peerEntry, peersRef, sendSignal, setPeerCount, showToast, targetPeerId, updateP2PStatus, wsRef } = ctx;
    // ---- Connection recovery ----
    // Network changes (Wi-Fi <-> mobile data, a dropped Wi-Fi) break the P2P path. The initiator
    // runs an ICE restart over the signaling socket; if that keeps failing it rebuilds the
    // connection from scratch once. The other side just answers the offers it receives.
    const isStillCurrent = () => peersRef.current.get(targetPeerId) === peerEntry;
    const isHealthy = () => pc.connectionState === 'connected' &&
        (!peerEntry.dataChannel || peerEntry.dataChannel.readyState === 'open');

    const sendIceRestartOffer = async () => {
        try {
            if (pc.signalingState === 'closed') return;
            // A previous restart offer was never answered (peer unreachable): withdraw it first
            if (pc.signalingState === 'have-local-offer') {
                await pc.setLocalDescription({ type: 'rollback' });
            }
            if (pc.signalingState !== 'stable') return;
            const offer = await pc.createOffer({ iceRestart: true });
            const tunedOffer = { type: offer.type, sdp: tuneSdpForDiscordAudio(offer.sdp) };
            await pc.setLocalDescription(tunedOffer);
            sendSignal({ type: 'offer', targetId: targetPeerId, offer: tunedOffer, iceRestart: true });
        } catch (err) {
            logLocalDebug('ICE_RESTART_ERR', `Peer ${targetPeerId}: ${err.message}`);
        }
    };

    const scheduleRecovery = (delayMs) => {
        clearTimeout(peerEntry.recoveryTimer);
        peerEntry.recoveryTimer = setTimeout(runRecovery, delayMs);
    };
    peerEntry.scheduleRecovery = scheduleRecovery;

    function runRecovery() {
        peerEntry.recoveryTimer = null;
        if (!isStillCurrent() || pc.connectionState === 'closed' || isHealthy()) return;

        // Peer already left signaling and now the P2P link broke too: they're gone
        if (peerEntry.signalingGone) {
            cleanupPeer(targetPeerId);
            setPeerCount(peersRef.current.size + 1);
            return;
        }

        if (!peerEntry.brokenSince) peerEntry.brokenSince = Date.now();

        if (!peerEntry.isInitiator) {
            // The initiator restarts; give up only if nothing works for a long time
            if (Date.now() - peerEntry.brokenSince > RECOVERY.maxWaitMs) {
                cleanupPeer(targetPeerId);
                setPeerCount(peersRef.current.size + 1);
                return;
            }
            scheduleRecovery(RECOVERY.retryMs);
            return;
        }

        // Offers travel over signaling: wait until it is back
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            scheduleRecovery(1500);
            return;
        }

        // ICE restart can't revive a closed data channel; only a fresh connection can
        const channelDead = peerEntry.dataChannel &&
            (peerEntry.dataChannel.readyState === 'closed' || peerEntry.dataChannel.readyState === 'closing');

        if (!channelDead && peerEntry.restartAttempts < RECOVERY.maxIceRestarts) {
            peerEntry.restartAttempts += 1;
            if (peerEntry.restartAttempts === 1) {
                addSystemMessage('⚠️ Connection to a peer was interrupted. Reconnecting...');
            }
            logLocalDebug('ICE_RESTART', `Peer ${targetPeerId} attempt ${peerEntry.restartAttempts}/${RECOVERY.maxIceRestarts}`);
            sendIceRestartOffer();
            scheduleRecovery(RECOVERY.retryMs);
        } else if (!peerEntry.rebuilt) {
            logLocalDebug('PEER_REBUILD', `Peer ${targetPeerId}: rebuilding the connection`);
            cleanupPeer(targetPeerId);
            const fresh = getOrCreatePeerConnectionRef.current?.(targetPeerId, true);
            if (fresh) fresh.rebuilt = true;
        } else {
            addSystemMessage('❌ Could not reconnect to a peer. They can rejoin the room to connect again.');
            cleanupPeer(targetPeerId);
            setPeerCount(peersRef.current.size + 1);
        }
    }

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (!isStillCurrent()) return;
        if (state === 'connected') {
            clearTimeout(peerEntry.recoveryTimer);
            peerEntry.recoveryTimer = null;
            const wasRecovering = peerEntry.wasInterrupted && peerEntry.restartAttempts > 0;
            peerEntry.restartAttempts = 0;
            peerEntry.brokenSince = 0;
            peerEntry.wasInterrupted = false;
            peerEntry.isConnected = peerEntry.dataChannel?.readyState === 'open';
            updateP2PStatus();
            if (wasRecovering) {
                addSystemMessage('🔄 Connection to peer restored.');
                showToast('Reconnected');
            }
        } else if (state === 'disconnected' || state === 'failed') {
            peerEntry.isConnected = false;
            peerEntry.wasInterrupted = true;
            updateP2PStatus();
            scheduleRecovery(state === 'failed' ? 0 : RECOVERY.disconnectGraceMs);
        }
    };

    return { isStillCurrent, scheduleRecovery };
}
