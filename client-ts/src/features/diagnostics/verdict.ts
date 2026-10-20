/**
 * Turns a stream test (./speedTest.ts) into plain findings: what limits local-video streaming
 * between two people, and what would fix it. Pure: unit tested in tests/unit/diagnostics.test.ts.
 */
import type { PhaseResult, StreamTestReport } from './speedTest';
import type { LiveSnapshot } from './telemetry';

export type Severity = 'bad' | 'warn' | 'info' | 'ok';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  fix?: string;
}

export interface Verdict {
  headline: string;
  severity: Severity;
  numbers: {
    pingIdleMs: number | null;
    /** control-channel ping while data flowed (includes waiting behind the data) */
    pingLoadedMs: number | null;
    /** the network's own round trip under load (ICE checks, voice RTCP) */
    networkRttMaxMs: number | null;
    downNowKbps: number | null;
    downBestKbps: number | null;
    upNowKbps: number | null;
    upBestKbps: number | null;
    /** the local video's average bitrate, when one is playing */
    videoKbps: number | null;
    /** which way the video flows between the two of you */
    videoDirection: 'download' | 'upload' | null;
    /** what 192 KB in flight allows at this ping */
    bufferCeilingKbps: number | null;
  };
  findings: Finding[];
}

export const CURRENT_BUFFER = 192 * 1024;
const ORDER: Record<Severity, number> = { bad: 0, warn: 1, info: 2, ok: 3 };

export const mbps = (kbps: number | null | undefined): string =>
  kbps === null || kbps === undefined ? '–' : kbps >= 10000 ? `${Math.round(kbps / 1000)} Mbps` : `${(kbps / 1000).toFixed(1)} Mbps`;

