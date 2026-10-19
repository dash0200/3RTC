import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomBus } from '../../src/core/roomBus.ts';
import { pickAuthority } from '../../src/core/sharedState.ts';
import { addressWithRoom } from '../../src/core/backStack.ts';

const createChannel = (readyState = 'open') => ({
  readyState,
  sent: [] as Array<Record<string, unknown>>,
  send(t: string | ArrayBufferView | ArrayBuffer) {
    if (typeof t === 'string') {
      this.sent.push(JSON.parse(t) as Record<string, unknown>);
    }
  }
});

function setupBus() {
  const peers = new Map([
    ['p1', { dataChannel: createChannel('open'), bulkChannel: createChannel('open') }],
    ['p2', { dataChannel: createChannel('open'), bulkChannel: createChannel('connecting') }],
    ['p3', { dataChannel: createChannel('closed'), bulkChannel: null }]
  ]);
  const bus = createRoomBus({
    getPeers: () => peers,
    getSelf: () => ({ peerId: 'me', username: 'Me', isHost: true })
  });
  return { peers, bus };
}

describe('TypeScript roomBus', () => {
  it('broadcasts to open channels and adds sender and timestamp stamps', () => {
    const { peers, bus } = setupBus();
    const count = bus.broadcast('reaction', { emoji: '🔥' });
    assert.equal(count, 2);

    const msg = (peers.get('p1')!.dataChannel as any).sent[0];
    assert.equal(msg.type, 'reaction');
    assert.equal(msg.emoji, '🔥');
    assert.equal(msg.sender, 'Me');
    assert.equal(typeof msg.timestamp, 'number');

    assert.equal((peers.get('p3')!.dataChannel as any).sent.length, 0);
  });

  it('delivers messages via dispatch to registered on handlers', () => {
    const { bus } = setupBus();
    let received: unknown = null;
    let from: string | null = null;

    const off = bus.on<{ text: string }>('chat', (msg, fromPeerId) => {
      received = msg;
      from = fromPeerId;
    });

    bus.dispatch({ type: 'chat', text: 'hello TypeScript' }, 'p1');
    assert.deepEqual(received, { type: 'chat', text: 'hello TypeScript' });
    assert.equal(from, 'p1');

    off();
    received = null;
    bus.dispatch({ type: 'chat', text: 'hello again' }, 'p1');
    assert.equal(received, null);
  });
});

describe('TypeScript pickAuthority', () => {
  it('selects the host when present', () => {
    assert.equal(
      pickAuthority('a', false, [
        { peerId: 'z', isHost: true },
        { peerId: 'b', isHost: false }
      ]),
      'z'
    );
    assert.equal(pickAuthority('a', true, [{ peerId: 'z', isHost: false }]), 'a');
  });

  it('falls back to the smallest peerId for deterministic consensus', () => {
    assert.equal(
      pickAuthority('m', false, [
        { peerId: 'q', isHost: false },
        { peerId: 'c', isHost: false }
      ]),
      'c'
    );
    assert.equal(pickAuthority('a', false, []), 'a');
  });
});

describe('TypeScript addressWithRoom', () => {
  it('adds and strips ?room query param safely', () => {
    const withRoom = addressWithRoom('12345', 'https://3rtc.me/watch');
    assert.equal(withRoom, '/watch?room=12345');

    const withoutRoom = addressWithRoom(null, 'https://3rtc.me/watch?room=12345');
    assert.equal(withoutRoom, '/watch');
  });
});
