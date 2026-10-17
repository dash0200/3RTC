/**
 * WebRTC Direct P2P Video Streaming & MSE Chunk Sharing
 * 
 * Features:
 * - Slices local video files into 16 KB binary chunks.
 * - Streams peer-to-peer over WebRTC DataChannel with backpressure flow control (`bufferedAmount`).
 * - Receiver buffers chunks using MediaSource Extensions (MSE) or progressive chunk assembly.
 * - Zero server bandwidth; direct peer-to-peer delivery.
 */

// 16 KB chunks: sent on their own "bulk" data channel, so chat, reactions and play/pause on the
// control channel only ever wait for one small chunk instead of queuing behind the video.
// The receiver reads chunkSize from the header, so this can change without breaking peers.
export const STREAM_CHUNK_SIZE = 16384;
export const BUFFERED_AMOUNT_HIGH = 512 * 1024; // 512 KB backpressure threshold
export const BUFFERED_AMOUNT_LOW = 128 * 1024;  // 128 KB resume threshold

export function getVideoMimeType(file) {
  if (file?.type) return file.type;
  const name = (file?.name || '').toLowerCase();
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mp4') || name.endsWith('.m4v')) return 'video/mp4';
  if (name.endsWith('.mov')) return 'video/quicktime';
  if (name.endsWith('.mkv')) return 'video/mp4';
  return 'video/mp4';
}

/**
 * P2P Stream Sender: Slices a local File and streams it with backpressure control.
 */
export class P2PStreamSender {
  constructor(file, dataChannel, options = {}) {
    this.file = file;
    this.dataChannel = dataChannel;
    this.senderName = options.senderName || 'Peer';
    this.streamId = options.streamId || crypto.randomUUID();
    this.targetPeerId = options.targetPeerId || '';
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.isAborted = false;
    this.totalChunks = Math.ceil(file.size / STREAM_CHUNK_SIZE);
    this.currentChunkIndex = 0;
    this.startTime = 0;
    this.lastProgressTime = 0;
    this.lastProgressBytes = 0;
  }

  start() {
    if (!this.file || !this.dataChannel || this.dataChannel.readyState !== 'open') {
      this.onError(new Error('DataChannel is not open or file is invalid'));
      return;
    }

    this.isAborted = false;
    this.startTime = Date.now();
    this.lastProgressTime = this.startTime;
    this.lastProgressBytes = 0;
    this.currentChunkIndex = 0;

    // 1. Send stream header JSON
    const headerMsg = {
      type: 'p2p-stream-header',
      streamId: this.streamId,
      fileName: this.file.name,
      fileSize: this.file.size,
      mimeType: getVideoMimeType(this.file),
      chunkSize: STREAM_CHUNK_SIZE,
      totalChunks: this.totalChunks,
      targetPeerId: this.targetPeerId,
      sender: this.senderName,
      timestamp: Date.now()
    };

    try {
      this.dataChannel.send(JSON.stringify(headerMsg));
    } catch (err) {
      this.onError(err);
      return;
    }

    // 2. Begin chunk streaming loop
    this._pump();
  }

  _pump() {
    if (this.isAborted) return;

    if (this.currentChunkIndex >= this.totalChunks) {
      // Completed sending all chunks
      const completeMsg = {
        type: 'p2p-stream-complete',
        streamId: this.streamId,
        totalChunks: this.totalChunks,
        fileSize: this.file.size,
        timestamp: Date.now()
      };
      try {
        this.dataChannel.send(JSON.stringify(completeMsg));
      } catch (e) {}

      this.onComplete({
        streamId: this.streamId,
        totalBytes: this.file.size,
        totalChunks: this.totalChunks,
        durationSec: (Date.now() - this.startTime) / 1000
      });
      return;
    }

    // Check backpressure on DataChannel buffer
    if (this.dataChannel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
      this.dataChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
      this.dataChannel.onbufferedamountlow = () => {
        this.dataChannel.onbufferedamountlow = null;
        this._pump();
      };
      return;
    }

    // Read and send the next slice
    const start = this.currentChunkIndex * STREAM_CHUNK_SIZE;
    const end = Math.min(start + STREAM_CHUNK_SIZE, this.file.size);
    const slice = this.file.slice(start, end);
    const chunkIdx = this.currentChunkIndex;
    this.currentChunkIndex++;

    const reader = new FileReader();
    reader.onload = () => {
      if (this.isAborted) return;
      const arrayBuffer = reader.result;

      // Pack 4-byte chunk index prefix + slice payload
      const packet = new Uint8Array(4 + arrayBuffer.byteLength);
      new DataView(packet.buffer).setUint32(0, chunkIdx, false);
      packet.set(new Uint8Array(arrayBuffer), 4);

      try {
        this.dataChannel.send(packet.buffer);
      } catch (err) {
        this.onError(err);
        return;
      }

      // Calculate progress and speed
      const now = Date.now();
      const bytesSent = Math.min(this.currentChunkIndex * STREAM_CHUNK_SIZE, this.file.size);
      const percent = Math.min(100, Math.round((bytesSent / this.file.size) * 100));

      if (now - this.lastProgressTime >= 250 || this.currentChunkIndex === this.totalChunks) {
        const timeDiffSec = Math.max(0.01, (now - this.lastProgressTime) / 1000);
        const bytesDiff = bytesSent - this.lastProgressBytes;
        const speedMBs = (bytesDiff / (1024 * 1024)) / timeDiffSec;

        this.onProgress({
          chunkIndex: chunkIdx,
          totalChunks: this.totalChunks,
          bytesSent,
          totalBytes: this.file.size,
          percent,
          speedMBs: Math.max(0, speedMBs)
        });

        this.lastProgressTime = now;
        this.lastProgressBytes = bytesSent;
      }

      // Schedule next pump
      this._pump();
    };

    reader.onerror = (err) => {
      this.onError(err);
    };

    reader.readAsArrayBuffer(slice);
  }

  abort() {
    this.isAborted = true;
    if (this.dataChannel) {
      this.dataChannel.onbufferedamountlow = null;
      try {
        this.dataChannel.send(JSON.stringify({
          type: 'p2p-stream-cancel',
          streamId: this.streamId,
          timestamp: Date.now()
        }));
      } catch (e) {}
    }
  }
}

export const MAX_STREAM_CHUNKS = 100000; // max ~1.6 GB with 16 KB chunks

/**
 * P2P Stream Receiver: Assembles incoming binary chunks and exposes playback via Blob / MSE.
 */
