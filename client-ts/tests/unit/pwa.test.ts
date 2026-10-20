import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareBuilds } from '../../src/version.ts';

// Assets that should not be precached upon launch
const ON_DEMAND_ASSET = /(^|\/)(rnnoise[^/]*\.wasm|workletProcessor-[^/]*\.js|hls-[^/]*\.js|subtitleWorker-[^/]*\.js|ffmpeg[^/]*|audioTranscode[^/]*|libbitsub[^/]*)$/;
const NOT_PRECACHED = /^(og-image\.png|robots\.txt|sitemap\.xml|404\.html)$/;

const ALLOWED_STREAM_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'audio/mp4',
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/wav',
  'audio/aac',
  'audio/flac',
  'audio/opus'
]);

function sanitizeStreamMime(mime: unknown): string {
  if (typeof mime !== 'string') return 'video/mp4';
  const clean = mime.toLowerCase().trim().split(';')[0];
  return ALLOWED_STREAM_MIME_TYPES.has(clean) ? clean : 'video/mp4';
}

const cleanUrl = (file: string) => (file === 'index.html' ? '' : file.replace(/\.html$/, ''));

describe('TypeScript PWA & Service Worker Rules', () => {
  it('correctly compares semantic build strings', () => {
    assert.equal(compareBuilds('261019.1200', '261019.1200'), 0);
    assert.ok(compareBuilds('261019.1200', '261019.1300') < 0);
    assert.ok(compareBuilds('261019.1400', '261019.1200') > 0);
    assert.ok(compareBuilds('261018.9999', '261019.0001') < 0);
    assert.equal(compareBuilds('dev', '261019.1200'), 0);
  });

  it('excludes on-demand wasm/worker chunks from initial precache list', () => {
    assert.ok(ON_DEMAND_ASSET.test('rnnoise-123.wasm'));
    assert.ok(ON_DEMAND_ASSET.test('assets/rnnoise-simd-abc.wasm'));
    assert.ok(ON_DEMAND_ASSET.test('workletProcessor-def.js'));
    assert.ok(ON_DEMAND_ASSET.test('assets/hls-ghi.js'));
    assert.ok(ON_DEMAND_ASSET.test('assets/subtitleWorker-jkl.js'));
    assert.ok(ON_DEMAND_ASSET.test('libbitsub-mno.js'));
    assert.ok(!ON_DEMAND_ASSET.test('assets/index-pqr.js'));
    assert.ok(!ON_DEMAND_ASSET.test('assets/index-stu.css'));
  });

  it('excludes external metadata and crawlable files from app shell cache', () => {
    assert.ok(NOT_PRECACHED.test('robots.txt'));
    assert.ok(NOT_PRECACHED.test('sitemap.xml'));
    assert.ok(NOT_PRECACHED.test('og-image.png'));
    assert.ok(NOT_PRECACHED.test('404.html'));
    assert.ok(!NOT_PRECACHED.test('manifest.webmanifest'));
    assert.ok(!NOT_PRECACHED.test('about.html'));
  });

  it('cleans URL endpoints for service worker precache mapping', () => {
    assert.equal(cleanUrl('index.html'), '');
    assert.equal(cleanUrl('about.html'), 'about');
    assert.equal(cleanUrl('play-ludo-online.html'), 'play-ludo-online');
    assert.equal(cleanUrl('assets/index-123.js'), 'assets/index-123.js');
  });

  it('sanitizes stream MIME types defensively for P2P video stream handler', () => {
    assert.equal(sanitizeStreamMime('video/mp4; codecs="avc1.42E01E"'), 'video/mp4');
    assert.equal(sanitizeStreamMime('video/webm'), 'video/webm');
    assert.equal(sanitizeStreamMime('audio/opus'), 'audio/opus');
    assert.equal(sanitizeStreamMime('text/html'), 'video/mp4');
    assert.equal(sanitizeStreamMime('application/javascript'), 'video/mp4');
    assert.equal(sanitizeStreamMime(null), 'video/mp4');
  });
});
