import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressWithRoom } from '../../src/core/backStack.js';

test('the room code goes into the address and out again', () => {
    assert.equal(addressWithRoom('12345', 'https://3rtc.me/'), '/?room=12345');
    assert.equal(addressWithRoom(null, 'https://3rtc.me/?room=12345'), '/');
});

test('other parts of the address are kept', () => {
    assert.equal(addressWithRoom('12345', 'https://3rtc.me/?utm=x#top'), '/?utm=x&room=12345#top');
    assert.equal(addressWithRoom(null, 'https://3rtc.me/?room=1&utm=x'), '/?utm=x');
});

test('a double slash never turns into another site', () => {
    assert.equal(addressWithRoom('12345', 'http://localhost:5199//?room=12345'), '/?room=12345');
});
