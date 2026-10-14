/**
 * In-memory rooms for unit tests: several "apps" whose buses are wired to each other with fake
 * data channels, so features can be tested without browsers or WebRTC.
 *
 *   const net = createFakeNetwork();
 *   const a = net.addPeer('a', { isHost: true });
 *   const b = net.addPeer('b');
 *   net.connect('a', 'b');           // opens channels both ways, fires 'peer-open'
 *   await net.flush();               // deliver queued messages
 */
import { createRoomBus } from '../../src/core/roomBus';
import { pickAuthority } from '../../src/core/sharedState';

export function createFakeNetwork() {
    const peers = new Map(); // id -> app
    const queue = [];

    const makeChannel = (from, to) => ({
        readyState: 'open',
        sent: [],
        send(text) {
            if (this.readyState !== 'open') throw new Error('channel closed');
            this.sent.push(text);
            queue.push({ from, to, text });
        }
    });

    function addPeer(id, { isHost = false, username = id } = {}) {
        const app = { id, isHost, username, entries: new Map(), settings: {} };
        app.bus = createRoomBus({
            getPeers: () => app.entries,
            getSelf: () => ({ peerId: id, username: app.username, isHost: app.isHost }),
            onHandlerError: (error) => { throw error; }
        });
        const connectedPeers = () => app.bus.connectedPeerIds().map((peerId) => ({ peerId, isHost: peers.get(peerId)?.isHost || false }));
        app.room = {
            bus: app.bus,
            getSelfId: () => id,
            getSelf: () => ({ peerId: id, username: app.username, isHost: app.isHost }),
            isPeerHost: (peerId) => (peerId === id ? app.isHost : Boolean(peers.get(peerId)?.isHost)),
            getHostPeerId: () => connectedPeers().find((p) => p.isHost)?.peerId || null,
            peerName: (peerId) => peers.get(peerId)?.username || null,
            peerProtocol: () => 2,
            getAuthorityId: () => pickAuthority(id, app.isHost, connectedPeers()),
            getRoomSettings: () => app.settings,
            notify: () => { },
            log: () => { }
        };
        peers.set(id, app);
        return app;
    }

    function connect(a, b) {
        const A = peers.get(a);
        const B = peers.get(b);
        A.entries.set(b, { dataChannel: makeChannel(a, b), bulkChannel: makeChannel(a, b) });
        B.entries.set(a, { dataChannel: makeChannel(b, a), bulkChannel: makeChannel(b, a) });
        A.bus.emitEvent('peer-open', b);
        B.bus.emitEvent('peer-open', a);
    }

    function disconnect(a, b) {
        for (const [x, y] of [[a, b], [b, a]]) {
            const app = peers.get(x);
            app.entries.delete(y);
            app.bus.emitEvent('peer-close', y);
        }
    }

    /** Deliver everything queued (and whatever that triggers), in order. */
    async function flush(limit = 1000) {
        let n = 0;
        while (queue.length) {
            if (++n > limit) throw new Error('message storm');
            const { from, to, text } = queue.shift();
            const target = peers.get(to);
            if (!target?.entries.has(from)) continue; // disconnected meanwhile
            target.bus.dispatch(JSON.parse(text), from);
        }
    }

    return { peers, addPeer, connect, disconnect, flush, queue };
}
