/**
 * Stream test between this device and one peer: how fast video data can really move over the
 * room's data channels, and why not faster.
 *
 *   1. hello       both apps support the test; swap device info and live streaming numbers
 *   2. idle ping   round trips over the control channel with nothing else going on
 *   3. download    the peer sends dummy video-sized frames on the bulk channel for a few seconds,
 *                  once per send-buffer size (the app's current 192 KB, then 1 MB and 4 MB).
 *                  Meanwhile we keep pinging: how much the ping grows shows the link filling up.
 *   4. upload      the same, from us to the peer (the peer measures and reports back)
 *   5. getStats    the connection's own numbers before and after, from both sides
 *
 * Wire (control channel, JSON): diag-hello / diag-hello-ok, diag-ping / diag-pong,
 * diag-burst / diag-burst-end, diag-recv-end / diag-recv-result, diag-stats / diag-stats-ok.
 * Binary frames on the bulk channel start with 'DGN1'. All new types: older apps ignore them, and
 * a peer only gets frames after it answered the hello.
 */
import type { RoomBus } from '../../types';
import { deviceInfo, linkSnapshot, audioLossBetween, type DeviceInfo, type LinkSnapshot } from './linkStats';
import { liveSnapshot, type LiveSnapshot } from './telemetry';

export const DIAG_VERSION = 1;
const MAGIC = 0x44474e31; // 'DGN1'
const FRAME_BYTES = 16384; // the size the video stream uses
const HEADER_BYTES = 12;

/** Send-buffer sizes tried: [high, low] (the first is what video streaming uses today) */
export const BUFFER_STEPS: [number, number][] = [
  [192 * 1024, 64 * 1024],
  [1024 * 1024, 512 * 1024],
  [4 * 1024 * 1024, 2 * 1024 * 1024]
];
const CURRENT = BUFFER_STEPS[0];
const WARMUP = BUFFER_STEPS[1];
/**
 * Each direction starts with an unmeasured warm-up (a connection that was idle starts slow and
 * often loses packets while it speeds up, which would unfairly hit whichever step runs first),
 * and today's setting runs again at the end, so the order of steps can't decide the result.
 */
const DOWNLOAD_PLAN: { step: [number, number]; warmup?: boolean }[] = [
  { step: WARMUP, warmup: true },
  { step: CURRENT },
  { step: BUFFER_STEPS[1] },
  { step: BUFFER_STEPS[2] },
  { step: CURRENT }
];
const UPLOAD_PLAN: { step: [number, number]; warmup?: boolean }[] = [
  { step: WARMUP, warmup: true },
  { step: CURRENT },
  { step: BUFFER_STEPS[2] },
  { step: CURRENT }
];
const BURST_MS = 3500;
const WARMUP_MS = 2000;
/** after a step, wait at most this long for queued data to leave */
const DRAIN_MAX_MS = 15000;
const PING_EVERY_MS = 250;
const GAP_NOTE_MS = 100; // gaps between frames longer than this are kept

export interface PeerLinks {
  pc: (peerId: string) => RTCPeerConnection | null;
  bulk: (peerId: string) => RTCDataChannel | null;
}

// ---- Measuring frames that arrive ---------------------------------------------------------

export interface MeterSummary {
  frames: number;
  bytes: number;
  outOfOrder: number;
  firstAtMs: number | null; // relative to the first frame: 0
  spanMs: number;
  rateKbps: number;
  /** rate over the second half (after the connection has ramped up) */
  steadyKbps: number;
  maxGapMs: number;
  /** gaps between frames longer than 100 ms (when they happened, how long) */
  gaps: { atMs: number; ms: number }[];
  /** kilobits per 250 ms slice */
  bins: number[];
}

class Meter {
  frames = 0;
  bytes = 0;
  lastSeq = -1;
  outOfOrder = 0;
  first = 0;
  last = 0;
  maxGap = 0;
  gaps: { atMs: number; ms: number }[] = [];
  bins: number[] = [];
  touched = 0;

  add(seq: number, bytes: number, now: number): void {
    if (!this.frames) this.first = now;
    else {
      const gap = now - this.last;
      if (gap > this.maxGap) this.maxGap = gap;
      if (gap > GAP_NOTE_MS && this.gaps.length < 200) this.gaps.push({ atMs: Math.round(this.last - this.first), ms: Math.round(gap) });
    }
    if (seq !== this.lastSeq + 1) this.outOfOrder++;
    this.lastSeq = seq;
    this.frames++;
    this.bytes += bytes;
    this.last = now;
    this.touched = now;
    const slot = Math.floor((now - this.first) / 250);
    while (this.bins.length <= slot) this.bins.push(0);
    this.bins[slot] += bytes;
  }

