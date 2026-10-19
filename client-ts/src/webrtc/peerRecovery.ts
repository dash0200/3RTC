/**
 * Automatic recovery for one peer connection (network change, Wi-Fi drop).
 * The initiator runs an ICE restart over the signaling socket; if that keeps failing it rebuilds
 * the connection from scratch once. The other side just answers the offers it receives.
 */

import { RECOVERY } from './config';
import { tuneSdpForDiscordAudio } from './sdp';
import { blockedNetworkHint, type NetworkHint } from './networkHint';

export interface PeerRecoveryEntry {
  pc?: RTCPeerConnection | null;
  dataChannel?: RTCDataChannel | null;
  bulkChannel?: RTCDataChannel | null;
  recoveryTimer?: ReturnType<typeof setTimeout> | null;
  cancelFirstTimer?: () => void;
  scheduleRecovery?: (delayMs: number) => void;
  everConnected?: boolean;
  blockedNoted?: boolean;
  signalingGone?: boolean;
  brokenSince?: number;
  isInitiator?: boolean;
  restartAttempts?: number;
  rebuilt?: boolean;
  wasInterrupted?: boolean;
  isConnected?: boolean;
  localCandidateTypes?: Set<string> | string[];
  [key: string]: unknown;
}

export interface PeerRecoveryContext {
  targetPeerId: string;
  peerEntry: PeerRecoveryEntry;
  peersRef: { current: Map<string, PeerRecoveryEntry> };
  wsRef: { current: WebSocket | null };
  sendSignal: (msg: Record<string, unknown>) => void;
  logLocalDebug: (tag: string, detail: string) => void;
  addSystemMessage: (text: string) => void;
  showToast: (text: string) => void;
  cleanupPeer: (peerId: string) => void;
  setPeerCount: (count: number) => void;
  updateP2PStatus: () => void;
  setNetworkHint?: (hint: NetworkHint | null) => void;
  getOrCreatePeerConnectionRef: {
    current: ((peerId: string, isInitiator: boolean) => PeerRecoveryEntry | null) | null;
  };
}

let lastBlockedNotice = 0;

