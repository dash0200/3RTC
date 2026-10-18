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

    it('rejects untargeted offer in multi-peer room', async () => {
        const host = await connected('host-mp');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest1 = await connected('guest-mp-1');
        guest1.send({ type: 'join', roomId, peerId: guest1.peerId });
        await guest1.next('joined');
        await host.next('peer-joined');
        const guest2 = await connected('guest-mp-2');
        guest2.send({ type: 'join', roomId, peerId: guest2.peerId });
        await guest2.next('joined');
        await host.next('peer-joined');
        await guest1.next('peer-joined');

        host.send({ type: 'offer', offer: { type: 'offer', sdp: 'xyz' } });
        const err = await host.next('error');
        assert.equal(err.message, 'targetId required in multi-peer rooms');

        host.close();
        guest1.close();
        guest2.close();
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
        for (let i = 0; i < 3; i++) {
            const c = await connected(`p3-${i}`);
            c.send({ type: 'join', roomId, peerId: c.peerId });
            await c.next('joined');
            others.push(c);
        }
        const fifth = await connected('p3-late');
        fifth.send({ type: 'join', roomId, peerId: fifth.peerId });
        assert.match((await fifth.next('error')).message, /full/);
        for (const c of [host, ...others, fifth]) c.close();
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

    it("refuses someone claiming a peer id that's in use (S1), and keeps routing to its owner", async () => {
        const host = await connected('h5');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const victim = await connected('victim-5');
        victim.send({ type: 'join', roomId, peerId: victim.peerId });
        await victim.next('joined');
        await host.next('peer-joined');
        const thief = await connected('victim-5');
        thief.send({ type: 'join', roomId, peerId: 'victim-5' });
        assert.equal((await thief.next('error')).code, 'seat-taken');
        thief.send({ type: 'join', roomId, peerId: 'victim-5', rejoin: true, seatToken: 'v1.0123456789abcdef.9999999999.forged' });
        assert.equal((await thief.next('error')).code, 'seat-taken');
        host.send({ type: 'offer', targetId: 'victim-5', offer: { type: 'offer', sdp: 'y' } });
        assert.equal((await victim.next('offer')).offer.sdp, 'y');
        for (const c of [host, victim, thief]) c.close();
    });

    it('lets a peer reclaim its own seat with its seat token (signaling dropped)', async () => {
        const host = await connected('h6');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest = await connected('g6');
        guest.send({ type: 'join', roomId, peerId: guest.peerId });
        const { seatToken, hostToken } = await guest.next('joined');
        assert.ok(seatToken);
        assert.equal(hostToken, undefined, 'only the host gets the host token');
        await host.next('peer-joined');
        const again = await connected('g6'); // the old socket isn't closed yet
        again.send({ type: 'join', roomId, peerId: 'g6', rejoin: true, seatToken });
        assert.deepEqual((await again.next('joined')).peers, ['h6']);
        host.send({ type: 'offer', targetId: 'g6', offer: { type: 'offer', sdp: 'z' } });
        assert.equal((await again.next('offer')).offer.sdp, 'z');
        for (const c of [host, guest, again]) c.close();
    });

    it('resumes a room only with its host token (S9), also with a new peer id', async () => {
        const host = await connected('h7');
        host.send({ type: 'create-room', peerId: host.peerId });
        const created = await host.next('room-created');
        assert.ok(created.hostToken && created.seatToken);
        const stranger = await connected('s7');
        stranger.send({ type: 'create-room', roomId: created.roomId, peerId: 's7' });
        assert.equal((await stranger.next('error')).code, 'resume-denied');
        // A host token for another room doesn't work either
        const other = await connected('h7b');
        other.send({ type: 'create-room', peerId: 'h7b' });
        const otherRoom = await other.next('room-created');
        stranger.send({ type: 'create-room', roomId: created.roomId, peerId: 's7', hostToken: otherRoom.hostToken });
        assert.equal((await stranger.next('error')).code, 'resume-denied');
        // The host after reloading the page: new peer id, same host token
        const reloaded = await connected('h7-new');
        reloaded.send({ type: 'create-room', roomId: created.roomId, peerId: 'h7-new', hostToken: created.hostToken });
        const resumed = await reloaded.next('room-resumed');
        assert.equal(resumed.roomId, created.roomId);
        assert.ok(resumed.hostToken, 'the resumed host gets a fresh host token');
        for (const c of [host, stranger, other, reloaded]) c.close();
    });

    it("brings back a closed room only with a seat token for it (a stranger can't make up rooms)", async () => {
        const host = await connected('h8');
        host.send({ type: 'create-room', peerId: host.peerId });
        const { roomId } = await host.next('room-created');
        const guest = await connected('g8');
        guest.send({ type: 'join', roomId, peerId: 'g8' });
        const { seatToken } = await guest.next('joined');
        host.close();
        guest.close();
        await new Promise((r) => setTimeout(r, 300)); // the room is gone
        const stranger = await connected('s8');
        stranger.send({ type: 'join', roomId, peerId: 's8', rejoin: true });
        assert.equal((await stranger.next('error')).code, 'not-found');
        stranger.send({ type: 'join', roomId, peerId: 's8', rejoin: true, seatToken });
        assert.equal((await stranger.next('error')).code, 'not-found', "someone else's seat token doesn't work");
        const back = await connected('g8');
        back.send({ type: 'join', roomId, peerId: 'g8', rejoin: true, seatToken });
        assert.equal((await back.next('joined')).roomId, roomId);
        for (const c of [stranger, back]) c.close();
    });

    it('says who the host is (S2): to joiners, and to everyone when the host comes back with a new id', async () => {
        const host = await connected('h9');
        host.send({ type: 'create-room', peerId: 'h9' });
        const created = await host.next('room-created');
        assert.equal(created.hostPeerId, 'h9');
        const guest = await connected('g9');
        guest.send({ type: 'join', roomId: created.roomId, peerId: 'g9' });
        assert.equal((await guest.next('joined')).hostPeerId, 'h9');
        const back = await connected('h9-new');
        back.send({ type: 'create-room', roomId: created.roomId, peerId: 'h9-new', hostToken: created.hostToken });
        assert.equal((await back.next('room-resumed')).hostPeerId, 'h9-new');
        assert.equal((await guest.next('host')).hostPeerId, 'h9-new');
        const late = await connected('l9');
        late.send({ type: 'join', roomId: created.roomId, peerId: 'l9' });
        assert.equal((await late.next('joined')).hostPeerId, 'h9-new');
        for (const c of [host, guest, back, late]) c.close();
    });

    it('ignores a peer id with unexpected characters (uses its own instead)', async () => {
        const c = await connected('x');
        c.send({ type: 'create-room', peerId: '<script>'.repeat(40) });
        const { peerId } = await c.next('room-created');
        assert.match(peerId, /^[0-9a-f-]{36}$/);
        c.close();
    });

    it('serves quick picks with CORS (503 without a YouTube key)', async () => {
        const res = await fetch(`http://localhost:${PORT}/api/quick-picks`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('access-control-allow-origin'), '*');

        // Trusted 3RTC domain
        const resTrusted = await fetch(`http://localhost:${PORT}/api/quick-picks`, {
            headers: { Origin: 'https://3rtc.me' }
        });
        assert.equal(resTrusted.headers.get('access-control-allow-origin'), 'https://3rtc.me');
        assert.equal(resTrusted.headers.get('vary'), 'Origin');

        // Trusted Vercel preview domain
        const resPreview = await fetch(`http://localhost:${PORT}/api/quick-picks`, {
            headers: { Origin: 'https://branch-preview.vercel.app' }
        });
        assert.equal(resPreview.headers.get('access-control-allow-origin'), 'https://branch-preview.vercel.app');

        // Untrusted domain (should NOT be granted CORS)
        const resUntrusted = await fetch(`http://localhost:${PORT}/api/quick-picks`, {
            headers: { Origin: 'https://malicious-attacker.com' }
        });
        assert.equal(resUntrusted.headers.get('access-control-allow-origin'), null);
    });

    it('rate-limits repeated failed room joins to prevent room code brute-force', async () => {
        const c = await connected('scanner');
        let rateLimited = false;
        for (let i = 0; i < 16; i++) {
            c.send({ type: 'join', roomId: '99990', peerId: 'scanner' });
            const msg = await c.next('error');
            if (msg.code === 'rate-limited') {
                rateLimited = true;
                break;
            }
        }
        assert.equal(rateLimited, true, 'client was rate-limited after repeated failed joins');
        c.close();
    });

    it('rejects WebSocket connections from untrusted origins', async () => {
        await assert.rejects(
            () => new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://localhost:${PORT}`, {
                    headers: { Origin: 'https://evil.com' }
                });
                ws.on('open', () => {
                    ws.close();
                    resolve();
                });
                ws.on('error', (err) => reject(err));
                ws.on('unexpected-response', (req, res) => {
                    reject(new Error(`Server responded with ${res.statusCode}`));
                });
            }),
            (err) => {
                assert.match(err.message, /403/);
                return true;
            }
        );

        // Trusted origin connects cleanly
        const trustedWs = new WebSocket(`ws://localhost:${PORT}`, {
            headers: { Origin: 'https://3rtc.me' }
        });
        await new Promise((resolve, reject) => {
            trustedWs.on('open', resolve);
            trustedWs.on('error', reject);
        });
        trustedWs.close();
    });
});