  summary(): MeterSummary {
    const span = this.frames > 1 ? this.last - this.first : 0;
    const half = Math.floor(this.bins.length / 2);
    const tail = this.bins.slice(half, Math.max(half + 1, this.bins.length - 1)); // last slice is partial
    const steadyBytes = tail.reduce((a, b) => a + b, 0);
    return {
      frames: this.frames,
      bytes: this.bytes,
      outOfOrder: this.outOfOrder,
      firstAtMs: this.frames ? 0 : null,
      spanMs: Math.round(span),
      rateKbps: span > 0 ? Math.round((this.bytes * 8) / span) : 0,
      steadyKbps: tail.length ? Math.round((steadyBytes * 8) / (tail.length * 250)) : 0,
      maxGapMs: Math.round(this.maxGap),
      gaps: this.gaps,
      bins: this.bins.map((b) => Math.round((b * 8) / 1000))
    };
  }
}

// ---- Sending a burst -----------------------------------------------------------------------

export interface SenderSummary {
  frames: number;
  bytes: number;
  durationMs: number;
  /** share of the time spent waiting for the send buffer to drain */
  blockedPct: number;
  maxBufferedKB: number;
  high: number;
  low: number;
  stoppedEarly: string | null;
  /** after sending stopped: how long the queued data took to leave, and what was still queued */
  drainMs: number;
  leftKB: number;
}