export function attachPeerRecovery(
  pc: RTCPeerConnection,
  ctx: PeerRecoveryContext
): { isStillCurrent: () => boolean; scheduleRecovery: (delayMs: number) => void } {
  const {
    addSystemMessage,
    cleanupPeer,
    getOrCreatePeerConnectionRef,
    logLocalDebug,
    peerEntry,
    peersRef,
    sendSignal,
    setNetworkHint,
    setPeerCount,
    showToast,
    targetPeerId,
    updateP2PStatus,
    wsRef
  } = ctx;

  const isStillCurrent = () => peersRef.current.get(targetPeerId) === peerEntry;
  const isHealthy = () =>
    pc.connectionState === 'connected' &&
    (!peerEntry.dataChannel || peerEntry.dataChannel.readyState === 'open');

  const sendIceRestartOffer = async () => {
    try {
      if (pc.signalingState === 'closed') return;
      if (pc.signalingState === 'have-local-offer') {
        await pc.setLocalDescription({ type: 'rollback' });
      }
      if (pc.signalingState !== 'stable') return;
      const offer = await pc.createOffer({ iceRestart: true });
      const tunedOffer = { type: offer.type, sdp: tuneSdpForDiscordAudio(offer.sdp) };
      await pc.setLocalDescription(tunedOffer);
      sendSignal({
        type: 'offer',
        targetId: targetPeerId,
        offer: tunedOffer,
        iceRestart: true
      });
    } catch (err: any) {
      logLocalDebug('ICE_RESTART_ERR', `Peer ${targetPeerId}: ${err.message}`);
    }
  };

  const scheduleRecovery = (delayMs: number) => {
    if (peerEntry.recoveryTimer) clearTimeout(peerEntry.recoveryTimer);
    peerEntry.recoveryTimer = setTimeout(runRecovery, delayMs);
  };

  const noteBlocked = () => {
    if (peerEntry.everConnected || peerEntry.blockedNoted) return;
    peerEntry.blockedNoted = true;
    if (Date.now() - lastBlockedNotice < 60000) return;
    lastBlockedNotice = Date.now();
    const hint = blockedNetworkHint(
      peerEntry.localCandidateTypes ? [...peerEntry.localCandidateTypes] : []
    );
    logLocalDebug(
      'NETWORK_BLOCKED',
      `Peer ${targetPeerId}: no connection (${hint.side}; ours: ${
        [...(peerEntry.localCandidateTypes || [])].join(',') || 'none'
      })`
    );
    addSystemMessage(hint.message);
    setNetworkHint?.(hint);
  };

  const firstTimer = setTimeout(() => {
    if (
      !isStillCurrent() ||
      peerEntry.everConnected ||
      pc.connectionState === 'closed' ||
      isHealthy()
    ) {
      return;
    }
    noteBlocked();
    if (!peerEntry.recoveryTimer) scheduleRecovery(0);
  }, RECOVERY.firstConnectMs);

  peerEntry.cancelFirstTimer = () => clearTimeout(firstTimer);
  peerEntry.scheduleRecovery = scheduleRecovery;

  function runRecovery() {
    peerEntry.recoveryTimer = null;
    if (!isStillCurrent() || pc.connectionState === 'closed' || isHealthy()) return;

    if (peerEntry.signalingGone) {
      cleanupPeer(targetPeerId);
      setPeerCount(peersRef.current.size + 1);
      return;
    }

    if (!peerEntry.brokenSince) peerEntry.brokenSince = Date.now();

    if (!peerEntry.isInitiator) {
      if (Date.now() - peerEntry.brokenSince > RECOVERY.maxWaitMs) {
        noteBlocked();
        cleanupPeer(targetPeerId);
        setPeerCount(peersRef.current.size + 1);
        return;
      }
      scheduleRecovery(RECOVERY.retryMs);
      return;
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      scheduleRecovery(1500);
      return;
    }

    const channelDead =
      peerEntry.dataChannel &&
      (peerEntry.dataChannel.readyState === 'closed' ||
        peerEntry.dataChannel.readyState === 'closing');

    const attempts = peerEntry.restartAttempts ?? 0;
    if (!channelDead && attempts < RECOVERY.maxIceRestarts) {
      peerEntry.restartAttempts = attempts + 1;
      if (peerEntry.restartAttempts === 1) {
        addSystemMessage('⚠️ Connection to a peer was interrupted. Reconnecting...');
      }
      logLocalDebug(
        'ICE_RESTART',
        `Peer ${targetPeerId} attempt ${peerEntry.restartAttempts}/${RECOVERY.maxIceRestarts}`
      );
      sendIceRestartOffer();
      scheduleRecovery(RECOVERY.retryMs);
    } else if (!peerEntry.rebuilt) {
      logLocalDebug('PEER_REBUILD', `Peer ${targetPeerId}: rebuilding the connection`);
      cleanupPeer(targetPeerId);
      const fresh = getOrCreatePeerConnectionRef.current?.(targetPeerId, true);
      if (fresh) {
        fresh.rebuilt = true;
        fresh.everConnected = peerEntry.everConnected;
        fresh.blockedNoted = peerEntry.blockedNoted;
      }
    } else if (!peerEntry.everConnected) {
      noteBlocked();
      cleanupPeer(targetPeerId);
      setPeerCount(peersRef.current.size + 1);
    } else {
      addSystemMessage(
        '❌ Could not reconnect to a peer. They can rejoin the room to connect again.'
      );
      cleanupPeer(targetPeerId);
      setPeerCount(peersRef.current.size + 1);
    }
  }

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (!isStillCurrent()) return;
    if (state === 'connected') {
      if (peerEntry.recoveryTimer) clearTimeout(peerEntry.recoveryTimer);
      peerEntry.recoveryTimer = null;
      peerEntry.cancelFirstTimer?.();
      if (peerEntry.blockedNoted && !peerEntry.everConnected) {
        addSystemMessage('✅ Connected after all.');
        setNetworkHint?.(null);
      }
      peerEntry.everConnected = true;
      const wasRecovering =
        peerEntry.wasInterrupted && (peerEntry.restartAttempts ?? 0) > 0;
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
      if (state === 'failed') noteBlocked();
      peerEntry.isConnected = false;
      peerEntry.wasInterrupted = true;
      updateP2PStatus();
      scheduleRecovery(state === 'failed' ? 0 : RECOVERY.disconnectGraceMs);
    }
  };

  return { isStillCurrent, scheduleRecovery };
}
