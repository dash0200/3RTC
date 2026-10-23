/**
 * One peer connection's numbers from RTCPeerConnection.getStats(), in a plain shape the Stream
 * doctor can compare over time and send to the other side. IP addresses are left out on purpose:
 * the report is meant to be copied and shared.
 */

export interface LinkSnapshot {
  at: number;
  iceState: string | null;
  connectionState: string | null;
  pair: {
    localType: string | null; // host | srflx | prflx | relay
    remoteType: string | null;
    protocol: string | null; // udp | tcp
    relayProtocol: string | null; // for relay: udp | tcp | tls
    networkType: string | null; // wifi | ethernet | cellular ... (not every browser says)
    localIsPrivate: boolean | null;
    localIsIpv6: boolean | null;
    currentRttMs: number | null;
    avgRttMs: number | null; // ICE checks over the whole connection
    availableOutgoingKbps: number | null;
    availableIncomingKbps: number | null;
    bytesSent: number;
    bytesReceived: number;
    packetsSent: number | null;
    packetsReceived: number | null;
    requestsSent: number | null;
    responsesReceived: number | null;
  } | null;
  candidatePairs: number;
  selectedPairChanges: number | null;
  audio: {
    inPacketsReceived: number;
    inPacketsLost: number;
    inJitterMs: number | null;
    outPacketsSent: number;
    outRetransmitted: number | null;
    remoteFractionLostPct: number | null; // what the other side reports losing of ours
    remotePacketsLost: number | null;
    remoteRttMs: number | null;
  } | null;
  dataChannels: { label: string; state: string | null; bytesSent: number; bytesReceived: number; messagesSent: number; messagesReceived: number }[];
}

type Stat = Record<string, unknown> & { id: string; type: string };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function isPrivateAddress(addr: string): boolean {
  return (
    /^10\./.test(addr) ||
    /^192\.168\./.test(addr) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(addr) ||
    /^(fc|fd)/i.test(addr) ||
    /^fe80/i.test(addr) ||
    /\.local$/i.test(addr)
  );
}

export async function linkSnapshot(pc: RTCPeerConnection | null | undefined): Promise<LinkSnapshot | null> {
  if (!pc || typeof pc.getStats !== 'function') return null;
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }
  const all: Stat[] = [];
  report.forEach((s: unknown) => all.push(s as Stat));
  const byId = new Map(all.map((s) => [s.id, s]));

  // The pair in use: the transport says which; otherwise the nominated, succeeded one
  const transport = all.find((s) => s.type === 'transport');
  let pair = transport?.selectedCandidatePairId ? byId.get(String(transport.selectedCandidatePairId)) : undefined;
  if (!pair) pair = all.find((s) => s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded')));
  const local = pair ? byId.get(String(pair.localCandidateId)) : undefined;
  const remote = pair ? byId.get(String(pair.remoteCandidateId)) : undefined;
  const localAddr = String(local?.address ?? local?.ip ?? '');

  const inbound = all.filter((s) => s.type === 'inbound-rtp' && s.kind === 'audio');
  const outbound = all.filter((s) => s.type === 'outbound-rtp' && s.kind === 'audio');
  const remoteIn = all.filter((s) => s.type === 'remote-inbound-rtp' && s.kind === 'audio');
  const sum = (list: Stat[], k: string): number => list.reduce((n, s) => n + (num(s[k]) ?? 0), 0);

  const responses = num(pair?.responsesReceived);
  const totalRtt = num(pair?.totalRoundTripTime);
  return {
    at: Date.now(),
    iceState: pc.iceConnectionState || null,
    connectionState: pc.connectionState || null,
    pair: pair
      ? {
          localType: str(local?.candidateType),
          remoteType: str(remote?.candidateType),
          protocol: str(local?.protocol),
          relayProtocol: str(local?.relayProtocol),
          networkType: str(local?.networkType),
          localIsPrivate: localAddr ? isPrivateAddress(localAddr) : null,
          localIsIpv6: localAddr ? localAddr.includes(':') : null,
          currentRttMs: num(pair.currentRoundTripTime) !== null ? Math.round(num(pair.currentRoundTripTime)! * 1000) : null,
          avgRttMs: responses && totalRtt !== null ? Math.round((totalRtt / responses) * 1000) : null,
          availableOutgoingKbps: num(pair.availableOutgoingBitrate) !== null ? Math.round(num(pair.availableOutgoingBitrate)! / 1000) : null,
          availableIncomingKbps: num(pair.availableIncomingBitrate) !== null ? Math.round(num(pair.availableIncomingBitrate)! / 1000) : null,
          bytesSent: num(pair.bytesSent) ?? 0,
          bytesReceived: num(pair.bytesReceived) ?? 0,
          packetsSent: num(pair.packetsSent),
          packetsReceived: num(pair.packetsReceived),
          requestsSent: num(pair.requestsSent),
          responsesReceived: responses
        }
      : null,
    candidatePairs: all.filter((s) => s.type === 'candidate-pair').length,
    selectedPairChanges: num(transport?.selectedCandidatePairChanges),
    audio:
      inbound.length || outbound.length
        ? {
            inPacketsReceived: sum(inbound, 'packetsReceived'),
            inPacketsLost: sum(inbound, 'packetsLost'),
            inJitterMs: inbound.length ? Math.round((num(inbound[0].jitter) ?? 0) * 1000) : null,
            outPacketsSent: sum(outbound, 'packetsSent'),
            outRetransmitted: outbound.length ? sum(outbound, 'retransmittedPacketsSent') : null,
            remoteFractionLostPct: remoteIn.length && num(remoteIn[0].fractionLost) !== null ? Math.round(num(remoteIn[0].fractionLost)! * 1000) / 10 : null,
            remotePacketsLost: remoteIn.length ? sum(remoteIn, 'packetsLost') : null,
            remoteRttMs: remoteIn.length && num(remoteIn[0].roundTripTime) !== null ? Math.round(num(remoteIn[0].roundTripTime)! * 1000) : null
          }
        : null,
    dataChannels: all
      .filter((s) => s.type === 'data-channel')
      .map((s) => ({
        label: String(s.label ?? ''),
        state: str(s.state),
        bytesSent: num(s.bytesSent) ?? 0,
        bytesReceived: num(s.bytesReceived) ?? 0,
        messagesSent: num(s.messagesSent) ?? 0,
        messagesReceived: num(s.messagesReceived) ?? 0
      }))
  };
}

