/**
 * Live numbers about local-video streaming on this device, for the Stream doctor
 * (features/diagnostics). The streaming code (utils/p2pStreamer.ts) reports what it does through
 * the small `note*` calls below; nothing here changes how streaming behaves.
 *
 * Everything is kept in one-second bins for the last WINDOW_S seconds, so memory stays tiny and
 * old numbers age out by themselves.
 */

const WINDOW_S = 120;

interface Bin {
  s: number; // second (Date.now() / 1000, floored)
  sentBytes: number;
  drainWaitMs: number; // time the sender sat waiting for the data channel's buffer to drain
  readMs: number; // time spent reading the file from disk
  reads: number;
  recvBytes: number;
  blocksDone: number;
  blockLatencyMs: number[]; // ask -> complete, per block
  playerWaitMs: number; // time the video player was waiting for a block
  playerWaits: number;
  reasks: number; // a block was asked again (late or lost)
  stalls: number; // <video> 'waiting' events
  stallMs: number;
}

const bins: Bin[] = [];
const nowS = (): number => Math.floor(Date.now() / 1000);

function bin(): Bin {
  const s = nowS();
  let last = bins[bins.length - 1];
  if (!last || last.s !== s) {
    last = {
      s,
      sentBytes: 0,
      drainWaitMs: 0,
      readMs: 0,
      reads: 0,
      recvBytes: 0,
      blocksDone: 0,
      blockLatencyMs: [],
      playerWaitMs: 0,
      playerWaits: 0,
      reasks: 0,
      stalls: 0,
      stallMs: 0
    };
    bins.push(last);
    while (bins.length && bins[0].s <= s - WINDOW_S) bins.shift();
  }
  return last;
}

// ---- What the stream is ---------------------------------------------------------------

export interface StreamInfo {
  role: 'sharing' | 'watching';
  fileName?: string;
  fileSize: number;
  /** watching: who it comes from */
  ownerId?: string;
  /** watching: fetched through another viewer */
  relayed?: boolean;
  swarm?: boolean;
  startedAt: number;
}

let watching: (StreamInfo & { key: string }) | null = null;
const sharingTo = new Map<string, { since: number; fileSize: number; fileName?: string; relay: boolean }>();

/** Returns a key to end exactly this stream with (an old one ending doesn't clear a new one) */
export function noteWatchStart(info: Omit<StreamInfo, 'role' | 'startedAt'>): string {
  const key = `watch-${Math.random().toString(36).slice(2)}`;
  watching = { ...info, role: 'watching', startedAt: Date.now(), key };
  return key;
}
export function noteWatchSource(relayed: boolean): void {
  if (watching) watching.relayed = relayed;
}
export function noteWatchEnd(key: string): void {
  if (watching?.key === key) watching = null;
}
export function noteShareStart(peerId: string, fileSize: number, fileName?: string, relay = false): void {
  sharingTo.set(peerId || '?', { since: Date.now(), fileSize, fileName, relay });
}
export function noteShareEnd(peerId: string): void {
  sharingTo.delete(peerId || '?');
}

// ---- Sender side ------------------------------------------------------------------------

export function noteSent(bytes: number): void {
  bin().sentBytes += bytes;
}
export function noteDrainWait(ms: number): void {
  if (ms > 0) bin().drainWaitMs += ms;
}
export function noteRead(ms: number): void {
  const b = bin();
  b.readMs += ms;
  b.reads++;
}

// ---- Receiver side ----------------------------------------------------------------------

export function noteReceived(bytes: number): void {
  bin().recvBytes += bytes;
}
export function noteBlockDone(latencyMs: number | null): void {
  const b = bin();
  b.blocksDone++;
  if (latencyMs !== null && latencyMs >= 0 && b.blockLatencyMs.length < 400) b.blockLatencyMs.push(Math.round(latencyMs));
}
export function notePlayerWait(ms: number): void {
  const b = bin();
  b.playerWaits++;
  b.playerWaitMs += ms;
}
export function noteReask(count = 1): void {
  if (count > 0) bin().reasks += count;
}

// ---- The <video> element (any on the page; we keep the one that played last) -------------

let video: HTMLVideoElement | null = null;
let stallStartedAt: number | null = null;
let listening = false;

function listenToVideos(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  // Media events don't bubble, but a capturing listener on the document still sees them
  const onWaiting = (e: Event): void => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    video = e.target;
    if (e.target.paused || e.target.seeking) return; // a seek or a pause isn't a stall
    if (stallStartedAt === null) {
      stallStartedAt = performance.now();
      bin().stalls++;
    }
  };
  const onPlaying = (e: Event): void => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    video = e.target;
    if (stallStartedAt !== null) {
      bin().stallMs += performance.now() - stallStartedAt;
      stallStartedAt = null;
    }
  };
  const onPauseOrSeek = (e: Event): void => {
    if (e.target instanceof HTMLVideoElement && e.target === video) stallStartedAt = null;
  };
  document.addEventListener('waiting', onWaiting, true);
  document.addEventListener('playing', onPlaying, true);
  document.addEventListener('pause', onPauseOrSeek, true);
  document.addEventListener('seeking', onPauseOrSeek, true);
  document.addEventListener('loadedmetadata', (e) => {
    if (e.target instanceof HTMLVideoElement) video = e.target;
  }, true);
}
listenToVideos();

