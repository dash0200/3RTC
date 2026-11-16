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
import * as telemetry from '../features/diagnostics/telemetry';

export const STREAM_CHUNK_SIZE = 16384;
export const BUFFERED_AMOUNT_HIGH = 512 * 1024; // 512 KB backpressure threshold
export const BUFFERED_AMOUNT_LOW = 128 * 1024;  // 128 KB resume threshold

export const MAX_STREAM_CHUNKS = 500000; // ~30 GB at 60 KB chunks

export const ALLOWED_MEDIA_MIME_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska',
  'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/flac', 'audio/opus'
]);

export function sanitizeMediaMimeType(mime?: string | null): string {
  if (typeof mime !== 'string') return 'video/mp4';
  const clean = mime.toLowerCase().trim().split(';')[0];
  return ALLOWED_MEDIA_MIME_TYPES.has(clean) ? clean : 'video/mp4';
}

export function getVideoMimeType(file?: File | Blob | { type?: string; name?: string } | null): string {
  if (file?.type) return file.type;
  const name = (file && 'name' in file ? String((file as { name?: string }).name || '') : '').toLowerCase();
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mp4') || name.endsWith('.m4v')) return 'video/mp4';
  if (name.endsWith('.mov')) return 'video/quicktime';
  if (name.endsWith('.mkv')) return 'video/mp4';
  return 'video/mp4';
}

export interface P2PStreamSenderOptions {
  senderName?: string;
  streamId?: string;
  targetPeerId?: string;
  onProgress?: (info: { chunkIndex: number; totalChunks: number; bytesSent: number; totalBytes: number; percent: number; speedMBs: number }) => void;
  onComplete?: (info: { streamId: string; totalBytes: number; totalChunks: number; durationSec: number }) => void;
  onError?: (err: Error) => void;
}

/**
 * P2P Stream Sender: Slices a local File and streams it with backpressure control.
 */
export class P2PStreamSender {
  public file: File;
  public dataChannel: RTCDataChannel;
  public senderName: string;
  public streamId: string;
  public targetPeerId: string;
  public onProgress: (info: { chunkIndex: number; totalChunks: number; bytesSent: number; totalBytes: number; percent: number; speedMBs: number }) => void;
  public onComplete: (info: { streamId: string; totalBytes: number; totalChunks: number; durationSec: number }) => void;
  public onError: (err: Error) => void;
  public isAborted: boolean;
  public totalChunks: number;
  public currentChunkIndex: number;
  public startTime: number;
  public lastProgressTime: number;
  public lastProgressBytes: number;

  constructor(file: File, dataChannel: RTCDataChannel, options: P2PStreamSenderOptions = {}) {
    this.file = file;
    this.dataChannel = dataChannel;
    this.senderName = options.senderName || 'Peer';
    this.streamId = options.streamId || crypto.randomUUID();
    this.targetPeerId = options.targetPeerId || '';
    this.onProgress = options.onProgress || (() => { });
    this.onComplete = options.onComplete || (() => { });
    this.onError = options.onError || (() => { });
    this.isAborted = false;
    this.totalChunks = Math.ceil(file.size / STREAM_CHUNK_SIZE);
    this.currentChunkIndex = 0;
    this.startTime = 0;
    this.lastProgressTime = 0;
    this.lastProgressBytes = 0;
  }

  start(): void {
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
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // 2. Begin chunk streaming loop
    this._pump();
  }

  private _pump(): void {
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
      } catch { /* channel closed */ }

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
      const arrayBuffer = reader.result as ArrayBuffer;

      // Pack 4-byte chunk index prefix + slice payload
      const packet = new Uint8Array(4 + arrayBuffer.byteLength);
      new DataView(packet.buffer).setUint32(0, chunkIdx, false);
      packet.set(new Uint8Array(arrayBuffer), 4);

      try {
        this.dataChannel.send(packet.buffer);
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
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
      this.onError(new Error(String(err)));
    };

    reader.readAsArrayBuffer(slice);
  }

  abort(): void {
    this.isAborted = true;
    if (this.dataChannel) {
      this.dataChannel.onbufferedamountlow = null;
      try {
        this.dataChannel.send(JSON.stringify({
          type: 'p2p-stream-cancel',
          streamId: this.streamId,
          timestamp: Date.now()
        }));
      } catch { /* channel already closed */ }
    }
  }
}

export interface P2PStreamReceiverHeader {
  streamId?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  chunkSize?: number;
  totalChunks?: number;
  sender?: string;
}

export interface P2PStreamReceiverOptions {
  onReady?: (url: string, meta: { blob: Blob; fileName: string; fileSize: number; percent: number }) => void;
  onProgress?: (info: { percent: number; receivedBytes: number; totalBytes: number; receivedChunksCount: number; totalChunks: number; speedMBs: number; isReady: boolean }) => void;
  onComplete?: (url: string, meta: { blob: Blob; fileName: string; fileSize: number; totalChunks: number }) => void;
  onError?: (err: Error) => void;
}

/**
 * P2P Stream Receiver: Assembles incoming binary chunks and exposes playback via Blob / MSE.
 */
