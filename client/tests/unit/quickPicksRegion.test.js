import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRegion, quickPicksUrl } from '../../src/utils/quickPicks.js';

test('the country comes from the time zone first', () => {
    assert.equal(detectRegion('Asia/Kolkata', ['en-US']), 'IN');
    assert.equal(detectRegion('Asia/Calcutta', []), 'IN');
    assert.equal(detectRegion('America/Los_Angeles', ['hi-IN']), 'US');
    assert.equal(detectRegion('America/Indiana/Indianapolis', []), 'US');
    assert.equal(detectRegion('America/Toronto', ['en-US']), 'CA');
    assert.equal(detectRegion('Europe/London', []), 'GB');
    assert.equal(detectRegion('Australia/Sydney', []), 'AU');
    assert.equal(detectRegion('America/Sao_Paulo', []), 'BR');
    assert.equal(detectRegion('Asia/Seoul', []), 'KR');
});

test('then from the language; nothing known means the worldwide list', () => {
    assert.equal(detectRegion('Europe/Madrid', ['es-ES', 'en-GB']), 'GB');
    assert.equal(detectRegion('UTC', ['de-DE']), 'DE');
    assert.equal(detectRegion('Asia/Dubai', ['ar-AE', 'en']), '');
    assert.equal(detectRegion('', []), '');
});

test('the request names the country', () => {
    assert.equal(quickPicksUrl('wss://sig.example.com', 'IN'), 'https://sig.example.com/api/quick-picks?region=IN');
    assert.equal(quickPicksUrl('ws://localhost:8091', ''), 'http://localhost:8091/api/quick-picks');
});
