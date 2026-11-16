/**
 * WebRTC Direct P2P Image & Screenshot Sharing
 * 
 * Features:
 * - Binary slicing into 60 KB SCTP-safe chunks.
 * - Unique packet magic tag (0x494D4731 / 'IMG1') for immediate demuxing from video streaming chunks.
 * - Compact UTF-8 metadata header per chunk to support concurrent multi-peer transfers.
 * - Backpressure handling (bufferedAmount check) to prevent buffer overflows.
 * - Zero upload server or cloud dependency: 100% direct Peer-to-Peer blob transfer.
 */

export const FILE_CHUNK_SIZE = 61440; // 60 KB (safely below 64 KB SCTP limit)
export const IMAGE_CHUNK_SIZE = 61440;
export const MAGIC_IMG1 = 0x494D4731;  // 'IMG1' in ASCII hex
export const MAX_FILE_CHUNKS = 500000;  // ~30 GB max
export const MAX_IMAGE_CHUNKS = 500000;
export const MAX_FILE_SIZE = MAX_FILE_CHUNKS * FILE_CHUNK_SIZE;
export const MAX_IMAGE_FILE_SIZE = MAX_FILE_SIZE;

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp'
]);
export const ALLOWED_IMAGE_MIMES = ALLOWED_IMAGE_MIME_TYPES;

export function sanitizeImageMimeType(mime?: string | null): string {
  if (typeof mime !== 'string') return 'image/png';
  const clean = mime.toLowerCase().trim().split(';')[0];
  return ALLOWED_IMAGE_MIME_TYPES.has(clean) ? clean : 'image/png';
}

export function sanitizeMimeType(mime?: string | null): string {
  if (typeof mime !== 'string' || !mime.trim()) return 'application/octet-stream';
  const clean = mime.toLowerCase().trim().split(';')[0].replace(/[^a-z0-9/._-]/g, '');
  return clean || 'application/octet-stream';
}

/**
 * Sanitizes download filename: strips directory traversal and enforces safe image extensions (.png, .jpg, .webp, .gif)
 */
export function safeImageDownloadName(name?: string | null, mimeType?: string | null): string {
  const mime = String(mimeType || '').toLowerCase();
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' :
    mime.includes('webp') ? '.webp' :
      mime.includes('gif') ? '.gif' :
        mime.includes('avif') ? '.avif' : '.png';

  const base = String(name || 'shared-image')
    .replace(/\.[^/.]+$/, '') // remove incoming extension
    .replace(/[^a-zA-Z0-9_\s-]/g, '') // remove path traversal / illegal characters
    .trim()
    .slice(0, 50) || 'shared-image';

  return `${base}${ext}`;
}

/**
 * Sanitizes download filename for any file type: removes path traversal while preserving extension
 */
export function safeFileDownloadName(name?: string | null, mimeType?: string | null): string {
  if (!name && mimeType && ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) {
    return safeImageDownloadName(name, mimeType);
  }
  let raw = String(name || 'shared-file').trim();
  raw = raw.replace(/^.*[/\\]/, '').replace(/^\.+/, '');
  const lastDot = raw.lastIndexOf('.');
  const hasExt = lastDot > 0 && lastDot < raw.length - 1;
  const stem = hasExt ? raw.slice(0, lastDot) : raw;
  const ext = hasExt ? raw.slice(lastDot).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 15) : '';

  const cleanStem = stem
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/[^a-zA-Z0-9_\s.-]/g, '')
    .trim()
    .slice(0, 80) || 'shared-file';

  return `${cleanStem}${ext}`;
}

/**
 * Human readable file size formatter with GB support
 */
export function formatFileSize(bytes?: number | null): string {
  if (!bytes || isNaN(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Returns a friendly emoji icon for any file type
 */
export function getFileIcon(fileName?: string | null, mimeType?: string | null): string {
  const mime = String(mimeType || '').toLowerCase();
  const n = String(fileName || '').toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(n)) return '🖼️';
  if (mime.startsWith('video/') || /\.(mp4|webm|mkv|mov|avi|flv|wmv)$/i.test(n)) return '🎥';
  if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|aac|flac|m4a|opus)$/i.test(n)) return '🎵';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar') || /\.(zip|tar|gz|bz2|7z|rar)$/i.test(n)) return '📦';
  if (mime.includes('pdf') || n.endsWith('.pdf')) return '📕';
  if (mime.startsWith('text/') || /\.(txt|md|rtf|json|csv|log)$/i.test(n)) return '📄';
  if (/\.(docx?|pptx?|xlsx?)$/i.test(n)) return '📊';
  if (/\.(exe|dmg|iso|bin|deb|rpm|apk)$/i.test(n)) return '💾';
  return '📁';
}

