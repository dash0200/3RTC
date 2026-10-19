import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionFeed } from '../../src/features/reactions/reactionFeed';
import { keyForIndex, DEFAULT_REACTIONS } from '../../src/features/reactions/reactionSet';

describe('reactionFeed', () => {
  it('delivers emitted reactions to subscribers without error', () => {
    const feed = createReactionFeed();
    const received: any[] = [];
    const unsub = feed.subscribe((item) => {
      received.push(item);
    });

    feed.emit({
      id: '1',
      emoji: '🔥',
      sender: 'Alice',
      isSelf: true,
      lane: 50,
      combo: 1,
      peerKey: 'self'
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].emoji, '🔥');
    assert.equal(received[0].sender, 'Alice');

    unsub();
    feed.emit({
      id: '2',
      emoji: '👍',
      sender: 'Bob',
      isSelf: false,
      lane: 40,
      combo: 2,
      peerKey: 'bob'
    });
    assert.equal(received.length, 1);
  });
});

describe('reactionSet', () => {
  it('maps indices 0-8 to 1-9 and index 9 to 0', () => {
    assert.equal(keyForIndex(0), '1');
    assert.equal(keyForIndex(4), '5');
    assert.equal(keyForIndex(8), '9');
    assert.equal(keyForIndex(9), '0');
  });

  it('contains expected default emojis', () => {
    assert.ok(DEFAULT_REACTIONS.includes('👍'));
    assert.ok(DEFAULT_REACTIONS.includes('🔥'));
    assert.ok(DEFAULT_REACTIONS.length >= 6);
  });
});
