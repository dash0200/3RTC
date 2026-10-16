// Seat and host tokens (seats.js): who may take a seat or get a room back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeats, isValidPeerId, newEpoch, TOKEN_TTL_MS } from '../seats.js';

const seats = createSeats('test-secret');
const epoch = newEpoch();

test('a seat token works for its own room, room instance and peer id only', () => {
    const t = seats.seatToken('12345', epoch, 'peer-a');
    assert.equal(seats.checkSeat(t, '12345', 'peer-a'), epoch);
    assert.equal(seats.checkSeat(t, '12346', 'peer-a'), null);
    assert.equal(seats.checkSeat(t, '12345', 'peer-b'), null);
    assert.equal(seats.checkHost(t, '12345'), null, 'a seat token is not a host token');
});

test('a host token works for its room with any peer id', () => {
    const t = seats.hostToken('12345', epoch);
    assert.equal(seats.checkHost(t, '12345'), epoch);
    assert.equal(seats.checkHost(t, '54321'), null);
    assert.equal(seats.checkSeat(t, '12345', ''), null);
});

test('tokens expire, and tampered or foreign tokens fail', () => {
    const now = Date.now();
    const t = seats.hostToken('12345', epoch, now);
    assert.equal(seats.checkHost(t, '12345', now + TOKEN_TTL_MS + 2000), null);
    const [v, e, exp, sig] = t.split('.');
    assert.equal(seats.checkHost([v, e, String(Number(exp) + 9999), sig].join('.'), '12345'), null, 'a longer expiry breaks it');
    assert.equal(seats.checkHost([v, newEpoch(), exp, sig].join('.'), '12345'), null, 'another room instance breaks it');
    assert.equal(createSeats('other-secret').checkHost(t, '12345'), null, 'another server secret');
    for (const junk of [undefined, null, 42, '', 'v1', 'x'.repeat(500)]) assert.equal(seats.checkHost(junk, '12345'), null);
});

test('peer ids: short safe text only', () => {
    assert.ok(isValidPeerId(crypto.randomUUID()));
    for (const bad of ['', 'a b', '<x>', 'x'.repeat(65), 7, null]) assert.equal(isValidPeerId(bad), false);
});
