/**
 * Automatic recovery for one peer connection (network change, Wi-Fi drop).
 * The initiator runs an ICE restart over the signaling socket; if that keeps failing it rebuilds
 * the connection from scratch once. The other side just answers the offers it receives.
 */

import { ICE_SERVERS, RECOVERY } from './config';
import { BUILD_LABEL } from '../version';
import { tuneSdpForDiscordAudio } from './sdp';
import { blockedNetworkHint, type NetworkHint } from './networkHint';
import { describePairs, diagnoseIce, formatIceReport, summarizePairs } from './iceDiagnosis';

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
  rebuilds?: number;
  reconnectNoticeShown?: boolean;
  wasInterrupted?: boolean;
  isConnected?: boolean;
  localCandidateTypes?: Set<string> | string[];
  localCandidates?: string[];
  remoteCandidates?: string[];
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
    current: ((peerId: string, isInitiator: boolean) => PeerRecoveryEntry | null | undefined) | null;
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logLocalDebug('ICE_RESTART_ERR', `Peer ${targetPeerId}: ${msg}`);
    }
  };

  const scheduleRecovery = (delayMs: number) => {
    if (peerEntry.recoveryTimer) clearTimeout(peerEntry.recoveryTimer);
    peerEntry.recoveryTimer = setTimeout(runRecovery, delayMs);
  };

  // Work out why (both sides' candidates + what the browser tried) and put it in the room log.
  // Started before any cleanup closes the connection; the stats are optional.
  const explainFailure = () => {
    let stats: Promise<RTCStatsReport | null> = Promise.resolve(null);
    try {
      if (typeof pc.getStats === 'function') stats = pc.getStats().catch(() => null);
    } catch {
      // closed already: diagnose from the candidates alone
    }
    const states = {
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
      signaling: pc.signalingState
    };
    void stats.then((report) => {
      const reportItems = report as Iterable<unknown> | null;
      const diagnosis = diagnoseIce({
        localCandidates: peerEntry.localCandidates,
        remoteCandidates: peerEntry.remoteCandidates,
        pairs: summarizePairs(reportItems)
      });
      const log = formatIceReport(diagnosis, {
        peerId: targetPeerId,
        app: `web ${BUILD_LABEL}`,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        iceServers: ICE_SERVERS.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])),
        states,
        pairLines: describePairs(reportItems),
        localCandidates: peerEntry.localCandidates,
        remoteCandidates: peerEntry.remoteCandidates
      });
      logLocalDebug('CONNECTION_DIAGNOSIS', `Peer ${targetPeerId}: ${diagnosis.cause}`);
      console.warn(log);
      addSystemMessage(`🔎 Why: ${diagnosis.summary} ${diagnosis.details.join(' ')}`);
      // The banner shows the reason and offers the full log to copy (unless it connected meanwhile)
      if (peerEntry.everConnected) return;
      setNetworkHint?.({
        ...blockedNetworkHint(peerEntry.localCandidateTypes ? [...peerEntry.localCandidateTypes] : []),
        why: diagnosis.summary,
        log
      });
    });
  };

  const noteBlocked = () => {
    if (peerEntry.everConnected || peerEntry.blockedNoted) return;
    peerEntry.blockedNoted = true;
    explainFailure();
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
      // The other side runs the recovery. While both of us are still in the room it keeps
      // trying, so keep this connection for its offers; drop it only if it never worked or
      // our own signaling is down too (we rejoin the room once it's back)
      const signalingUp = wsRef.current?.readyState === WebSocket.OPEN;
      if ((!peerEntry.everConnected || !signalingUp) && Date.now() - peerEntry.brokenSince > RECOVERY.maxWaitMs) {
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
      if (peerEntry.restartAttempts === 1 && !peerEntry.reconnectNoticeShown) {
        peerEntry.reconnectNoticeShown = true;
        addSystemMessage('⚠️ Connection to a peer was interrupted. Reconnecting...');
      }
      logLocalDebug(
        'ICE_RESTART',
        `Peer ${targetPeerId} attempt ${peerEntry.restartAttempts}/${RECOVERY.maxIceRestarts}`
      );
      sendIceRestartOffer();
      scheduleRecovery(RECOVERY.retryMs);
    } else if (!peerEntry.rebuilt || peerEntry.everConnected) {
      // Rebuild the connection from scratch. A connection that worked before is rebuilt again and
      // again while they're still in the room (a long Wi-Fi or UDP drop, a busy network while
      // gaming): it comes back by itself once the network does. Leaving the room ends it (peer-left).
      const rebuilds = (peerEntry.rebuilds ?? 0) + 1;
      logLocalDebug('PEER_REBUILD', `Peer ${targetPeerId}: rebuilding the connection (${rebuilds})`);
      cleanupPeer(targetPeerId);
      const fresh = getOrCreatePeerConnectionRef.current?.(targetPeerId, true);
      if (fresh) {
        fresh.rebuilt = true;
        fresh.rebuilds = rebuilds;
        fresh.everConnected = peerEntry.everConnected;
        fresh.blockedNoted = peerEntry.blockedNoted;
        fresh.wasInterrupted = peerEntry.wasInterrupted;
        fresh.reconnectNoticeShown = peerEntry.reconnectNoticeShown;
        fresh.brokenSince = peerEntry.brokenSince;
        // A fresh connection to someone we were talking to: if it isn't up in a while, recover it
        // the same way (the first-connection timer skips connections that worked before)
        if (fresh.everConnected) fresh.scheduleRecovery?.(RECOVERY.firstConnectMs);
      }
    } else {
      noteBlocked();
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
        peerEntry.wasInterrupted && ((peerEntry.restartAttempts ?? 0) > 0 || Boolean(peerEntry.rebuilds));
      peerEntry.restartAttempts = 0;
      peerEntry.rebuilds = 0;
      peerEntry.brokenSince = 0;
      peerEntry.wasInterrupted = false;
      peerEntry.reconnectNoticeShown = false;
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
