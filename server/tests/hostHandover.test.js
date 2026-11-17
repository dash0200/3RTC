// Host migration: when the host leaves and doesn't come back in time, the person in the room
// longest becomes the host. Run: npm test (in server/)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client } from './helpers.js';

const GRACE = 400;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function room(url, ids) {
    const people = [];
    for (const id of ids) {
        const c = client(url);
        await c.open();
        people.push(c);
    }
    people[0].send({ type: 'create-room', peerId: ids[0] });
    const created = await people[0].next('room-created');
    for (let i = 1; i < ids.length; i++) {
        people[i].send({ type: 'join', roomId: created.roomId, peerId: ids[i] });
        await people[i].next('joined');
    }
    return { people, created };
}

describe('host migration', () => {
    let server;
    before(async () => { server = await startServer({ HOST_HANDOVER_GRACE_MS: String(GRACE) }); });
    after(() => server.proc.kill());

    it('makes the longest-present person host after the host leaves, with a working host token', async () => {
        const { people: [host, first, second], created } = await room(server.url, ['hm-h', 'hm-a', 'hm-b']);
        host.send({ type: 'leave' });
        await first.next('peer-left');
        const msg = await first.next('host', GRACE + 2000);
        assert.equal(msg.hostPeerId, 'hm-a', 'the first to join after the host');
        assert.equal(msg.reason, 'host-left');
        assert.equal(msg.from, undefined, "not a hand-over: older apps don't say someone made them host");
        assert.equal((await second.next('host')).hostPeerId, 'hm-a');
        const token = await first.next('host-token');
        assert.equal(token.roomId, created.roomId);

        // The new host's token gets the room back after a drop; the old host's no longer does
        first.close();
        await wait(100);
        const back = client(server.url);
        await back.open();
        back.send({ type: 'create-room', roomId: created.roomId, peerId: 'hm-a', hostToken: token.hostToken });
        assert.equal((await back.next('room-resumed')).hostPeerId, 'hm-a');
        host.send({ type: 'create-room', roomId: created.roomId, peerId: 'hm-h', hostToken: created.hostToken });
        assert.equal((await host.next('error')).code, 'resume-denied');
        for (const c of [host, back, second]) c.close();
    });

    it('keeps the host when it comes back within the grace period (Leave then Rejoin)', async () => {
        const { people: [host, guest], created } = await room(server.url, ['hk-h', 'hk-g']);
        host.send({ type: 'leave' });
        await host.next('left');
        await wait(GRACE / 4);
        host.send({ type: 'create-room', roomId: created.roomId, peerId: 'hk-h', hostToken: created.hostToken });
        await host.next('room-resumed');
        assert.equal((await guest.next('host')).hostPeerId, 'hk-h');
        await wait(GRACE + 300);
        assert.ok(!guest.inbox.some((m) => m.type === 'host'), 'no hand-over after the host came back');
        assert.ok(!guest.inbox.some((m) => m.type === 'host-token'));
        host.close();
        guest.close();
    });

    it('keeps the host when it comes back with a new peer id (page reload)', async () => {
        const { people: [host, guest], created } = await room(server.url, ['hr-h', 'hr-g']);
        host.close();
        await guest.next('peer-left');
        const reloaded = client(server.url);
        await reloaded.open();
        reloaded.send({ type: 'create-room', roomId: created.roomId, peerId: 'hr-h2', hostToken: created.hostToken });
        await reloaded.next('room-resumed');
        assert.equal((await guest.next('host')).hostPeerId, 'hr-h2');
        await wait(GRACE + 300);
        assert.ok(!guest.inbox.some((m) => m.type === 'host'), 'no hand-over');
        reloaded.close();
        guest.close();
    });

    it("doesn't hand over when a guest leaves, or when the room empties", async () => {
        const { people: [host, guest] } = await room(server.url, ['hg-h', 'hg-g']);
        guest.send({ type: 'leave' });
        await host.next('peer-left');
        await wait(GRACE + 300);
        assert.ok(!host.inbox.some((m) => m.type === 'host' || m.type === 'host-token'));
        host.send({ type: 'leave' });
        await host.next('left');
        await wait(GRACE + 300); // nothing left to hand over (and nothing crashes)
        const probe = client(server.url);
        await probe.open();
        probe.send({ type: 'ping' });
        await probe.next('pong');
        for (const c of [host, guest, probe]) c.close();
    });

    it('turns a hub room back into a mesh when its host leaves', async () => {
        const { people: [host, guest] } = await room(server.url, ['hh-h', 'hh-g']);
        host.send({ type: 'set-topology', topology: 'hub' });
        assert.equal((await guest.next('topology-changed')).topology, 'hub');
        host.send({ type: 'leave' });
        assert.equal((await guest.next('host', GRACE + 2000)).hostPeerId, 'hh-g');
        assert.equal((await guest.next('topology-changed')).topology, 'mesh');
        host.close();
        guest.close();
    });
});