/** Audio packet loss between two snapshots, both ways, in % (null when no audio flowed) */
export function audioLossBetween(
  a: LinkSnapshot | null,
  b: LinkSnapshot | null
): { inPct: number | null; inPackets: number } {
  if (!a?.audio || !b?.audio) return { inPct: null, inPackets: 0 };
  const got = b.audio.inPacketsReceived - a.audio.inPacketsReceived;
  const lost = b.audio.inPacketsLost - a.audio.inPacketsLost;
  if (got + lost < 20) return { inPct: null, inPackets: got + lost };
  return { inPct: Math.round((Math.max(0, lost) / (got + Math.max(0, lost))) * 1000) / 10, inPackets: got + lost };
}

export interface DeviceInfo {
  browser: string;
  platform: string;
  cores: number | null;
  memoryGb: number | null;
  phoneLike: boolean;
  connection: { type: string | null; effectiveType: string | null; downlinkMbps: number | null; rttMs: number | null; saveData: boolean | null } | null;
  hidden: boolean;
}

export function deviceInfo(): DeviceInfo {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & {
    deviceMemory?: number;
    connection?: { type?: string; effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean };
  };
  const ua = String(nav.userAgent || '');
  const brand = nav.userAgentData?.brands?.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand));
  const browser = brand
    ? `${brand.brand} ${brand.version}`
    : (/(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/.exec(ua) || []).slice(1, 3).join(' ') || 'unknown';
  let phoneLike = false;
  try {
    phoneLike = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    /* no window */
  }
  const c = nav.connection;
  return {
    browser,
    platform: nav.userAgentData?.platform || (/(Android|iPhone|iPad|Mac OS X|Windows|Linux)/.exec(ua)?.[1] ?? 'unknown'),
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    phoneLike,
    connection: c
      ? {
          type: c.type ?? null,
          effectiveType: c.effectiveType ?? null,
          downlinkMbps: typeof c.downlink === 'number' ? c.downlink : null,
          rttMs: typeof c.rtt === 'number' ? c.rtt : null,
          saveData: typeof c.saveData === 'boolean' ? c.saveData : null
        }
      : null,
    hidden: typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false
  };
}
