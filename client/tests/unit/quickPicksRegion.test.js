import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickPicksUrl } from '../../src/utils/quickPicks.js';

test('the request names the country (worldwide unless one was picked)', () => {
    assert.equal(quickPicksUrl('wss://sig.example.com', 'GLOBAL'), 'https://sig.example.com/api/quick-picks?region=GLOBAL');
    assert.equal(quickPicksUrl('wss://sig.example.com', 'IN'), 'https://sig.example.com/api/quick-picks?region=IN');
    assert.equal(quickPicksUrl('ws://localhost:8091', ''), 'http://localhost:8091/api/quick-picks');
});