/**
 * Checks whether a File or Blob is a safe raster image
 */
export function isImageFile(file?: File | Blob | null): boolean {
  if (!file) return false;
  if (file.type && ALLOWED_IMAGE_MIMES.has(file.type.toLowerCase())) return true;
  const name = (file instanceof File ? file.name : '').toLowerCase();
  return /\.(png|jpe?g|webp|gif)$/i.test(name);
}

/**
 * Packs a binary chunk packet with magic, header metadata, and slice payload
 * [4B MAGIC 'IMG1'] [2B headerJson length] [UTF-8 headerJson] [raw image slice bytes]
 */
export function createImagePacket(
  transferId: string,
  chunkIndex: number,
  totalChunks: number,
  rawSliceBuffer: ArrayBuffer
): ArrayBuffer {
  const headerJson = JSON.stringify({ id: transferId, i: chunkIndex, t: totalChunks });
  const headerBytes = new TextEncoder().encode(headerJson);
  const totalLength = 6 + headerBytes.byteLength + rawSliceBuffer.byteLength;
  const packet = new Uint8Array(totalLength);
  const view = new DataView(packet.buffer);

  // Set magic tag & header length
  view.setUint32(0, MAGIC_IMG1, false);
  view.setUint16(4, headerBytes.byteLength, false);

  // Copy header bytes & binary slice payload
  packet.set(headerBytes, 6);
  packet.set(new Uint8Array(rawSliceBuffer), 6 + headerBytes.byteLength);

  return packet.buffer;
}

export interface ParsedImagePacket {
  transferId: string;
  chunkIndex: number;
  totalChunks: number;
  data: ArrayBuffer;
}

/**
 * Unpacks an incoming binary image packet
 */
export function parseImagePacket(arrayBuffer: ArrayBuffer | null | undefined): ParsedImagePacket | null {
  if (!arrayBuffer || arrayBuffer.byteLength < 6) return null;
  const view = new DataView(arrayBuffer);
  const magic = view.getUint32(0, false);
  if (magic !== MAGIC_IMG1) return null;

  const headerLen = view.getUint16(4, false);
  if (arrayBuffer.byteLength < 6 + headerLen) return null;

  try {
    const headerBytes = new Uint8Array(arrayBuffer, 6, headerLen);
    const headerStr = new TextDecoder().decode(headerBytes);
    const meta = JSON.parse(headerStr);
    const data = arrayBuffer.slice(6 + headerLen);

    return {
      transferId: meta.id,
      chunkIndex: meta.i,
      totalChunks: meta.t,
      data
    };
  } catch {
    return null;
  }
}

export interface P2PImageSenderOptions {
  id?: string;
  transferId?: string;
  sender?: string;
  isHost?: boolean;
  caption?: string;
  startChunk?: number;
  onProgress?: (info: { transferId: string; id: string; chunkIndex: number; totalChunks: number; percent: number; isPaused?: boolean }) => void;
  onComplete?: (info: { transferId: string; id: string; fileSize: number; totalChunks: number }) => void;
  onError?: (err: Error) => void;
}

/**
 * Sender: Slices an image or arbitrary file and broadcasts it over open WebRTC DataChannels
 */
export class P2PImageSender {
  public file: File | Blob;
  public getDataChannels: () => RTCDataChannel[];
  public id: string;
  public transferId: string;
  public sender: string;
  public isHost: boolean;
  public caption: string;
  public onProgress: (info: { transferId: string; id: string; chunkIndex: number; totalChunks: number; percent: number; isPaused?: boolean }) => void;
  public onComplete: (info: { transferId: string; id: string; fileSize: number; totalChunks: number }) => void;
  public onError: (err: Error) => void;
  public totalChunks: number;
  public currentChunkIndex: number;
  public isAborted: boolean;
  public isPaused: boolean;