export class P2PStreamReceiver {
  public streamId?: string;
  public fileName: string;
  public fileSize: number;
  public mimeType: string;
  public chunkSize: number;
  public totalChunks: number;
  public sender: string;
  public onReady: (url: string, meta: { blob: Blob; fileName: string; fileSize: number; percent: number }) => void;
  public onProgress: (info: { percent: number; receivedBytes: number; totalBytes: number; receivedChunksCount: number; totalChunks: number; speedMBs: number; isReady: boolean }) => void;
  public onComplete: (url: string, meta: { blob: Blob; fileName: string; fileSize: number; totalChunks: number }) => void;
  public onError: (err: Error) => void;
  public chunks: Array<ArrayBuffer | null>;
  public receivedBytes: number;
  public receivedChunksCount: number;
  public isReady: boolean;
  public isCompleted: boolean;
  public isAborted: boolean;
  public currentObjectUrl: string | null;
  public startTime: number;
  public lastProgressTime: number;
  public lastProgressBytes: number;
  public useMSE: boolean;

  constructor(header?: P2PStreamReceiverHeader | null, options: P2PStreamReceiverOptions = {}) {
    this.streamId = header?.streamId;
    this.fileName = typeof header?.fileName === 'string' ? header.fileName.slice(0, 180) : 'video';
    this.fileSize = Number.isFinite(header?.fileSize) && header!.fileSize! > 0 ? header!.fileSize! : 0;
    this.mimeType = sanitizeMediaMimeType(header?.mimeType);
    this.chunkSize = Number.isInteger(header?.chunkSize) && header!.chunkSize! > 0 && header!.chunkSize! <= 1024 * 1024
      ? header!.chunkSize!
      : STREAM_CHUNK_SIZE;
    const computedChunks = this.fileSize > 0 ? Math.ceil(this.fileSize / this.chunkSize) : 0;
    const rawChunks = Number.isInteger(header?.totalChunks) && header!.totalChunks! > 0 ? header!.totalChunks! : computedChunks;
    this.totalChunks = Math.min(Math.max(1, rawChunks), MAX_STREAM_CHUNKS);
    this.sender = typeof header?.sender === 'string' ? header.sender.slice(0, 64) : 'Peer';

    this.onReady = options.onReady || (() => { });
    this.onProgress = options.onProgress || (() => { });
    this.onComplete = options.onComplete || (() => { });
    this.onError = options.onError || (() => { });

    this.chunks = new Array(this.totalChunks).fill(null);
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
    this.useMSE = typeof window !== 'undefined' && Boolean(window.MediaSource && window.MediaSource.isTypeSupported?.(this.mimeType));
  }

