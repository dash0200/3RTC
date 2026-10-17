import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedStore, pickAuthority, answerForMissingStores } from '../../src/core/sharedState.js';
import { createFakeNetwork } from './fakeRoom.js';

// A tiny turn-based game: only the player whose turn it is may add; only the host may reset
const initial = { total: 0, turn: null };
function reducer(state, action, meta) {
    if (action.kind === 'add') {
        if (state.turn && state.turn !== meta.by) return state; // not your turn
        return { total: state.total + action.n, turn: action.next || null };
    }
    if (action.kind === 'reset') return meta.isHost ? initial : state;
    return state;
}

function room3() {
    const net = createFakeNetwork();
    const apps = [net.addPeer('h', { isHost: true }), net.addPeer('a'), net.addPeer('b')];
    const stores = {};
    for (const app of apps) stores[app.id] = createSharedStore(app.bus, app.room, 'game', { initial, reducer });
    net.connect('h', 'a');
    net.connect('h', 'b');
    net.connect('a', 'b');
    return { net, apps, stores };
}

describe('pickAuthority', () => {
    it('is the host when present', () => {
        assert.equal(pickAuthority('a', false, [{ peerId: 'z', isHost: true }, { peerId: 'b', isHost: false }]), 'z');
        assert.equal(pickAuthority('a', true, [{ peerId: 'z', isHost: false }]), 'a');
    });
    it('falls back to the smallest id, so every app picks the same peer', () => {
        assert.equal(pickAuthority('m', false, [{ peerId: 'q' }, { peerId: 'c' }]), 'c');
        assert.equal(pickAuthority('a', false, []), 'a');
    });
});