  constructor(
    file: File | Blob,
    getDataChannels: RTCDataChannel[] | (() => RTCDataChannel[]),
    options: P2PImageSenderOptions = {}
  ) {
    this.file = file;
    this.getDataChannels = typeof getDataChannels === 'function' ? getDataChannels : () => getDataChannels;
    this.id = options.id || crypto.randomUUID();
    this.transferId = options.transferId || crypto.randomUUID();
    this.sender = options.sender || 'Peer';
    this.isHost = Boolean(options.isHost);
    this.caption = options.caption || '';
    this.onProgress = options.onProgress || (() => { });
    this.onComplete = options.onComplete || (() => { });
    this.onError = options.onError || (() => { });
    this.totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE) || 1;
    this.currentChunkIndex = 0;
    this.isAborted = false;
    this.isPaused = false;
    if (typeof options.startChunk === 'number' && options.startChunk >= 0) {
      this.currentChunkIndex = Math.min(options.startChunk, this.totalChunks);
    }
  }

  pause(): void {
    this.isPaused = true;
    const percent = Math.min(100, Math.round((this.currentChunkIndex / this.totalChunks) * 100));
    this.onProgress({
      transferId: this.transferId,
      id: this.id,
      chunkIndex: this.currentChunkIndex,
      totalChunks: this.totalChunks,
      percent,
      isPaused: true
    });
  }

  resume(): void {
    if (!this.isPaused && !this.isAborted) return;
    this.isPaused = false;
    this._pump();
  }

  seekTo(chunkIndex: number): void {
    if (chunkIndex >= 0 && chunkIndex <= this.totalChunks) {
      this.currentChunkIndex = chunkIndex;
    }
  }

  start(): void {
    this.isAborted = false;
    this.isPaused = false;

    const channels = this.getDataChannels().filter((dc) => dc && dc.readyState === 'open');
    if (channels.length === 0) {
      this.onError(new Error('No open peer data channels available to send file'));
      return;
    }

    const isImage = isImageFile(this.file);
    const msgType = isImage ? 'p2p-image-start' : 'p2p-file-start';
    const rawName = (this.file instanceof File ? this.file.name : '') || (isImage ? 'screenshot.png' : 'file.bin');
    const safeName = isImage ? safeImageDownloadName(rawName, this.file.type) : safeFileDownloadName(rawName, this.file.type);
    const mime = this.file.type || (isImage ? 'image/png' : 'application/octet-stream');

    // 1. Broadcast initial start announcement message to all peers
    const startMsg = JSON.stringify({
      type: msgType,
      id: this.id,
      transferId: this.transferId,
      fileName: safeName,
      fileSize: this.file.size,
      mimeType: mime,
      totalChunks: this.totalChunks,
      sender: this.sender,
      isHost: this.isHost,
      caption: this.caption,
      timestamp: Date.now()
    });

    for (const dc of channels) {
      try {
        dc.send(startMsg);
      } catch { /* channel send error */ }
    }

    // 2. Begin pumping binary chunks
    this._pump();
  }

  abort(): void {
    this.isAborted = true;
    this.isPaused = false;
  }

  private _pump(): void {
    if (this.isAborted || this.isPaused) return;

    if (this.currentChunkIndex >= this.totalChunks) {
      this.onComplete({
        transferId: this.transferId,
        id: this.id,
        fileSize: this.file.size,
        totalChunks: this.totalChunks
      });
      return;
    }

    const channels = this.getDataChannels().filter((dc) => dc && dc.readyState === 'open');
    if (channels.length === 0) {
      // Peer connection temporarily lost: pause transfer so reconnect resume can continue seamlessly
      this.isPaused = true;
      const percent = Math.min(100, Math.round((this.currentChunkIndex / this.totalChunks) * 100));
      this.onProgress({
        transferId: this.transferId,
        id: this.id,
        chunkIndex: this.currentChunkIndex,
        totalChunks: this.totalChunks,
        percent,
        isPaused: true
      });
      return;
    }

    // Backpressure flow control check: pause if any channel buffer is overloaded (>256 KB)
    const congested = channels.filter((dc) => (dc.bufferedAmount || 0) > 256 * 1024);
    if (congested.length > 0) {
      const slow = congested[0];
      let done = false;
      const cb = () => {
        if (done) return;
        done = true;
        slow.onbufferedamountlow = null;
        this._pump();
      };
      slow.bufferedAmountLowThreshold = 64 * 1024;
      slow.onbufferedamountlow = cb;
      setTimeout(cb, 50);
      return;
    }

    const start = this.currentChunkIndex * FILE_CHUNK_SIZE;
    const end = Math.min(start + FILE_CHUNK_SIZE, this.file.size);
    const slice = this.file.slice(start, end);
    const chunkIdx = this.currentChunkIndex;
    this.currentChunkIndex++;

    const reader = new FileReader();
    reader.onload = () => {
      if (this.isAborted || this.isPaused) return;
      const arrayBuffer = reader.result as ArrayBuffer;
      const packet = createImagePacket(this.transferId, chunkIdx, this.totalChunks, arrayBuffer);

      for (const dc of channels) {
        try {
          if (dc.readyState === 'open') {
            dc.send(packet);
          }
        } catch { /* dropped chunk */ }
      }

      const percent = Math.min(100, Math.round((this.currentChunkIndex / this.totalChunks) * 100));
      this.onProgress({
        transferId: this.transferId,
        id: this.id,
        chunkIndex: chunkIdx,
        totalChunks: this.totalChunks,
        percent,
        isPaused: false
      });

      // Pump next slice with micro-yield
      if (this.currentChunkIndex < this.totalChunks) {
        setTimeout(() => this._pump(), 1);
      } else {
        this._pump();
      }
    };

    reader.onerror = (err) => {
      this.onError(new Error(String(err)));
    };

    reader.readAsArrayBuffer(slice);
  }
}

