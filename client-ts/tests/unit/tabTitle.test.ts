import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeTitle, titleLine } from '../../src/utils/tabTitle.ts';

const room = { roomId: '12345', others: ['Riya'] };

describe('tab title', () => {
  it('outside a room: the page keeps its own title', () => {
    assert.equal(composeTitle({ roomId: null, others: [] }), null);
  });
  it('in a room: who with', () => {
    assert.equal(composeTitle({ roomId: '12345', others: [] }), 'Room 12345 · waiting for friends — 3RTC');
    assert.equal(titleLine(room), 'Room 12345 · with Riya');
    assert.equal(titleLine({ roomId: '12345', others: ['Riya', 'Ben', 'Asha'] }), 'Room 12345 · with Riya +2');
  });
  it('most useful first: reconnecting, your turn, messages, talking, a game to join, the video, the game', () => {
    const all = {
      ...room,
      reconnecting: true,
      game: { name: 'Ludo', icon: '🎲', attention: true, label: 'Your turn' },
      unread: 2,
      lastMessage: { name: 'Riya', text: 'are you there?' },
      talking: ['Riya'],
      invite: { name: 'Chess', icon: '♟️', by: 'Riya' },
      nowPlaying: 'Lofi beats'
    };
    assert.equal(titleLine(all), '⚠️ Reconnecting… · Room 12345');
    assert.equal(titleLine({ ...all, reconnecting: false }), '🎲 Your turn · Ludo');
    const noTurn = { ...all, reconnecting: false, game: { name: 'Ludo', icon: '🎲' } };
    assert.equal(titleLine(noTurn), '💬 Riya: are you there?');
    assert.equal(titleLine({ ...noTurn, unread: 0 }), '🔊 Riya is talking');
    assert.equal(titleLine({ ...noTurn, unread: 0, talking: [] }), '♟️ Riya started Chess · join in');
    assert.equal(titleLine({ ...noTurn, unread: 0, talking: [], invite: null }), '▶ Lofi beats');
    assert.equal(titleLine({ ...noTurn, unread: 0, talking: [], invite: null, nowPlaying: '' }), '🎲 Ludo · Room 12345');
  });
  it('the unread count goes in front; long text is cut', () => {
    const t = composeTitle({ ...room, unread: 12, lastMessage: { name: 'Riya', text: 'x'.repeat(80) } })!;
    assert.match(t, /^\(9\+\) 💬 Riya: x+… — 3RTC$/);
    assert.ok(t.length < 70, t);
  });
  it('several people talking', () => {
    assert.equal(titleLine({ ...room, talking: ['Riya', 'Ben'] }), '🔊 Riya & Ben are talking');
    assert.equal(titleLine({ ...room, talking: ['Riya', 'Ben', 'Asha'] }), '🔊 Riya +2 talking');
  });
});
