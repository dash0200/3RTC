import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftCorrection, playingKey, DRIFT_LIMIT_S } from '../../src/features/playback/drift';

const yt = (t: number, extra = {}) => ({ videoId: 'abc', currentTime: t, isPlaying: true, ...extra });
const hb = (t: number | string, extra = {}) => ({ key: 'yt:abc', currentTime: t as number, isPlaying: true, ...extra });
const calm = { now: 100000, lastChangeAt: 0, backoffUntil: 0 };

test('what is playing: same key on two apps means the same video', () => {
  assert.equal(playingKey(yt(1)), 'yt:abc');
  assert.equal(
    playingKey({ mediaType: 'local', fileName: 'film.mp4', fileSize: 10 } as any),
    'local:film.mp4:10'
  );
  assert.equal(
    playingKey({
      mediaType: 'link',
      media: { provider: 'vimeo', url: 'https://vimeo.com/1' }
    } as any),
    'link:vimeo:https://vimeo.com/1'
  );
  assert.equal(playingKey(null), '');
  assert.equal(playingKey({ videoId: null } as any), '');
});

test('in step: nothing to do', () => {
  assert.equal(driftCorrection(hb(100) as any, yt(100.4) as any, calm), null);
  assert.equal(driftCorrection(hb(100) as any, yt(100 - DRIFT_LIMIT_S) as any, calm), null);
});

test('behind or ahead by more than the limit: jump to the room (a little ahead)', () => {
  const t = driftCorrection(hb(100) as any, yt(95) as any, calm);
  assert.ok(t !== null && t > 100 && t < 101, String(t));
  const tAhead = driftCorrection(hb(100) as any, yt(104) as any, calm);
  assert.ok(tAhead !== null && tAhead > 100);
});

test('left alone: paused, buffering, live, another video, just after a change, backing off', () => {
  assert.equal(driftCorrection(hb(100, { isPlaying: false }) as any, yt(90) as any, calm), null, 'room paused');
  assert.equal(driftCorrection(hb(100) as any, yt(90, { isPlaying: false }) as any, calm), null, 'we paused');
  assert.equal(driftCorrection(hb(100) as any, yt(90, { isBuffering: true }) as any, calm), null, 'we are loading');
  assert.equal(driftCorrection(hb(100) as any, yt(90, { live: true }) as any, calm), null, 'live stream');
  assert.equal(driftCorrection({ ...hb(100), key: 'yt:other' } as any, yt(90) as any, calm), null, 'different video');
  assert.equal(
    driftCorrection(hb(100) as any, yt(90) as any, { ...calm, lastChangeAt: calm.now - 2000 }),
    null,
    'someone just seeked'
  );
  assert.equal(
    driftCorrection(hb(100) as any, yt(90) as any, { ...calm, backoffUntil: calm.now + 1000 }),
    null,
    'backing off'
  );
  assert.equal(driftCorrection(null, yt(90) as any, calm), null);
  assert.equal(driftCorrection(hb('x') as any, yt(90) as any, calm), null);
});
