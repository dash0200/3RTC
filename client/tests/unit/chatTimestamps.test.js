import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitTimestamps } from '../../src/utils/chatTimestamps.js';

const found = (text) => splitTimestamps(text).filter((p) => p.seconds !== undefined).map((p) => [p.text, p.seconds]);

describe('chat timestamps', () => {
    it('finds m:ss and h:mm:ss', () => {
        assert.deepEqual(found('look at 12:34!'), [['12:34', 754]]);
        assert.deepEqual(found('skip to 1:02:03 then 0:45'), [['1:02:03', 3723], ['0:45', 45]]);
    });
    it('ignores clock times, scores and invalid times', () => {
        for (const text of ['meet at 9:30 pm', 'call 10:15am', 'score 2:1', 'version 1.2:30', 'at 5:61', '1:75:00 nope']) {
            assert.deepEqual(found(text), [], text);
        }
    });
});