export const size = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB` : `${Math.round(bytes / 1024)} KB`;

const rateOf = (p: PhaseResult | undefined): number | null => {
  if (!p?.meter || !p.meter.frames) return null;
  return Math.max(p.meter.steadyKbps, p.meter.rateKbps);
};

/** kbps that `bytes` in flight allow at `rttMs`: one buffer per round trip */
export const ceilingKbps = (bytes: number, rttMs: number): number => Math.round((bytes * 8) / Math.max(1, rttMs));

function videoNeed(r: StreamTestReport): { kbps: number | null; direction: 'download' | 'upload' | null } {
  const lw = r.local.live?.watching;
  const rs = r.remote.live?.sharing;
  const ls = r.local.live?.sharing;
  const rw = r.remote.live?.watching;
  // They share, I watch: the video comes down to me
  if ((lw && lw.ownerId === r.peer.id) || (rs && rs.viewers + rs.relays > 0 && lw)) {
    return { kbps: lw?.bitrateKbps ?? rs?.bitrateKbps ?? null, direction: 'download' };
  }
  if (rs && rs.bitrateKbps && rs.viewers > 0) return { kbps: rs.bitrateKbps, direction: 'download' };
  // I share, they watch: it goes up from me
  if ((ls && ls.viewers + ls.relays > 0) || rw) {
    return { kbps: rw?.bitrateKbps ?? ls?.bitrateKbps ?? null, direction: 'upload' };
  }
  if (lw) return { kbps: lw.bitrateKbps, direction: 'download' };
  return { kbps: null, direction: null };
}

function liveFindings(live: LiveSnapshot | null, who: string, needKbps: number | null, out: Finding[]): void {
  if (!live) return;
  const o = live.overall;
  if (live.sharing.viewers + live.sharing.relays > 0 || o.sendKbps > 100) {
    if (o.readMsAvg !== null && o.readMsAvg > 40 && o.reads >= 5) {
      out.push({
        id: `disk-${who}`,
        severity: o.readMsAvg > 120 ? 'bad' : 'warn',
        title: `Reading the video file is slow on ${who === 'you' ? 'your device' : `${who}'s device`}`,
        detail: `Each 256 KB piece takes about ${o.readMsAvg} ms to read from the file. That's usually a slow USB stick, a network or cloud drive, or a busy phone.`,
        fix: 'Copy the video to the device itself before sharing.'
      });
    }
    if (o.drainWaitPct >= 50 && o.sendKbps > 0) {
      out.push({
        id: `drain-${who}`,
        severity: 'warn',
        title: `While streaming, ${who === 'you' ? 'your app' : `${who}'s app`} waited on its send buffer ${o.drainWaitPct}% of the time`,
        detail: `It sent at ${mbps(o.sendKbps)} on average over the last ${o.seconds} s. A sender that is mostly waiting means data leaves slower than it could: either the connection is full, or the buffer is too small for the ping.`
      });
    }
  }
  if (live.watching) {
    if (live.watching.relayed) {
      out.push({
        id: `relayed-${who}`,
        severity: 'info',
        title: `${who === 'you' ? 'You get' : `${who} gets`} the video through another viewer`,
        detail: 'In bigger rooms some viewers are fed by another viewer instead of the owner. Each extra hop adds its own ping and upload limit.'
      });
    }
    if (o.stalls > 0) {
      const receivingFastEnough = needKbps !== null && o.recvKbps >= needKbps;
      out.push({
        id: `stalls-${who}`,
        severity: o.stalls >= 3 || o.stallMs > 5000 ? 'bad' : 'warn',
        title: `The video stopped to load ${o.stalls} time${o.stalls === 1 ? '' : 's'} (${(o.stallMs / 1000).toFixed(1)} s in all) for ${who === 'you' ? 'you' : who}`,
        detail: receivingFastEnough
          ? `Data still arrived at ${mbps(o.recvKbps)}, more than the video needs. The player is waiting for something else (seeking to parts not loaded yet, or the browser's playback pipeline).`
          : `Data arrived at ${mbps(o.recvKbps)} on average${needKbps ? ` and the video needs about ${mbps(needKbps)}` : ''}. The stream can't keep up.`
      });
    }
    if (o.blockLatencyMs.p95 !== null && o.blockLatencyMs.samples >= 5 && o.blockLatencyMs.p95 > 3000) {
      out.push({
        id: `latency-${who}`,
        severity: 'warn',
        title: `Pieces of the video take long to arrive for ${who === 'you' ? 'you' : who}`,
        detail: `From asking to having a 256 KB piece: typically ${o.blockLatencyMs.p50} ms, slowest 5% ${o.blockLatencyMs.p95} ms. ${o.reasks} piece${o.reasks === 1 ? ' was' : 's were'} asked for again.`
      });
    }
  }
}