  handleChunk(arrayBuffer: ArrayBuffer): void {
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

  private _producePlayableBlob(isFinal = false): void {
    try {
      const validChunks = this.chunks.filter((c): c is ArrayBuffer => Boolean(c));
      if (validChunks.length === 0) return;

      const blob = new Blob(validChunks, { type: this.mimeType });
      const newUrl = URL.createObjectURL(blob);

      if (isFinal) {
        if (this.currentObjectUrl && this.currentObjectUrl !== newUrl) {
          try { URL.revokeObjectURL(this.currentObjectUrl); } catch { /* ignore */ }
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
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  handleComplete(): void {
    if (this.isAborted || this.isCompleted) return;
    this._producePlayableBlob(true);
  }

  abort(): void {
    this.isAborted = true;
    if (this.currentObjectUrl) {
      try {
        URL.revokeObjectURL(this.currentObjectUrl);
      } catch { /* ignore */ }
      this.currentObjectUrl = null;
    }
    this.chunks = [];
  }
}

/* ==========================================================================
   On-demand streaming (byte ranges)
   ========================================================================== */

export const RANGE_BLOCK_SIZE = 256 * 1024;
export const RANGE_PREFETCH_BYTES = 2 * 1024 * 1024; // block read-ahead past the player's position
export const STREAM_CACHE_BYTES = 700 * 1024 * 1024;       // computers
export const STREAM_CACHE_BYTES_PHONE = 200 * 1024 * 1024; // phones
const KEEP_BEHIND_SHARE = 0.25;
export const BUFFER_AHEAD_BYTES = 96 * 1024 * 1024;
export const BUFFER_AHEAD_BYTES_PHONE = 40 * 1024 * 1024;
const BUFFER_IN_FLIGHT_BLOCKS = 16;
const ANCHOR_MIN_BYTES = 1024 * 1024;
export const P2P_STREAM_URL_PREFIX = '/__p2p-stream/';
const RANGE_PACKET_MAGIC = 0x524E4731; // 'RNG1'
const RANGE_HEADER_BYTES = 16;
const RANGE_PACKET_PAYLOAD = 16384;
const RANGE_BUFFER_HIGH = 192 * 1024;
const RANGE_BUFFER_LOW = 64 * 1024;
const BLOCK_WAIT_MS = 15000;
const BLOCK_MAX_TRIES = 4;
const RELAY_WAIT_MS = 5000;
export const RELAY_FANOUT = 2;
const SWARM_WAIT_MS = 4000;
const SWARM_PENALTY_MS = 10000;
const SWARM_SLOW_MS = 5000;
const SWARM_PEER_IN_FLIGHT = 12;
const SWARM_URGENT_IN_FLIGHT = 4;
const SWARM_NEAR_BLOCKS = 2;
const OWNER_BIAS = 3;
const HASH_WAIT_MS = 10000;
const SWARM_HASH_AHEAD = 64;

/** Checksums need crypto.subtle (https or localhost); without it there's no swarm. */
export const canChecksum = (): boolean => typeof crypto !== 'undefined' && Boolean(crypto.subtle);

/** SHA-256 of a block, as hex (the owner's checksums; checks blocks that came from other viewers). */
export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureController(sw: ServiceWorkerContainer, timeoutMs = 6000): Promise<ServiceWorker | null> {
  if (sw.controller) return sw.controller;
  let existing = await sw.getRegistration().catch(() => null);
  if (!existing) {
    existing = (await sw.register('/sw.js').catch(() => null)) ?? undefined;
  }
  if (!existing) return null;
  const changed = new Promise<void>((resolve) => sw.addEventListener('controllerchange', () => resolve(), { once: true }));
  const deadline = sleep(timeoutMs);
  const registration = await Promise.race([sw.ready.catch(() => null), deadline]);
  if (registration && 'active' in registration && registration.active) {
    try { registration.active.postMessage({ type: 'p2p-claim' }); } catch { /* old worker */ }
  }
  await Promise.race([changed, deadline]);
  return sw.controller;
}

export async function detectOnDemandStreaming(): Promise<boolean> {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  if (!sw || typeof MessageChannel === 'undefined') return false;
  const controller = await ensureController(sw);
  if (!controller) return false;
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 1500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(Boolean(event.data?.p2pStreaming));
    };
    try {
      controller.postMessage({ type: 'p2p-stream-ping' }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

export interface P2PRangeSenderOptions {
  streamNo?: number;
  senderName?: string;
  onError?: (err: Error) => void;
  blockSize?: number;
  fileSize?: number;
  readBlock?: (block: number) => Promise<Uint8Array>;
  onRequest?: (blocks: number[], urgent: boolean) => void;
  onMiss?: (block: number) => void;
  onBlockRead?: (block: number, data: Uint8Array) => void;
  headerExtra?: Record<string, unknown>;
  cancelType?: string;
}

/**
 * Serves blocks to one peer, in the order they are needed.
 */
export class P2PRangeSender {
  public file: File | null;
  public dataChannel: RTCDataChannel;
  public streamNo: number;
  public senderName: string;
  public onError: (err: Error) => void;
  public blockSize: number;
  public fileSize: number;
  public totalBlocks: number;
  public readBlock: (block: number) => Promise<Uint8Array>;
  public onRequest: ((blocks: number[], urgent: boolean) => void) | null;
  public onMiss: ((block: number) => void) | null;
  public onBlockRead: ((block: number, data: Uint8Array) => void) | null;
  public headerExtra: Record<string, unknown>;
  public cancelType: string;
  public isRelay: boolean;
  public queue: number[];
  public current: number;
  public isPumping: boolean;
  public isAborted: boolean;
  public drainResolve: (() => void) | null;
  private telemetryKey = `send-${Math.random().toString(36).slice(2)}`;

  constructor(file: File | null, dataChannel: RTCDataChannel, options: P2PRangeSenderOptions = {}) {
    this.file = file;
    this.dataChannel = dataChannel;
    this.streamNo = (options.streamNo ?? 0) >>> 0;
    this.senderName = options.senderName || 'Peer';
    this.onError = options.onError || (() => { });
    this.blockSize = options.blockSize || RANGE_BLOCK_SIZE;
    this.fileSize = file ? file.size : (options.fileSize || 0);
    this.totalBlocks = Math.ceil(this.fileSize / this.blockSize);
    this.readBlock = options.readBlock || ((block: number) => {
      const start = block * this.blockSize;
      return this.file!.slice(start, Math.min(start + this.blockSize, this.file!.size)).arrayBuffer()
        .then((buf) => new Uint8Array(buf));
    });
    this.onRequest = options.onRequest || null;
    this.onMiss = options.onMiss || null;
    this.onBlockRead = options.onBlockRead || null;
    this.headerExtra = options.headerExtra || {};
    this.cancelType = options.cancelType || 'p2p-stream-cancel';
    this.isRelay = Boolean(options.readBlock);
    this.queue = [];
    this.current = -1;
    this.isPumping = false;
    this.isAborted = false;
    this.drainResolve = null;
  }

  static header(file: { name: string; size: number }, streamNo: number, senderName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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

  start(): void {
    telemetry.noteShareStart(this.telemetryKey, this.fileSize, this.file?.name, this.isRelay);
    try {
      this.dataChannel.send(JSON.stringify(P2PRangeSender.header(this.file || { name: 'video', size: this.fileSize }, this.streamNo, this.senderName, this.headerExtra)));
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  handleRequest({ blocks = [], urgent = false }: { blocks?: number[]; urgent?: boolean } = {}): void {
    if (this.isAborted) return;
    const wanted = blocks
      .map((b) => b >>> 0)
      .filter((b) => b < this.totalBlocks && b !== this.current);
    this.onRequest?.(wanted, urgent);
    if (urgent) {
      this.queue = this.queue.filter((b) => !wanted.includes(b));
      this.queue.unshift(...wanted);
    } else {
      for (const b of wanted) if (!this.queue.includes(b)) this.queue.push(b);
    }
    this._pump();
  }

  handleCancel({ blocks = [] }: { blocks?: number[] } = {}): void {
    const drop = new Set(blocks.map((b) => b >>> 0));
    this.queue = this.queue.filter((b) => !drop.has(b));
  }

  private _waitForDrain(): Promise<void> {
    const dc = this.dataChannel;
    if (dc.bufferedAmount <= RANGE_BUFFER_HIGH) return Promise.resolve();
    return new Promise((resolve) => {
      dc.bufferedAmountLowThreshold = RANGE_BUFFER_LOW;
      const done = (): void => {
        dc.removeEventListener('bufferedamountlow', done);
        this.drainResolve = null;
        resolve();
      };
      this.drainResolve = done;
      dc.addEventListener('bufferedamountlow', done);
    });
  }

  private async _pump(): Promise<void> {
    if (this.isPumping || this.isAborted) return;
    this.isPumping = true;
    try {
      while (this.queue.length && !this.isAborted) {
        const block = this.queue.shift()!;
        this.current = block;
        let data: Uint8Array;
        try {
          const readStart = performance.now();
          data = await this.readBlock(block);
          if (!this.isRelay) telemetry.noteRead(performance.now() - readStart);
        } catch (err) {
          if (this.isRelay) {
            this.onMiss?.(block);
            continue;
          }
          throw err;
        }
        if (this.isAborted) break;
        this.onBlockRead?.(block, data);
        for (let offset = 0; offset < data.length && !this.isAborted; offset += RANGE_PACKET_PAYLOAD) {
          const waitStart = performance.now();
          await this._waitForDrain();
          telemetry.noteDrainWait(performance.now() - waitStart);
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
          telemetry.noteSent(packet.byteLength);
        }
        this.current = -1;
      }
    } catch (err) {
      if (!this.isAborted) this.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.current = -1;
      this.isPumping = false;
    }
  }

  abort(): void {
    if (this.isAborted) return;
    this.isAborted = true;
    telemetry.noteShareEnd(this.telemetryKey);
    this.queue = [];
    if (this.drainResolve) this.drainResolve();
    try {
      if (this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify({ type: this.cancelType, streamNo: this.streamNo, timestamp: Date.now() }));
      }
    } catch { /* channel closed */ }
  }
}

export interface RangeReceiverHeader {
  streamNo?: number;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  blockSize?: number;
  swarm?: boolean;
}

export interface BlockEntry {
  data: Uint8Array;
  received: number;
  done: boolean;
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  got: Set<number> | null;
  peer?: string | null;
  checking?: boolean;
  urgent?: boolean;
  background?: boolean;
  forRelay?: boolean;
}

export interface P2PRangeReceiverOptions {
  ownerId?: string | null;
  sourceId?: string | null;
  getChannel?: (peerId: string | null) => RTCDataChannel | null;
  onSourceChange?: (newSourceId: string | null, reason: string) => void;
  sendControl?: (msg: unknown) => void;
  onProgress?: (info: Record<string, unknown>) => void;
  onError?: (err: Error) => void;
  cacheLimit?: number;
  bufferAhead?: number;
  swarm?: boolean;
  sendTo?: (peerId: string, msg: unknown) => boolean;
  hashBlock?: (data: BufferSource) => Promise<string>;
  onBadBlock?: (peerId: string, index: number) => void;
  seed?: number;
}

/**
 * Guest side: block cache + reads for the service worker.
 */
export class P2PRangeReceiver {
  public streamNo: number;
  public fileName: string;
  public fileSize: number;
  public mimeType: string;
  public blockSize: number;
  public totalBlocks: number;
  public ownerId: string | null;
  public sourceId: string | null;
  public getChannel: ((peerId: string | null) => RTCDataChannel | null) | null;
  public onSourceChange: (newSourceId: string | null, reason: string) => void;
  public sendControl: (msg: unknown) => void;
  public onProgress: (info: Record<string, unknown>) => void;
  public onError: (err: Error) => void;
  public cacheLimit: number;
  public bufferAhead: number;
  public window: { first: number; last: number } | null;

  public blocks = new Map<number, BlockEntry>();
  public pending = new Map<number, number>();
  public cachedBytes = 0;
  public isAborted = false;
  public lastProgressTime: number;
  public lastProgressBytes = 0;
  public lastSpeed = 0;
  public url: string;

  public swarm: boolean;
  public sendTo: (peerId: string, msg: unknown) => boolean;
  public hashBlock: (data: BufferSource) => Promise<string>;
  public onBadBlock: (peerId: string, index: number) => void;
  public sourceOf = new Map<number, string | null>();
  public peerHave = new Map<string, Uint8Array>();
  public lastDataFrom = new Map<string, number>();
  public banned = new Set<string>();
  public penalty = new Map<string, number>();
  public hashes = new Map<number, string>();
  public hashWaiters = new Map<number, Array<(hash: string | null) => void>>();
  public hashAsked = new Map<number, number>();
  public hashBatch: number[] | null = null;
  public haveVersion = 0;
  public haveAdded: number[] = [];
  public haveRemoved: number[] = [];
  public gettingAdded: number[] = [];
  public peerGetting = new Map<string, Map<number, number>>();
  public seed: number;
  public stats = { fromOwner: 0, fromPeers: 0, rejected: 0 };
  public counts: Record<string, number> = {
    ownerUrgent: 0, ownerRest: 0, peerUrgent: 0, peerRest: 0, slow: 0,
    slowUrgent: 0, misses: 0, waitBusy: 0, waitGetting: 0, bumps: 0
  };

  constructor(header: RangeReceiverHeader, options: P2PRangeReceiverOptions = {}) {
    this.streamNo = (header.streamNo ?? 0) >>> 0;
    this.fileName = typeof header.fileName === 'string' ? header.fileName.slice(0, 180) : 'video';
    this.fileSize = Number.isFinite(header.fileSize) && header.fileSize! > 0 ? header.fileSize! : 0;
    this.mimeType = sanitizeMediaMimeType(header.mimeType);
    this.blockSize = Number.isInteger(header.blockSize) && header.blockSize! > 0 && header.blockSize! <= 1024 * 1024
      ? header.blockSize!
      : RANGE_BLOCK_SIZE;
    this.totalBlocks = this.fileSize > 0 ? Math.ceil(this.fileSize / this.blockSize) : 0;
    this.ownerId = options.ownerId ?? null;
    this.sourceId = options.sourceId ?? this.ownerId;
    this.getChannel = options.getChannel || null;
    this.onSourceChange = options.onSourceChange || (() => { });
    this.sendControl = options.sendControl || ((msg: unknown) => this._send(msg));
    this.onProgress = options.onProgress || (() => { });
    this.onError = options.onError || (() => { });
    this.cacheLimit = options.cacheLimit || STREAM_CACHE_BYTES;
    this.bufferAhead = Math.min(options.bufferAhead || BUFFER_AHEAD_BYTES, this.cacheLimit * 0.5);
    this.window = null;

    this.lastProgressTime = Date.now();
    this.url = `${P2P_STREAM_URL_PREFIX}${this.streamNo}/${encodeURIComponent(this.fileName)}`;

    this.swarm = Boolean(options.swarm) && header.swarm === true;
    this.sendTo = options.sendTo || ((peerId: string, msg: unknown) => {
      const channel = this.getChannel?.(peerId);
      if (!channel) return false;
      try { channel.send(JSON.stringify(msg)); return true; } catch { return false; }
    });
    this.hashBlock = options.hashBlock || sha256Hex;
    this.onBadBlock = options.onBadBlock || (() => { });
    this.seed = options.seed ?? Math.random();
    this.telemetryKey = telemetry.noteWatchStart({
      fileName: this.fileName,
      fileSize: this.fileSize,
      ownerId: this.ownerId ?? undefined,
      relayed: this.isRelayed,
      swarm: this.swarm
    });
  }

  private telemetryKey = '';

  get isRelayed(): boolean {
    return this.sourceId !== null && this.sourceId !== this.ownerId;
  }

  private _send(msg: unknown): void {
    if (!this.getChannel) return;
    const channel = this.getChannel(this.sourceId);
    if (!channel && this.isRelayed) {
      this.useOwner('parent unreachable');
      return;
    }
    try { channel?.send(JSON.stringify(msg)); } catch { /* channel closed */ }
  }

  useOwner(reason = ''): void {
    if (!this.isRelayed || this.isAborted) return;
    this.sourceId = this.ownerId;
    telemetry.noteWatchSource(false);
    this.onSourceChange(this.ownerId, reason);
    const urgent: number[] = [];
    const rest: number[] = [];
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

  handlePeerGone(peerId: string): void {
    if (this.isRelayed && peerId === this.sourceId) this.useOwner('parent left');
    if (this.swarm) this.dropPeer(peerId);
  }

  private _load(peerId: string | null): number {
    const now = Date.now();
    let n = 0;
    for (const [b, at] of this.pending) if (this.sourceOf.get(b) === peerId && !this._late(b, at, now)) n++;
    return n;
  }

  private _pickSource(block: number, urgent: boolean): string | null {
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

  private _penalizeSlow(blocks: number[], ms = SWARM_SLOW_MS): void {
    if (!this.swarm || !blocks.length) return;
    const slow: number[] = [];
    for (const b of blocks) {
      const source = this.sourceOf.get(b);
      if (source === undefined || source === this.ownerId || !source) continue;
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

  private _ask(blocks: number[], urgent = false): void {
    if (!blocks.length) return;
    if (!this.swarm) {
      for (const b of blocks) {
        this.sourceOf.set(b, this.sourceId);
        if (urgent) this._block(b).urgent = true;
      }
      this.sendControl({ type: 'p2p-range-request', streamNo: this.streamNo, blocks, urgent });
      return;
    }
    const groups = new Map<string | null, number[]>();
    for (const b of blocks) {
      const source = this._pickSource(b, urgent);
      this.counts[(source === this.ownerId ? 'owner' : 'peer') + (urgent ? 'Urgent' : 'Rest')]++;
      if (source === this.ownerId) this.gettingAdded.push(b);
      this.sourceOf.set(b, source);
      if (urgent) this._block(b).urgent = true;
      if (!groups.has(source)) groups.set(source, []);
      groups.get(source)!.push(b);
    }
    for (const [source, list] of groups) {
      if (source === this.ownerId) {
        this.sendControl({ type: 'p2p-range-request', streamNo: this.streamNo, blocks: list, urgent });
      } else if (source && this.sendTo(source, { type: 'p2p-range-request', streamNo: this.streamNo, blocks: list, urgent, swarm: true })) {
        this._needHashes(list);
      } else if (source) {
        this.dropPeer(source);
      }
    }
  }

  private _cancel(blocks: number[]): void {
    if (!blocks.length) return;
    if (!this.swarm) {
      this.sendControl({ type: 'p2p-range-cancel', streamNo: this.streamNo, blocks });
      return;
    }
    const groups = new Map<string | null, number[]>();
    for (const b of blocks) {
      const source = this.sourceOf.get(b) ?? this.ownerId;
      this.sourceOf.delete(b);
      if (!groups.has(source)) groups.set(source, []);
      groups.get(source)!.push(b);
    }
    for (const [source, list] of groups) {
      if (source === this.ownerId) this.sendControl({ type: 'p2p-range-cancel', streamNo: this.streamNo, blocks: list });
      else if (source) this.sendTo(source, { type: 'p2p-range-cancel', streamNo: this.streamNo, blocks: list, swarm: true });
    }
  }

  private _late(block: number, at: number, now = Date.now()): boolean {
    if (this.swarm) {
      const source = this.sourceOf.get(block);
      if (source !== undefined && source !== this.ownerId && source) {
        const lastData = Math.max(at, this.lastDataFrom.get(source) || 0);
        return now - lastData > SWARM_WAIT_MS || now - at > BLOCK_WAIT_MS;
      }
    }
    return now - at > this._waitMs(block);
  }

  private _waitMs(block: number): number {
    if (this.swarm) {
      const source = this.sourceOf.get(block);
      if (source !== undefined && source !== this.ownerId) return SWARM_WAIT_MS;
    }
    return this.isRelayed ? RELAY_WAIT_MS : BLOCK_WAIT_MS;
  }

  private _reroute(peerId: string, only: Set<number> | null = null): void {
    const urgent: number[] = [];
    const rest: number[] = [];
    for (const b of [...this.pending.keys()]) {
      if (this.sourceOf.get(b) !== peerId || (only && !only.has(b))) continue;
      const entry = this.blocks.get(b);
      this.pending.delete(b);
      this.sourceOf.delete(b);
      if (!entry || entry.done) continue;
      if (entry.received) this._resetBlock(entry);
      if (entry.waiters.length) urgent.push(b);
      else if (entry.background || entry.forRelay) rest.push(b);
    }
    const now = Date.now();
    for (const b of [...urgent, ...rest]) this.pending.set(b, now);
    this._ask(urgent, true);
    this._ask(rest, false);
  }

  private _resetBlock(entry: BlockEntry): void {
    entry.urgent = false;
    entry.data = new Uint8Array(entry.data.length);
    entry.received = 0;
    entry.got = new Set<number>();
    entry.peer = null;
    entry.checking = false;
  }

  setPeerHave(peerId: string, ranges: number[]): void {
    if (!this.swarm || peerId === this.ownerId || !Array.isArray(ranges)) return;
    const have = new Uint8Array(this.totalBlocks);
    for (let i = 0; i + 1 < ranges.length && i < 40000; i += 2) {
      const first = Math.max(0, ranges[i] >>> 0);
      const last = Math.min(this.totalBlocks - 1, ranges[i + 1] >>> 0);
      for (let b = first; b <= last; b++) have[b] = 1;
    }
    this.peerHave.set(peerId, have);
  }

  updatePeerHave(peerId: string, add: number[] = [], remove: number[] = [], getting: number[] = []): void {
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

  notePeerGetting(peerId: string, blocks: number[]): void {
    if (!this.swarm || !Array.isArray(blocks) || !blocks.length) return;
    if (!this.peerGetting.has(peerId)) this.peerGetting.set(peerId, new Map());
    const gets = this.peerGetting.get(peerId)!;
    const now = Date.now();
    for (const b of blocks.slice(0, 2000)) if ((b >>> 0) < this.totalBlocks) gets.set(b >>> 0, now);
  }

  private _someoneGetting(b: number, now = Date.now()): boolean {
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

  takeHaveChanges(): { add: number[]; remove: number[]; getting: number[] } {
    const out = { add: this.haveAdded, remove: this.haveRemoved, getting: this.gettingAdded };
    this.haveAdded = [];
    this.haveRemoved = [];
    this.gettingAdded = [];
    return out;
  }

  gettingNow(): number[] {
    const out: number[] = [];
    for (const b of this.pending.keys()) if ((this.sourceOf.get(b) ?? this.ownerId) === this.ownerId) out.push(b);
    return out;
  }

  haveRanges(): number[] {
    const done: number[] = [];
    for (const [b, entry] of this.blocks) if (entry.done) done.push(b);
    done.sort((a, b) => a - b);
    const ranges: number[] = [];
    for (const b of done) {
      if (ranges.length && ranges[ranges.length - 1] === b - 1) ranges[ranges.length - 1] = b;
      else ranges.push(b, b);
    }
    return ranges;
  }

  getCachedBlock(index: number): Uint8Array | null {
    const entry = this.blocks.get(index);
    return entry?.done ? entry.data : null;
  }

  handleMiss(peerId: string, blocks: number[] = []): void {
    this.counts.misses += blocks.length;
    const have = this.peerHave.get(peerId);
    const set = new Set<number>();
    for (const b of blocks) {
      const i = b >>> 0;
      if (have && i < have.length) have[i] = 0;
      set.add(i);
    }
    this._reroute(peerId, set);
  }

  dropPeer(peerId: string): void {
    if (!this.swarm || peerId === this.ownerId) return;
    this.peerHave.delete(peerId);
    this.peerGetting.delete(peerId);
    this._reroute(peerId);
  }

  private _needHashes(blocks: number[]): void {
    const now = Date.now();
    for (const b of blocks) {
      if (this.hashes.has(b)) continue;
      const at = this.hashAsked.get(b);
      if (at !== undefined && now - at < HASH_WAIT_MS) continue;
      this.hashAsked.set(b, now);
      if (!this.hashBatch) {
        this.hashBatch = [];
        Promise.resolve().then(() => {
          const list = this.hashBatch!;
          this.hashBatch = null;
          if (list.length && !this.isAborted) this.sendControl({ type: 'p2p-hash-request', streamNo: this.streamNo, blocks: list });
        });
      }
      this.hashBatch.push(b);
    }
  }

  addHashes(list: Array<[number, string]> = []): void {
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

  private _hashFor(index: number): Promise<string | null> {
    if (this.hashes.has(index)) return Promise.resolve(this.hashes.get(index)!);
    this._needHashes([index]);
    return new Promise((resolve) => {
      if (!this.hashWaiters.has(index)) this.hashWaiters.set(index, []);
      const list = this.hashWaiters.get(index)!;
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

  private async _check(index: number, entry: BlockEntry): Promise<void> {
    entry.checking = true;
    const peerId = entry.peer!;
    const t0 = Date.now();
    const expected = await this._hashFor(index);
    this.counts.hashMaxMs = Math.max(this.counts.hashMaxMs || 0, Date.now() - t0);
    const actual = expected ? await this.hashBlock(entry.data as unknown as BufferSource) : null;
    if (this.isAborted || this.blocks.get(index) !== entry || !entry.checking) return;
    entry.checking = false;
    if (expected && actual === expected) {
      this._finish(index, entry, peerId);
      return;
    }
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

  private _finish(index: number, entry: BlockEntry, from?: string | null): void {
    entry.done = true;
    const askedAt = this.pending.get(index);
    telemetry.noteBlockDone(askedAt !== undefined ? Date.now() - askedAt : null);
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

  private _block(index: number): BlockEntry {
    let entry = this.blocks.get(index);
    if (!entry) {
      const size = Math.min(this.blockSize, this.fileSize - index * this.blockSize);
      entry = { data: new Uint8Array(size), received: 0, done: false, waiters: [], got: new Set<number>() };
      this.blocks.set(index, entry);
    }
    return entry;
  }

  handleChunk(arrayBuffer: ArrayBuffer, fromPeerId: string | null = null): void {
    if (this.isAborted || arrayBuffer.byteLength < RANGE_HEADER_BYTES) return;
    const view = new DataView(arrayBuffer);
    if (view.getUint32(0, false) !== RANGE_PACKET_MAGIC) return;
    if (view.getUint32(4, false) !== this.streamNo) return;
    const index = view.getUint32(8, false);
    const offset = view.getUint32(12, false);
    if (index >= this.totalBlocks) return;

    const entry = this._block(index);
    if (entry.done || entry.checking) return;
    const payload = new Uint8Array(arrayBuffer, RANGE_HEADER_BYTES);
    if (offset + payload.length > entry.data.length) return;
    if (entry.got && entry.got.has(offset)) return;
    entry.got?.add(offset);
    entry.data.set(payload, offset);
    entry.received += payload.length;
    telemetry.noteReceived(payload.length);
    if (this.swarm && fromPeerId !== null && fromPeerId !== this.ownerId) {
      entry.peer = fromPeerId;
      this.lastDataFrom.set(fromPeerId, Date.now());
    }
    if (entry.received >= entry.data.length) {
      if (entry.peer) this._check(index, entry);
      else this._finish(index, entry, fromPeerId);
    }
  }

  private _noteReading(index: number): void {
    if (this.window && this.window.first === index + 1) return;
    const last = Math.min(this.totalBlocks - 1, index + Math.ceil(this.bufferAhead / this.blockSize));
    this.window = { first: index + 1, last };
    const stale: number[] = [];
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

  private _topUp(): void {
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
      const wanted: number[] = [];
      for (let b = first; b <= last && inFlight + wanted.length < BUFFER_IN_FLIGHT_BLOCKS; b++) {
        if (this._needsFetch(b, now)) wanted.push(b);
      }
      this._askBackground(wanted, now);
      return;
    }
    const limit = BUFFER_IN_FLIGHT_BLOCKS + Math.min(3, this.peerHave.size) * SWARM_PEER_IN_FLIGHT;
    const ownerLimit = Math.ceil(BUFFER_IN_FLIGHT_BLOCKS / 2);
    const fromPeers: number[] = [];
    const fromOwner: number[] = [];
    const planned = new Map<string, number>();
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
      } else if (holders.any) {
        this.counts.waitBusy++;
      } else if (this._someoneGetting(b, now)) {
        this.counts.waitGetting++;
      } else if (ownerInFlight + fromOwner.length < ownerLimit) {
        fromOwner.push(b);
      }
    }
    this.counts.bgOwner = (this.counts.bgOwner || 0) + fromOwner.length;
    this._askBackground([...fromPeers, ...fromOwner], now);

    const hashesAhead: number[] = [];
    for (let b = first; b <= last && hashesAhead.length < SWARM_HASH_AHEAD; b++) {
      if (!this.hashes.has(b) && !this.blocks.get(b)?.done) hashesAhead.push(b);
    }
    this._needHashes(hashesAhead);
  }

  private _needsFetch(b: number, now: number): boolean {
    const entry = this.blocks.get(b);
    if (entry?.done || entry?.checking) return false;
    const at = this.pending.get(b);
    return at === undefined || this._late(b, at, now);
  }

  private _askBackground(blocks: number[], now: number): void {
    const again = blocks.filter((b) => this.pending.has(b));
    telemetry.noteReask(again.length);
    this._penalizeSlow(again);
    for (const b of blocks) {
      this.pending.set(b, now);
      this._block(b).background = true;
    }
    this._ask(blocks, false);
  }

  private _holders(b: number, now = Date.now(), planned: Map<string, number> | null = null): { any: boolean; free: string | null } {
    let any = false;
    let free: string | null = null;
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

  handleComplete(): void { }

  private _reportProgress(force = false): void {
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

  private _request(index: number): void {
    const ahead = Math.ceil(RANGE_PREFETCH_BYTES / this.blockSize);
    const last = Math.min(this.totalBlocks - 1, index + ahead);
    const now = Date.now();

    const stale: number[] = [];
    for (const b of this.pending.keys()) {
      const entry = this.blocks.get(b);
      const inWindow = this.window && b >= this.window.first && b <= this.window.last;
      if ((b < index || b > last) && !inWindow && !(entry && (entry.waiters.length || entry.forRelay))) stale.push(b);
    }
    if (stale.length) {
      for (const b of stale) this.pending.delete(b);
      this._cancel(stale);
    }

    const again: number[] = [];
    const isMissing = (b: number): boolean => {
      const entry = this.blocks.get(b);
      if (entry?.done || entry?.checking) return false;
      const at = this.pending.get(b);
      const late = at !== undefined && this._late(b, at, now);
      if (late) again.push(b);
      return at === undefined || late;
    };

    if (isMissing(index)) {
      telemetry.noteReask(again.length);
      this._penalizeSlow(again);
      again.length = 0;
      this.pending.set(index, now);
      this._ask([index], true);
    } else {
      const entry = this._block(index);
      if (!entry.done && !entry.checking && !entry.urgent && this.pending.has(index)) {
        entry.urgent = true;
        this.counts.bumps++;
        this.pending.set(index, now);
        const source = this.sourceOf.get(index) ?? this.sourceId;
        const msg = { type: 'p2p-range-request', streamNo: this.streamNo, blocks: [index], urgent: true };
        if (this.swarm && source !== this.ownerId && source) this.sendTo(source, { ...msg, swarm: true });
        else this.sendControl(msg);
      }
    }

    const prefetch: number[] = [];
    const others = this.swarm && this.peerHave.size > 0;
    const byBackground = others && this.window && this.window.first <= index + 1 && this.window.last >= last;
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

  private _waitForBlock(index: number): Promise<void> {
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

  async read(position: number, maxLength: number): Promise<ArrayBuffer> {
    const index = Math.floor(position / this.blockSize);
    let patience = 2;
    for (let attempt = 1; ; attempt++) {
      if (this.isAborted) throw new Error('aborted');
      this._request(index);
      const waitStart = performance.now();
      const waited = !this.blocks.get(index)?.done;
      try {
        await this._waitForBlock(index);
        if (waited) telemetry.notePlayerWait(performance.now() - waitStart);
        break;
      } catch (err) {
        if (this.isAborted) throw err;
        const source = this.sourceOf.get(index);
        if (this.isRelayed) {
          this.useOwner('parent too slow');
          attempt -= 1;
        } else if (this.swarm && source !== undefined && source !== this.ownerId) {
          attempt -= 1;
          const at = this.pending.get(index);
          if (at !== undefined && !this._late(index, at) && patience-- > 0) {
            this.counts.patience = (this.counts.patience || 0) + 1;
            continue;
          }
          this._penalizeSlow([index], SWARM_PENALTY_MS);
        } else if (attempt >= BLOCK_MAX_TRIES) {
          throw err;
        }
        this.pending.delete(index);
      }
    }
    const entry = this.blocks.get(index)!;
    const from = position - index * this.blockSize;
    const to = Math.min(entry.data.length, from + maxLength);
    const out = entry.data.slice(from, to).buffer;
    this._evict(index);
    return out;
  }

  private _evict(index: number): void {
    if (this.cachedBytes <= this.cacheLimit) return;
    const keepFrom = index - Math.ceil((this.cacheLimit * KEEP_BEHIND_SHARE) / this.blockSize);
    const keepTo = Math.max(index + Math.ceil(RANGE_PREFETCH_BYTES / this.blockSize), this.window?.last ?? 0);
    const victims: number[] = [];
    for (const [b, entry] of this.blocks) {
      if (entry.done && !entry.waiters.length && !entry.forRelay && (b < keepFrom || b > keepTo)) victims.push(b);
    }
    victims.sort((a, b) => Math.abs(b - index) - Math.abs(a - index));
    for (const b of victims) {
      if (this.cachedBytes <= this.cacheLimit * 0.9) break;
      this.cachedBytes -= this.blocks.get(b)!.data.length;
      this.blocks.delete(b);
      this.haveVersion++;
      if (this.swarm) this.haveRemoved.push(b);
    }
  }

  want(blocks: number[], urgent = false): void {
    if (this.isAborted) return;
    const now = Date.now();
    const missing: number[] = [];
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

  async getBlock(index: number): Promise<Uint8Array> {
    for (let attempt = 1; ; attempt++) {
      if (this.isAborted) throw new Error('aborted');
      this.want([index], true);
      try {
        await this._waitForBlock(index);
        return this.blocks.get(index)!.data;
      } catch (err) {
        if (this.isAborted || attempt >= 2) throw err;
        if (this.isRelayed) this.useOwner('parent too slow');
        this.pending.delete(index);
      }
    }
  }

  serve(port: MessagePort, start: number, end?: number | null): void {
    if (this.isAborted || start >= this.fileSize) {
      port.postMessage({ type: 'meta', ok: false, size: this.fileSize });
      return;
    }
    const last = end === null || end === undefined ? this.fileSize - 1 : Math.min(end, this.fileSize - 1);
    let cursor = start;
    let served = 0;
    port.onmessage = async (event: MessageEvent): Promise<void> => {
      const msg = event.data || {};
      if (msg.type === 'cancel') {
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

  abort(): void {
    this.isAborted = true;
    telemetry.noteWatchEnd(this.telemetryKey);
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
