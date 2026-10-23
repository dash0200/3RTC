/**
 * Network HUD data: per-peer ping (data-channel probes), connection type, throughput and video
 * sync drift, polled from the peer connections while in a room.
 */
import { useState, useRef, useCallback, useEffect, type MutableRefObject } from 'react';
import { extractPeerConnectionStats, PING_INTERVAL_MS, MAX_HISTORY_SAMPLES, type PeerConnectionStatsData } from '../utils/networkMonitor';
import { usePeerMessageOn } from '../core/RoomContext';
import type { RoomBus } from '../types';
import type { PeerEntryRecord } from '../webrtc/peerEntry';
import { DRIFT_LIMIT_S } from '../features/playback/drift';

function keepIfSame<T>(prev: T, next: T): T {
  try {
    return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  } catch {
    return next;
  }
}

export interface NetworkStatsSummary {
  avgPingMs: number | null;
  minPingMs: number | null;
  maxPingMs: number | null;
  overallConnectionType: string;
  totalDownloadKBps: number;
  totalUploadKBps: number;
  maxPacketLoss?: number;
  syncDriftMs?: number;
  syncDriftStatus: string;
  pingHistory?: number[];
}

export interface PeerNetworkStatsRecord {
  peerId: string;
  username: string;
  isConnected?: boolean;
  pingMs: number | null;
  avgPingMs: number | null;
  pingHistory: number[];
  connectionType: string;
  protocol: string;
  packetLossPercent?: number;
  jitterMs?: number;
  downloadKBps?: number;
  uploadKBps?: number;
  candidatePair?: {
    localType: string;
    remoteType: string;
    localIp: string;
    remoteIp: string;
  } | null;
}

export interface UseNetworkStatsContext {
  activeVideoId?: string | null;
  bus: RoomBus;
  localVideoFile?: File | null;
  /** Anything playing for the room (YouTube, a link, a shared file) */
  mediaActive?: boolean;
  peerMetadata: Record<string, { username?: string }>;
  peersRef: MutableRefObject<Map<string, PeerEntryRecord>>;
  roomId?: string | null;
  showToast: (msg: string) => void;
}