export function analyze(r: StreamTestReport): Verdict {
  const findings: Finding[] = [];
  const peer = r.peer.name || 'the other person';
  const rtt = r.idlePing.p50 ?? r.local.linkStart?.pair?.currentRttMs ?? null;

  const downs = r.phases.filter((p) => p.direction === 'download' && !p.error && !p.warmup);
  const ups = r.phases.filter((p) => p.direction === 'upload' && !p.error && !p.warmup);
  // today's setting runs twice (before and after the bigger ones): its better run counts
  const at = (list: PhaseResult[], high: number) =>
    list.filter((p) => p.high === high).reduce<PhaseResult | undefined>((b, p) => ((rateOf(p) ?? 0) > (rateOf(b) ?? -1) ? p : b), undefined);
  const best = (list: PhaseResult[]) => list.reduce<PhaseResult | undefined>((b, p) => ((rateOf(p) ?? 0) > (rateOf(b) ?? 0) ? p : b), undefined);
  const downNow = rateOf(at(downs, CURRENT_BUFFER));
  const upNow = rateOf(at(ups, CURRENT_BUFFER));
  const downBestPhase = best(downs);
  const upBestPhase = best(ups);
  const downBest = rateOf(downBestPhase);
  const upBest = rateOf(upBestPhase);
  const ceiling = rtt ? ceilingKbps(CURRENT_BUFFER, rtt) : null;
  const need = videoNeed(r);
  const needKbps = need.kbps ? Math.round(need.kbps * 1.25) : null; // headroom for seeking and starts

  // ---- The path ---------------------------------------------------------------------------
  const pair = r.local.linkStart?.pair;
  if (pair) {
    if (pair.localType === 'relay' || pair.remoteType === 'relay') {
      findings.push({
        id: 'relay',
        severity: 'bad',
        title: 'The connection goes through a relay server',
        detail: `A relay (TURN${pair.relayProtocol ? ` over ${pair.relayProtocol.toUpperCase()}` : ''}) adds a detour and caps the speed at what the relay allows.`,
        fix: 'A direct connection is usually possible on home networks; strict office, school or mobile networks may block it.'
      });
    }
    if (pair.protocol === 'tcp') {
      findings.push({
        id: 'tcp',
        severity: 'bad',
        title: 'The connection runs over TCP instead of UDP',
        detail: 'One lost packet then holds up everything after it, which hurts most when the ping is high. A firewall is probably blocking UDP.'
      });
    }
    if (pair.localType === 'host' && pair.remoteType === 'host') {
      findings.push({ id: 'lan', severity: 'info', title: 'You are on the same local network', detail: 'Traffic stays inside your network, so the internet connection isn’t involved.' });
    }
    const changes = r.local.linkEnd?.selectedPairChanges ?? r.local.linkStart?.selectedPairChanges ?? null;
    if (changes !== null && changes > 2) {
      findings.push({
        id: 'path-changes',
        severity: 'warn',
        title: `The connection switched paths ${changes - 1} times`,
        detail: 'That happens when a network drops or changes (Wi-Fi to mobile data, a router restart). Each switch pauses the data for a moment.'
      });
    }
  }

  // ---- Ping -----------------------------------------------------------------------------------
  const ip = r.idlePing;
  if (rtt !== null) {
    if (ip.p95 !== null && ip.p50 !== null && (ip.p95 - ip.p50 > Math.max(60, ip.p50 * 0.5) || ip.lost > 1)) {
      findings.push({
        id: 'unsteady-ping',
        severity: 'warn',
        title: `The ping is unsteady: ${ip.min}–${ip.max} ms with the line idle`,
        detail: `Typical ${ip.p50} ms, slowest 5% ${ip.p95} ms${ip.lost ? `, ${ip.lost} ping${ip.lost === 1 ? '' : 's'} got no answer` : ''}. This is common on busy Wi-Fi, far from the router, or on mobile data.`,
        fix: 'Try a cable or sitting closer to the router, on both sides.'
      });
    }
    if (rtt >= 120) {
      findings.push({
        id: 'high-ping',
        severity: 'info',
        title: `Ping is high: about ${rtt} ms`,
        detail: `Every start and every seek waits at least one round trip (${rtt} ms) before data arrives. On its own, ping doesn't limit speed — but anything that keeps a fixed amount of data in flight does (see below).`
      });
    }
  }

  // ---- The send buffer vs the ping ------------------------------------------------------------
  const bufferFinding = (dir: 'download' | 'upload', now: number | null, top: number | null, topPhase: PhaseResult | undefined): void => {
    if (now === null || top === null || ceiling === null) return;
    const from = dir === 'download' ? `${peer} → you` : `you → ${peer}`;
    // Blame the buffer only when today's speed sits right at what 192 KB per round trip allows
    // and bigger buffers clearly beat it
    if (top >= now * 1.35 && now >= ceiling * 0.6 && now <= ceiling * 1.3) {
      findings.push({
        id: `buffer-${dir}`,
        severity: 'bad',
        title: `The app's 192 KB send buffer limits the speed (${from})`,
        detail: `At ${rtt} ms ping, keeping at most 192 KB in flight allows about ${mbps(ceiling)}. Measured ${mbps(now)} with it, and ${mbps(top)} with a ${size(topPhase?.high ?? 0)} buffer.`,
        fix: 'Size the video send buffer from the measured ping (about ping × the speed you want).'
      });
    } else if (top < now * 1.15) {
      findings.push({
        id: `buffer-ok-${dir}`,
        severity: 'ok',
        title: `The send buffer isn't the limit (${from})`,
        detail: `A bigger buffer didn't help: ${mbps(now)} with 192 KB, ${mbps(top)} at best. Something else holds the speed back.`
      });
    }
  };
  bufferFinding('download', downNow, downBest, downBestPhase);
  bufferFinding('upload', upNow, upBest, upBestPhase);

  // ---- The network filling up vs the app's own queue ------------------------------------------
  const netFull: Record<'download' | 'upload', boolean> = { download: false, upload: false };
  const loadFinding = (dir: 'download' | 'upload', list: PhaseResult[], top: number | null): void => {
    if (!list.length || top === null || rtt === null) return;
    const flow = dir === 'download' ? `${peer} → you` : `you → ${peer}`;
    // Round trips measured outside the data channel (ICE checks, voice): these only grow when
    // queues in the network fill up
    const net = list.flatMap((p) => p.networkRtt || []);
    const netMax = net.length ? Math.max(...net) : null;
    if (netMax !== null && netMax - rtt > Math.max(80, rtt * 0.6)) {
      netFull[dir] = true;
      const who = dir === 'download' ? `${peer}'s upload or your download` : `your upload or ${peer}'s download`;
      findings.push({
        id: `full-${dir}`,
        severity: 'warn',
        title: `The network is full at about ${mbps(top)} (${flow})`,
        detail: `The connection's own round-trip checks went from ${rtt} ms up to ${netMax} ms while data flowed: queues in the network filled up, so this is the most the line carries. The limit is most likely ${who}; home connections often upload far slower than they download.`
      });
    }
    // Control messages (play, pause, chat) share the transport with the video data
    const slowest = Math.max(...list.map((p) => p.loadedPing.p95 ?? 0));
    const typical = Math.max(...list.map((p) => p.loadedPing.p50 ?? 0));
    if (slowest - rtt > Math.max(150, rtt)) {
      findings.push({
        id: `control-delay-${dir}`,
        severity: slowest > 1000 ? 'bad' : 'warn',
        title: `Play/pause and chat messages wait up to ${slowest} ms while video data flows (${flow})`,
        detail: `Normally ${rtt} ms; ${typical} ms typical and ${slowest} ms at worst during the test. They travel on the same connection as the video data and queue behind it${netFull[dir] ? ' and behind the full network' : ''}.`
      });
    }
  };
  loadFinding('download', downs, downBest);
  loadFinding('upload', ups, upBest);

  // ---- Freezes: the data channel stopped for seconds (warm-ups count: that's real traffic) -----
  {
    const all = r.phases.flatMap((p) => p.loadedPing.samples.map((x) => ({ ...x, dir: p.direction })));
    const worst = all.reduce<{ rttMs: number | null; dir: string } | null>((w, x) => ((x.rttMs ?? 0) > (w?.rttMs ?? 0) ? x : w), null);
    const silent = r.phases.filter((p) => p.error === 'no answer from the other side').length;
    if ((worst?.rttMs ?? 0) > 3000 || silent) {
      findings.push({
        id: 'freeze',
        severity: 'bad',
        title: `The connection froze for up to ${Math.round(Math.max(worst?.rttMs ?? 0, silent ? 20000 : 0) / 1000)} s while data was flowing`,
        detail: `${worst?.rttMs ? `A message took ${(worst.rttMs / 1000).toFixed(1)} s to come back (normally ${rtt ?? '–'} ms)` : 'Some steps got no answer at all'}. When several packets in a row are lost, the data channel waits longer and longer before sending them again (1 s, 2 s, 4 s…), and chat, play/pause and the video all stop meanwhile. Sudden bursts of data on a line that was quiet are the usual trigger.`,
        fix: 'Start streams gently (pace the first seconds) and keep less data queued, so a burst doesn’t overflow the line.'
      });
    }
  }

  // ---- Speed that no setting changes, without the network filling up -------------------------
  const windowFinding = (dir: 'download' | 'upload', now: number | null, top: number | null): void => {
    if (now === null || top === null || rtt === null || rtt < 60 || netFull[dir]) return;
    if (top >= now * 1.35) return;
    const perTripKB = Math.round((top * rtt) / 8 / 1000);
    findings.push({
      id: `window-${dir}`,
      severity: perTripKB < 100 ? 'warn' : 'info',
      title: `About ${perTripKB} KB moves per round trip, whatever the setting (${dir === 'download' ? `${peer} → you` : `you → ${peer}`})`,
      detail: `${mbps(top)} at ${rtt} ms ping, and the network showed no sign of filling up. Then the limit is how much the data channel's transport keeps in flight per round trip (it shrinks after every lost packet), not the line or the app's buffer. More data in flight needs either fewer losses or more than one connection carrying the video (other viewers sharing pieces helps).`
    });
  };
  windowFinding('download', downNow, downBest);
  windowFinding('upload', upNow, upBest);

  // ---- Pauses in the flow (lost packets being resent) -----------------------------------------
  const pauseFinding = (dir: 'download' | 'upload', list: PhaseResult[]): void => {
    if (!list.length || rtt === null) return;
    const limit = Math.max(250, rtt * 2);
    let pauses = 0;
    let longest = 0;
    let seconds = 0;
    for (const p of list) {
      if (!p.meter) continue;
      seconds += p.meter.spanMs / 1000;
      for (const g of p.meter.gaps) {
        if (g.ms >= limit) pauses++;
        longest = Math.max(longest, g.ms);
      }
    }
    const loss = list.map((p) => p.audioLossInPct).filter((v): v is number => v !== null);
    const worstLoss = loss.length ? Math.max(...loss) : null;
    if (pauses >= 2 || longest > Math.max(600, rtt * 4)) {
      findings.push({
        id: `pauses-${dir}`,
        severity: pauses >= 4 || longest > 1500 ? 'bad' : 'warn',
        title: `Data stopped completely ${pauses} time${pauses === 1 ? '' : 's'} (${dir === 'download' ? `${peer} → you` : `you → ${peer}`})`,
        detail: `In ${Math.round(seconds)} s of sending, the flow paused ${pauses} time${pauses === 1 ? '' : 's'} for more than ${Math.round(limit)} ms (longest ${longest} ms). That's what a lost packet looks like: the video channel delivers in order, so everything waits until the lost piece is sent again — and after each loss the connection slows down and takes several round trips to speed up again.${worstLoss !== null ? ` Voice packets lost meanwhile: up to ${worstLoss}%${rtt >= 100 && worstLoss < 2 ? ' — at this ping even that little loss costs a lot of speed' : ''}.` : ''}`,
        fix: 'Send video data on an unordered channel, so one lost packet doesn’t hold up the rest.'
      });
    } else if (worstLoss !== null && worstLoss >= 2) {
      findings.push({
        id: `loss-${dir}`,
        severity: 'warn',
        title: `Packets are being lost (${worstLoss}% of voice packets while testing)`,
        detail: 'Loss slows any transfer down and causes small pauses.'
      });
    }
  };
  pauseFinding('download', downs);
  pauseFinding('upload', ups);

  // ---- Does the video fit? --------------------------------------------------------------------
  const relevantNow = need.direction === 'upload' ? upNow : downNow;
  const relevantBest = need.direction === 'upload' ? upBest : downBest;
  if (need.kbps && needKbps) {
    const flow = need.direction === 'upload' ? `you → ${peer}` : `${peer} → you`;
    if (relevantNow !== null && relevantNow >= needKbps) {
      findings.push({
        id: 'video-fits',
        severity: 'ok',
        title: `Fast enough for this video (${flow})`,
        detail: `The video averages ${mbps(need.kbps)}; the connection moved ${mbps(relevantNow)} with today's settings.`
      });
    } else if (relevantBest !== null && relevantBest >= needKbps) {
      findings.push({
        id: 'video-fits-with-fix',
        severity: 'bad',
        title: `Too slow for this video today, but fixable (${flow})`,
        detail: `The video averages ${mbps(need.kbps)} (about ${mbps(needKbps)} with headroom). Today's settings moved ${mbps(relevantNow)}, a bigger send buffer ${mbps(relevantBest)}.`,
        fix: 'Fix the send buffer first.'
      });
    } else if (relevantBest !== null) {
      findings.push({
        id: 'video-too-big',
        severity: 'bad',
        title: `This video needs more than the connection can carry (${flow})`,
        detail: `The video averages ${mbps(need.kbps)}; at best the connection moved ${mbps(relevantBest)}.`,
        fix: 'Share a lighter copy (720p at 3–5 Mbps), or let the person with the faster upload share it.'
      });
    }
  } else if (downBest !== null || upBest !== null) {
    findings.push({
      id: 'no-video',
      severity: 'info',
      title: 'Run it again while a local video plays to compare with its bitrate',
      detail: `For reference: 720p usually needs 3–5 Mbps, 1080p 6–12 Mbps, 4K 20+ Mbps. Measured best: ${mbps(downBest)} from ${peer}, ${mbps(upBest)} to ${peer}.`
    });
  }

  // ---- Live streaming numbers from both apps --------------------------------------------------
  liveFindings(r.local.live, 'you', needKbps, findings);
  liveFindings(r.remote.live, peer, needKbps, findings);

  // ---- Devices --------------------------------------------------------------------------------
  for (const [who, dev] of [['you', r.local.device], [peer, r.remote.device]] as const) {
    if (!dev) continue;
    if (dev.connection?.saveData) {
      findings.push({ id: `savedata-${who}`, severity: 'warn', title: `Data saver is on for ${who}`, detail: 'The browser may hold back traffic.' });
    }
    if (dev.connection?.effectiveType && /^(slow-2g|2g|3g)$/.test(dev.connection.effectiveType)) {
      findings.push({ id: `slow-net-${who}`, severity: 'warn', title: `${who === 'you' ? 'Your' : `${who}'s`} browser rates the network as ${dev.connection.effectiveType}`, detail: 'The browser’s own estimate of the connection is low.' });
    }
    if (dev.hidden) {
      findings.push({ id: `hidden-${who}`, severity: 'warn', title: `${who === 'you' ? 'Your' : `${who}'s`} app was in the background`, detail: 'Browsers slow down background tabs, which can make the test look worse than it is.' });
    }
  }
  if (r.streamingDuringTest) {
    findings.push({ id: 'busy', severity: 'info', title: 'A video was streaming during the test', detail: 'Its traffic shares the connection, so the test speeds are a little lower than the connection can do.' });
  }
  if (r.aborted) findings.push({ id: 'aborted', severity: 'warn', title: 'The test was stopped early', detail: 'Some steps are missing.' });
  const errors = r.phases.filter((p) => p.error);
  if (errors.length) {
    findings.push({ id: 'errors', severity: 'warn', title: `${errors.length} test step${errors.length === 1 ? '' : 's'} failed`, detail: errors.map((p) => `${p.direction} ${size(p.high)}: ${p.error}`).join('; ') });
  }

  // Same severity: causes before symptoms
  const PRIORITY = ['relay', 'tcp', 'freeze', 'video-too-big', 'video-fits-with-fix', 'buffer-', 'full-', 'pauses-', 'window-', 'loss-', 'disk-', 'unsteady-ping', 'stalls-', 'control-delay-'];
  const rank = (id: string): number => {
    const i = PRIORITY.findIndex((p) => id === p || (p.endsWith('-') && id.startsWith(p)));
    return i === -1 ? PRIORITY.length : i;
  };
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || rank(a.id) - rank(b.id));
  const top = findings[0];
  const loaded = downBestPhase?.loadedPing.p50 ?? null;
  const netAll = [...downs, ...ups].flatMap((p) => p.networkRtt || []);
  return {
    headline: top && top.severity !== 'ok' && top.severity !== 'info' ? top.title : 'No problems found between you two',
    severity: top ? (top.severity === 'info' ? 'ok' : top.severity) : 'ok',
    numbers: {
      pingIdleMs: rtt,
      pingLoadedMs: loaded,
      networkRttMaxMs: netAll.length ? Math.max(...netAll) : null,
      downNowKbps: downNow,
      downBestKbps: downBest,
      upNowKbps: upNow,
      upBestKbps: upBest,
      videoKbps: need.kbps,
      videoDirection: need.direction,
      bufferCeilingKbps: ceiling
    },
    findings
  };
}

/** The whole thing as text, for "Copy report" (numbers first, then raw JSON) */
export function reportText(r: StreamTestReport, v: Verdict): string {
  const n = v.numbers;
  const lines = [
    `3RTC stream test — ${r.self.name} ↔ ${r.peer.name} — ${r.startedAt}`,
    '',
    `Verdict: ${v.headline}`,
    '',
    `Ping idle ${n.pingIdleMs ?? '–'} ms (min ${r.idlePing.min ?? '–'}, p95 ${r.idlePing.p95 ?? '–'}, jitter ${r.idlePing.jitterMs ?? '–'}), app ping under load ${n.pingLoadedMs ?? '–'} ms, network round trip under load up to ${n.networkRttMaxMs ?? '–'} ms`,
    `Download (${r.peer.name} → me): ${mbps(n.downNowKbps)} with 192 KB buffer, best ${mbps(n.downBestKbps)}`,
    `Upload (me → ${r.peer.name}): ${mbps(n.upNowKbps)} with 192 KB buffer, best ${mbps(n.upBestKbps)}`,
    `192 KB buffer ceiling at this ping: ${mbps(n.bufferCeilingKbps)}`,
    `Video: ${n.videoKbps ? `${mbps(n.videoKbps)} (${n.videoDirection})` : 'none playing'}`,
    '',
    'Steps:',
    ...r.phases.map((p) => {
      const m = p.meter;
      return `  ${(p.warmup ? 'warm-up' : p.direction).padEnd(8)} ${String(Math.round(p.high / 1024)).padStart(5)} KB  ${mbps(m ? Math.max(m.steadyKbps, m.rateKbps) : null).padStart(9)}  ping ${p.loadedPing.p50 ?? '–'}/${p.loadedPing.p95 ?? '–'} ms  net rtt ${p.networkRtt?.length ? Math.max(...p.networkRtt) : '–'} ms  max gap ${m?.maxGapMs ?? '–'} ms  gaps>100ms ${m?.gaps.length ?? '–'}  sender blocked ${p.sender?.blockedPct ?? '–'}%  drain ${p.sender?.drainMs ?? '–'} ms${p.sender?.leftKB ? ` (${p.sender.leftKB} KB left)` : ''}  voice loss ${p.audioLossInPct ?? '–'}%${p.error ? `  ERROR ${p.error}` : ''}`;
    }),
    '',
    'Findings:',
    ...v.findings.map((f) => `  [${f.severity}] ${f.title}\n      ${f.detail}${f.fix ? `\n      Fix: ${f.fix}` : ''}`),
    '',
    'Raw data:',
    JSON.stringify(r, null, 1)
  ];
  return lines.join('\n');
}