export class P2PStreamReceiver {
  constructor(header, options = {}) {
    this.streamId = header?.streamId;
    this.fileName = header?.fileName;
    this.fileSize = header?.fileSize;
    this.mimeType = header?.mimeType || 'video/mp4';
    this.chunkSize = header?.chunkSize || STREAM_CHUNK_SIZE;

    this.onReady = options.onReady || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});

    const rawTotal = header?.totalChunks || (this.fileSize && this.chunkSize ? Math.ceil(this.fileSize / this.chunkSize) : 0);
    if (!Number.isInteger(rawTotal) || rawTotal <= 0 || rawTotal > MAX_STREAM_CHUNKS) {
      this.totalChunks = 0;
      this.chunks = [];
      this.isAborted = true;
      this.onError(new Error(`Invalid totalChunks count: ${rawTotal}`));
      return;
    }

    this.totalChunks = rawTotal;
    this.sender = header?.sender || 'Peer';

    this.chunks = new Array(this.totalChunks);
    this.receivedBytes = 0;
    this.receivedChunksCount = 0;
    this.isReady = false;
    this.isCompleted = false;
    this.isAborted = false;
    this.currentObjectUrl = null;

    this.startTime = Date.now();
    this.lastProgressTime = this.startTime;
    this.lastProgressBytes = 0;

    // MSE support detection
    this.useMSE = Boolean(typeof window !== 'undefined' && window.MediaSource && MediaSource.isTypeSupported(this.mimeType));
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.mseQueue = [];
    this.isMseUpdating = false;
  }

  handleChunk(arrayBuffer) {
    if (this.isAborted || arrayBuffer.byteLength < 4) return;

    const chunkIndex = new DataView(arrayBuffer).getUint32(0, false);
    if (chunkIndex >= this.totalChunks) return;

    if (!this.chunks[chunkIndex]) {
      const rawChunk = arrayBuffer.slice(4);
      this.chunks[chunkIndex] = rawChunk;
      this.receivedBytes += rawChunk.byteLength;
      this.receivedChunksCount++;

      // Progress calculation
      const now = Date.now();
      const percent = Math.min(100, Math.round((this.receivedBytes / this.fileSize) * 100));

      if (now - this.lastProgressTime >= 250 || this.receivedChunksCount === this.totalChunks) {
        const timeDiffSec = Math.max(0.01, (now - this.lastProgressTime) / 1000);
        const bytesDiff = this.receivedBytes - this.lastProgressBytes;
        const speedMBs = (bytesDiff / (1024 * 1024)) / timeDiffSec;

        this.onProgress({
          percent,
          receivedBytes: this.receivedBytes,
          totalBytes: this.fileSize,
          receivedChunksCount: this.receivedChunksCount,
          totalChunks: this.totalChunks,
          speedMBs: Math.max(0, speedMBs),
          isReady: this.isReady
        });

        this.lastProgressTime = now;
        this.lastProgressBytes = this.receivedBytes;
      }

      // Check if complete or ready for initial playback:
      if (this.receivedChunksCount === this.totalChunks) {
        this.handleComplete();
      } else {
        const readyThreshold = Math.min(1.8 * 1024 * 1024, this.fileSize * 0.12);
        if (!this.isReady && (this.receivedBytes >= readyThreshold || this.receivedChunksCount >= 30)) {
          this.isReady = true;
          this._producePlayableBlob(false);
        }
      }
    }
  }

  _producePlayableBlob(isFinal = false) {
    try {
      const validChunks = this.chunks.filter(Boolean);
      if (validChunks.length === 0) return;

      const blob = new Blob(validChunks, { type: this.mimeType });
      const newUrl = URL.createObjectURL(blob);

      if (isFinal) {
        if (this.currentObjectUrl && this.currentObjectUrl !== newUrl) {
          try { URL.revokeObjectURL(this.currentObjectUrl); } catch (e) {}
        }
        this.currentObjectUrl = newUrl;
        this.isCompleted = true;
        this.isReady = true;
        this.onComplete(newUrl, {
          blob,
          fileName: this.fileName,
          fileSize: this.fileSize,
          totalChunks: this.totalChunks
        });
      } else {
        this.currentObjectUrl = newUrl;
        this.onReady(newUrl, {
          blob,
          fileName: this.fileName,
          fileSize: this.fileSize,
          percent: Math.min(100, Math.round((this.receivedBytes / this.fileSize) * 100))
        });
      }
    } catch (err) {
      this.onError(err);
    }
  }

  handleComplete() {
    if (this.isAborted || this.isCompleted) return;
    this._producePlayableBlob(true);
  }

  abort() {
    this.isAborted = true;
    if (this.currentObjectUrl) {
      try {
        URL.revokeObjectURL(this.currentObjectUrl);
      } catch (e) {}
      this.currentObjectUrl = null;
    }
    this.chunks = [];
  }
}

/* ==========================================================================
   On-demand streaming (byte ranges)
   --------------------------------------------------------------------------
   The guest's <video> plays a virtual URL (/__p2p-stream/...) that the service worker answers.
   Every range the player asks for is fetched from the host's file over the bulk data channel,
   in 256 KB blocks, plus a small read-ahead. So playback starts after the first few blocks and
   seeking works anywhere (including MP4s whose index sits at the end of the file).
   The player's reads are never held back (holding them by guessing where playback is in the
   file froze films whose bitrate isn't even: the guess lagged the real position and the player
   waited on a read we held). The browser buffers a little ahead on its own; beyond that, the
   viewer keeps fetching in the background up to BUFFER_AHEAD bytes past where the player reads,
   using spare connection time in calm scenes to carry playback through heavy ones and short
   network hiccups. Received blocks are kept for rewinding, up to a memory limit; past it, the
   ones furthest from where the player reads are dropped.

   Wire format (bulk channel):
     guest -> host  JSON {type:'p2p-range-request', streamNo, blocks:[...], urgent}
     guest -> host  JSON {type:'p2p-range-cancel',  streamNo, blocks:[...]}
     host -> guest  binary [ 'RNG1' | streamNo u32 | block u32 | offset-in-block u32 | data ]

   Relay tree (bigger rooms): the owner of the file serves at most RELAY_FANOUT viewers itself.
   Each further viewer is told (header field `via`) to fetch from a parent viewer instead. The
   parent answers from the blocks it already has, or fetches them from its own source and passes
   them on, so the owner's upload no longer grows with the number of viewers. A child goes back to
   fetching from the owner when its parent leaves, stops ('p2p-relay-gone') or is too slow; the
   owner serves anyone asking for its current stream, so that needs no extra coordination.
   ========================================================================== */

export const RANGE_BLOCK_SIZE = 256 * 1024;
export const RANGE_PREFETCH_BYTES = 2 * 1024 * 1024; // block read-ahead past the player's position
// Memory for received blocks (kept for rewinding); past it the ones furthest from the player's
// reading position are dropped, never the stretch just behind it
export const STREAM_CACHE_BYTES = 700 * 1024 * 1024;       // computers
export const STREAM_CACHE_BYTES_PHONE = 200 * 1024 * 1024; // phones
const KEEP_BEHIND_SHARE = 0.25;
// Background buffer past the player's reading position (a ~95 min 1080p film: ~5 min on a computer)
export const BUFFER_AHEAD_BYTES = 96 * 1024 * 1024;
export const BUFFER_AHEAD_BYTES_PHONE = 40 * 1024 * 1024;
const BUFFER_IN_FLIGHT_BLOCKS = 16;           // 4 MB asked for at a time: keeps a slow link busy, seeks stay quick
const ANCHOR_MIN_BYTES = 1024 * 1024;         // a reader counts as "playback" once it has read this much (not a quick index read)
export const P2P_STREAM_URL_PREFIX = '/__p2p-stream/';
const RANGE_PACKET_MAGIC = 0x524E4731; // 'RNG1'
const RANGE_HEADER_BYTES = 16;
const RANGE_PACKET_PAYLOAD = 16384;
const RANGE_BUFFER_HIGH = 192 * 1024; // kept small so a block needed after a seek isn't stuck behind read-ahead
const RANGE_BUFFER_LOW = 64 * 1024;
const BLOCK_WAIT_MS = 15000;          // re-request a block that hasn't arrived by then
const BLOCK_MAX_TRIES = 4;
const RELAY_WAIT_MS = 5000;           // a parent viewer that takes longer than this: fetch from the owner
export const RELAY_FANOUT = 2;        // viewers fed directly by the owner, or by one relaying viewer
// Swarm (torrent-like): viewers also fetch blocks from other viewers that have them
const SWARM_WAIT_MS = 4000;           // a viewer that takes longer than this for a block: ask someone else
const SWARM_PENALTY_MS = 10000;       // ...and leave that viewer alone for a while (the player was waiting)
const SWARM_SLOW_MS = 5000;           // ...or a short while (only the background buffer was waiting)
const SWARM_PEER_IN_FLIGHT = 12;      // blocks asked from one viewer at a time
const SWARM_URGENT_IN_FLIGHT = 4;     // a block the player waits for only goes to a viewer this idle
const SWARM_NEAR_BLOCKS = 2;         // the next blocks are fetched in order; past them each viewer has its own order
const OWNER_BIAS = 3;                 // the owner counts as this much busier: its upload is the one everyone shares
const HASH_WAIT_MS = 10000;           // the owner's checksum for a block
const SWARM_HASH_AHEAD = 64;          // checksums asked for ahead of the blocks themselves