async function sendBurst(
  channel: RTCDataChannel,
  id: number,
  high: number,
  low: number,
  ms: number,
  stopped: () => boolean
): Promise<SenderSummary> {
  const oldThreshold = channel.bufferedAmountLowThreshold;
  const start = performance.now();
  let seq = 0;
  let blocked = 0;
  let maxBuffered = 0;
  let stoppedEarly: string | null = null;
  const waitLow = (): Promise<void> =>
    new Promise((resolve) => {
      channel.bufferedAmountLowThreshold = low;
      const done = (): void => {
        clearTimeout(t);
        channel.removeEventListener('bufferedamountlow', done);
        resolve();
      };
      const t = setTimeout(done, 1000);
      channel.addEventListener('bufferedamountlow', done);
    });
  try {
    while (performance.now() - start < ms) {
      if (stopped()) {
        stoppedEarly = 'cancelled';
        break;
      }
      if (channel.readyState !== 'open') {
        stoppedEarly = 'channel closed';
        break;
      }
      if (channel.bufferedAmount > high) {
        const t0 = performance.now();
        await waitLow();
        blocked += performance.now() - t0;
        continue;
      }
      const frame = new Uint8Array(FRAME_BYTES);
      const view = new DataView(frame.buffer);
      view.setUint32(0, MAGIC, false);
      view.setUint32(4, id, false);
      view.setUint32(8, seq, false);
      channel.send(frame.buffer);
      seq++;
      if (channel.bufferedAmount > maxBuffered) maxBuffered = channel.bufferedAmount;
      // let other work (pings, the UI) run now and then
      if (seq % 64 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  } catch (err) {
    stoppedEarly = err instanceof Error ? err.message : String(err);
  }
  // Let what's queued leave before the next step, or it would be measured there
  const sendingStopped = performance.now();
  while (channel.readyState === 'open' && channel.bufferedAmount > 0 && performance.now() - sendingStopped < DRAIN_MAX_MS && !stopped()) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const drainMs = Math.round(performance.now() - sendingStopped);
  const leftKB = channel.readyState === 'open' ? Math.round(channel.bufferedAmount / 1024) : 0;
  channel.bufferedAmountLowThreshold = oldThreshold;
  const duration = sendingStopped - start;
  return {
    drainMs,
    leftKB,
    frames: seq,
    bytes: seq * FRAME_BYTES,
    durationMs: Math.round(duration),
    blockedPct: duration > 0 ? Math.round((blocked / duration) * 100) : 0,
    maxBufferedKB: Math.round(maxBuffered / 1024),
    high,
    low,
    stoppedEarly
  };
}

// ---- The side that answers (every app, always) ---------------------------------------------

const meters = new Map<string, Meter>(); // `${from}:${id}`

function frameHandler(buffer: ArrayBuffer, from: string): boolean {
  if (buffer.byteLength < HEADER_BYTES) return false;
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== MAGIC) return false;
  const key = `${from}:${view.getUint32(4, false)}`;
  let meter = meters.get(key);
  if (!meter) {
    // keep the map small: drop meters nobody asked about for a minute
    const now = performance.now();
    for (const [k, m] of meters) if (now - m.touched > 60000) meters.delete(k);
    meter = new Meter();
    meters.set(key, meter);
  }
  meter.add(view.getUint32(8, false), buffer.byteLength, performance.now());
  return true;
}

/** Wait until `frames` arrived in a meter, or nothing arrived for `quietMs` */
async function settle(key: string, frames: number, quietMs = 2500, maxMs = 30000): Promise<Meter> {
  const start = performance.now();
  for (;;) {
    const m = meters.get(key);
    const now = performance.now();
    if (m && m.frames >= frames) return m;
    const lastActivity = m ? m.touched : start;
    if (now - lastActivity > quietMs || now - start > maxMs) return m || new Meter();
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function installDiagResponder(bus: RoomBus, links: PeerLinks): () => void {
  const active = new Set<string>(); // peers we're sending to
  const recent = new Map<string, number[]>(); // peer -> when its last bursts started
  const allowBurst = (peer: string): boolean => {
    // a test needs about 8; more than 20 a minute is someone misusing it
    const now = Date.now();
    const list = (recent.get(peer) || []).filter((t) => now - t < 60000);
    if (list.length >= 20) return false;
    list.push(now);
    recent.set(peer, list);
    return true;
  };
  const offs = [
    bus.onBinary(frameHandler),
    bus.on<{ v?: number; nonce?: string }>('diag-hello', (msg, from) => {
      bus.send(from, 'diag-hello-ok', { v: DIAG_VERSION, nonce: msg?.nonce, device: deviceInfo(), live: liveSnapshot() });
    }),
    bus.on<{ t?: number; n?: number }>('diag-ping', (msg, from) => {
      bus.send(from, 'diag-pong', { t: msg?.t, n: msg?.n });
    }),
    bus.on<{ id?: number }>('diag-stats', async (msg, from) => {
      const link = await linkSnapshot(links.pc(from));
      bus.send(from, 'diag-stats-ok', { id: msg?.id, link, live: liveSnapshot(), device: deviceInfo() });
    }),
    bus.on<{ id?: number; high?: number; low?: number; ms?: number }>('diag-burst', async (msg, from) => {
      const id = Number(msg?.id) >>> 0;
      const channel = links.bulk(from);
      const high = Math.min(16 * 1024 * 1024, Math.max(16 * 1024, Number(msg?.high) || BUFFER_STEPS[0][0]));
      const low = Math.min(high, Math.max(0, Number(msg?.low) || high / 2));
      const ms = Math.min(10000, Math.max(500, Number(msg?.ms) || BURST_MS));
      if (!channel || channel.readyState !== 'open' || active.has(from) || !allowBurst(from)) {
        bus.send(from, 'diag-burst-end', { id, error: channel ? 'busy' : 'no bulk channel' });
        return;
      }
      active.add(from);
      try {
        const sender = await sendBurst(channel, id, high, low, ms, () => channel.readyState !== 'open');
        const link = await linkSnapshot(links.pc(from));
        bus.send(from, 'diag-burst-end', { id, sender, link });
      } finally {
        active.delete(from);
      }
    }),
    bus.on<{ id?: number; frames?: number }>('diag-recv-end', async (msg, from) => {
      const id = Number(msg?.id) >>> 0;
      const key = `${from}:${id}`;
      const meter = await settle(key, Number(msg?.frames) || 0);
      meters.delete(key);
      const link = await linkSnapshot(links.pc(from));
      bus.send(from, 'diag-recv-result', { id, meter: meter.summary(), link });
    })
  ];
  return () => offs.forEach((off) => off());
}

// ---- The side that runs the test ----------------------------------------------------------

export interface PingSample {
  atMs: number; // since the phase started
  rttMs: number | null; // null: no answer
}

export interface PhaseResult {
  direction: 'download' | 'upload';
  /** unmeasured warm-up: shown, not used for findings */
  warmup?: boolean;
  high: number;
  low: number;
  /** what arrived (measured by the receiving side) */
  meter: MeterSummary | null;
  /** what the sending side saw */
  sender: SenderSummary | null;
  /**
   * pings sent on the control channel while the data was flowing. They share the connection's
   * transport with the data, so they show how long play/pause and chat wait during streaming —
   * not only how full the network is.
   */
  loadedPing: { samples: PingSample[]; p50: number | null; p95: number | null; lost: number };
  /**
   * round trips measured outside the data channel meanwhile (ICE checks and voice RTCP): these
   * only grow when queues in the network itself fill up
   */
  networkRtt: number[];
  /** audio packet loss on the same connection meanwhile (both sides' views) */
  audioLossInPct: number | null;
  linkBefore: LinkSnapshot | null;
  linkAfter: LinkSnapshot | null;
  remoteLinkAfter: LinkSnapshot | null;
  error: string | null;
}

export interface StreamTestReport {
  version: number;
  startedAt: string;
  durationMs: number;
  peer: { id: string; name: string };
  self: { name: string };
  local: { device: DeviceInfo; live: LiveSnapshot; linkStart: LinkSnapshot | null; linkEnd: LinkSnapshot | null };
  remote: { device: DeviceInfo | null; live: LiveSnapshot | null; linkStart: LinkSnapshot | null; linkEnd: LinkSnapshot | null; v: number | null };
  idlePing: { samples: number[]; lost: number; min: number | null; p50: number | null; p95: number | null; max: number | null; jitterMs: number | null };
  phases: PhaseResult[];
  /** a video stream was moving while testing: speeds include its traffic */
  streamingDuringTest: boolean;
  aborted: string | null;
}

export class PeerTooOldError extends Error {}

export const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

interface RunOptions {
  bus: RoomBus;
  links: PeerLinks;
  peerId: string;
  peerName: string;
  selfName: string;
  onProgress?: (step: string, fraction: number) => void;
  signal?: { aborted: boolean };
}

function waitFor<T>(bus: RoomBus, type: string, from: string, match: (msg: T) => boolean, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const off = bus.on<T>(type, (msg, peer) => {
      if (peer !== from || !match(msg)) return;
      clearTimeout(t);
      off();
      resolve(msg);
    });
    const t = setTimeout(() => {
      off();
      resolve(null);
    }, ms);
  });
}

/** Ping the peer every PING_EVERY_MS until stop() */
function pinger(bus: RoomBus, peerId: string): { stop: () => PingSample[] } {
  const start = performance.now();
  const sent = new Map<number, number>();
  const samples: PingSample[] = [];
  let n = 0;
  const off = bus.on<{ t?: number; n?: number }>('diag-pong', (msg, from) => {
    if (from !== peerId || typeof msg?.n !== 'number' || !sent.has(msg.n)) return;
    const at = sent.get(msg.n)!;
    sent.delete(msg.n);
    samples.push({ atMs: Math.round(at - start), rttMs: Math.round(performance.now() - at) });
  });
  const ping = (): void => {
    const at = performance.now();
    sent.set(++n, at);
    bus.send(peerId, 'diag-ping', { t: at, n });
  };
  ping();
  const timer = setInterval(ping, PING_EVERY_MS);
  return {
    stop: () => {
      clearInterval(timer);
      off();
      for (const at of sent.values()) samples.push({ atMs: Math.round(at - start), rttMs: null });
      return samples.sort((a, b) => a.atMs - b.atMs);
    }
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The most worth queuing at a measured speed: ~3 s of data, never under 2× today's buffer */
const capFromRate = (kbps: number | null | undefined): number =>
  kbps && kbps > 0 ? Math.max(2 * CURRENT[0], Math.ceil((kbps * 1000) / 8 * 3 / 65536) * 65536) : Infinity;
const capStep = ([high, low]: [number, number], cap: number): [number, number] =>
  high <= CURRENT[0] || high <= cap ? [high, low] : [cap, Math.round(cap / 2)];

/** Poll the connection's own round-trip numbers (ICE checks, voice RTCP) until stop() */
function rttWatcher(pc: RTCPeerConnection | null): { stop: () => number[] } {
  const samples: number[] = [];
  let lastPair: number | null = null;
  let lastAudio: number | null = null;
  let stopped = false;
  const poll = async (): Promise<void> => {
    while (!stopped) {
      const s = await linkSnapshot(pc);
      // a value only counts when it changed: these update every second or few
      const pair = s?.pair?.currentRttMs ?? null;
      const audio = s?.audio?.remoteRttMs ?? null;
      if (pair !== null && pair !== lastPair) samples.push(pair);
      if (audio !== null && audio !== lastAudio) samples.push(audio);
      lastPair = pair;
      lastAudio = audio;
      await sleep(400);
    }
  };
  void poll();
  return {
    stop: () => {
      stopped = true;
      return samples;
    }
  };
}

export async function runStreamTest(opts: RunOptions): Promise<StreamTestReport> {
  const { bus, links, peerId, onProgress } = opts;
  const signal = opts.signal || { aborted: false };
  const t0 = performance.now();
  const totalSteps = 2 + DOWNLOAD_PLAN.length + UPLOAD_PLAN.length + 1;
  let step = 0;
  const progress = (label: string): void => onProgress?.(label, Math.min(1, step++ / totalSteps));

  // 1. hello
  progress('Checking the other app supports the test');
  const nonce = Math.random().toString(36).slice(2);
  const helloWait = waitFor<{ nonce?: string; v?: number; device?: DeviceInfo; live?: LiveSnapshot }>(
    bus, 'diag-hello-ok', peerId, (m) => m?.nonce === nonce, 4000
  );
  bus.send(peerId, 'diag-hello', { v: DIAG_VERSION, nonce });
  const hello = await helloWait;
  if (!hello) throw new PeerTooOldError(`${opts.peerName}'s app didn't answer the test: it may be an older version.`);

  const report: StreamTestReport = {
    version: DIAG_VERSION,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    peer: { id: peerId, name: opts.peerName },
    self: { name: opts.selfName },
    local: { device: deviceInfo(), live: liveSnapshot(), linkStart: await linkSnapshot(links.pc(peerId)), linkEnd: null },
    remote: { device: hello.device ?? null, live: hello.live ?? null, linkStart: null, linkEnd: null, v: hello.v ?? null },
    idlePing: { samples: [], lost: 0, min: null, p50: null, p95: null, max: null, jitterMs: null },
    phases: [],
    streamingDuringTest: false,
    aborted: null
  };
  const statsId = (): number => (Math.random() * 0xffffffff) >>> 0;
  const remoteStats = async (): Promise<{ link: LinkSnapshot | null; live: LiveSnapshot | null } | null> => {
    const id = statsId();
    const wait = waitFor<{ id?: number; link?: LinkSnapshot; live?: LiveSnapshot }>(bus, 'diag-stats-ok', peerId, (m) => m?.id === id, 4000);
    bus.send(peerId, 'diag-stats', { id });
    const got = await wait;
    return got ? { link: got.link ?? null, live: got.live ?? null } : null;
  };
  report.remote.linkStart = (await remoteStats())?.link ?? null;
  const streamingNow = (live: LiveSnapshot | null | undefined): boolean =>
    Boolean(live && (live.recent.sendKbps > 200 || live.recent.recvKbps > 200));
  report.streamingDuringTest = streamingNow(report.local.live) || streamingNow(report.remote.live);

  // 2. idle ping
  progress('Measuring ping with the line idle');
  const idle = pinger(bus, peerId);
  await sleep(3000);
  const idleSamples = idle.stop();
  const rtts = idleSamples.map((s) => s.rttMs).filter((v): v is number => v !== null);
  const p50 = percentile(rtts, 50);
  report.idlePing = {
    samples: rtts,
    lost: idleSamples.length - rtts.length,
    min: rtts.length ? Math.min(...rtts) : null,
    p50,
    p95: percentile(rtts, 95),
    max: rtts.length ? Math.max(...rtts) : null,
    jitterMs: rtts.length > 1 ? Math.round(rtts.slice(1).reduce((n, v, i) => n + Math.abs(v - rtts[i]), 0) / (rtts.length - 1)) : null
  };

  const loadedPing = (samples: PingSample[]): PhaseResult['loadedPing'] => {
    const ok = samples.map((s) => s.rttMs).filter((v): v is number => v !== null);
    return { samples, p50: percentile(ok, 50), p95: percentile(ok, 95), lost: samples.length - ok.length };
  };

  const sizeLabel = (high: number): string => (high >= 1024 * 1024 ? `${high / 1024 / 1024} MB` : `${high / 1024} KB`);

  // 3. downloads: the peer sends to us
  // On a slow line a big buffer takes ages to empty: bigger steps are capped at ~3 s of data
  let downCap = Infinity;
  const downDone = new Set<number>();
  for (const { step, warmup } of DOWNLOAD_PLAN) {
    if (signal.aborted) break;
    const [high, low] = capStep(step, downCap);
    // a capped step can come out the same size as the one before: no need to run it twice
    if (!warmup && high !== CURRENT[0] && downDone.has(high)) continue;
    if (!warmup) downDone.add(high);
    const ms = warmup ? WARMUP_MS : BURST_MS;
    progress(warmup ? `Warming up the connection from ${opts.peerName}` : `Download, ${sizeLabel(high)} send buffer`);
    const id = statsId();
    const key = `${peerId}:${id}`;
    const before = await linkSnapshot(links.pc(peerId));
    const end = waitFor<{ id?: number; sender?: SenderSummary; link?: LinkSnapshot; error?: string }>(
      bus, 'diag-burst-end', peerId, (m) => m?.id === id, ms + DRAIN_MAX_MS + 15000
    );
    const pings = pinger(bus, peerId);
    const netRtt = rttWatcher(links.pc(peerId));
    bus.send(peerId, 'diag-burst', { id, high, low, ms });
    const done = await end;
    const meter = done && !done.error ? await settle(key, done.sender?.frames ?? 0) : meters.get(key) || null;
    const samples = pings.stop();
    const networkRtt = netRtt.stop();
    meters.delete(key);
    const after = await linkSnapshot(links.pc(peerId));
    report.phases.push({
      direction: 'download',
      ...(warmup ? { warmup: true } : {}),
      networkRtt,
      high,
      low,
      meter: meter ? meter.summary() : null,
      sender: done?.sender ?? null,
      loadedPing: loadedPing(samples),
      audioLossInPct: audioLossBetween(before, after).inPct,
      linkBefore: before,
      linkAfter: after,
      remoteLinkAfter: done?.link ?? null,
      error: done ? done.error ?? null : 'no answer from the other side'
    });
    if (warmup) downCap = capFromRate(report.phases[report.phases.length - 1].meter?.rateKbps);
    await sleep(800); // let queues empty between steps
  }

  // 4. uploads: we send to the peer
  let upCap = Infinity;
  const upDone = new Set<number>();
  for (const { step, warmup } of UPLOAD_PLAN) {
    if (signal.aborted) break;
    const [high, low] = capStep(step, upCap);
    if (!warmup && high !== CURRENT[0] && upDone.has(high)) continue;
    if (!warmup) upDone.add(high);
    const ms = warmup ? WARMUP_MS : BURST_MS;
    progress(warmup ? `Warming up the connection to ${opts.peerName}` : `Upload, ${sizeLabel(high)} send buffer`);
    const channel = links.bulk(peerId);
    const id = statsId();
    const before = await linkSnapshot(links.pc(peerId));
    if (!channel || channel.readyState !== 'open') {
      report.phases.push({
        direction: 'upload', ...(warmup ? { warmup: true } : {}), networkRtt: [], high, low, meter: null, sender: null,
        loadedPing: { samples: [], p50: null, p95: null, lost: 0 }, audioLossInPct: null,
        linkBefore: before, linkAfter: null, remoteLinkAfter: null, error: 'no bulk channel to this peer'
      });
      continue;
    }
    const pings = pinger(bus, peerId);
    const netRtt = rttWatcher(links.pc(peerId));
    const sender = await sendBurst(channel, id, high, low, ms, () => signal.aborted);
    const result = waitFor<{ id?: number; meter?: MeterSummary; link?: LinkSnapshot }>(
      bus, 'diag-recv-result', peerId, (m) => m?.id === id, 35000
    );
    bus.send(peerId, 'diag-recv-end', { id, frames: sender.frames });
    const got = await result;
    const samples = pings.stop();
    const networkRtt = netRtt.stop();
    const after = await linkSnapshot(links.pc(peerId));
    report.phases.push({
      direction: 'upload',
      ...(warmup ? { warmup: true } : {}),
      networkRtt,
      high,
      low,
      meter: got?.meter ?? null,
      sender,
      loadedPing: loadedPing(samples),
      audioLossInPct: audioLossBetween(before, after).inPct,
      linkBefore: before,
      linkAfter: after,
      remoteLinkAfter: got?.link ?? null,
      error: got ? null : 'no answer from the other side'
    });
    if (warmup) upCap = capFromRate(got?.meter?.rateKbps);
    await sleep(800);
  }

  // 5. final numbers
  progress('Collecting connection stats');
  report.local.linkEnd = await linkSnapshot(links.pc(peerId));
  report.local.live = liveSnapshot();
  const last = await remoteStats();
  report.remote.linkEnd = last?.link ?? null;
  if (last?.live) report.remote.live = last.live;
  if (signal.aborted) report.aborted = 'cancelled';
  report.durationMs = Math.round(performance.now() - t0);
  onProgress?.('Done', 1);
  return report;
}
