/**
 * Why a peer connection never came up, worked out from what both sides offered (their ICE
 * candidates, exchanged over signaling) and what the browser tried (candidate-pair stats).
 *
 * What the candidates tell us about a network:
 *   no "srflx" candidate         the STUN check got no answer: UDP is blocked there
 *   one public port per socket   the router keeps the same public port for every destination:
 *                                a normal NAT, direct connections usually work
 *   several public ports         the router picks a new public port per destination (one per STUN
 *                                server): a strict ("symmetric") NAT. Two of these can't connect
 *                                directly; a TURN relay is needed
 * The last one is a strong hint, not proof (two network adapters behind one router look the same).
 * (pure, for tests)
 */

export interface ParsedCandidate {
  protocol: string; // 'udp' | 'tcp'
  address: string;
  port: number;
  type: string; // 'host' | 'srflx' | 'prflx' | 'relay'
  relatedAddress: string;
  relatedPort: number;
}

/** Parses an ICE candidate line ("candidate:1 1 udp 2122260223 1.2.3.4 5000 typ srflx raddr ..."). */
export function parseCandidate(line?: string | null): ParsedCandidate | null {
  if (!line) return null;
  const parts = line.replace(/^a=/, '').trim().split(/\s+/);
  if (parts.length < 8 || parts[6] !== 'typ') return null;
  const extra = new Map<string, string>();
  for (let i = 8; i + 1 < parts.length; i += 2) extra.set(parts[i], parts[i + 1]);
  return {
    protocol: parts[2].toLowerCase(),
    address: parts[4],
    port: Number(parts[5]) || 0,
    type: parts[7],
    relatedAddress: extra.get('raddr') || '',
    relatedPort: Number(extra.get('rport')) || 0
  };
}

export type NatMapping = 'blocked' | 'normal' | 'strict' | 'unknown';

export interface SideSummary {
  candidates: number;
  host: number;
  srflx: number;
  relay: number;
  publicAddresses: string[];
  mapping: NatMapping;
}

export function summarizeSide(lines: string[] = []): SideSummary {
  const cands = lines.map(parseCandidate).filter((c): c is ParsedCandidate => c !== null);
  const srflx = cands.filter((c) => c.type === 'srflx');
  const relay = cands.filter((c) => c.type === 'relay').length;
  // Group the public (srflx) ports by the local socket they came from. Browsers often hide the
  // local socket (raddr 0.0.0.0), then group by public address alone.
  const ports = new Map<string, Set<number>>();
  for (const c of srflx) {
    if (c.protocol !== 'udp') continue;
    const base = c.relatedPort && c.relatedAddress !== '0.0.0.0' ? `${c.relatedAddress}:${c.relatedPort}` : '';
    const key = `${c.address}|${base}`;
    (ports.get(key) ?? ports.set(key, new Set()).get(key)!).add(c.port);
  }
  let mapping: NatMapping = 'unknown';
  if (cands.length > 0 && srflx.length === 0 && relay === 0) mapping = 'blocked';
  else if ([...ports.values()].some((p) => p.size > 1)) mapping = 'strict';
  else if (ports.size > 0) mapping = 'normal';
  return {
    candidates: cands.length,
    host: cands.filter((c) => c.type === 'host').length,
    srflx: srflx.length,
    relay,
    publicAddresses: [...new Set(srflx.map((c) => c.address))],
    mapping
  };
}

export interface PairStats {
  pairs: number;
  succeeded: number;
  failed: number;
  requestsSent: number;
  responsesReceived: number;
}

/** Candidate-pair totals from an RTCStatsReport (or anything iterable like one). */
export function summarizePairs(report: Iterable<unknown> | null | undefined): PairStats | null {
  if (!report) return null;
  const out: PairStats = { pairs: 0, succeeded: 0, failed: 0, requestsSent: 0, responsesReceived: 0 };
  const items: Iterable<unknown> =
    typeof (report as { values?: unknown }).values === 'function'
      ? (report as unknown as { values: () => Iterable<unknown> }).values()
      : report;
  for (const raw of items) {
    const s = raw as { type?: string; state?: string; requestsSent?: number; responsesReceived?: number };
    if (s?.type !== 'candidate-pair') continue;
    out.pairs++;
    if (s.state === 'succeeded') out.succeeded++;
    if (s.state === 'failed') out.failed++;
    out.requestsSent += s.requestsSent || 0;
    out.responsesReceived += s.responsesReceived || 0;
  }
  return out;
}