export function useNetworkStats(ctx: UseNetworkStatsContext) {
  const { activeVideoId, bus, localVideoFile, mediaActive, peerMetadata, peersRef, roomId, showToast } = ctx;

  const [networkStats, setNetworkStats] = useState<NetworkStatsSummary>({
    avgPingMs: null,
    minPingMs: null,
    maxPingMs: null,
    overallConnectionType: 'Direct P2P',
    totalDownloadKBps: 0,
    totalUploadKBps: 0,
    syncDriftMs: undefined,
    syncDriftStatus: 'P2P Mesh Ready'
  });
  const [peersNetworkStats, setPeersNetworkStats] = useState<PeerNetworkStatsRecord[]>([]);
  const peerStatsCacheRef = useRef<Map<string, PeerConnectionStatsData>>(new Map());
  const pingHistoryRef = useRef<Map<string, number[]>>(new Map());
  const lastSyncDriftMsRef = useRef<number | undefined>(undefined);

  // Feature 4.1: Record DataChannel ping latency probe
  const recordPeerPing = useCallback((peerId: string, pingMs: number): void => {
    if (!peerId || typeof pingMs !== 'number' || pingMs < 0 || pingMs > 10000) return;

    const history = pingHistoryRef.current.get(peerId) || [];
    const updatedHistory = [...history.slice(-(MAX_HISTORY_SAMPLES - 1)), pingMs];
    pingHistoryRef.current.set(peerId, updatedHistory);

    const avg = Math.round(updatedHistory.reduce((a, b) => a + b, 0) / updatedHistory.length);

    setPeersNetworkStats((prev) => {
      const existing = prev.find((p) => p.peerId === peerId);
      if (existing) {
        return prev.map((p) =>
          p.peerId === peerId
            ? {
              ...p,
              pingMs,
              avgPingMs: avg,
              pingHistory: updatedHistory
            }
            : p
        );
      } else {
        return [
          ...prev,
          {
            peerId,
            username: peerMetadata[peerId]?.username || `User_${peerId.slice(0, 4)}`,
            pingMs,
            avgPingMs: avg,
            pingHistory: updatedHistory,
            connectionType: 'Direct P2P',
            protocol: 'UDP'
          }
        ];
      }
    });
  }, [peerMetadata]);

  // Background WebRTC Mesh Metrics Polling & Ping Loop
  useEffect(() => {
    if (!roomId) {
      setNetworkStats({
        avgPingMs: null,
        minPingMs: null,
        maxPingMs: null,
        overallConnectionType: 'Direct P2P',
        totalDownloadKBps: 0,
        totalUploadKBps: 0,
        syncDriftMs: undefined,
        syncDriftStatus: 'No active room'
      });
      setPeersNetworkStats([]);
      return;
    }

    let isCancelled = false;

    const pollStats = async (): Promise<void> => {
      if (isCancelled) return;
      const activePeers = Array.from(peersRef.current.entries());
      if (activePeers.length === 0) return;

      const peerStatsList: PeerNetworkStatsRecord[] = [];
      let totalDown = 0;
      let totalUp = 0;
      let sumPing = 0;
      let pingCount = 0;
      let minPing = Infinity;
      let maxPing = -Infinity;
      let hasRelay = false;
      let maxLoss = 0;

      for (const [peerId, peerEntry] of activePeers) {
        if (!peerEntry || !peerEntry.pc) continue;

        // 1. Send active DataChannel net-ping probe
        if (peerEntry.dataChannel && peerEntry.dataChannel.readyState === 'open') {
          try {
            peerEntry.dataChannel.send(
              JSON.stringify({
                type: 'net-ping',
                pingId: crypto.randomUUID(),
                sendTime: performance.now()
              })
            );
          } catch { /* channel send error */ }
        }

        // 2. Query RTCPeerConnection.getStats()
        const prevStats = peerStatsCacheRef.current.get(peerId);
        const extracted = await extractPeerConnectionStats(peerEntry.pc, prevStats);
        if (extracted) {
          peerStatsCacheRef.current.set(peerId, extracted);
        }

        const history = pingHistoryRef.current.get(peerId) || [];
        const rtt = extracted?.rttMs ?? (history.length > 0 ? history[history.length - 1] : null);
        if (rtt !== null) {
          if (history.length === 0 || history[history.length - 1] !== rtt) {
            history.push(rtt);
            if (history.length > MAX_HISTORY_SAMPLES) history.shift();
            pingHistoryRef.current.set(peerId, history);
          }
        }

        const avgPing = history.length > 0 ? Math.round(history.reduce((a, b) => a + b, 0) / history.length) : rtt;

        if (rtt !== null) {
          sumPing += rtt;
          pingCount++;
          if (rtt < minPing) minPing = rtt;
          if (rtt > maxPing) maxPing = rtt;
        }

        const downRate = extracted?.downloadKBps || 0;
        const upRate = extracted?.uploadKBps || 0;
        totalDown += downRate;
        totalUp += upRate;

        if (extracted?.connectionType?.includes('Relay')) {
          hasRelay = true;
        }
        if (extracted && extracted.packetLossPercent > maxLoss) {
          maxLoss = extracted.packetLossPercent;
        }

        peerStatsList.push({
          peerId,
          username: peerMetadata[peerId]?.username || `User_${peerId.slice(0, 4)}`,
          isConnected: Boolean(peerEntry.isConnected),
          pingMs: rtt,
          avgPingMs: avgPing,
          pingHistory: [...history],
          connectionType: extracted?.connectionType || 'Direct P2P (STUN)',
          protocol: extracted?.protocol || 'UDP',
          packetLossPercent: extracted?.packetLossPercent ?? 0,
          jitterMs: extracted?.jitterMs ?? 0,
          downloadKBps: downRate,
          uploadKBps: upRate,
          candidatePair: extracted
            ? {
              localType: extracted.localCandidate.type,
              remoteType: extracted.remoteCandidate.type,
              localIp: extracted.localCandidate.address,
              remoteIp: extracted.remoteCandidate.address
            }
            : null
        });
      }

      if (isCancelled) return;

      setPeersNetworkStats((prev) => keepIfSame(prev, peerStatsList));

      const currentAvg = pingCount > 0 ? Math.round(sumPing / pingCount) : null;
      // Only a measured drift: nothing made up while it hasn't been measured or nothing is playing
      const playing = Boolean(mediaActive ?? (activeVideoId || localVideoFile));
      const drift = playing ? lastSyncDriftMsRef.current ?? undefined : undefined;
      const driftText =
        drift !== undefined
          ? drift <= 50
            ? `Strict Sync (±${drift}ms)`
            : `Acceptable Drift (±${drift}ms)`
          : playing ? `Auto re-sync keeps everyone within ${DRIFT_LIMIT_S} s` : 'No video playing';

      const nextStats: NetworkStatsSummary = {
        avgPingMs: currentAvg,
        minPingMs: minPing === Infinity ? currentAvg : minPing,
        maxPingMs: maxPing === -Infinity ? currentAvg : maxPing,
        overallConnectionType: hasRelay ? 'Relay (TURN)' : 'Direct P2P',
        totalDownloadKBps: +totalDown.toFixed(1),
        totalUploadKBps: +totalUp.toFixed(1),
        maxPacketLoss: maxLoss,
        syncDriftMs: drift,
        syncDriftStatus: driftText,
        pingHistory: peerStatsList[0]?.pingHistory || []
      };
      setNetworkStats((prev) => keepIfSame(prev, nextStats));
    };

    pollStats();
    const interval = setInterval(pollStats, PING_INTERVAL_MS);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [roomId, activeVideoId, localVideoFile, mediaActive, peerMetadata, peersRef]);

  const handleTriggerPing = useCallback((): void => {
    for (const peerEntry of peersRef.current.values()) {
      if (peerEntry.dataChannel && peerEntry.dataChannel.readyState === 'open') {
        try {
          peerEntry.dataChannel.send(
            JSON.stringify({
              type: 'net-ping',
              pingId: crypto.randomUUID(),
              sendTime: performance.now()
            })
          );
        } catch { /* ignore */ }
      }
    }
    showToast('Ping probe sent to mesh peers');
  }, [peersRef, showToast]);

  interface NetPingPayload {
    pingId?: string;
    sendTime?: number;
  }

  // Ping probes over the data channel: answer theirs, time ours
  usePeerMessageOn<NetPingPayload>(bus, 'net-ping', (data, from) => {
    bus.send(from, 'net-pong', { pingId: data?.pingId, sendTime: data?.sendTime });
  });
  usePeerMessageOn<NetPingPayload>(bus, 'net-pong', (data, from) => {
    recordPeerPing(from, Math.max(1, Math.round(performance.now() - (data?.sendTime || 0))));
  });

  return {
    networkStats,
    setNetworkStats,
    peersNetworkStats,
    setPeersNetworkStats,
    peerStatsCacheRef,
    pingHistoryRef,
    lastSyncDriftMsRef,
    recordPeerPing,
    handleTriggerPing
  };
}
