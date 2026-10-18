import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P2PImageReceiver, sanitizeImageMimeType, MAX_IMAGE_CHUNKS } from '../../src/utils/p2pImageShare.js';
import { sanitizeMediaMimeType, P2PStreamReceiver, P2PRangeReceiver, MAX_STREAM_CHUNKS } from '../../src/utils/p2pStreamer.js';

test('security: sanitizeMediaMimeType prevents XSS mime injection', () => {
  assert.equal(sanitizeMediaMimeType('video/mp4'), 'video/mp4');
  assert.equal(sanitizeMediaMimeType('video/webm; codecs="vp9"'), 'video/webm');
  assert.equal(sanitizeMediaMimeType('audio/mp4'), 'audio/mp4');

  // Malicious / unexpected MIME types fall back to video/mp4
  assert.equal(sanitizeMediaMimeType('text/html'), 'video/mp4');
  assert.equal(sanitizeMediaMimeType('image/svg+xml'), 'video/mp4');
  assert.equal(sanitizeMediaMimeType('application/javascript'), 'video/mp4');
  assert.equal(sanitizeMediaMimeType(null), 'video/mp4');
  assert.equal(sanitizeMediaMimeType(''), 'video/mp4');
});

test('security: sanitizeImageMimeType restricts P2P images to safe raster formats', () => {
  assert.equal(sanitizeImageMimeType('image/png'), 'image/png');
  assert.equal(sanitizeImageMimeType('image/jpeg'), 'image/jpeg');
  assert.equal(sanitizeImageMimeType('image/webp'), 'image/webp');

  // Malicious image MIME types (SVG scripts, HTML) fall back to image/png
  assert.equal(sanitizeImageMimeType('image/svg+xml'), 'image/png');
  assert.equal(sanitizeImageMimeType('text/html'), 'image/png');
  assert.equal(sanitizeImageMimeType(undefined), 'image/png');
});

test('security: P2PImageReceiver handles malformed or out-of-bounds totalChunks without crashing', () => {
  const receiver = new P2PImageReceiver();

  // Negative chunks
  receiver.handleStart({ transferId: 't1', totalChunks: -10 });
  assert.equal(receiver.transfers.has('t1'), false);

  // Zero chunks
  receiver.handleStart({ transferId: 't2', totalChunks: 0 });
  assert.equal(receiver.transfers.has('t2'), false);

  // Non-integer string
  receiver.handleStart({ transferId: 't3', totalChunks: 'invalid' });
  assert.equal(receiver.transfers.has('t3'), false);

  // Exorbitant chunks (OOM attack attempt)
  receiver.handleStart({ transferId: 't4', totalChunks: 50000000 });
  assert.equal(receiver.transfers.has('t4'), false);

  // Valid chunks
  receiver.handleStart({ transferId: 't5', totalChunks: 5, mimeType: 'text/html' });
  assert.equal(receiver.transfers.has('t5'), true);
  const tr = receiver.transfers.get('t5');
  assert.equal(tr.mimeType, 'image/png', 'dangerous text/html sanitized to image/png');
  assert.equal(tr.chunks.length, 5);

  // Malformed chunk packet index
  const badPacket = receiver.handleChunk(new ArrayBuffer(3)); // too short
  assert.equal(badPacket, null);
});

test('security: P2PStreamReceiver caps totalChunks and sanitizes mimeType', () => {
  const rec = new P2PStreamReceiver({
    streamId: 's1',
    fileName: 'hack.html',
    mimeType: 'text/html',
    fileSize: 1000,
    totalChunks: 999999999
  });

  assert.equal(rec.mimeType, 'video/mp4');
  assert.equal(rec.totalChunks, MAX_STREAM_CHUNKS);
  assert.equal(rec.chunks.length, MAX_STREAM_CHUNKS);
});

test('security: P2PRangeReceiver safely calculates totalBlocks and sanitizes mimeType', () => {
  const rangeRec = new P2PRangeReceiver({
    streamNo: 1,
    fileName: 'exploit.svg',
    mimeType: 'image/svg+xml',
    fileSize: -500,
    blockSize: 0
  });

  assert.equal(rangeRec.mimeType, 'video/mp4');
  assert.equal(rangeRec.fileSize, 0);
  assert.equal(rangeRec.totalBlocks, 0);
});

test('security: safeImageDownloadName sanitizes download filenames and forces safe extensions', async () => {
  const { safeImageDownloadName } = await import('../../src/utils/p2pImageShare.js');

  // Traversal & malicious executable extension stripped
  assert.equal(safeImageDownloadName('../../malicious_payload.exe', 'image/png'), 'malicious_payload.png');
  assert.equal(safeImageDownloadName('script.bat', 'image/jpeg'), 'script.jpg');
  assert.equal(safeImageDownloadName('exploit.html', 'image/webp'), 'exploit.webp');
  assert.equal(safeImageDownloadName('invoice.pdf.cmd', 'image/gif'), 'invoicepdf.gif');
  assert.equal(safeImageDownloadName('', 'image/png'), 'shared-image.png');
  assert.equal(safeImageDownloadName(null, null), 'shared-image.png');
});

test('security: detectLink blocks cloud metadata / link-local SSRF endpoints', async () => {
  const { detectLink } = await import('../../src/features/media/sources.js');

  // AWS / GCP / Azure IMDS endpoint
  const awsImds = detectLink('http://169.254.169.254/latest/meta-data/');
  assert.equal(awsImds.ok, false);

  // Google Cloud metadata hostname
  const gcpMeta = detectLink('http://metadata.google.internal/computeMetadata/v1/');
  assert.equal(gcpMeta.ok, false);

  // Legitimate links continue to work
  const legit = detectLink('https://example.com/movie.mp4');
  assert.equal(legit.ok, true);
  assert.equal(legit.media.provider, 'file');
});

