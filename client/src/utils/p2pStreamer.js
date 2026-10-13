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

/**
 * P2P Stream Receiver: Assembles incoming binary chunks and exposes playback via Blob / MSE.
 */
export class P2PStreamReceiver {
  constructor(header, options = {}) {
    this.streamId = header.streamId;
    this.fileName = header.fileName;
    this.fileSize = header.fileSize;
    this.mimeType = header.mimeType || 'video/mp4';
    this.chunkSize = header.chunkSize || STREAM_CHUNK_SIZE;
    this.totalChunks = header.totalChunks || Math.ceil(this.fileSize / this.chunkSize);
    this.sender = header.sender || 'Peer';

    this.onReady = options.onReady || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});

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
    this.useMSE = Boolean(window.MediaSource && MediaSource.isTypeSupported(this.mimeType));
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
   in 256 KB blocks, plus a small read-ahead. So playback starts after the first few blocks,
   seeking works anywhere (including MP4s whose index sits at the end of the file), and only
   what is actually watched gets transferred. Received blocks stay in memory until the stream
   is closed (video change / leaving), so rewinding or re-watching never re-downloads.

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
// The player is fed at most this far past the playback position (it would otherwise pull the
// whole file as fast as the connection allows). ~8 s + the 2 MB read-ahead = ~10 s buffered.
const PLAYER_AHEAD_SEC = 8;
const PLAYER_AHEAD_MIN_BYTES = 2 * 1024 * 1024;
const INDEX_READ_BYTES = 2 * 1024 * 1024; // reads far from playback (file index, seek) are never held
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

/**
 * True when this page is controlled by a service worker that can serve P2P streams
 * (the current one, not an older cached version). Resolves within ~1.5 s.
 */
export function detectOnDemandStreaming() {
  const controller = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null;
  if (!controller || typeof MessageChannel === 'undefined') return Promise.resolve(false);
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
      this.dataChannel.send(JSON.stringify(P2PRangeSender.header(this.file, this.streamNo, this.senderName)));
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
          if (this.isRelay) continue; // relay couldn't get it in time: the child asks the owner
          throw err;
        }
        if (this.isAborted) break;
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
    // () => { byte, bytesPerSec } of the video using this stream, or null if unknown yet
    this.getPlaybackInfo = options.getPlaybackInfo || (() => null);

    this.blocks = new Map();   // block -> { data, received, done, waiters }
    this.pending = new Map();  // block -> time requested
    this.cachedBytes = 0;
    this.isAborted = false;
    this.lastProgressTime = Date.now();
    this.lastProgressBytes = 0;
    this.lastSpeed = 0;
    this.url = `${P2P_STREAM_URL_PREFIX}${this.streamNo}/${encodeURIComponent(this.fileName)}`;
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
  }

  _block(index) {
    let entry = this.blocks.get(index);
    if (!entry) {
      const size = Math.min(this.blockSize, this.fileSize - index * this.blockSize);
      entry = { data: new Uint8Array(size), received: 0, done: false, waiters: [] };
      this.blocks.set(index, entry);
    }
    return entry;
  }

  handleChunk(arrayBuffer) {
    if (this.isAborted || arrayBuffer.byteLength < RANGE_HEADER_BYTES) return;
    const view = new DataView(arrayBuffer);
    if (view.getUint32(0, false) !== RANGE_PACKET_MAGIC) return;
    if (view.getUint32(4, false) !== this.streamNo) return; // left over from a previous video
    const index = view.getUint32(8, false);
    const offset = view.getUint32(12, false);
    if (index >= this.totalBlocks) return;

    const entry = this._block(index);
    if (entry.done) return;
    const payload = new Uint8Array(arrayBuffer, RANGE_HEADER_BYTES);
    if (offset + payload.length > entry.data.length) return;
    entry.data.set(payload, offset);
    entry.received += payload.length;
    if (entry.received >= entry.data.length) {
      entry.done = true;
      this.pending.delete(index);
      this.cachedBytes += entry.data.length;
      const waiters = entry.waiters;
      entry.waiters = [];
      for (const w of waiters) w.resolve();
      this._reportProgress();
    }
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
      isCompleted: this.cachedBytes >= this.fileSize
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
      if ((b < index || b > last) && !(entry && (entry.waiters.length || entry.forRelay))) stale.push(b);
    }
    if (stale.length) {
      for (const b of stale) this.pending.delete(b);
      this.sendControl({ type: 'p2p-range-cancel', streamNo: this.streamNo, blocks: stale });
    }

    const isMissing = (b) => {
      const entry = this.blocks.get(b);
      if (entry?.done) return false;
      const at = this.pending.get(b);
      return at === undefined || now - at > BLOCK_WAIT_MS;
    };
    if (isMissing(index)) {
      this.pending.set(index, now);
      this.sendControl({ type: 'p2p-range-request', streamNo: this.streamNo, blocks: [index], urgent: true });
    }
    const prefetch = [];
    for (let b = index + 1; b <= last; b++) {
      if (isMissing(b)) {
        this.pending.set(b, now);
        prefetch.push(b);
      }
    }
    if (prefetch.length) {
      this.sendControl({ type: 'p2p-range-request', streamNo: this.streamNo, blocks: prefetch, urgent: false });
    }
  }

  _waitForBlock(index) {
    const entry = this._block(index);
    if (entry.done) return Promise.resolve();
    const waitMs = this.isRelayed ? RELAY_WAIT_MS : BLOCK_WAIT_MS;
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
    for (let attempt = 1; ; attempt++) {
      if (this.isAborted) throw new Error('aborted');
      this._request(index);
      try {
        await this._waitForBlock(index);
        break;
      } catch (err) {
        if (this.isAborted) throw err;
        if (this.isRelayed) {
          this.useOwner('parent too slow'); // doesn't count as a failed try
          attempt -= 1;
        } else if (attempt >= BLOCK_MAX_TRIES) {
          throw err;
        }
        this.pending.delete(index); // ask again
      }
    }
    const entry = this.blocks.get(index);
    const from = position - index * this.blockSize;
    const to = Math.min(entry.data.length, from + maxLength);
    return entry.data.slice(from, to).buffer;
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
      if (at === undefined || now - at > (this.isRelayed ? RELAY_WAIT_MS : BLOCK_WAIT_MS)) {
        this.pending.set(b, now);
        missing.push(b);
      }
    }
    if (missing.length) this.sendControl({ type: 'p2p-range-request', streamNo: this.streamNo, blocks: missing, urgent });
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

  /** Hold a read while it is far enough ahead of playback; returns when it may proceed. */
  async _paceRead(cursor, readerStart, isClosed) {
    for (;;) {
      if (this.isAborted || isClosed()) return;
      const info = this.getPlaybackInfo();
      if (!info) return;
      const ahead = Math.max(PLAYER_AHEAD_MIN_BYTES, info.bytesPerSec * PLAYER_AHEAD_SEC);
      // A reader that started far from playback is reading the file index or a fresh seek target
      if (Math.abs(readerStart - info.byte) > ahead && cursor - readerStart < INDEX_READ_BYTES) return;
      if (cursor <= info.byte + ahead) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
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
      await this._paceRead(cursor, start, () => closed);
      if (closed) return;
      try {
        const buffer = await this.read(cursor, Math.min(msg.want || this.blockSize, last - cursor + 1));
        cursor += buffer.byteLength;
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
  }
}
