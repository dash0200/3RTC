import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomBus } from '../../src/core/roomBus.ts';
import { createSharedStore } from '../../src/core/sharedState.ts';

// Three apps wired together in memory: messages arrive on the next tick, like a data channel
function mesh(ids: string[], hostId: string) {
  const buses: Record<string, ReturnType<typeof createRoomBus>> = {};
  const sent: { from: string; to: string; msg: Record<string, unknown> }[] = [];
  for (const me of ids) {
    const peers = new Map(
      ids.filter((p) => p !== me).map((p) => [p, {
        dataChannel: {
          readyState: 'open',
          bufferedAmount: 0,
          send: (text: string) => {
            const msg = JSON.parse(text);
            sent.push({ from: me, to: p, msg });
            setTimeout(() => buses[p].dispatch(msg, me), 0);
          }
        },
        bulkChannel: null
      }])
    );
    buses[me] = createRoomBus({ getPeers: () => peers as never, getSelf: () => ({ peerId: me, username: me, isHost: me === hostId }) as never });
  }
  const roomOf = (me: string) => ({
    bus: buses[me],
    getSelfId: () => me,
    getSelf: () => ({ peerId: me, username: me, isHost: me === hostId }),
    isPeerHost: (p: string | null | undefined) => p === hostId,
    getHostPeerId: () => hostId,
    peerName: () => null,
    clientIdOf: () => null,
    peerProtocol: () => 1,
    getAuthorityId: () => hostId,
    getRoomSettings: () => ({}),
    notify: () => {},
    log: () => {}
  }) as never;
  return { buses, roomOf, sent };
}

interface S { secrets: Record<string, number>; open: number }
type A = { kind: 'set'; n: number };
const options = {
  initial: { secrets: {}, open: 0 } as S,
  reducer: (s: S, a: A, meta: { by: string }): S => ({ secrets: { ...s.secrets, [meta.by]: a.n }, open: s.open + 1 }),
  redact: (s: S, peerId: string): S => ({ ...s, secrets: peerId in s.secrets ? { [peerId]: s.secrets[peerId] } : {} })
};
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('shared state with redact', () => {
  it('each peer only ever receives its own secret', async () => {
    const { buses, roomOf, sent } = mesh(['h', 'a', 'b'], 'h');
    const stores = Object.fromEntries(['h', 'a', 'b'].map((id) => [id, createSharedStore<S, A>(buses[id], roomOf(id), 'g', options)]));
    await tick();
    stores.a.dispatch({ kind: 'set', n: 1 });
    stores.b.dispatch({ kind: 'set', n: 2 });
    stores.h.dispatch({ kind: 'set', n: 9 });
    await tick();
    await tick();
    assert.deepEqual(stores.h.getState().secrets, { a: 1, b: 2, h: 9 }); // the authority has it all
    assert.deepEqual(stores.a.getState(), { secrets: { a: 1 }, open: 3 });
    assert.deepEqual(stores.b.getState(), { secrets: { b: 2 }, open: 3 });
    // nothing on the wire ever carried another peer's secret to it
    for (const { to, msg } of sent) {
      if (msg.type !== 'room-state') continue;
      const secrets = (msg.state as S).secrets;
      for (const owner of Object.keys(secrets)) assert.equal(owner, to, `leaked ${owner}'s secret to ${to}`);
    }
    for (const s of Object.values(stores)) s.destroy();
  });

  it('a late joiner gets a copy made for it', async () => {
    const { buses, roomOf } = mesh(['h', 'a'], 'h');
    const h = createSharedStore<S, A>(buses.h, roomOf('h'), 'g2', options);
    h.dispatch({ kind: 'set', n: 5 });
    await tick();
    const a = createSharedStore<S, A>(buses.a, roomOf('a'), 'g2', options);
    await tick();
    await tick();
    assert.deepEqual(a.getState(), { secrets: {}, open: 1 });
    h.destroy();
    a.destroy();
  });
});
