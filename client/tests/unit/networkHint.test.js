// Which network to blame when a first connection doesn't work (webrtc/networkHint.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedNetworkHint, candidateType } from '../../src/webrtc/networkHint.js';

test('no public address found: our network blocks it', () => {
    assert.equal(blockedNetworkHint([]).side, 'ours');
    assert.equal(blockedNetworkHint(['host']).side, 'ours');
    assert.match(blockedNetworkHint(['host']).message, /your network seems to block/);
});

test('a public address found: theirs or ours', () => {
    assert.equal(blockedNetworkHint(['host', 'srflx']).side, 'either');
    assert.match(blockedNetworkHint(['srflx']).message, /your network or theirs/);
});

test('candidate type from the object or its text', () => {
    assert.equal(candidateType({ type: 'srflx' }), 'srflx');
    assert.equal(candidateType({ candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0' }), 'host');
    assert.equal(candidateType(null), '');
});
