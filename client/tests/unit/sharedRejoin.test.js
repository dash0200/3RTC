import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomBus } from '../../src/core/roomBus.js';
import { createSharedStore, answerForMissingStores } from '../../src/core/sharedState.js';

// Apps wired together in memory. Messages arrive on a later tick; messages from the peers in
// `slow` arrive later than the rest, so tests can choose the order things land in.
function mesh(ids, hostId, slow = {}) {
  const buses = {};
  for (const me of ids) {
    const peers = new Map(
      ids.filter((p) => p !== me).map((p) => [p, {
        dataChannel: {
          readyState: 'open',
          bufferedAmount: 0,
          send: (text) => {
            const msg = JSON.parse(text);
            setTimeout(() => buses[p].dispatch(msg, me), slow[me] || 0);
          }
        },
        bulkChannel: null
      }])
    );
    buses[me] = createRoomBus({ getPeers: () => peers, getSelf: () => ({ peerId: me, username: me, isHost: me === hostId }) });
  }
  const roomOf = (me) => ({
    bus: buses[me],
    getSelfId: () => me,
    getSelf: () => ({ peerId: me, username: me, isHost: me === hostId }),
    isPeerHost: (p) => p === hostId,
    getHostPeerId: () => hostId,
    peerName: () => null,
    clientIdOf: () => null,
    peerProtocol: () => 1,
    getAuthorityId: () => hostId,
    getRoomSettings: () => ({}),
    notify: () => {},
    log: () => {}
  });
  return { buses, roomOf };
}

const options = {
  initial: { strokes: 0 },
  reducer: (s, a) => (a.kind === 'draw' ? { strokes: s.strokes + 1 } : s)
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('joining a game the host has left (M4)', () => {
  // 'h' is the host but has left the game (still in the room); 'p' is still playing; 'g' joins
  // the game again. The host's "I don't have it" reaches g after p's state does.
  for (const [label, joiner] of [['the rejoiner is not the new authority', 'z'], ['the rejoiner becomes the authority', 'a']]) {
    it(`gets the current state even when it arrives before the host's "gone" (${label})`, async () => {
      const { buses, roomOf } = mesh(['h', 'p', joiner], 'h', { h: 25 });
      // As in the app (useActivityLoad): everyone without the game says so when asked
      answerForMissingStores(buses.h, (k) => k === 'board');
      answerForMissingStores(buses[joiner], (k) => k === 'board');
      const player = createSharedStore(buses.p, roomOf('p'), 'board', options);
      await wait(60); // p learns the host doesn't have the game: p decides now
      player.dispatch({ kind: 'draw' });
      player.dispatch({ kind: 'draw' });
      player.dispatch({ kind: 'draw' });
      await wait(10);
      assert.equal(player.getState().strokes, 3);

      const back = createSharedStore(buses[joiner], roomOf(joiner), 'board', options);
      await wait(120);
      assert.equal(back.getState().strokes, 3, 'the returning player sees the board as it is');
      assert.equal(back.getVersion(), player.getVersion());

      // ...and stays in step afterwards
      back.dispatch({ kind: 'draw' });
      await wait(30);
      assert.equal(player.getState().strokes, 4);
      assert.equal(back.getState().strokes, 4);
      player.destroy();
      back.destroy();
    });
  }
});
