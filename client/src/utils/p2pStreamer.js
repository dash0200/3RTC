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
