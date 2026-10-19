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

export const IMAGE_CHUNK_SIZE = 61440; // 60 KB (safely below 64 KB SCTP limit)
export const MAGIC_IMG1 = 0x494D4731;  // 'IMG1' in ASCII hex
export const MAX_IMAGE_CHUNKS = 2048;   // 2048 * 60 KB = ~122 MB max
export const MAX_IMAGE_FILE_SIZE = MAX_IMAGE_CHUNKS * IMAGE_CHUNK_SIZE;

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
 * Human readable file size formatter
 */
export function formatFileSize(bytes?: number | null): string {
  if (!bytes || isNaN(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  onProgress?: (info: { transferId: string; id: string; chunkIndex: number; totalChunks: number; percent: number }) => void;
  onComplete?: (info: { transferId: string; id: string; fileSize: number; totalChunks: number }) => void;
  onError?: (err: Error) => void;
}

/**
 * Sender: Slices an image File and broadcasts it over open WebRTC DataChannels
 */
export class P2PImageSender {
  public file: File | Blob;
  public getDataChannels: () => RTCDataChannel[];
  public id: string;
  public transferId: string;
  public sender: string;
  public isHost: boolean;
  public caption: string;
  public onProgress: (info: { transferId: string; id: string; chunkIndex: number; totalChunks: number; percent: number }) => void;
  public onComplete: (info: { transferId: string; id: string; fileSize: number; totalChunks: number }) => void;
  public onError: (err: Error) => void;
  public totalChunks: number;
  public currentChunkIndex: number;
  public isAborted: boolean;

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
    this.totalChunks = Math.ceil(file.size / IMAGE_CHUNK_SIZE) || 1;
    this.currentChunkIndex = 0;
    this.isAborted = false;
  }

  start(): void {
    this.isAborted = false;
    this.currentChunkIndex = 0;

    const channels = this.getDataChannels().filter((dc) => dc && dc.readyState === 'open');
    if (channels.length === 0) {
      this.onError(new Error('No open peer data channels available to send image'));
      return;
    }

    // 1. Broadcast initial start announcement message to all peers
    const startMsg = JSON.stringify({
      type: 'p2p-image-start',
      id: this.id,
      transferId: this.transferId,
      fileName: (this.file instanceof File ? this.file.name : '') || 'screenshot.png',
      fileSize: this.file.size,
      mimeType: this.file.type || 'image/png',
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
  }

  private _pump(): void {
    if (this.isAborted) return;

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
      this.onError(new Error('All peer connections dropped during image transfer'));
      return;
    }

    // Backpressure flow control check: pause if any channel buffer is overloaded (>256 KB)
    const isCongested = channels.some((dc) => (dc.bufferedAmount || 0) > 256 * 1024);
    if (isCongested) {
      setTimeout(() => this._pump(), 20);
      return;
    }

    const start = this.currentChunkIndex * IMAGE_CHUNK_SIZE;
    const end = Math.min(start + IMAGE_CHUNK_SIZE, this.file.size);
    const slice = this.file.slice(start, end);
    const chunkIdx = this.currentChunkIndex;
    this.currentChunkIndex++;

    const reader = new FileReader();
    reader.onload = () => {
      if (this.isAborted) return;
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
        percent
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
}

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

export interface ReceiverCallbacks {
  onProgress?: (transferId: string, percent: number, transfer: InboundImageTransfer) => void;
  onComplete?: (transferId: string, result: CompletedImageTransfer) => void;
}

/**
 * Receiver: Manages incoming peer image transfers and reassembles slices into Blobs
 */
export class P2PImageReceiver {
  public transfers = new Map<string, InboundImageTransfer>();

  handleStart(headerMsg: Record<string, unknown> | null | undefined): void {
    if (!headerMsg || typeof headerMsg !== 'object') return;
    const transferId = typeof headerMsg.transferId === 'string' ? headerMsg.transferId : '';
    if (!transferId.trim() || transferId.length > 64) return;

    const totalChunks = typeof headerMsg.totalChunks === 'number' ? headerMsg.totalChunks : 0;
    if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > MAX_IMAGE_CHUNKS) return;

    const rawFileSize = typeof headerMsg.fileSize === 'number' ? headerMsg.fileSize : 0;
    const safeFileSize = Number.isFinite(rawFileSize) && rawFileSize > 0 ? rawFileSize : 0;
    const safeMime = sanitizeImageMimeType(typeof headerMsg.mimeType === 'string' ? headerMsg.mimeType : undefined);
    const rawTimestamp = typeof headerMsg.timestamp === 'number' ? headerMsg.timestamp : Date.now();
    const safeTimestamp = Number.isFinite(rawTimestamp) ? rawTimestamp : Date.now();

    this.transfers.set(transferId, {
      id: typeof headerMsg.id === 'string' && headerMsg.id ? headerMsg.id.slice(0, 64) : crypto.randomUUID(),
      transferId,
      fileName: typeof headerMsg.fileName === 'string' ? headerMsg.fileName.slice(0, 120) : 'shared-image.png',
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
      createdAt: Date.now()
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

      if (transfer.receivedBytes > MAX_IMAGE_FILE_SIZE) {
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

  abort(transferId: string): void {
    this.transfers.delete(transferId);
  }

  reset(): void {
    this.transfers.clear();
  }

  cleanStale(maxAgeMs = 120000): void {
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