describe('shared state', () => {
    it("a guest's action goes to the host, and everyone ends with the same state", async () => {
        const { net, stores } = room3();
        await net.flush();
        stores.a.dispatch({ kind: 'add', n: 5 });
        await net.flush();
        for (const id of ['h', 'a', 'b']) {
            assert.deepEqual(stores[id].getState(), { total: 5, turn: null });
            assert.equal(stores[id].getVersion(), 1);
        }
    });

    it('the reducer rejects actions using who really sent them', async () => {
        const { net, stores } = room3();
        stores.h.dispatch({ kind: 'add', n: 1, next: 'a' }); // now it's a's turn
        await net.flush();
        stores.b.dispatch({ kind: 'add', n: 100 });          // b may not
        await net.flush();
        assert.equal(stores.h.getState().total, 1);
        stores.a.dispatch({ kind: 'add', n: 2 });
        await net.flush();
        assert.equal(stores.b.getState().total, 3);
        stores.a.dispatch({ kind: 'reset' });                // only the host may reset
        await net.flush();
        assert.equal(stores.h.getState().total, 3);
    });

    it('a late joiner gets the current state', async () => {
        const { net, stores } = room3();
        stores.h.dispatch({ kind: 'add', n: 7 });
        await net.flush();
        const late = net.addPeer('late');
        const lateStore = createSharedStore(late.bus, late.room, 'game', { initial, reducer });
        net.connect('h', 'late');
        await net.flush();
        assert.equal(lateStore.getState().total, 7);
    });

    it('a store created after connecting asks for the state (lazy-loaded feature)', async () => {
        const net = createFakeNetwork();
        const host = net.addPeer('h', { isHost: true });
        const guest = net.addPeer('g');
        const hostStore = createSharedStore(host.bus, host.room, 'game', { initial, reducer });
        net.connect('h', 'g');
        hostStore.dispatch({ kind: 'add', n: 4 });
        await net.flush();
        const guestStore = createSharedStore(guest.bus, guest.room, 'game', { initial, reducer });
        await net.flush();
        assert.equal(guestStore.getState().total, 4);
    });

    it('when the host leaves, the next authority carries on', async () => {
        const { net, stores } = room3();
        stores.a.dispatch({ kind: 'add', n: 1 });
        await net.flush();
        net.disconnect('h', 'a');
        net.disconnect('h', 'b');
        stores.b.dispatch({ kind: 'add', n: 1 });            // 'a' (smallest id) decides now
        await net.flush();
        assert.equal(stores.a.getState().total, 2);
        assert.equal(stores.b.getState().total, 2);
    });

    it('ignores older versions and other keys', async () => {
        const { net, apps, stores } = room3();
        stores.h.dispatch({ kind: 'add', n: 3 });
        await net.flush();
        const a = apps[1];
        a.bus.dispatch({ type: 'room-state', key: 'game', v: 1, state: { total: 999 } }, 'h');
        a.bus.dispatch({ type: 'room-state', key: 'other', v: 50, state: { total: 999 } }, 'h');
        assert.equal(stores.a.getState().total, 3);
    });

    it('rejects unverified room-state broadcasts from non-authority peers', async () => {
        const { net, apps, stores } = room3();
        stores.h.dispatch({ kind: 'add', n: 3 });
        await net.flush();
        // Guest 'b' attempts to broadcast forged high-version room-state to Guest 'a' and Host 'h'
        apps[1].bus.dispatch({ type: 'room-state', key: 'game', v: 99999999, state: { total: 0 } }, 'b');
        apps[0].bus.dispatch({ type: 'room-state', key: 'game', v: 99999999, state: { total: 0 } }, 'b');
        await net.flush();
        assert.equal(stores.a.getState().total, 3, 'guest a rejected state from guest b');
        assert.equal(stores.a.getVersion(), 1);
        assert.equal(stores.h.getState().total, 3, 'host h rejected state from guest b');
        assert.equal(stores.h.getVersion(), 1);
    });

    it('actions sent to a peer that is not the authority are ignored', async () => {
        const { net, apps, stores } = room3();
        apps[2].bus.dispatch({ type: 'room-state-action', key: 'game', action: { kind: 'add', n: 50 } }, 'a');
        await net.flush();
        assert.equal(stores.b.getState().total, 0);
    });

    it('a throwing reducer never breaks the room', () => {
        const net = createFakeNetwork();
        const host = net.addPeer('h', { isHost: true });
        const store = createSharedStore(host.bus, host.room, 'x', { initial: 0, reducer: () => { throw new Error('bad'); } });
        assert.doesNotThrow(() => store.dispatch({}));
        assert.equal(store.getState(), 0);
    });

    it('leaving the room resets it', async () => {
        const { net, apps, stores } = room3();
        stores.h.dispatch({ kind: 'add', n: 3 });
        await net.flush();
        apps[1].bus.emitEvent('room-left');
        assert.deepEqual(stores.a.getState(), initial);
        assert.equal(stores.a.getVersion(), 0);
    });

    it('subscribers hear about every change', async () => {
        const { net, stores } = room3();
        let heard = 0;
        stores.b.subscribe(() => { heard += 1; });
        stores.a.dispatch({ kind: 'add', n: 1 });
        stores.a.dispatch({ kind: 'add', n: 1 });
        await net.flush();
        assert.equal(heard, 2);
    });
});

it('a host coming back (new connection, empty store) gets the game from the others', async () => {
    const net = createFakeNetwork();
    const reducer = (state, action) => (action.kind === 'add' ? { n: state.n + 1 } : state);
    const host = net.addPeer('h', { isHost: true });
    const guest = net.addPeer('g');
    const hs = createSharedStore(host.bus, host.room, 'game', { initial: { n: 0 }, reducer });
    const gs = createSharedStore(guest.bus, guest.room, 'game', { initial: { n: 0 }, reducer });
    net.connect('h', 'g');
    await net.flush();
    for (let i = 0; i < 3; i++) gs.dispatch({ kind: 'add' });
    await net.flush();
    assert.equal(hs.getState().n, 3);
    // The host leaves: the guest carries on as the authority
    net.disconnect('h', 'g');
    host.bus.emitEvent('room-left');
    gs.dispatch({ kind: 'add' });
    await net.flush();
    assert.equal(gs.getState().n, 4);
    assert.equal(hs.getState().n, 0);
    // ...and comes back: authority again, and it has the game as it is now
    net.connect('h', 'g');
    await net.flush();
    assert.equal(hs.getState().n, 4);
    gs.dispatch({ kind: 'add' });
    await net.flush();
    assert.deepEqual([hs.getState().n, gs.getState().n], [5, 5]);
});

