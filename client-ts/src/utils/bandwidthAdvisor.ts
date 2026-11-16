/**
 * Bandwidth Advisor:
 * Estimates average download and upload bandwidth, and recommends the optimal
 * peer capacity and network topology (Mesh vs Hub/HStar).
 */
import type { RoomTopologyKind } from '../types/protocol';

export interface BandwidthEstimation {
  avgDownloadMbps: number;
  avgUploadMbps: number;
  measuredSamples: number;
  recommendedPeers: number;
  recommendedTopology: RoomTopologyKind;
  suggestionText: string;
}

/**
 * Calculates average network speeds and recommended peer capacity.
 */
export function evaluateBandwidthAdvisor(params: {
  totalDownloadKBps: number;
  totalUploadKBps: number;
  activePeerCount?: number;
  currentTopology?: RoomTopologyKind;
  isHost?: boolean;
  downlinkEstimateMbps?: number | null;
  history?: { downKBps: number[]; upKBps: number[] };
}): BandwidthEstimation {
  const {
    totalDownloadKBps,
    totalUploadKBps,
    currentTopology = 'mesh',
    downlinkEstimateMbps = null,
    history
  } = params;

  // 1. Calculate average throughput from history or instantaneous rate
  const downSamples = history?.downKBps || [];
  const upSamples = history?.upKBps || [];

  const avgDownKBps = downSamples.length > 0
    ? downSamples.reduce((a, b) => a + b, 0) / downSamples.length
    : totalDownloadKBps;

  const avgUpKBps = upSamples.length > 0
    ? upSamples.reduce((a, b) => a + b, 0) / upSamples.length
    : totalUploadKBps;

  const measuredDownMbps = (avgDownKBps * 8) / 1024;
  const measuredUpMbps = (avgUpKBps * 8) / 1024;

  // Check browser NetworkInformation downlink if available
  let effectiveDownlink = downlinkEstimateMbps;
  if (!effectiveDownlink && typeof navigator !== 'undefined' && 'connection' in navigator) {
    const conn = (navigator as unknown as { connection?: { downlink?: number } }).connection;
    if (conn && typeof conn.downlink === 'number' && conn.downlink > 0) {
      effectiveDownlink = conn.downlink;
    }
  }

  // If idle (e.g. before streaming large files), combine active rate with downlink baseline
  let estimatedDownMbps = Math.max(measuredDownMbps, effectiveDownlink || 15);
  let estimatedUpMbps = measuredUpMbps > 0.5
    ? Math.max(measuredUpMbps, (effectiveDownlink || 15) * 0.35)
    : (effectiveDownlink ? effectiveDownlink * 0.4 : 10);

  estimatedDownMbps = Math.round(estimatedDownMbps * 10) / 10;
  estimatedUpMbps = Math.round(estimatedUpMbps * 10) / 10;

  // 2. Recommend topology
  const recommendedTopology: RoomTopologyKind = estimatedUpMbps >= 8 ? 'hub' : 'mesh';

  // 3. Recommended peer count
  let recommendedPeers = 4;
  if (currentTopology === 'hub') {
    if (estimatedUpMbps < 8) {
      recommendedPeers = 6;
    } else if (estimatedUpMbps < 15) {
      recommendedPeers = 8;
    } else if (estimatedUpMbps < 25) {
      recommendedPeers = 12;
    } else if (estimatedUpMbps < 45) {
      recommendedPeers = 18;
    } else if (estimatedUpMbps < 80) {
      recommendedPeers = 25;
    } else {
      recommendedPeers = Math.min(100, Math.floor(estimatedUpMbps / 2.2) + 2);
    }
  } else {
    // Full Mesh mode: capped at 4-6 to prevent N*(N-1)/2 quadratic connection explosion
    recommendedPeers = estimatedUpMbps >= 12 ? 6 : 4;
  }

  // 4. Construct suggestion message
  let suggestionText = '';
  if (currentTopology === 'hub') {
    suggestionText = `Based on your ~${estimatedUpMbps} Mbps upload & ~${estimatedDownMbps} Mbps download, ~${recommendedPeers} peers can join smoothly in Hub mode.`;
  } else {
    suggestionText = `Mesh mode is best for ~${recommendedPeers} peers. For larger groups, switch to Hub (HStar) mode.`;
  }

  return {
    avgDownloadMbps: estimatedDownMbps,
    avgUploadMbps: estimatedUpMbps,
    measuredSamples: Math.max(downSamples.length, upSamples.length),
    recommendedPeers,
    recommendedTopology,
    suggestionText
  };
}
