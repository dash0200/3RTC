// Signaling server: rooms, joining, the size limit, relaying offers. Starts the real server.
// Run: npm test (in server/)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL = `ws://localhost:${PORT}`;
let server;

function client() {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        const i = waiters.findIndex((w) => w.type === msg.type);
        if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
        else inbox.push(msg);
    });
    return {
        ws,
        open: () => new Promise((resolve) => ws.once('open', resolve)),
        send: (msg) => ws.send(JSON.stringify(msg)),
        next(type, ms = 3000) {
            const i = inbox.findIndex((m) => m.type === type);
            if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
            return new Promise((resolve, reject) => {
                waiters.push({ type, resolve });
                setTimeout(() => reject(new Error(`no ${type} within ${ms} ms`)), ms);
            });
        },
        close: () => ws.close()
    };
}

async function connected(peerId) {
    const c = client();
    await c.open();
    c.peerId = peerId;
    return c;
}

describe('signaling server', () => {
    before(async () => {
        server = spawn(process.execPath, ['server.js'], { cwd: path.join(here, '..'), env: { ...process.env, PORT: String(PORT), YOUTUBE_API_KEY: '' }, stdio: 'ignore' });
        for (let i = 0; i < 50; i++) {
            try {
                const res = await fetch(`http://localhost:${PORT}/api/quick-picks`);
                if (res.status) return;
            } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('server did not start');
    });
    after(() => server?.kill());

    it('creates a room with a 5-digit code and lets people join it', async () => {
        const host = await connected('host-1');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        assert.match(String(roomId), /^\d{5}$/);
        const guest = await connected('guest-1');
        guest.send({ type: 'join', roomId, peerId: guest.peerId });
        const joined = await guest.next('joined');
        assert.deepEqual(joined.peers, ['host-1']);
        const notice = await host.next('peer-joined');
        assert.equal(notice.peerId, 'guest-1');
        host.close();
        guest.close();
    });

    it('relays an offer to the named peer, marked with who sent it', async () => {
        const host = await connected('host-2');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest = await connected('guest-2');
        guest.send({ type: 'join', roomId, peerId: guest.peerId });
        await guest.next('joined');
        await host.next('peer-joined');
        host.send({ type: 'offer', targetId: 'guest-2', offer: { type: 'offer', sdp: 'x' } });
        const offer = await guest.next('offer');
        assert.equal(offer.from, 'host-2');
        assert.equal(offer.offer.sdp, 'x');
        host.close();
        guest.close();
    });

    it('refuses an unknown room and a full room', async () => {
        const lost = await connected('lost');
        lost.send({ type: 'join', roomId: '00000', peerId: lost.peerId });
        assert.ok((await lost.next('error')).message);
        lost.close();

        const host = await connected('h3');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const others = [];
        for (let i = 0; i < 5; i++) {
            const c = await connected(`p3-${i}`);
            c.send({ type: 'join', roomId, peerId: c.peerId });
            await c.next('joined');
            others.push(c);
        }
        const seventh = await connected('p3-late');
        seventh.send({ type: 'join', roomId, peerId: seventh.peerId });
        assert.match((await seventh.next('error')).message, /full/);
        for (const c of [host, ...others, seventh]) c.close();
    });

    it('tells the room when someone leaves', async () => {
        const host = await connected('h4');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest = await connected('g4');
        guest.send({ type: 'join', roomId, peerId: guest.peerId });
        await guest.next('joined');
        guest.send({ type: 'leave' });
        assert.equal((await host.next('peer-left')).peerId, 'g4');
        host.close();
        guest.close();
    });

    it('serves quick picks with CORS (503 without a YouTube key)', async () => {
        const res = await fetch(`http://localhost:${PORT}/api/quick-picks`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });
});
