/**
 * WebRTC P2P Network Monitor & Diagnostics
 * 
 * Capabilities:
 * - Real-time RTCPeerConnection.getStats() metric extraction.
 * - Active candidate pair inspection (Direct P2P STUN vs TURN Relay vs LAN Host).
 * - Application-level DataChannel Ping/Pong RTT calculation.
 * - Audio inbound/outbound packet loss, jitter, and throughput tracking.
 * - Rolling ping history for sparkline graphs.
 * - Video synchronization drift tracking.
 */

export const PING_INTERVAL_MS = 2500;
export const MAX_HISTORY_SAMPLES = 15;

/**
 * Health assessment helper
 */
export function getNetworkHealthGrade(pingMs, packetLoss = 0) {
  if (pingMs === null || pingMs === undefined) {
    return { label: 'Connecting', color: '#94a3b8', grade: '?' };
  }
  if (pingMs <= 50 && packetLoss < 1) {
    return { label: 'Excellent', color: '#22c55e', grade: 'A+' };
  }
  if (pingMs <= 100 && packetLoss < 3) {
    return { label: 'Good', color: '#38bdf8', grade: 'A' };
  }
  if (pingMs <= 180 && packetLoss < 8) {
    return { label: 'Fair', color: '#f59e0b', grade: 'B' };
  }
  return { label: 'Poor / High Latency', color: '#ef4444', grade: 'C' };
}

/**
 * Determine connection type from candidate pair
 */
export function parseCandidateConnectionType(localType, remoteType) {
  const local = (localType || '').toLowerCase();
  const remote = (remoteType || '').toLowerCase();

  if (local === 'relay' || remote === 'relay') {
    return 'Relay (TURN)';
  }
  if (local === 'host' && remote === 'host') {
    return 'Direct LAN (Host)';
  }
  if (local === 'srflx' || remote === 'srflx' || local === 'prflx' || remote === 'prflx') {
    return 'Direct P2P (STUN)';
  }
  return 'Direct P2P';
}

/**
 * Reads low-level WebRTC metrics from RTCPeerConnection.getStats()
 */
export async function extractPeerConnectionStats(pc, prevStats = null) {
  if (!pc || typeof pc.getStats !== 'function') return null;

  try {
    const statsReport = await pc.getStats();
    let activePair = null;
    let localCandidate = null;
    let remoteCandidate = null;

    let packetsReceived = 0;
    let packetsLost = 0;
    let jitterSec = 0;
    let audioBytesReceived = 0;
    let audioBytesSent = 0;

    let totalBytesSent = 0;
    let totalBytesReceived = 0;

    const candidateMap = new Map();

    statsReport.forEach((report) => {
      if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
        candidateMap.set(report.id, report);
      }

      if (report.type === 'candidate-pair') {
        if (report.state === 'succeeded' || report.nominated === true || report.selected) {
          activePair = report;
        } else if (!activePair && report.bytesReceived > 0) {
          activePair = report;
        }
      }

      if (report.type === 'inbound-rtp' && report.kind === 'audio') {
        packetsReceived += report.packetsReceived || 0;
        packetsLost += report.packetsLost || 0;
        if (report.jitter !== undefined) jitterSec = report.jitter;
        audioBytesReceived += report.bytesReceived || 0;
      }

      if (report.type === 'outbound-rtp' && report.kind === 'audio') {
        audioBytesSent += report.bytesSent || 0;
      }

      if (report.type === 'transport') {
        if (report.bytesSent) totalBytesSent = report.bytesSent;
        if (report.bytesReceived) totalBytesReceived = report.bytesReceived;
        if (report.selectedCandidatePairId && candidateMap.has(report.selectedCandidatePairId)) {
          activePair = candidateMap.get(report.selectedCandidatePairId);
        }
      }
    });

    if (activePair) {
      if (activePair.localCandidateId) localCandidate = candidateMap.get(activePair.localCandidateId);
      if (activePair.remoteCandidateId) remoteCandidate = candidateMap.get(activePair.remoteCandidateId);
      if (activePair.bytesSent) totalBytesSent = activePair.bytesSent;
      if (activePair.bytesReceived) totalBytesReceived = activePair.bytesReceived;
    }

    // Round trip time in ms
    let rttMs = null;
    if (activePair && typeof activePair.currentRoundTripTime === 'number') {
      rttMs = Math.round(activePair.currentRoundTripTime * 1000);
    }

    // Packet loss percentage
    const totalPackets = packetsReceived + packetsLost;
    const packetLossPercent = totalPackets > 0
      ? +((packetsLost / totalPackets) * 100).toFixed(1)
      : 0;

    const jitterMs = +(jitterSec * 1000).toFixed(1);

    // Throughput speed computation (KB/s)
    let downloadKBps = 0;
    let uploadKBps = 0;
    const now = Date.now();

    if (prevStats && prevStats.lastTimestamp) {
      const elapsedSec = Math.max(0.1, (now - prevStats.lastTimestamp) / 1000);
      const rxDelta = Math.max(0, totalBytesReceived - (prevStats.totalBytesReceived || 0));
      const txDelta = Math.max(0, totalBytesSent - (prevStats.totalBytesSent || 0));
      downloadKBps = +(rxDelta / 1024 / elapsedSec).toFixed(1);
      uploadKBps = +(txDelta / 1024 / elapsedSec).toFixed(1);
    }

    const localType = localCandidate?.candidateType || 'unknown';
    const remoteType = remoteCandidate?.candidateType || 'unknown';
    const connectionType = parseCandidateConnectionType(localType, remoteType);
    const protocol = (localCandidate?.protocol || activePair?.protocol || 'udp').toUpperCase();

    return {
      rttMs,
      connectionType,
      protocol,
      localCandidate: {
        type: localType,
        protocol: localCandidate?.protocol || protocol,
        address: localCandidate?.address || localCandidate?.ip || 'local',
        port: localCandidate?.port || 0
      },
      remoteCandidate: {
        type: remoteType,
        protocol: remoteCandidate?.protocol || protocol,
        address: remoteCandidate?.address || remoteCandidate?.ip || 'peer',
        port: remoteCandidate?.port || 0
      },
      packetLossPercent,
      jitterMs,
      downloadKBps,
      uploadKBps,
      totalBytesReceived,
      totalBytesSent,
      lastTimestamp: now
    };
  } catch (err) {
    return null;
  }
}

