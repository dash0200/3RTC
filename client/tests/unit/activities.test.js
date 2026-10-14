import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedStore } from '../../src/core/sharedState.js';
import { activityReducer, ACTIVITY_INITIAL } from '../../src/features/activities/activityState.js';
import { createFakeNetwork } from './fakeRoom.js';

function room() {
    const net = createFakeNetwork();
    const host = net.addPeer('h', { isHost: true });
    const guest = net.addPeer('g');
    const opts = { initial: ACTIVITY_INITIAL, reducer: activityReducer };
    const stores = { h: createSharedStore(host.bus, host.room, 'activity', opts), g: createSharedStore(guest.bus, guest.room, 'activity', opts) };
    net.connect('h', 'g');
    return { net, host, guest, stores };
}

describe('open activity', () => {
    it('anyone can start one; everyone sees who started it', async () => {
        const { net, stores } = room();
        stores.g.dispatch({ kind: 'start', id: 'chess', byName: 'Gita' });
        await net.flush();
        assert.equal(stores.h.getState().current.id, 'chess');
        assert.equal(stores.h.getState().current.startedBy, 'g');
        assert.equal(stores.h.getState().current.startedByName, 'Gita');
    });

    it('accepts activities this app does not know (a newer app may), but not malformed ids', async () => {
        const { net, stores } = room();
        stores.g.dispatch({ kind: 'start', id: 'not-in-this-version' });
        await net.flush();
        assert.equal(stores.g.getState().current.id, 'not-in-this-version');
        stores.g.dispatch({ kind: 'start', id: '<script>' });
        await net.flush();
        assert.equal(stores.g.getState().current.id, 'not-in-this-version');
    });

    it('with the host controls lock on, only the host can start or close', async () => {
        const { net, host, stores } = room();
        host.settings.playbackLock = true;
        stores.g.dispatch({ kind: 'start', id: 'chess' });
        await net.flush();
        assert.equal(stores.g.getState().current, null);
        stores.h.dispatch({ kind: 'start', id: 'chess' });
        await net.flush();
        stores.g.dispatch({ kind: 'stop' });
        await net.flush();
        assert.equal(stores.g.getState().current.id, 'chess');
        stores.h.dispatch({ kind: 'stop' });
        await net.flush();
        assert.equal(stores.g.getState().current, null);
    });
});
