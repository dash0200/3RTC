import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spy } from './spy.js';
import { createRoomBus } from '../../src/core/roomBus.js';

const channel = (readyState = 'open') => ({ readyState, sent: [], send(t) { this.sent.push(JSON.parse(t)); } });

function setup() {
    const peers = new Map([
        ['p1', { dataChannel: channel(), bulkChannel: channel() }],
        ['p2', { dataChannel: channel(), bulkChannel: channel('connecting') }],
        ['p3', { dataChannel: channel('closed'), bulkChannel: null }]
    ]);
    const bus = createRoomBus({ getPeers: () => peers, getSelf: () => ({ peerId: 'me', username: 'Me', isHost: true }) });
    return { peers, bus };
}

describe('roomBus', () => {
    it('broadcasts to open channels only and stamps sender and timestamp', () => {
        const { peers, bus } = setup();
        assert.equal(bus.broadcast('reaction', { emoji: '🔥' }), 2);
        const msg = peers.get('p1').dataChannel.sent[0];
        assert.equal(msg.type, 'reaction');
        assert.equal(msg.emoji, '🔥');
        assert.equal(msg.sender, 'Me');
        assert.equal(typeof msg.timestamp, 'number');
        assert.equal(peers.get('p3').dataChannel.sent.length, 0);
    });

    it('keeps a sender given by the caller, but the payload never changes the type', () => {
        const { peers, bus } = setup();
        bus.send('p1', 'chat', { sender: 'Alias', type: 'evil' });
        const msg = peers.get('p1').dataChannel.sent[0];
        assert.equal(msg.type, 'chat');
        assert.equal(msg.sender, 'Alias');
    });

    it('uses the bulk channel when asked and open, otherwise the main one', () => {
        const { peers, bus } = setup();
        bus.broadcast('blob', {}, { bulk: true });
        assert.equal(peers.get('p1').bulkChannel.sent.length, 1);
        assert.equal(peers.get('p2').dataChannel.sent.length, 1); // its bulk channel isn't open yet
    });

    it('can skip one peer', () => {
        const { peers, bus } = setup();
        assert.equal(bus.broadcast('x', {}, { except: 'p1' }), 1);
        assert.equal(peers.get('p1').dataChannel.sent.length, 0);
    });

    it('send() to a missing or closed peer reports false', () => {
        const { bus } = setup();
        assert.equal(bus.send('p3', 'x'), false);
        assert.equal(bus.send('nobody', 'x'), false);
    });

    it('lists connected peers', () => {
        assert.deepEqual(setup().bus.connectedPeerIds(), ['p1', 'p2']);
    });

    it('dispatches to every handler of a type, and unsubscribes', () => {
        const { bus } = setup();
        const a = spy();
        const b = spy();
        const offA = bus.on('chat', a);
        bus.on('chat', b);
        assert.equal(bus.dispatch({ type: 'chat', text: 'hi' }, 'p1'), true);
        assert.deepEqual(a.calls[0], [{ type: 'chat', text: 'hi' }, 'p1']);
        offA();
        bus.dispatch({ type: 'chat' }, 'p1');
        assert.equal(a.calls.length, 1);
        assert.equal(b.calls.length, 2);
        assert.equal(bus.dispatch({ type: 'unknown' }, 'p1'), false); // ignored, no error
    });

    it('a failing handler does not stop the others', () => {
        const onHandlerError = spy();
        const bus = createRoomBus({ getPeers: () => new Map(), getSelf: () => ({}), onHandlerError });
        const after = spy();
        bus.on('t', () => { throw new Error('boom'); });
        bus.on('t', after);
        bus.dispatch({ type: 't' }, 'p');
        assert.equal(after.calls.length, 1);
        assert.equal(onHandlerError.calls[0][1], 't');
    });

    it('binary frames go to the first handler that claims them', () => {
        const { bus } = setup();
        const image = spy((buf) => new DataView(buf).getUint8(0) === 1);
        const stream = spy(() => true);
        bus.onBinary(image);
        bus.onBinary(stream);
        bus.dispatchBinary(new Uint8Array([1]).buffer, 'p1');
        assert.equal(stream.calls.length, 0);
        bus.dispatchBinary(new Uint8Array([2]).buffer, 'p1');
        assert.equal(stream.calls.length, 1);
    });

    it('local events reach their listeners until they unsubscribe', () => {
        const { bus } = setup();
        const fn = spy();
        const off = bus.onEvent('peer-open', fn);
        bus.emitEvent('peer-open', 'p9');
        off();
        bus.emitEvent('peer-open', 'p9');
        assert.deepEqual(fn.calls, [['p9']]);
    });
});