/** One line per candidate pair the browser tried: "srflx/udp -> host/udp failed, 5 sent, 0 answered". */
export function describePairs(report: Iterable<unknown> | null | undefined): string[] {
  if (!report) return [];
  const all = [
    ...(typeof (report as unknown as { values?: unknown }).values === 'function'
      ? (report as unknown as { values: () => Iterable<unknown> }).values()
      : report)
  ] as Array<Record<string, unknown>>;
  const byId = new Map(all.map((s) => [String(s?.id), s]));
  const side = (id: unknown) => {
    const c = byId.get(String(id));
    return c ? `${c.candidateType ?? '?'}/${c.protocol ?? '?'}` : '?';
  };
  return all
    .filter((s) => s?.type === 'candidate-pair')
    .map(
      (s) =>
        `${side(s.localCandidateId)} -> ${side(s.remoteCandidateId)} ${s.state ?? '?'}` +
        `${s.nominated ? ' nominated' : ''}, ${Number(s.requestsSent) || 0} sent, ` +
        `${Number(s.responsesReceived) || 0} answered`
    );
}

/** Hides the last part of an IP address (1.2.3.4 -> 1.2.3.x) and drops ICE passwords and ufrags. */
export function maskCandidate(line: string): string {
  return line
    .replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g, '$1.x')
    .replace(/\b([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2})(?::[0-9a-f]{0,4}){2,}\b/gi, '$1:…')
    .replace(/\s(ufrag|pwd)\s\S+/g, '');
}