export const P2PFileSender = P2PImageSender;
export type P2PFileSenderOptions = P2PImageSenderOptions;

export interface InboundImageTransfer {
  id: string;
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  sender: string;
  isHost: boolean;
  caption: string;
  timestamp: number;
  chunks: ArrayBuffer[];
  receivedCount: number;
  receivedBytes: number;
  createdAt: number;
  isPaused?: boolean;
}

export type InboundFileTransfer = InboundImageTransfer;

export interface CompletedImageTransfer {
  transferId: string;
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sender: string;
  isHost: boolean;
  caption: string;
  timestamp: number;
  blob: Blob;
  objectUrl: string;
}

export type CompletedFileTransfer = CompletedImageTransfer;

export interface ReceiverCallbacks {
  onProgress?: (transferId: string, percent: number, transfer: InboundImageTransfer) => void;
  onComplete?: (transferId: string, result: CompletedImageTransfer) => void;
}

/**
 * Receiver: Manages incoming peer image & file transfers and reassembles slices into Blobs
 */
export class P2PImageReceiver {
  public transfers = new Map<string, InboundImageTransfer>();

  handleStart(headerMsg: Record<string, unknown> | null | undefined): void {
    if (!headerMsg || typeof headerMsg !== 'object') return;
    const transferId = typeof headerMsg.transferId === 'string' ? headerMsg.transferId : '';
    if (!transferId.trim() || transferId.length > 64) return;

    // Do not overwrite existing chunks on reconnect announcement
    if (this.transfers.has(transferId)) {
      return;
    }

    const totalChunks = typeof headerMsg.totalChunks === 'number' ? headerMsg.totalChunks : 0;
    if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > MAX_FILE_CHUNKS) return;

    const rawFileSize = typeof headerMsg.fileSize === 'number' ? headerMsg.fileSize : 0;
    const safeFileSize = Number.isFinite(rawFileSize) && rawFileSize > 0 ? rawFileSize : 0;
    const rawMime = typeof headerMsg.mimeType === 'string' ? headerMsg.mimeType : undefined;
    const rawFileName = typeof headerMsg.fileName === 'string' ? headerMsg.fileName : '';
    const isImg = isImageFile({ type: rawMime, name: rawFileName } as File);
    const safeMime = isImg ? sanitizeImageMimeType(rawMime) : sanitizeMimeType(rawMime);
    const rawTimestamp = typeof headerMsg.timestamp === 'number' ? headerMsg.timestamp : Date.now();
    const safeTimestamp = Number.isFinite(rawTimestamp) ? rawTimestamp : Date.now();
    const safeName = isImg
      ? safeImageDownloadName(rawFileName || 'shared-image.png', safeMime)
      : safeFileDownloadName(rawFileName || 'shared-file.bin', safeMime);