/** Checksums need crypto.subtle (https or localhost); without it there's no swarm. */
export const canChecksum = () => typeof crypto !== 'undefined' && Boolean(crypto.subtle);

/** SHA-256 of a block, as hex (the owner's checksums; checks blocks that came from other viewers). */
export async function sha256Hex(data) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Make sure this page is controlled by the service worker. A page opened with a hard refresh
 * (Ctrl+Shift+R), or before the worker finished starting, isn't: ask the worker to take it over.
 * Resolves with the controller, or null (no service workers here, or it took too long).
 */
async function ensureController(sw, timeoutMs = 6000) {
  if (sw.controller) return sw.controller;
  // No worker registered for this site (dev builds, blocked): don't wait for one
  const existing = await sw.getRegistration().catch(() => null);
  if (!existing) return null;
  const changed = new Promise((resolve) => sw.addEventListener('controllerchange', resolve, { once: true }));
  const deadline = sleep(timeoutMs);
  const registration = await Promise.race([sw.ready.catch(() => null), deadline]);
  if (!registration?.active) return sw.controller;
  try { registration.active.postMessage({ type: 'p2p-claim' }); } catch { /* old worker */ }
  await Promise.race([changed, deadline]);
  return sw.controller;
}

/**
 * True when this page is controlled by a service worker that can serve P2P streams
 * (the current one, not an older cached version). Takes up to ~7 s when the page has to be
 * taken over first, ~1.5 s at most otherwise.
 */