/** The full log to copy and share: everything the diagnosis used, addresses partly hidden. */
export function formatIceReport(
  d: IceDiagnosis,
  info: {
    peerId?: string;
    time?: Date;
    app?: string;
    userAgent?: string;
    iceServers?: string[];
    states?: Record<string, string>;
    pairLines?: string[];
    localCandidates?: string[];
    remoteCandidates?: string[];
  } = {}
): string {
  const lines = [
    '=== 3RTC connection failure log ===',
    `Time: ${(info.time ?? new Date()).toISOString()}`,
    ...(info.app ? [`App: ${info.app}`] : []),
    ...(info.userAgent ? [`Browser: ${info.userAgent}`] : []),
    ...(info.peerId ? [`Peer: ${info.peerId}`] : []),
    '',
    `Cause: ${d.cause}`,
    `Why: ${d.summary}`,
    ...d.details,
    '',
    `You (NAT ${d.local.mapping}): ${d.local.host} host, ${d.local.srflx} srflx, ${d.local.relay} relay`,
    `Them (NAT ${d.remote.mapping}): ${d.remote.host} host, ${d.remote.srflx} srflx, ${d.remote.relay} relay`
  ];
  if (info.states) {
    lines.push(`States: ${Object.entries(info.states).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (info.iceServers?.length) lines.push(`ICE servers: ${info.iceServers.join(', ')}`);
  const section = (title: string, items?: string[]) => {
    lines.push('', `--- ${title} (${items?.length ?? 0}) ---`, ...(items ?? []));
  };
  section('Your candidates', info.localCandidates?.map(maskCandidate));
  section('Their candidates', info.remoteCandidates?.map(maskCandidate));
  section('Paths tried', info.pairLines);
  return lines.join('\n');
}

export type FailureCause =
  | 'no-local-candidates'
  | 'no-remote-candidates'
  | 'both-udp-blocked'
  | 'local-udp-blocked'
  | 'remote-udp-blocked'
  | 'both-strict-nat'
  | 'local-strict-nat'
  | 'remote-strict-nat'
  | 'path-ok-setup-failed'
  | 'filtered';

export interface IceDiagnosis {
  cause: FailureCause;
  /** One line for the room log. */
  summary: string;
  /** Details for the room log (no IP addresses). */
  details: string[];
  local: SideSummary;
  remote: SideSummary;
  pairs: PairStats | null;
}

const RELAY_FIX = 'A TURN relay server fixes this; until then, one of you can switch to another network.';

function describe(side: SideSummary): string {
  if (side.candidates === 0) return 'no connection addresses';
  const parts = [`${side.candidates} address${side.candidates === 1 ? '' : 'es'}`];
  if (side.relay) parts.push('relay available');
  const nat: Record<NatMapping, string> = {
    blocked: 'no public address found (UDP blocked)',
    strict: 'public port changes per destination (strict NAT)',
    normal: 'public port stays the same (normal NAT)',
    unknown: 'NAT type unknown'
  };
  parts.push(nat[side.mapping]);
  return parts.join(', ');
}

export function diagnoseIce(input: {
  localCandidates?: string[];
  remoteCandidates?: string[];
  pairs?: PairStats | null;
  peerName?: string;
}): IceDiagnosis {
  const local = summarizeSide(input.localCandidates);
  const remote = summarizeSide(input.remoteCandidates);
  const pairs = input.pairs ?? null;
  const them = input.peerName || 'them';
  const theirs = input.peerName ? `${input.peerName}'s` : 'their';

  let cause: FailureCause;
  let summary: string;
  if (local.candidates === 0) {
    cause = 'no-local-candidates';
    summary = 'Your browser gave no connection addresses (a privacy setting, extension or policy may block WebRTC).';
  } else if (remote.candidates === 0) {
    cause = 'no-remote-candidates';
    summary = `No connection addresses arrived from ${them}: their browser blocks WebRTC, or the room server lost them.`;
  } else if (pairs && pairs.succeeded > 0) {
    cause = 'path-ok-setup-failed';
    summary = `A network path to ${them} was found, but the secure connection on top of it failed to start.`;
  } else if (local.mapping === 'blocked' && remote.mapping === 'blocked') {
    cause = 'both-udp-blocked';
    summary = `Both your network and ${theirs} block direct-connection traffic (UDP). ${RELAY_FIX}`;
  } else if (local.mapping === 'blocked') {
    cause = 'local-udp-blocked';
    summary = `Your network blocks direct-connection traffic (UDP): a firewall, VPN, or work/school network. ${RELAY_FIX}`;
  } else if (remote.mapping === 'blocked') {
    cause = 'remote-udp-blocked';
    summary = `${input.peerName ? `${input.peerName}'s` : 'Their'} network blocks direct-connection traffic (UDP): a firewall, VPN, or work/school network. ${RELAY_FIX}`;
  } else if (local.mapping === 'strict' && remote.mapping === 'strict') {
    cause = 'both-strict-nat';
    summary = `You and ${them} are both behind a strict NAT (common with mobile data and some broadband ISPs); two of these can't connect directly. ${RELAY_FIX}`;
  } else if (local.mapping === 'strict') {
    cause = 'local-strict-nat';
    summary = `Your network uses a strict NAT and ${theirs} doesn't let unexpected traffic in, so no direct path opens. ${RELAY_FIX}`;
  } else if (remote.mapping === 'strict') {
    cause = 'remote-strict-nat';
    summary = `${input.peerName ? `${input.peerName}'s` : 'Their'} network uses a strict NAT and yours doesn't let unexpected traffic in, so no direct path opens. ${RELAY_FIX}`;
  } else {
    cause = 'filtered';
    summary = `Both networks look normal, but no test packet got through: a firewall, antivirus or VPN on one side is likely dropping them.`;
  }

  const details = [`You: ${describe(local)}.`, `${input.peerName || 'Them'}: ${describe(remote)}.`];
  if (pairs) {
    details.push(
      `Connection checks: ${pairs.pairs} path${pairs.pairs === 1 ? '' : 's'} tried, ${pairs.succeeded} worked, ` +
        `${pairs.requestsSent} test packets sent, ${pairs.responsesReceived} answered.`
    );
  }
  return { cause, summary, details, local, remote, pairs };
}
