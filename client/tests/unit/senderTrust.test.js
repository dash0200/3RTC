// What a peer's message says about who sent it: the host flag comes from the signaling server,
// names are cleaned (webrtc/peerMessages.js, utils/names.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSender } from '../../src/webrtc/peerMessages.js';
import { cleanName } from '../../src/utils/names.js';

test('a peer saying it is the host is ignored when the server named someone else', () => {
    const hostRef = { current: 'real-host' };
    const fake = { type: 'peer-identity', isHost: true, username: 'Host' };
    normalizeSender(fake, 'guest-1', hostRef);
    assert.equal(fake.isHost, false);
    const real = { type: 'peer-identity', isHost: false };
    normalizeSender(real, 'real-host', hostRef);
    assert.equal(real.isHost, true, 'the real host is the host even if its message says otherwise');
    const chat = { type: 'chat', isHost: true, text: 'hi' };
    normalizeSender(chat, 'guest-1', hostRef);
    assert.equal(chat.isHost, false, 'no HOST badge on a chat message from a guest');
});

test('no host known (room brought back by a guest): nobody is host; an older server: claims are used', () => {
    const none = { type: 'chat', isHost: true };
    normalizeSender(none, 'guest-1', { current: null });
    assert.equal(none.isHost, false);
    const legacy = { type: 'chat', isHost: true };
    normalizeSender(legacy, 'guest-1', { current: undefined });
    assert.equal(legacy.isHost, true);
});

test('messages without the field are left as they are', () => {
    const msg = { type: 'queue-action', action: 'add' };
    normalizeSender(msg, 'p', { current: 'h' });
    assert.deepEqual(msg, { type: 'queue-action', action: 'add' });
});

test('names: trimmed, single spaces, no invisible characters, at most 24 characters', () => {
    assert.equal(cleanName('  Ana   Lee  '), 'Ana Lee');
    assert.equal(cleanName('Ana​‮\nLee'), 'AnaLee');
    assert.equal(cleanName('x'.repeat(500)).length, 24);
    assert.equal(cleanName('😀'.repeat(30)), '😀'.repeat(24));
    for (const empty of ['   ', '​', 42, null, undefined, {}]) assert.equal(cleanName(empty), '');
    const m = { type: 'chat', sender: '   ' };
    normalizeSender(m, 'p', { current: undefined });
    assert.equal(m.sender, undefined, 'an empty name falls back to the default');
});
