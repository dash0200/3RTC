import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSingleEmoji, splitEmojis } from '../../src/utils/emoji.js';
import { setReactionSet, getReactionSet, keyForIndex, DEFAULT_REACTIONS, MAX_REACTIONS } from '../../src/features/reactions/reactionSet.js';

describe('emoji checks', () => {
    it('accepts one emoji, including joined ones, flags and skin tones', () => {
        for (const e of ['👍', '❤️', '👩‍🚀', '🇮🇳', '👍🏽', '❤️‍🔥', '🫠']) assert.ok(isSingleEmoji(e), e);
    });
    it('refuses text, numbers, several emojis and empty input', () => {
        for (const e of ['a', '1', 'hi 👍', '👍👍', '', ' ', '<b>', null, 5]) assert.equal(isSingleEmoji(e), false, String(e));
    });
    it('splits pasted text into its emojis', () => {
        assert.deepEqual(splitEmojis('🦄 and 🐼🇮🇳!'), ['🦄', '🐼', '🇮🇳']);
    });
});

describe('quick reaction set', () => {
    it('keys are 1-9 then 0', () => {
        assert.deepEqual([0, 1, 8, 9].map(keyForIndex), ['1', '2', '9', '0']);
    });
    it('keeps at most 10, drops duplicates and non-emojis', () => {
        setReactionSet(['🔥', '🔥', 'x', '😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊']);
        const set = getReactionSet();
        assert.equal(set.length, MAX_REACTIONS);
        assert.equal(set[0].emoji, '🔥');
        assert.equal(set[1].emoji, '😀');
        assert.equal(set[9].key, '0');
    });
    it('an empty or broken set falls back to the defaults', () => {
        setReactionSet([]);
        assert.deepEqual(getReactionSet().map((r) => r.emoji), DEFAULT_REACTIONS);
        setReactionSet('nope');
        assert.deepEqual(getReactionSet().map((r) => r.emoji), DEFAULT_REACTIONS);
    });
});
