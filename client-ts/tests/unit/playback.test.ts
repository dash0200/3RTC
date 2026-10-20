import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  driftCorrection,
  playingKey,
  DRIFT_LIMIT_S,
  type PlaybackSyncState,
  type DriftHeartbeat
} from '../../src/features/playback/drift';

const yt = (t: number, extra: Partial<PlaybackSyncState> = {}): PlaybackSyncState => ({
  videoId: 'abc',
  currentTime: t,
  isPlaying: true,
  ...extra
});

const hb = (t: number | string, extra: Partial<DriftHeartbeat> = {}): DriftHeartbeat => ({
  key: 'yt:abc',
  currentTime: t as unknown as number,
  isPlaying: true,
  ...extra
});

const calm = { now: 100000, lastChangeAt: 0, backoffUntil: 0 };

test('what is playing: same key on two apps means the same video', () => {
  assert.equal(playingKey(yt(1)), 'yt:abc');
  assert.equal(
    playingKey({ mediaType: 'local', fileName: 'film.mp4', fileSize: 10, currentTime: 0, isPlaying: true }),
    'local:film.mp4:10'
  );
  assert.equal(
    playingKey({
      mediaType: 'link',
      media: { provider: 'vimeo', url: 'https://vimeo.com/1' },
      currentTime: 0,
      isPlaying: true
    }),
    'link:vimeo:https://vimeo.com/1'
  );
  assert.equal(playingKey(null), '');
  assert.equal(playingKey({ videoId: null, currentTime: 0, isPlaying: false }), '');
});

test('in step: nothing to do', () => {
  assert.equal(driftCorrection(hb(100), yt(100.4), calm), null);
  assert.equal(driftCorrection(hb(100), yt(100 - DRIFT_LIMIT_S), calm), null);
});

test('behind or ahead by more than the limit: jump to the room (a little ahead)', () => {
  const t = driftCorrection(hb(100), yt(95), calm);
  assert.ok(t !== null && t > 100 && t < 101, String(t));
  const tAhead = driftCorrection(hb(100), yt(104), calm);
  assert.ok(tAhead !== null && tAhead > 100);
});

test('left alone: paused, buffering, live, another video, just after a change, backing off', () => {
  assert.equal(driftCorrection(hb(100, { isPlaying: false }), yt(90), calm), null, 'room paused');
  assert.equal(driftCorrection(hb(100), yt(90, { isPlaying: false }), calm), null, 'we paused');
  assert.equal(driftCorrection(hb(100), yt(90, { isBuffering: true }), calm), null, 'we are loading');
  assert.equal(driftCorrection(hb(100), yt(90, { live: true }), calm), null, 'live stream');
  assert.equal(driftCorrection({ ...hb(100), key: 'yt:other' }, yt(90), calm), null, 'different video');
  assert.equal(
    driftCorrection(hb(100), yt(90), { ...calm, lastChangeAt: calm.now - 2000 }),
    null,
    'someone just seeked'
  );
  assert.equal(
    driftCorrection(hb(100), yt(90), { ...calm, backoffUntil: calm.now + 1000 }),
    null,
    'backing off'
  );
  assert.equal(driftCorrection(null, yt(90), calm), null);
  assert.equal(driftCorrection(hb('x'), yt(90), calm), null);
});