    this.transfers.set(transferId, {
      id: typeof headerMsg.id === 'string' && headerMsg.id ? headerMsg.id.slice(0, 64) : crypto.randomUUID(),
      transferId,
      fileName: safeName,
      fileSize: safeFileSize,
      mimeType: safeMime,
      totalChunks,
      sender: typeof headerMsg.sender === 'string' ? headerMsg.sender.slice(0, 64) : 'Peer',
      isHost: Boolean(headerMsg.isHost),
      caption: typeof headerMsg.caption === 'string' ? headerMsg.caption.slice(0, 2000) : '',
      timestamp: safeTimestamp,
      chunks: new Array<ArrayBuffer>(totalChunks),
      receivedCount: 0,
      receivedBytes: 0,
      createdAt: Date.now(),
      isPaused: false
    });
  }

  handleChunk(arrayBuffer: ArrayBuffer, callbacks: ReceiverCallbacks = {}): CompletedImageTransfer | null {
    const parsed = parseImagePacket(arrayBuffer);
    if (!parsed) return null;

    const { transferId, chunkIndex, data } = parsed;
    const transfer = this.transfers.get(transferId);
    if (!transfer) return null;

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= transfer.totalChunks) {
      return null;
    }

    if (!transfer.chunks[chunkIndex]) {
      transfer.chunks[chunkIndex] = data;
      transfer.receivedCount++;
      transfer.receivedBytes += data.byteLength;

      if (transfer.receivedBytes > MAX_FILE_SIZE) {
        this.transfers.delete(transferId);
        return null;
      }

      const percent = Math.min(100, Math.round((transfer.receivedCount / transfer.totalChunks) * 100));
      if (typeof callbacks.onProgress === 'function') {
        callbacks.onProgress(transferId, percent, transfer);
      }

      if (transfer.receivedCount >= transfer.totalChunks) {
        // Complete! Assemble Blob & create Object URL
        const blob = new Blob(transfer.chunks, { type: transfer.mimeType });
        const objectUrl = URL.createObjectURL(blob);
        const result: CompletedImageTransfer = {
          transferId,
          id: transfer.id,
          fileName: transfer.fileName,
          fileSize: transfer.fileSize,
          mimeType: transfer.mimeType,
          sender: transfer.sender,
          isHost: transfer.isHost,
          caption: transfer.caption,
          timestamp: transfer.timestamp,
          blob,
          objectUrl
        };
        this.transfers.delete(transferId);
        if (typeof callbacks.onComplete === 'function') {
          callbacks.onComplete(transferId, result);
        }
        return result;
      }
    }
    return null;
  }

  pause(transferId: string): void {
    const tr = this.transfers.get(transferId);
    if (tr) tr.isPaused = true;
  }

  resume(transferId: string): void {
    const tr = this.transfers.get(transferId);
    if (tr) tr.isPaused = false;
  }

  isPaused(transferId: string): boolean {
    return Boolean(this.transfers.get(transferId)?.isPaused);
  }

  getResumeChunk(transferId: string): number {
    const tr = this.transfers.get(transferId);
    if (!tr) return 0;
    for (let i = 0; i < tr.totalChunks; i++) {
      if (!tr.chunks[i]) return i;
    }
    return tr.totalChunks;
  }

  abort(transferId: string): void {
    this.transfers.delete(transferId);
  }

  reset(): void {
    this.transfers.clear();
  }

  cleanStale(maxAgeMs = 300000): void {
    const now = Date.now();
    for (const [tid, tr] of this.transfers.entries()) {
      if (now - tr.createdAt > maxAgeMs) {
        this.transfers.delete(tid);
      }
    }
  }
}

// Global receiver singleton for room sessions
export const p2pImageReceiver = new P2PImageReceiver();
export const P2PFileReceiver = P2PImageReceiver;
export const p2pFileReceiver = p2pImageReceiver;
