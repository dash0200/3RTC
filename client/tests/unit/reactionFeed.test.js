import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionFeed } from '../../src/features/reactions/reactionFeed.js';

describe('reactionFeed event stream', () => {
    it('emits to subscribed listeners with mediaTime', () => {
        const feed = createReactionFeed();
        const received = [];
        const unsub = feed.subscribe((item) => {
            received.push(item);
        });

        feed.emit({ emoji: '🔥', mediaTime: 42.5 });
        feed.emit({ emoji: '❤️', mediaTime: 43.1 });

        assert.equal(received.length, 2);
        assert.equal(received[0].emoji, '🔥');
        assert.equal(received[0].mediaTime, 42.5);
        assert.equal(received[1].emoji, '❤️');

        unsub();
        feed.emit({ emoji: '🎉', mediaTime: 45.0 });
        // Should not receive after unsubscribe
        assert.equal(received.length, 2);
    });

    it('tolerates failing listeners without crashing feed', () => {
        const feed = createReactionFeed();
        feed.subscribe(() => {
            throw new Error('Listener crash');
        });

        let successCalled = false;
        feed.subscribe(() => {
            successCalled = true;
        });

        assert.doesNotThrow(() => {
            feed.emit({ emoji: '👍' });
        });
        assert.equal(successCalled, true);
    });
});