describe('who has the store (people can skip or leave a game)', () => {
    // h (host) and a, b in the room; the ones without the game answer for it with "gone"
    function room(withGame) {
        const net = createFakeNetwork();
        const apps = {};
        for (const [id, isHost] of [['h', true], ['a', false], ['b', false]]) apps[id] = net.addPeer(id, { isHost });
        for (const id of ['h', 'a', 'b']) if (!withGame.includes(id)) answerForMissingStores(apps[id].bus, (k) => k.startsWith('act:'));
        net.connect('h', 'a'); net.connect('h', 'b'); net.connect('a', 'b');
        const stores = {};
        for (const id of withGame) stores[id] = createSharedStore(apps[id].bus, apps[id].room, 'act:game', { initial, reducer });
        return { net, apps, stores };
    }

    it("the host without the game doesn't decide: the smallest id among those who have it does", async () => {
        const { net, stores } = room(['a', 'b']);
        await net.flush();
        assert.equal(stores.a.getPresence().authorityId, 'a');
        assert.deepEqual(stores.b.getPresence().members, ['a', 'b']);
        stores.b.dispatch({ kind: 'add', n: 4 });
        await net.flush();
        assert.equal(stores.a.getState().total, 4, 'the game works without the host');
        assert.equal(stores.b.getState().total, 4);
    });

    it('someone who leaves the game is no longer counted; coming back gets the current state', async () => {
        const { net, apps, stores } = room(['h', 'a', 'b']);
        await net.flush();
        stores.a.dispatch({ kind: 'add', n: 2 });
        await net.flush();
        stores.h.destroy(); // the host leaves the game
        answerForMissingStores(apps.h.bus, (k) => k.startsWith('act:'));
        await net.flush();
        assert.equal(stores.a.getPresence().authorityId, 'a');
        assert.deepEqual(stores.b.getPresence().members, ['a', 'b']);
        stores.b.dispatch({ kind: 'add', n: 3 });
        await net.flush();
        assert.equal(stores.b.getState().total, 5, 'the game goes on without the host');
        const back = createSharedStore(apps.h.bus, apps.h.room, 'act:game', { initial, reducer });
        await net.flush();
        assert.equal(back.getState().total, 5, 'the host gets the game as it is now');
        assert.equal(stores.a.getPresence().authorityId, 'h', 'and decides again');
    });

    it('meta.present lists only the people who have the game (others count as away)', async () => {
        let seen = null;
        const spyReducer = (state, action, meta) => { seen = meta.present; return reducer(state, action, meta); };
        const net = createFakeNetwork();
        const h = net.addPeer('h', { isHost: true }); const a = net.addPeer('a'); const b = net.addPeer('b');
        answerForMissingStores(b.bus, (k) => k.startsWith('act:'));
        net.connect('h', 'a'); net.connect('h', 'b'); net.connect('a', 'b');
        const sh = createSharedStore(h.bus, h.room, 'act:g', { initial, reducer: spyReducer });
        createSharedStore(a.bus, a.room, 'act:g', { initial, reducer: spyReducer });
        await net.flush();
        sh.dispatch({ kind: 'add', n: 1 });
        await net.flush();
        assert.deepEqual([...seen].sort(), ['a', 'h']);
    });

    it('an app that never says "gone" (older version) always counts as having it', async () => {
        const net = createFakeNetwork();
        net.addPeer('h', { isHost: true }); const a = net.addPeer('a');
        net.connect('h', 'a');
        const sa = createSharedStore(a.bus, a.room, 'act:g', { initial, reducer });
        await net.flush();
        assert.equal(sa.getPresence().authorityId, 'h');
    });
});
