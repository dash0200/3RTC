import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  P2PImageReceiver,
  sanitizeImageFilename,
  isImageFile,
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_CHUNKS
} from '../../src/utils/p2pImageShare.js';
import { P2PStreamReceiver, MAX_STREAM_CHUNKS } from '../../src/utils/p2pStreamer.js';

describe('sanitizeImageFilename (M-02)', () => {
  it('strips directory traversal and path separators', () => {
    assert.equal(sanitizeImageFilename('../../../evil.exe'), 'evil.png');
    assert.equal(sanitizeImageFilename('..\\..\\malicious.bat'), 'malicious.png');
    assert.equal(sanitizeImageFilename('/etc/passwd'), 'passwd.png');
  });

  it('enforces safe raster image extensions', () => {
    assert.equal(sanitizeImageFilename('payload.exe'), 'payload.png');
    assert.equal(sanitizeImageFilename('vector.svg'), 'vector.png');
    assert.equal(sanitizeImageFilename('script.js'), 'script.png');
    assert.equal(sanitizeImageFilename('photo.JPG'), 'photo.jpg');
    assert.equal(sanitizeImageFilename('avatar.png'), 'avatar.png');
    assert.equal(sanitizeImageFilename('anim.gif'), 'anim.gif');
    assert.equal(sanitizeImageFilename('pic.webp'), 'pic.webp');
  });

  it('falls back to default for empty or invalid names', () => {
    assert.equal(sanitizeImageFilename(''), 'shared-image.png');
    assert.equal(sanitizeImageFilename('   '), 'shared-image.png');
    assert.equal(sanitizeImageFilename(null), 'shared-image.png');
  });
});

describe('isImageFile (M-02)', () => {
  it('accepts safe raster images only', () => {
    assert.equal(isImageFile({ type: 'image/png' }), true);
    assert.equal(isImageFile({ type: 'image/jpeg' }), true);
    assert.equal(isImageFile({ type: 'image/webp' }), true);
    assert.equal(isImageFile({ type: 'image/gif' }), true);
  });

  it('rejects SVG and dangerous file types', () => {
    assert.equal(isImageFile({ type: 'image/svg+xml' }), false);
    assert.equal(isImageFile({ name: 'exploit.svg' }), false);
    assert.equal(isImageFile({ type: 'text/html' }), false);
    assert.equal(isImageFile({ name: 'file.exe' }), false);
  });
});

describe('P2PImageReceiver bounds & sanitization (M-01, M-02)', () => {
  it('rejects transfers with invalid or unbounded totalChunks', () => {
    const receiver = new P2PImageReceiver();

    // Negative totalChunks
    receiver.handleStart({ transferId: 't1', totalChunks: -5 });
    assert.equal(receiver.transfers.has('t1'), false);

    // Zero totalChunks
    receiver.handleStart({ transferId: 't2', totalChunks: 0 });
    assert.equal(receiver.transfers.has('t2'), false);

    // Non-integer totalChunks
    receiver.handleStart({ transferId: 't3', totalChunks: 3.5 });
    assert.equal(receiver.transfers.has('t3'), false);

    // Exceeds max chunks
    receiver.handleStart({ transferId: 't4', totalChunks: MAX_IMAGE_CHUNKS + 1 });
    assert.equal(receiver.transfers.has('t4'), false);

    // Valid totalChunks
    receiver.handleStart({ transferId: 't5', totalChunks: 10 });
    assert.equal(receiver.transfers.has('t5'), true);
  });

  it('sanitizes unsafe MIME types to image/png', () => {
    const receiver = new P2PImageReceiver();
    receiver.handleStart({
      transferId: 't-xss',
      totalChunks: 2,
      mimeType: 'image/svg+xml',
      fileName: 'test.svg'
    });
    const tr = receiver.transfers.get('t-xss');
    assert.ok(tr);
    assert.equal(tr.mimeType, 'image/png', 'SVG MIME sanitized to safe raster PNG');
    assert.equal(tr.fileName, 'test.png', 'SVG filename extension sanitized');
  });

  it('ignores chunks out of bounds', () => {
    const receiver = new P2PImageReceiver();
    receiver.handleStart({ transferId: 't-bounds', totalChunks: 2 });
    assert.ok(receiver.transfers.has('t-bounds'));

    // Try sending out of bounds chunk index
    const result = receiver.handleChunk(new ArrayBuffer(0));
    assert.equal(result, null);
  });
});

describe('P2PStreamReceiver bounds validation (M-01)', () => {
  it('rejects invalid or excessive totalChunks via onError', () => {
    let errorCalled = false;
    let errObj = null;

    const receiver = new P2PStreamReceiver(
      { streamId: 's1', totalChunks: -10 },
      { onError: (err) => { errorCalled = true; errObj = err; } }
    );

    assert.equal(errorCalled, true);
    assert.ok(errObj);
    assert.equal(receiver.isAborted, true);
    assert.equal(receiver.chunks.length, 0);

    // Exceeding MAX_STREAM_CHUNKS
    let excessiveError = false;
    new P2PStreamReceiver(
      { streamId: 's2', totalChunks: MAX_STREAM_CHUNKS + 100 },
      { onError: () => { excessiveError = true; } }
    );
    assert.equal(excessiveError, true);
  });
});