// ---- Snapshot -----------------------------------------------------------------------------

export interface LiveSnapshot {
  at: number;
  windowS: number;
  watching: (StreamInfo & { bitrateKbps: number | null }) | null;
  /** viewers: fed straight from this file; relays: blocks passed on for other viewers */
  sharing: { viewers: number; relays: number; fileSize: number | null; fileName?: string; bitrateKbps: number | null };
  video: {
    present: boolean;
    paused: boolean | null;
    durationS: number | null;
    currentS: number | null;
    bufferedAheadS: number | null;
    resolution: string | null;
    droppedFrames: number | null;
    totalFrames: number | null;
  };
  /** last 10 s and last WINDOW_S */
  recent: Rates;
  overall: Rates;
}

export interface Rates {
  seconds: number;
  sendKbps: number;
  recvKbps: number;
  drainWaitPct: number; // share of the time the sender was blocked on the buffer
  readMsAvg: number | null;
  reads: number;
  blocksDone: number;
  blockLatencyMs: { p50: number | null; p95: number | null; max: number | null; samples: number };
  playerWaits: number;
  playerWaitMs: number;
  reasks: number;
  stalls: number;
  stallMs: number;
}

const pct = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;

function rates(window: number): Rates {
  const now = nowS();
  const from = now - window + 1;
  const sel = bins.filter((b) => b.s >= from);
  // averages cover the time since the first activity, when that's shorter than the window
  const seconds = sel.length ? Math.max(1, Math.min(window, now - sel[0].s + 1)) : window;
  const sum = (k: keyof Omit<Bin, 's' | 'blockLatencyMs'>): number => sel.reduce((n, b) => n + b[k], 0);
  const lat = sel.flatMap((b) => b.blockLatencyMs).sort((a, b) => a - b);
  const reads = sum('reads');
  const ongoing = stallStartedAt !== null ? performance.now() - stallStartedAt : 0;
  return {
    seconds,
    sendKbps: Math.round((sum('sentBytes') * 8) / 1000 / seconds),
    recvKbps: Math.round((sum('recvBytes') * 8) / 1000 / seconds),
    drainWaitPct: Math.min(100, Math.round(sum('drainWaitMs') / (10 * seconds))),
    readMsAvg: reads ? Math.round(sum('readMs') / reads) : null,
    reads,
    blocksDone: sum('blocksDone'),
    blockLatencyMs: { p50: pct(lat, 50), p95: pct(lat, 95), max: lat.length ? lat[lat.length - 1] : null, samples: lat.length },
    playerWaits: sum('playerWaits'),
    playerWaitMs: Math.round(sum('playerWaitMs')),
    reasks: sum('reasks'),
    stalls: sum('stalls'),
    stallMs: Math.round(sum('stallMs') + ongoing)
  };
}

function videoInfo(): LiveSnapshot['video'] {
  const v = video && video.isConnected ? video : null;
  if (!v) {
    return { present: false, paused: null, durationS: null, currentS: null, bufferedAheadS: null, resolution: null, droppedFrames: null, totalFrames: null };
  }
  let ahead: number | null = null;
  try {
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.25 && v.buffered.end(i) >= v.currentTime) {
        ahead = Math.max(0, v.buffered.end(i) - v.currentTime);
      }
    }
    if (ahead === null) ahead = 0;
  } catch {
    ahead = null;
  }
  let dropped: number | null = null;
  let total: number | null = null;
  try {
    const q = v.getVideoPlaybackQuality?.();
    if (q) {
      dropped = q.droppedVideoFrames;
      total = q.totalVideoFrames;
    }
  } catch {
    /* not supported */
  }
  return {
    present: true,
    paused: v.paused,
    durationS: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
    currentS: Math.round(v.currentTime),
    bufferedAheadS: ahead === null ? null : Math.round(ahead * 10) / 10,
    resolution: v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : null,
    droppedFrames: dropped,
    totalFrames: total
  };
}

/** Average bitrate of a file: size over duration */
export const bitrateKbps = (fileSize: number | null | undefined, durationS: number | null | undefined): number | null =>
  fileSize && durationS && durationS > 0 ? Math.round((fileSize * 8) / 1000 / durationS) : null;

export function liveSnapshot(): LiveSnapshot {
  const v = videoInfo();
  const shares = [...sharingTo.values()];
  return {
    at: Date.now(),
    windowS: WINDOW_S,
    watching: watching
      ? (({ key: _key, ...rest }) => ({ ...rest, bitrateKbps: bitrateKbps(rest.fileSize, v.durationS) }))(watching)
      : null,
    sharing: {
      viewers: shares.filter((s) => !s.relay).length,
      relays: shares.filter((s) => s.relay).length,
      fileSize: shares[0]?.fileSize ?? null,
      fileName: shares[0]?.fileName,
      bitrateKbps: bitrateKbps(shares[0]?.fileSize, v.durationS)
    },
    video: v,
    recent: rates(10),
    overall: rates(WINDOW_S)
  };
}

/** For tests */
export function resetTelemetry(): void {
  bins.length = 0;
  watching = null;
  sharingTo.clear();
  stallStartedAt = null;
}