/**
 * Formats a comprehensive Diagnostic Markdown Report for clipboard copying
 */
export function generateDiagnosticReport({
  roomId = '',
  username = '',
  summary = {},
  peers = []
}) {
  const dateStr = new Date().toISOString();
  let md = `# 3RTC WebRTC P2P Network Diagnostic Report\n`;
  md += `- **Generated:** ${dateStr}\n`;
  md += `- **Room ID:** ${roomId || 'N/A'}\n`;
  md += `- **Local Client:** ${username || 'Anonymous'}\n`;
  md += `- **Connected Peers:** ${peers.length}\n`;
  md += `- **Overall Connection:** ${summary.overallConnectionType || 'Direct P2P'}\n`;
  md += `- **Average Latency:** ${summary.avgPingMs !== null ? `${summary.avgPingMs} ms` : 'N/A'}\n`;
  md += `- **Min / Max Latency:** ${summary.minPingMs ?? 0} ms / ${summary.maxPingMs ?? 0} ms\n`;
  md += `- **Total Throughput:** ↓ ${summary.totalDownloadKBps ?? 0} KB/s | ↑ ${summary.totalUploadKBps ?? 0} KB/s\n`;
  md += `- **Video Sync Drift:** ${summary.syncDriftMs !== undefined ? `±${summary.syncDriftMs} ms` : 'In Sync (<20ms)'}\n\n`;

  md += `## Peer Connections Breakdown\n`;
  if (peers.length === 0) {
    md += `_No active peer connections in current session._\n`;
  } else {
    peers.forEach((peer, i) => {
      md += `### Peer #${i + 1}: ${peer.username || peer.peerId}\n`;
      md += `- **Peer ID:** \`${peer.peerId}\`\n`;
      md += `- **Connection Mode:** ${peer.connectionType || 'Direct P2P'}\n`;
      md += `- **Protocol:** ${peer.protocol || 'UDP'}\n`;
      md += `- **RTT (Ping):** ${peer.pingMs ?? 'N/A'} ms (Avg: ${peer.avgPingMs ?? 'N/A'} ms)\n`;
      md += `- **Packet Loss:** ${peer.packetLossPercent ?? 0}%\n`;
      md += `- **Audio Jitter:** ${peer.jitterMs ?? 0} ms\n`;
      md += `- **Bandwidth:** ↓ ${peer.downloadKBps ?? 0} KB/s | ↑ ${peer.uploadKBps ?? 0} KB/s\n`;
      if (peer.candidatePair) {
        md += `- **Local Candidate:** ${peer.candidatePair.localType} (${peer.candidatePair.localIp || 'hidden'})\n`;
        md += `- **Remote Candidate:** ${peer.candidatePair.remoteType} (${peer.candidatePair.remoteIp || 'hidden'})\n`;
      }
      md += `\n`;
    });
  }

  return md;
}
