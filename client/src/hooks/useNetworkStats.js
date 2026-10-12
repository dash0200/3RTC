/**
 * Network HUD data: per-peer ping (data-channel probes), connection type, throughput and video
 * sync drift, polled from the peer connections while in a room.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { extractPeerConnectionStats, PING_INTERVAL_MS, MAX_HISTORY_SAMPLES } from '../utils/networkMonitor';

export function useNetworkStats(ctx) {
    const { activeVideoId, localVideoFile, peerMetadata, peersRef, roomId, showToast } = ctx;

    const [networkStats, setNetworkStats] = useState({
        avgPingMs: null,
        minPingMs: null,
        maxPingMs: null,
        overallConnectionType: 'Direct P2P',
        totalDownloadKBps: 0,
        totalUploadKBps: 0,
        syncDriftMs: undefined,
        syncDriftStatus: 'P2P Mesh Ready'
    });
    const [peersNetworkStats, setPeersNetworkStats] = useState([]);
    const peerStatsCacheRef = useRef(new Map());
    const pingHistoryRef = useRef(new Map());
    const lastSyncDriftMsRef = useRef(undefined);

    // Feature 4.1: Record DataChannel ping latency probe
    const recordPeerPing = useCallback((peerId, pingMs) => {
        if (!peerId || typeof pingMs !== 'number' || pingMs < 0 || pingMs > 10000) return;

        const history = pingHistoryRef.current.get(peerId) || [];
        const updatedHistory = [...history.slice(-(MAX_HISTORY_SAMPLES - 1)), pingMs];
        pingHistoryRef.current.set(peerId, updatedHistory);

        const avg = Math.round(updatedHistory.reduce((a, b) => a + b, 0) / updatedHistory.length);

        setPeersNetworkStats((prev) => {
            const existing = prev.find((p) => p.peerId === peerId);
            if (existing) {
                return prev.map((p) => (p.peerId === peerId ? {
                    ...p,
                    pingMs,
                    avgPingMs: avg,
                    pingHistory: updatedHistory
                } : p));
            } else {
                return [...prev, {
                    peerId,
                    username: peerMetadata[peerId]?.username || `User_${peerId.slice(0, 4)}`,
                    pingMs,
                    avgPingMs: avg,
                    pingHistory: updatedHistory,
                    connectionType: 'Direct P2P',
                    protocol: 'UDP'
                }];
            }
        });
    }, [peerMetadata]);

    // Create or get peer connection in mesh
    // Feature 4.1: Background WebRTC Mesh Metrics Polling & Ping Loop
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

        const pollStats = async () => {
            if (isCancelled) return;
            const activePeers = Array.from(peersRef.current.entries());
            if (activePeers.length === 0) return;

            const peerStatsList = [];
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
                        peerEntry.dataChannel.send(JSON.stringify({
                            type: 'net-ping',
                            pingId: crypto.randomUUID(),
                            sendTime: performance.now()
                        }));
                    } catch (e) { }
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
                if (extracted?.packetLossPercent > maxLoss) {
                    maxLoss = extracted.packetLossPercent;
                }

                peerStatsList.push({
                    peerId,
                    username: peerMetadata[peerId]?.username || `User_${peerId.slice(0, 4)}`,
                    isConnected: peerEntry.isConnected,
                    pingMs: rtt,
                    avgPingMs: avgPing,
                    pingHistory: [...history],
                    connectionType: extracted?.connectionType || 'Direct P2P (STUN)',
                    protocol: extracted?.protocol || 'UDP',
                    packetLossPercent: extracted?.packetLossPercent ?? 0,
                    jitterMs: extracted?.jitterMs ?? 0,
                    downloadKBps: downRate,
                    uploadKBps: upRate,
                    candidatePair: extracted ? {
                        localType: extracted.localCandidate.type,
                        remoteType: extracted.remoteCandidate.type,
                        localIp: extracted.localCandidate.address,
                        remoteIp: extracted.remoteCandidate.address
                    } : null
                });
            }

            if (isCancelled) return;

            setPeersNetworkStats(peerStatsList);

            const currentAvg = pingCount > 0 ? Math.round(sumPing / pingCount) : null;
            const drift = lastSyncDriftMsRef.current ?? (activeVideoId || localVideoFile ? 14 : undefined);
            const driftText = drift !== undefined
                ? (drift <= 50 ? `Strict Sync (±${drift}ms)` : `Acceptable Drift (±${drift}ms)`)
                : 'In Sync';

            setNetworkStats({
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
            });
        };

        pollStats();
        const interval = setInterval(pollStats, PING_INTERVAL_MS);

        return () => {
            isCancelled = true;
            clearInterval(interval);
        };
    }, [roomId, activeVideoId, localVideoFile, peerMetadata]);

    const handleTriggerPing = useCallback(() => {
        for (const peerEntry of peersRef.current.values()) {
            if (peerEntry.dataChannel && peerEntry.dataChannel.readyState === 'open') {
                try {
                    peerEntry.dataChannel.send(JSON.stringify({
                        type: 'net-ping',
                        pingId: crypto.randomUUID(),
                        sendTime: performance.now()
                    }));
                } catch (e) { }
            }
        }
        showToast('Ping probe sent to mesh peers');
    }, [showToast]);

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