export async function detectOnDemandStreaming() {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  if (!sw || typeof MessageChannel === 'undefined') return false;
  const controller = await ensureController(sw);
  if (!controller) return false;
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const timer = setTimeout(() => { port1.close(); resolve(false); }, 1500);
    port1.onmessage = (event) => {
      clearTimeout(timer);
      port1.close();
      resolve(Boolean(event.data?.p2pStreaming));
    };
    try {
      controller.postMessage({ type: 'p2p-stream-ping' }, [port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/**
 * Serves blocks to one peer, in the order they are needed. On the owner the blocks come from the
 * local file; on a relaying viewer (options.readBlock) they come from its own stream cache.
 */
export class P2PRangeSender {
  constructor(file, dataChannel, options = {}) {
    this.file = file;
    this.dataChannel = dataChannel;
    this.streamNo = options.streamNo >>> 0;
    this.senderName = options.senderName || 'Peer';
    this.onError = options.onError || (() => { });
    this.blockSize = options.blockSize || RANGE_BLOCK_SIZE;
    this.fileSize = file ? file.size : options.fileSize;
    this.totalBlocks = Math.ceil(this.fileSize / this.blockSize);
    // (block) => Promise<Uint8Array>; default reads the local file
    this.readBlock = options.readBlock || ((block) => {
      const start = block * this.blockSize;
      return this.file.slice(start, Math.min(start + this.blockSize, this.file.size)).arrayBuffer()
        .then((buf) => new Uint8Array(buf));
    });
    this.onRequest = options.onRequest || null;   // relay: fetch the requested blocks upstream early
    this.onMiss = options.onMiss || null;         // swarm: a block we don't have (any more)
    this.onBlockRead = options.onBlockRead || null; // owner: each block read from the file (checksums)
    this.headerExtra = options.headerExtra || {};
    this.cancelType = options.cancelType || 'p2p-stream-cancel';
    this.isRelay = Boolean(options.readBlock);
    this.queue = [];
    this.current = -1;
    this.isPumping = false;
    this.isAborted = false;
    this.drainResolve = null;
  }

  /** The stream announcement; `extra.via` names the viewer that relays it to this peer. */
  static header(file, streamNo, senderName, extra = {}) {
    return {
      type: 'p2p-stream-header',
      mode: 'range',
      streamNo: streamNo >>> 0,
      fileName: file.name,
      fileSize: file.size,
      mimeType: getVideoMimeType(file),
      blockSize: RANGE_BLOCK_SIZE,
      sender: senderName,
      timestamp: Date.now(),
      ...extra
    };
  }

  /** Announce the stream (skipped when re-attaching to a rebuilt connection). */
  start() {
    try {
      this.dataChannel.send(JSON.stringify(P2PRangeSender.header(this.file, this.streamNo, this.senderName, this.headerExtra)));
    } catch (err) {
      this.onError(err);
    }
  }

  handleRequest({ blocks = [], urgent = false } = {}) {
    if (this.isAborted) return;
    const wanted = blocks
      .map((b) => b >>> 0)
      .filter((b) => b < this.totalBlocks && b !== this.current);
    this.onRequest?.(wanted, urgent);
    if (urgent) {
      // Needed right now (playback start / seek): jump the queue, in the order given
      this.queue = this.queue.filter((b) => !wanted.includes(b));
      this.queue.unshift(...wanted);
    } else {
      for (const b of wanted) if (!this.queue.includes(b)) this.queue.push(b);
    }
    this._pump();
  }

  handleCancel({ blocks = [] } = {}) {
    const drop = new Set(blocks.map((b) => b >>> 0));
    this.queue = this.queue.filter((b) => !drop.has(b));
  }

  _waitForDrain() {
    const dc = this.dataChannel;
    if (dc.bufferedAmount <= RANGE_BUFFER_HIGH) return Promise.resolve();
    return new Promise((resolve) => {
      dc.bufferedAmountLowThreshold = RANGE_BUFFER_LOW;
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done);
        this.drainResolve = null;
        resolve();
      };
      this.drainResolve = done;
      dc.addEventListener('bufferedamountlow', done);
    });
  }

  async _pump() {
    if (this.isPumping || this.isAborted) return;
    this.isPumping = true;
    try {
      while (this.queue.length && !this.isAborted) {
        const block = this.queue.shift();
        this.current = block;
        let data;
        try {
          data = await this.readBlock(block);
        } catch (err) {
          if (this.isRelay) { // relay couldn't get it in time / swarm: we don't have it: the peer asks someone else
            this.onMiss?.(block);
            continue;
          }
          throw err;
        }
        if (this.isAborted) break;
        this.onBlockRead?.(block, data);
        for (let offset = 0; offset < data.length && !this.isAborted; offset += RANGE_PACKET_PAYLOAD) {
          await this._waitForDrain();
          if (this.isAborted || this.dataChannel.readyState !== 'open') break;
          const payload = data.subarray(offset, Math.min(offset + RANGE_PACKET_PAYLOAD, data.length));
          const packet = new Uint8Array(RANGE_HEADER_BYTES + payload.length);
          const view = new DataView(packet.buffer);
          view.setUint32(0, RANGE_PACKET_MAGIC, false);
          view.setUint32(4, this.streamNo, false);
          view.setUint32(8, block, false);
          view.setUint32(12, offset, false);
          packet.set(payload, RANGE_HEADER_BYTES);
          this.dataChannel.send(packet.buffer);
        }
        this.current = -1;
      }
    } catch (err) {
      if (!this.isAborted) this.onError(err);
    } finally {
      this.current = -1;
      this.isPumping = false;
    }
  }

  abort() {
    if (this.isAborted) return;
    this.isAborted = true;
    this.queue = [];
    if (this.drainResolve) this.drainResolve();
    try {
      if (this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify({ type: this.cancelType, streamNo: this.streamNo, timestamp: Date.now() }));
      }
    } catch { }
  }
}

/** Guest side: block cache + reads for the service worker. */
export class P2PRangeReceiver {
  constructor(header, options = {}) {
    this.streamNo = header.streamNo >>> 0;
    this.fileName = header.fileName || 'video';
    this.fileSize = header.fileSize;
    this.mimeType = header.mimeType || 'video/mp4';
    this.blockSize = header.blockSize || RANGE_BLOCK_SIZE;
    this.totalBlocks = Math.ceil(this.fileSize / this.blockSize);
    // Who we fetch from: the owner of the file, or a parent viewer that relays it
    this.ownerId = options.ownerId ?? null;
    this.sourceId = options.sourceId ?? this.ownerId;
    this.getChannel = options.getChannel || null; // (peerId) => open data channel or null
    this.onSourceChange = options.onSourceChange || (() => { });
    this.sendControl = options.sendControl || ((msg) => this._send(msg));
    this.onProgress = options.onProgress || (() => { });
    this.onError = options.onError || (() => { });
    this.cacheLimit = options.cacheLimit || STREAM_CACHE_BYTES;
    this.bufferAhead = Math.min(options.bufferAhead || BUFFER_AHEAD_BYTES, this.cacheLimit * 0.5);
    this.window = null; // { first, last } blocks the background buffer keeps filled

    this.blocks = new Map();   // block -> { data, received, done, waiters }
    this.pending = new Map();  // block -> time requested
    this.cachedBytes = 0;
    this.isAborted = false;
    this.lastProgressTime = Date.now();
    this.lastProgressBytes = 0;
    this.lastSpeed = 0;
    this.url = `${P2P_STREAM_URL_PREFIX}${this.streamNo}/${encodeURIComponent(this.fileName)}`;

    // Swarm: only when we asked for it and the owner's app does it too (older owners: as before)
    this.swarm = Boolean(options.swarm) && header.swarm === true;
    this.sendTo = options.sendTo || ((peerId, msg) => {
      const channel = this.getChannel?.(peerId);
      if (!channel) return false;
      try { channel.send(JSON.stringify(msg)); return true; } catch { return false; }
    });
    this.hashBlock = options.hashBlock || sha256Hex;
    this.onBadBlock = options.onBadBlock || (() => { });
    this.sourceOf = new Map();   // block -> peer we asked for it
    this.peerHave = new Map();   // viewer -> Uint8Array (1 = has that block)
    this.lastDataFrom = new Map(); // viewer -> when its last packet arrived
    this.banned = new Set();     // viewers that sent a block that didn't match the owner's checksum
    this.penalty = new Map();    // viewer -> time until which it isn't asked
    this.hashes = new Map();     // block -> hex (from the owner)
    this.hashWaiters = new Map();
    this.hashAsked = new Map();
    this.hashBatch = null;
    this.haveVersion = 0;        // changes when the blocks we hold change (for announcing them)
    this.haveAdded = [];         // since the last announcement
    this.haveRemoved = [];
    this.gettingAdded = [];      // blocks we asked the owner for, since the last announcement
    this.peerGetting = new Map(); // viewer -> Map(block -> when it said it's getting it from the owner)
    this.seed = options.seed ?? Math.random();
    this.stats = { fromOwner: 0, fromPeers: 0, rejected: 0 };
    // Why blocks went where (for tests and tuning)
    this.counts = { ownerUrgent: 0, ownerRest: 0, peerUrgent: 0, peerRest: 0, slow: 0, slowUrgent: 0, misses: 0, waitBusy: 0, waitGetting: 0, bumps: 0 };
  }

  get isRelayed() {
    return this.sourceId !== null && this.sourceId !== this.ownerId;
  }

  _send(msg) {
    if (!this.getChannel) return;
    let channel = this.getChannel(this.sourceId);
    if (!channel && this.isRelayed) {
      this.useOwner('parent unreachable');
      return; // useOwner re-sends what is outstanding
    }
    try { channel?.send(JSON.stringify(msg)); } catch { }
  }

  /** Stop fetching through a parent viewer: ask the owner directly from now on. */
  useOwner(reason = '') {
    if (!this.isRelayed || this.isAborted) return;
    this.sourceId = this.ownerId;
    this.onSourceChange(this.ownerId, reason);
    // Everything still outstanding goes to the owner now
    const urgent = [];
    const rest = [];
    for (const b of this.pending.keys()) {
      const entry = this.blocks.get(b);
      if (entry?.done) continue;
      (entry?.waiters.length ? urgent : rest).push(b);
    }
    const now = Date.now();
    for (const b of [...urgent, ...rest]) this.pending.set(b, now);
    if (urgent.length) this._send({ type: 'p2p-range-request', streamNo: this.streamNo, blocks: urgent, urgent: true });
    if (rest.length) this._send({ type: 'p2p-range-request', streamNo: this.streamNo, blocks: rest, urgent: false });
  }

  /** A peer left or its connection broke. */
  handlePeerGone(peerId) {
    if (this.isRelayed && peerId === this.sourceId) this.useOwner('parent left');
    if (this.swarm) this.dropPeer(peerId);
  }

  // ---- swarm ------------------------------------------------------------------------------------

  /** Blocks asked from this peer that may still come (late ones don't count). */
  _load(peerId) {
    const now = Date.now();
    let n = 0;
    for (const [b, at] of this.pending) if (this.sourceOf.get(b) === peerId && !this._late(b, at, now)) n++;
    return n;
  }

  /** Who to ask for a block: the least busy viewer that has it, else the owner. A block the
   *  player waits for goes to a viewer only if it's about as idle as the owner. */
  _pickSource(block, urgent) {
    if (!this.swarm) return this.sourceId;
    let best = this.ownerId;
    let bestLoad = urgent ? Math.min(SWARM_URGENT_IN_FLIGHT, this._load(this.ownerId) + OWNER_BIAS) : SWARM_PEER_IN_FLIGHT;
    const now = Date.now();
    for (const [peerId, have] of this.peerHave) {
      if (!have[block] || this.banned.has(peerId) || (this.penalty.get(peerId) || 0) > now) continue;
      const load = this._load(peerId);
      if (load < bestLoad) {
        best = peerId;
        bestLoad = load;
      }
    }
    return best;
  }

  /** Blocks asked from other viewers that didn't come in time: cancel there, leave them alone a while. */
  _penalizeSlow(blocks, ms = SWARM_SLOW_MS) {
    if (!this.swarm || !blocks.length) return;
    const slow = [];
    for (const b of blocks) {
      const source = this.sourceOf.get(b);
      if (source === undefined || source === this.ownerId) continue;
      this.penalty.set(source, Math.max(this.penalty.get(source) || 0, Date.now() + ms));
      this.counts[ms === SWARM_SLOW_MS ? 'slow' : 'slowUrgent']++;
      slow.push(b);
    }
    if (!slow.length) return;
    this._cancel(slow);
    for (const b of slow) {
      const entry = this.blocks.get(b);
      if (entry && !entry.done && entry.peer) this._resetBlock(entry);
    }
  }

  /** Ask for blocks (from the source, or in a swarm from whoever is best for each). */
  _ask(blocks, urgent = false) {
    if (!blocks.length) return;
    if (!this.swarm) {
      for (const b of blocks) {
        this.sourceOf.set(b, this.sourceId);
        if (urgent) this._block(b).urgent = true;
      }
      this.sendControl({ type: 'p2p-range-request', streamNo: this.streamNo, blocks, urgent });
      return;
    }
    const groups = new Map();
    for (const b of blocks) {
      const source = this._pickSource(b, urgent);
      this.counts[(source === this.ownerId ? 'owner' : 'peer') + (urgent ? 'Urgent' : 'Rest')]++;
      if (source === this.ownerId) this.gettingAdded.push(b);
      this.sourceOf.set(b, source);
      if (urgent) this._block(b).urgent = true;
      if (!groups.has(source)) groups.set(source, []);
      groups.get(source).push(b);
    }
    for (const [source, list] of groups) {
      if (source === this.ownerId) {
        this.sendControl({ type: 'p2p-range-request', streamNo: this.streamNo, blocks: list, urgent });
      } else if (this.sendTo(source, { type: 'p2p-range-request', streamNo: this.streamNo, blocks: list, urgent, swarm: true })) {
        this._needHashes(list);
      } else {
        this.dropPeer(source); // asks the owner instead
      }
    }
  }

  /** No longer needed: tell whoever we asked. */
  _cancel(blocks) {
    if (!blocks.length) return;
    if (!this.swarm) {
      this.sendControl({ type: 'p2p-range-cancel', streamNo: this.streamNo, blocks });
      return;
    }
    const groups = new Map();
    for (const b of blocks) {
      const source = this.sourceOf.get(b) ?? this.ownerId;
      this.sourceOf.delete(b);
      if (!groups.has(source)) groups.set(source, []);
      groups.get(source).push(b);
    }
    for (const [source, list] of groups) {
      if (source === this.ownerId) this.sendControl({ type: 'p2p-range-cancel', streamNo: this.streamNo, blocks: list });
      else this.sendTo(source, { type: 'p2p-range-cancel', streamNo: this.streamNo, blocks: list, swarm: true });
    }
  }

  /** Has a requested block taken too long? From another viewer: only if that viewer has stopped
   *  sending anything (a block far down its queue is fine while it keeps delivering). */
  _late(block, at, now = Date.now()) {
    if (this.swarm) {
      const source = this.sourceOf.get(block);
      if (source !== undefined && source !== this.ownerId) {
        const lastData = Math.max(at, this.lastDataFrom.get(source) || 0);
        return now - lastData > SWARM_WAIT_MS || now - at > BLOCK_WAIT_MS;
      }
    }
    return now - at > this._waitMs(block);
  }

  /** How long to wait for a block before asking again (or someone else). */
  _waitMs(block) {
    if (this.swarm) {
      const source = this.sourceOf.get(block);
      if (source !== undefined && source !== this.ownerId) return SWARM_WAIT_MS;
    }
    return this.isRelayed ? RELAY_WAIT_MS : BLOCK_WAIT_MS;
  }

  /** Ask again, elsewhere, for blocks we were waiting on from `peerId`. */
  _reroute(peerId, only = null) {
    const urgent = [];
    const rest = [];
    for (const b of [...this.pending.keys()]) {
      if (this.sourceOf.get(b) !== peerId || (only && !only.has(b))) continue;
      const entry = this.blocks.get(b);
      this.pending.delete(b);
      this.sourceOf.delete(b);
      if (!entry || entry.done) continue;
      if (entry.received) this._resetBlock(entry); // part came from them: start over
      if (entry.waiters.length) urgent.push(b);
      else if (entry.background || entry.forRelay) rest.push(b);
    }
    const now = Date.now();
    for (const b of [...urgent, ...rest]) this.pending.set(b, now);
    this._ask(urgent, true);
    this._ask(rest, false);
  }

  _resetBlock(entry) {
    entry.urgent = false;
    entry.data = new Uint8Array(entry.data.length);
    entry.received = 0;
    entry.got = new Set();
    entry.peer = null;
    entry.checking = false;
  }

  /** A viewer said which blocks it has (`ranges`: [first, last, first, last, ...]). */
  setPeerHave(peerId, ranges) {
    if (!this.swarm || peerId === this.ownerId || !Array.isArray(ranges)) return;
    const have = new Uint8Array(this.totalBlocks);
    for (let i = 0; i + 1 < ranges.length && i < 40000; i += 2) {
      const first = Math.max(0, ranges[i] >>> 0);
      const last = Math.min(this.totalBlocks - 1, ranges[i + 1] >>> 0);
      for (let b = first; b <= last; b++) have[b] = 1;
    }
    this.peerHave.set(peerId, have);
  }

  /** A viewer's blocks changed: `add` / `remove` lists (after a full `setPeerHave`), and the
   *  blocks it is `getting` from the owner right now. */
  updatePeerHave(peerId, add = [], remove = [], getting = []) {
    const have = this.peerHave.get(peerId);
    if (!have) return;
    const gets = this.peerGetting.get(peerId);
    for (const b of Array.isArray(add) ? add.slice(0, 20000) : []) {
      if ((b >>> 0) < have.length) have[b >>> 0] = 1;
      gets?.delete(b >>> 0);
    }
    for (const b of Array.isArray(remove) ? remove.slice(0, 20000) : []) if ((b >>> 0) < have.length) have[b >>> 0] = 0;
    this.notePeerGetting(peerId, getting);
  }

  notePeerGetting(peerId, blocks) {
    if (!this.swarm || !Array.isArray(blocks) || !blocks.length) return;
    if (!this.peerGetting.has(peerId)) this.peerGetting.set(peerId, new Map());
    const gets = this.peerGetting.get(peerId);
    const now = Date.now();
    for (const b of blocks.slice(0, 2000)) if ((b >>> 0) < this.totalBlocks) gets.set(b >>> 0, now);
  }

  /** Is another viewer getting this block from the owner right now (so it'll have it soon)? */
  _someoneGetting(b, now = Date.now()) {
    for (const [peerId, gets] of this.peerGetting) {
      const at = gets.get(b);
      if (at === undefined) continue;
      if (now - at > 2 * SWARM_WAIT_MS || this.banned.has(peerId) || !this.peerHave.has(peerId)) {
        gets.delete(b);
        continue;
      }
      return true;
    }
    return false;
  }

  /** What changed since the last announcement (and forget it): { add, remove, getting } */
  takeHaveChanges() {
    const out = { add: this.haveAdded, remove: this.haveRemoved, getting: this.gettingAdded };
    this.haveAdded = [];
    this.haveRemoved = [];
    this.gettingAdded = [];
    return out;
  }

  /** Blocks we're getting from the owner now (for a full announcement). */
  gettingNow() {
    const out = [];
    for (const b of this.pending.keys()) if ((this.sourceOf.get(b) ?? this.ownerId) === this.ownerId) out.push(b);
    return out;
  }

  /** The blocks we hold, for announcing: [first, last, first, last, ...] */
  haveRanges() {
    const done = [];
    for (const [b, entry] of this.blocks) if (entry.done) done.push(b);
    done.sort((a, b) => a - b);
    const ranges = [];
    for (const b of done) {
      if (ranges.length && ranges[ranges.length - 1] === b - 1) ranges[ranges.length - 1] = b;
      else ranges.push(b, b);
    }
    return ranges;
  }

  /** A block we hold (for another viewer), or null. */
  getCachedBlock(index) {
    const entry = this.blocks.get(index);
    return entry?.done ? entry.data : null;
  }

  /** A viewer doesn't have these blocks (any more): ask someone else. */
  handleMiss(peerId, blocks = []) {
    this.counts.misses += blocks.length;
    const have = this.peerHave.get(peerId);
    const set = new Set();
    for (const b of blocks) {
      const i = b >>> 0;
      if (have && i < have.length) have[i] = 0;
      set.add(i);
    }
    this._reroute(peerId, set);
  }

  /** A viewer stopped (left, closed the video): forget what it has, ask elsewhere. */
  dropPeer(peerId) {
    if (!this.swarm || peerId === this.ownerId) return;
    this.peerHave.delete(peerId);
    this.peerGetting.delete(peerId);
    this._reroute(peerId);
  }

  _needHashes(blocks) {
    const now = Date.now();
    for (const b of blocks) {
      if (this.hashes.has(b)) continue;
      const at = this.hashAsked.get(b);
      if (at !== undefined && now - at < HASH_WAIT_MS) continue;
      this.hashAsked.set(b, now);
      if (!this.hashBatch) {
        this.hashBatch = [];
        Promise.resolve().then(() => {
          const list = this.hashBatch;
          this.hashBatch = null;
          if (list.length && !this.isAborted) this.sendControl({ type: 'p2p-hash-request', streamNo: this.streamNo, blocks: list });
        });
      }
      this.hashBatch.push(b);
    }
  }

  /** The owner's checksums: [[block, hex], ...] */
  addHashes(list = []) {
    for (const item of list) {
      if (!Array.isArray(item) || typeof item[1] !== 'string') continue;
      const b = item[0] >>> 0;
      this.hashes.set(b, item[1]);
      const waiters = this.hashWaiters.get(b);
      if (waiters) {
        this.hashWaiters.delete(b);
        for (const w of waiters) w(item[1]);
      }
    }
  }

  _hashFor(index) {
    if (this.hashes.has(index)) return Promise.resolve(this.hashes.get(index));
    this._needHashes([index]);
    return new Promise((resolve) => {
      if (!this.hashWaiters.has(index)) this.hashWaiters.set(index, []);
      const list = this.hashWaiters.get(index);
      list.push(resolve);
      setTimeout(() => {
        const i = list.indexOf(resolve);
        if (i !== -1) {
          list.splice(i, 1);
          resolve(null);
        }
      }, HASH_WAIT_MS);
    });
  }

  /** A block from another viewer: keep it only if it matches the owner's checksum. */
  async _check(index, entry) {
    entry.checking = true;
    const peerId = entry.peer;
    const t0 = Date.now();
    const expected = await this._hashFor(index);
    this.counts.hashMaxMs = Math.max(this.counts.hashMaxMs || 0, Date.now() - t0);
    const actual = expected ? await this.hashBlock(entry.data) : null;
    if (this.isAborted || this.blocks.get(index) !== entry || !entry.checking) return;
    entry.checking = false;
    if (expected && actual === expected) {
      this._finish(index, entry, peerId);
      return;
    }
    // Damaged, or no checksum to compare with: don't use it, get it from the owner
    if (expected) {
      this.stats.rejected++;
      this.banned.add(peerId);
      this.peerHave.delete(peerId);
      this.onBadBlock(peerId, index);
    } else {
      this.penalty.set(peerId, Date.now() + SWARM_PENALTY_MS);
    }
    this._resetBlock(entry);
    this.pending.delete(index);
    this.sourceOf.delete(index);
    if (entry.waiters.length || entry.background || entry.forRelay) {
      this.pending.set(index, Date.now());
      this._ask([index], entry.waiters.length > 0);
    }
  }

  _finish(index, entry, from) {
    entry.done = true;
    this.pending.delete(index);
    this.sourceOf.delete(index);
    this.cachedBytes += entry.data.length;
    if (this.swarm && from !== undefined && from !== null && from !== this.ownerId) this.stats.fromPeers += entry.data.length;
    else this.stats.fromOwner += entry.data.length;
    this.haveVersion++;
    if (this.swarm) this.haveAdded.push(index);
    entry.got = null;
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const w of waiters) w.resolve();
    this._reportProgress();
    if (entry.background) this._topUp();
  }

  _block(index) {
    let entry = this.blocks.get(index);
    if (!entry) {
      const size = Math.min(this.blockSize, this.fileSize - index * this.blockSize);
      entry = { data: new Uint8Array(size), received: 0, done: false, waiters: [], got: new Set() };
      this.blocks.set(index, entry);
    }
    return entry;
  }

  handleChunk(arrayBuffer, fromPeerId = null) {
    if (this.isAborted || arrayBuffer.byteLength < RANGE_HEADER_BYTES) return;
    const view = new DataView(arrayBuffer);
    if (view.getUint32(0, false) !== RANGE_PACKET_MAGIC) return;
    if (view.getUint32(4, false) !== this.streamNo) return; // left over from a previous video
    const index = view.getUint32(8, false);
    const offset = view.getUint32(12, false);
    if (index >= this.totalBlocks) return;

    const entry = this._block(index);
    if (entry.done || entry.checking) return;
    const payload = new Uint8Array(arrayBuffer, RANGE_HEADER_BYTES);
    if (offset + payload.length > entry.data.length) return;
    if (entry.got.has(offset)) return; // the same part twice (asked again, two senders)
    entry.got.add(offset);
    entry.data.set(payload, offset);
    entry.received += payload.length;
    // Any part from another viewer (not the owner): the whole block gets checked
    if (this.swarm && fromPeerId !== null && fromPeerId !== this.ownerId) {
      entry.peer = fromPeerId;
      this.lastDataFrom.set(fromPeerId, Date.now());
    }
    if (entry.received >= entry.data.length) {
      if (entry.peer) this._check(index, entry);
      else this._finish(index, entry, fromPeerId);
    }
  }

  /** The player reads at `index`: the background buffer follows. */
  _noteReading(index) {
    if (this.window && this.window.first === index + 1) return;
    const last = Math.min(this.totalBlocks - 1, index + Math.ceil(this.bufferAhead / this.blockSize));
    this.window = { first: index + 1, last };
    // Background requests for parts nobody needs now (the player moved, e.g. a seek): cancel them
    const stale = [];
    for (const b of this.pending.keys()) {
      const entry = this.blocks.get(b);
      if (entry?.background && (b < index || b > last) && !entry.waiters.length && !entry.forRelay) {
        stale.push(b);
        entry.background = false;
      }
    }
    if (stale.length) {
      for (const b of stale) this.pending.delete(b);
      this._cancel(stale);
    }
    this._topUp();
  }

  /** Keep a few background blocks in flight, nearest first. */
  _topUp() {
    if (this.isAborted || !this.window) return;
    const now = Date.now();
    let inFlight = 0;
    let ownerInFlight = 0;
    for (const [b, at] of this.pending) {
      if (this._late(b, at, now)) continue;
      inFlight++;
      if ((this.sourceOf.get(b) ?? this.ownerId) === this.ownerId) ownerInFlight++;
    }
    const { first, last } = this.window;
    if (!this.swarm || !this.peerHave.size) {
      // Alone (or no swarm): nearest first
      const wanted = [];
      for (let b = first; b <= last && inFlight + wanted.length < BUFFER_IN_FLIGHT_BLOCKS; b++) {
        if (this._needsFetch(b, now)) wanted.push(b);
      }
      this._askBackground(wanted, now);
      return;
    }
    // Swarm: blocks other viewers have go to them (up to what each takes at a time); the owner
    // gets only blocks nobody has, a few at a time. Past the next few blocks each viewer goes
    // through the window in its own order, so viewers watching together fetch different parts
    // from the owner and then swap them, instead of all asking the owner for the same ones.
    const limit = BUFFER_IN_FLIGHT_BLOCKS + Math.min(3, this.peerHave.size) * SWARM_PEER_IN_FLIGHT;
    const ownerLimit = Math.ceil(BUFFER_IN_FLIGHT_BLOCKS / 2);
    const fromPeers = [];
    const fromOwner = [];
    const planned = new Map(); // viewer -> blocks this round
    const near = Math.min(last, first + SWARM_NEAR_BLOCKS - 1);
    const span = last - near;
    const offset = span > 0 ? Math.floor(this.seed * span) : 0;
    for (let i = 0; i <= last - first && inFlight + fromPeers.length + fromOwner.length < limit; i++) {
      const b = first + i <= near ? first + i : near + 1 + ((i - (near - first + 1) + offset) % span);
      if (!this._needsFetch(b, now)) continue;
      const holders = this._holders(b, now, planned);
      if (holders.free) {
        fromPeers.push(b);
        planned.set(holders.free, (planned.get(holders.free) || 0) + 1);
      }
      else if (holders.any) this.counts.waitBusy++; // they're busy: wait for them, not the owner
      else if (this._someoneGetting(b, now)) this.counts.waitGetting++; // another viewer is getting it from the owner
      else if (ownerInFlight + fromOwner.length < ownerLimit) fromOwner.push(b);
    }
    this.counts.bgOwner = (this.counts.bgOwner || 0) + fromOwner.length;
    this._askBackground([...fromPeers, ...fromOwner], now);
    // Checksums for what's coming, before other viewers' blocks arrive (so checking them doesn't wait)
    const hashesAhead = [];
    for (let b = first; b <= last && hashesAhead.length < SWARM_HASH_AHEAD; b++) {
      if (!this.hashes.has(b) && !this.blocks.get(b)?.done) hashesAhead.push(b);
    }
    this._needHashes(hashesAhead);
  }

  /** Not here, not checking, and not asked for (or asked too long ago). */
  _needsFetch(b, now) {
    const entry = this.blocks.get(b);
    if (entry?.done || entry?.checking) return false;
    const at = this.pending.get(b);
    return at === undefined || this._late(b, at, now);
  }

  _askBackground(blocks, now) {
    const again = blocks.filter((b) => this.pending.has(b));
    this._penalizeSlow(again);
    for (const b of blocks) {
      this.pending.set(b, now);
      this._block(b).background = true;
    }
    this._ask(blocks, false);
  }

  /** Viewers that have block `b`: { any, free } (free: the least busy one that can take another
   *  request, counting `planned` ones not sent yet). */
  _holders(b, now = Date.now(), planned = null) {
    let any = false;
    let free = null;
    let freeLoad = SWARM_PEER_IN_FLIGHT;
    for (const [peerId, have] of this.peerHave) {
      if (!have[b] || this.banned.has(peerId) || (this.penalty.get(peerId) || 0) > now) continue;
      any = true;
      const load = this._load(peerId) + (planned?.get(peerId) || 0);
      if (load < freeLoad) {
        free = peerId;
        freeLoad = load;
      }
    }
    return { any, free };
  }

  /** Legacy push-stream completion message: not used in on-demand mode. */
  handleComplete() { }

  _reportProgress(force = false) {
    const now = Date.now();
    if (!force && now - this.lastProgressTime < 400 && this.cachedBytes < this.fileSize) return;
    const dt = Math.max(0.05, (now - this.lastProgressTime) / 1000);
    this.lastSpeed = ((this.cachedBytes - this.lastProgressBytes) / (1024 * 1024)) / dt;
    this.lastProgressTime = now;
    this.lastProgressBytes = this.cachedBytes;
    let doneBlocks = 0;
    for (const entry of this.blocks.values()) if (entry.done) doneBlocks++;
    this.onProgress({
      percent: Math.min(100, Math.round((this.cachedBytes / this.fileSize) * 100)),
      receivedBytes: this.cachedBytes,
      totalBytes: this.fileSize,
      receivedChunksCount: doneBlocks,
      totalChunks: this.totalBlocks,
      speedMBs: Math.max(0, this.lastSpeed),
      isReady: true,
      isCompleted: this.cachedBytes >= this.fileSize,
      ...(this.swarm ? {
        fromPeersPercent: Math.round((100 * this.stats.fromPeers) / Math.max(1, this.stats.fromPeers + this.stats.fromOwner)),
        swarmPeers: [...this.peerHave.keys()].filter((id) => !this.banned.has(id)).length,
        rejectedBlocks: this.stats.rejected
      } : {})
    });
  }

  /** Make sure `index` and the read-ahead after it are requested; drop stale read-ahead. */
  _request(index) {
    const ahead = Math.ceil(RANGE_PREFETCH_BYTES / this.blockSize);
    const last = Math.min(this.totalBlocks - 1, index + ahead);
    const now = Date.now();

    // Read-ahead nobody is waiting for any more (the viewer seeked away): cancel it
    const stale = [];
    for (const b of this.pending.keys()) {
      const entry = this.blocks.get(b);
      const inWindow = this.window && b >= this.window.first && b <= this.window.last;
      if ((b < index || b > last) && !inWindow && !(entry && (entry.waiters.length || entry.forRelay))) stale.push(b);
    }
    if (stale.length) {
      for (const b of stale) this.pending.delete(b);
      this._cancel(stale);
    }

    const again = [];
    const isMissing = (b) => {
      const entry = this.blocks.get(b);
      if (entry?.done || entry?.checking) return false;
      const at = this.pending.get(b);
      const late = at !== undefined && this._late(b, at, now);
      if (late) again.push(b);
      return at === undefined || late;
    };
    if (isMissing(index)) {
      this._penalizeSlow(again);
      again.length = 0;
      this.pending.set(index, now);
      this._ask([index], true);
    } else {
      // Already asked for (read-ahead or background, maybe far down someone's queue): the player
      // waits for it now, so move it to the front
      const entry = this._block(index);
      if (!entry.done && !entry.checking && !entry.urgent && this.pending.has(index)) {
        entry.urgent = true;
        this.counts.bumps++;
        this.pending.set(index, now);
        const source = this.sourceOf.get(index) ?? this.sourceId;
        const msg = { type: 'p2p-range-request', streamNo: this.streamNo, blocks: [index], urgent: true };
        if (this.swarm && source !== this.ownerId) this.sendTo(source, { ...msg, swarm: true });
        else this.sendControl(msg);
      }
    }
    const prefetch = [];
    // Swarm with others watching: the background buffer (which shares the work out) covers this
    const others = this.swarm && this.peerHave.size > 0;
    const byBackground = others && this.window && this.window.first <= index + 1 && this.window.last >= last;
    // ...and before it starts, read ahead only a little, leaving what others are fetching to them
    const prefetchTo = others ? Math.min(last, index + SWARM_NEAR_BLOCKS) : last;
    for (let b = index + 1; b <= prefetchTo && !byBackground; b++) {
      if (others && !this._holders(b, now).free && this._someoneGetting(b, now)) continue;
      if (isMissing(b)) {
        this.pending.set(b, now);
        prefetch.push(b);
      }
    }
    this._penalizeSlow(again);
    this.counts.prefetch = (this.counts.prefetch || 0) + prefetch.length;
    this._ask(prefetch, false);
  }

  _waitForBlock(index) {
    const entry = this._block(index);
    if (entry.done) return Promise.resolve();
    const waitMs = this._waitMs(index);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      entry.waiters.push(waiter);
      setTimeout(() => {
        const i = entry.waiters.indexOf(waiter);
        if (i !== -1) {
          entry.waiters.splice(i, 1);
          reject(new Error('timeout'));
        }
      }, waitMs);
    });
  }

  /** Bytes from `position` (at most `maxLength`, never past the end of its block). */
  async read(position, maxLength) {
    const index = Math.floor(position / this.blockSize);
    let patience = 2;
    for (let attempt = 1; ; attempt++) {
      if (this.isAborted) throw new Error('aborted');
      this._request(index);
      try {
        await this._waitForBlock(index);
        break;
      } catch (err) {
        if (this.isAborted) throw err;
        const source = this.sourceOf.get(index);
        if (this.isRelayed) {
          this.useOwner('parent too slow'); // doesn't count as a failed try
          attempt -= 1;
        } else if (this.swarm && source !== undefined && source !== this.ownerId) {
          attempt -= 1; // not a failed try
          const at = this.pending.get(index);
          if (at !== undefined && !this._late(index, at) && patience-- > 0) { // it's busy sending us data: give it a moment
            this.counts.patience = (this.counts.patience || 0) + 1;
            continue;
          }
          this._penalizeSlow([index], SWARM_PENALTY_MS); // too slow: ask elsewhere
        } else if (attempt >= BLOCK_MAX_TRIES) {
          throw err;
        }
        this.pending.delete(index); // ask again
      }
    }
    const entry = this.blocks.get(index);
    const from = position - index * this.blockSize;
    const to = Math.min(entry.data.length, from + maxLength);
    const out = entry.data.slice(from, to).buffer;
    this._evict(index);
    return out;
  }

  /** Over the memory limit: drop the blocks furthest from `index` (where the player reads). */
  _evict(index) {
    if (this.cachedBytes <= this.cacheLimit) return;
    const keepFrom = index - Math.ceil((this.cacheLimit * KEEP_BEHIND_SHARE) / this.blockSize);
    const keepTo = Math.max(index + Math.ceil(RANGE_PREFETCH_BYTES / this.blockSize), this.window?.last ?? 0);
    const victims = [];
    for (const [b, entry] of this.blocks) {
      if (entry.done && !entry.waiters.length && !entry.forRelay && (b < keepFrom || b > keepTo)) victims.push(b);
    }
    victims.sort((a, b) => Math.abs(b - index) - Math.abs(a - index));
    for (const b of victims) {
      if (this.cachedBytes <= this.cacheLimit * 0.9) break;
      this.cachedBytes -= this.blocks.get(b).data.length;
      this.blocks.delete(b);
      this.haveVersion++;
      if (this.swarm) this.haveRemoved.push(b);
    }
  }

  /** Relay: a child asked us for these blocks; fetch the ones we don't have from our source. */
  want(blocks, urgent = false) {
    if (this.isAborted) return;
    const now = Date.now();
    const missing = [];
    for (const b of blocks) {
      if (b >= this.totalBlocks) continue;
      const entry = this._block(b);
      if (entry.done) continue;
      entry.forRelay = true;
      const at = this.pending.get(b);
      if (at === undefined || this._late(b, at, now)) {
        this.pending.set(b, now);
        missing.push(b);
      }
    }
    this._ask(missing, urgent);
  }

  /** Relay: the data of one block, fetching it from our source if needed. */
  async getBlock(index) {
    for (let attempt = 1; ; attempt++) {
      if (this.isAborted) throw new Error('aborted');
      this.want([index], true);
      try {
        await this._waitForBlock(index);
        return this.blocks.get(index).data;
      } catch (err) {
        if (this.isAborted || attempt >= 2) throw err;
        if (this.isRelayed) this.useOwner('parent too slow');
        this.pending.delete(index);
      }
    }
  }

  /** Answer one service-worker range request over `port` (bytes start..end inclusive). */
  serve(port, start, end) {
    if (this.isAborted || start >= this.fileSize) {
      port.postMessage({ type: 'meta', ok: false, size: this.fileSize });
      return;
    }
    const last = end === null || end === undefined ? this.fileSize - 1 : Math.min(end, this.fileSize - 1);
    let cursor = start;
    let closed = false;
    let served = 0;
    port.onmessage = async (event) => {
      const msg = event.data || {};
      if (msg.type === 'cancel') {
        closed = true;
        port.onmessage = null;
        port.close();
        return;
      }
      if (msg.type !== 'read') return;
      if (cursor > last) {
        port.postMessage({ done: true });
        return;
      }
      try {
        const buffer = await this.read(cursor, Math.min(msg.want || this.blockSize, last - cursor + 1));
        cursor += buffer.byteLength;
        served += buffer.byteLength;
        if (served >= ANCHOR_MIN_BYTES) this._noteReading(Math.floor((cursor - 1) / this.blockSize));
        port.postMessage({ data: buffer }, [buffer]);
      } catch {
        port.postMessage({ error: true });
      }
    };
    port.postMessage({ type: 'meta', ok: true, size: this.fileSize, mimeType: this.mimeType });
  }

  /** Close the stream: drops the cache (video changed / left the room). */
  abort() {
    this.isAborted = true;
    for (const entry of this.blocks.values()) {
      for (const w of entry.waiters) w.reject(new Error('aborted'));
      entry.waiters = [];
    }
    this.blocks.clear();
    this.pending.clear();
    this.sourceOf.clear();
    this.peerHave.clear();
    for (const list of this.hashWaiters.values()) for (const w of list) w(null);
    this.hashWaiters.clear();
  }
}
