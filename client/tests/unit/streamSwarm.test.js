import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P2PRangeReceiver, sha256Hex } from '../../src/utils/p2pStreamer.js';

const BLOCK = 64 * 1024;
const PART = 16384;
const OWNER = 'owner';
const fill = (block) => block * 7 + 1;

function packet(streamNo, block, offset, length, value) {
    const buf = new ArrayBuffer(16 + length);
    const view = new DataView(buf);
    view.setUint32(0, 0x524E4731);
    view.setUint32(4, streamNo);
    view.setUint32(8, block);
    view.setUint32(12, offset);
    new Uint8Array(buf, 16).fill(value);
    return buf;
}
const deliver = (r, block, from, value = fill(block)) => {
    for (let off = 0; off < BLOCK; off += PART) r.handleChunk(packet(5, block, off, PART, value), from);
};
const hashOf = (block) => sha256Hex(new Uint8Array(BLOCK).fill(fill(block)));
const tick = () => new Promise((r) => setTimeout(r, 0));

function swarmReceiver({ headerSwarm = true } = {}) {
    const toOwner = [];
    const toPeers = [];
    const r = new P2PRangeReceiver({ streamNo: 5, fileSize: 40 * BLOCK, blockSize: BLOCK, fileName: 'film.mkv', swarm: headerSwarm }, {
        ownerId: OWNER,
        swarm: true,
        sendControl: (m) => toOwner.push(m),
        sendTo: (peerId, m) => { toPeers.push({ peerId, ...m }); return true; }
    });
    return { r, toOwner, toPeers };
}
const asked = (list, type = 'p2p-range-request') => list.filter((m) => m.type === type).flatMap((m) => m.blocks);

test('only a swarm when the owner\'s app does it too', () => {
    assert.equal(swarmReceiver({ headerSwarm: false }).r.swarm, false);
    assert.equal(swarmReceiver().r.swarm, true);
});

test('blocks are asked from viewers that have them, spread out, the owner for the rest', () => {
    const { r, toOwner, toPeers } = swarmReceiver();
    r.setPeerHave('a', [0, 9]);
    r.setPeerHave('b', [0, 4]);
    r.want([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21]);
    const fromA = toPeers.filter((m) => m.peerId === 'a').flatMap((m) => m.blocks);
    const fromB = toPeers.filter((m) => m.peerId === 'b').flatMap((m) => m.blocks);
    assert.ok(fromA.length > 0 && fromB.length > 0, `a: ${fromA} b: ${fromB}`);
    assert.ok(fromB.every((b) => b <= 4), 'b is only asked for what it has');
    assert.ok(toPeers.every((m) => m.swarm === true));
    assert.deepEqual(asked(toOwner).filter((b) => b >= 20), [20, 21], 'nobody else has 20, 21');
    assert.ok(asked(toOwner, 'p2p-hash-request').length === 0, 'hashes are asked in a batch afterwards');
});

test('a block from a viewer is used only once it matches the owner\'s checksum', async () => {
    const { r, toOwner } = swarmReceiver();
    r.setPeerHave('a', [3, 3]);
    const reading = r.read(3 * BLOCK, 10);
    await tick();
    const hashAsk = toOwner.find((m) => m.type === 'p2p-hash-request');
    assert.deepEqual(hashAsk.blocks, [3]);
    deliver(r, 3, 'a');
    assert.equal(r.getCachedBlock(3), null, 'not used before it is checked');
    r.addHashes([[3, await hashOf(3)]]);
    const data = new Uint8Array(await reading);
    assert.equal(data[0], fill(3));
    assert.equal(r.stats.fromPeers, BLOCK);
    assert.deepEqual(r.haveRanges(), [3, 3]);
    r.abort();
});

test('a damaged block is thrown away, that viewer is never asked again, the owner sends it', async () => {
    const { r, toOwner, toPeers } = swarmReceiver();
    const bad = [];
    r.onBadBlock = (peerId, block) => bad.push([peerId, block]);
    r.setPeerHave('evil', [0, 39]);
    const reading = r.read(2 * BLOCK, 10);
    assert.equal(toPeers[0].peerId, 'evil');
    r.addHashes([[2, await hashOf(2)]]);
    deliver(r, 2, 'evil', 0xee);
    for (let i = 0; i < 20 && !asked(toOwner).includes(2); i++) await tick();
    assert.deepEqual(bad, [['evil', 2]]);
    assert.ok(asked(toOwner).includes(2), 'asked from the owner instead');
    deliver(r, 2, OWNER);
    assert.equal(new Uint8Array(await reading)[0], fill(2));
    assert.equal(r.stats.rejected, 1);
    toPeers.length = 0;
    r.want([10, 11]);
    assert.equal(toPeers.length, 0, 'the bad viewer is not asked again');
    r.abort();
});

test('a viewer that no longer has a block says so: asked elsewhere at once', () => {
    const { r, toOwner, toPeers } = swarmReceiver();
    r.setPeerHave('a', [0, 39]);
    r.want([7], true);
    assert.equal(toPeers[0].peerId, 'a');
    r.handleMiss('a', [7]);
    assert.ok(asked(toOwner).includes(7));
    toPeers.length = 0;
    r.want([7], true);
    assert.equal(toPeers.length, 0, 'a no longer counts as having 7');
});

test('a viewer leaving: what we waited for from it is asked from the owner', () => {
    const { r, toOwner } = swarmReceiver();
    r.setPeerHave('a', [0, 39]);
    r.want([1, 2, 3], true);
    r.dropPeer('a');
    assert.deepEqual(asked(toOwner).sort(), [1, 2, 3]);
    assert.equal(r.peerHave.size, 0);
});

test('parts of the same block arriving twice are counted once', () => {
    const { r } = swarmReceiver();
    r.want([4], true);
    r.handleChunk(packet(5, 4, 0, PART, fill(4)), OWNER);
    r.handleChunk(packet(5, 4, 0, PART, fill(4)), OWNER);
    r.handleChunk(packet(5, 4, PART, PART, fill(4)), OWNER);
    r.handleChunk(packet(5, 4, 2 * PART, PART, fill(4)), OWNER);
    assert.equal(r.getCachedBlock(4), null, 'one part still missing');
    r.handleChunk(packet(5, 4, 3 * PART, PART, fill(4)), OWNER);
    assert.equal(r.getCachedBlock(4)[0], fill(4));
});

test('the blocks we hold are announced as ranges', () => {
    const { r } = swarmReceiver();
    for (const b of [0, 1, 2, 5, 9, 10]) deliver(r, b, OWNER);
    assert.deepEqual(r.haveRanges(), [0, 2, 5, 5, 9, 10]);
    const v = r.haveVersion;
    deliver(r, 3, OWNER);
    assert.ok(r.haveVersion > v);
});

test('viewers watching together fetch different parts of the buffer from the owner', () => {
    const asked = (seed) => {
        const toOwner = [];
        const r = new P2PRangeReceiver({ streamNo: 5, fileSize: 400 * BLOCK, blockSize: BLOCK, fileName: 'film.mkv', swarm: true }, {
            ownerId: OWNER, swarm: true, seed, bufferAhead: 200 * BLOCK, cacheLimit: 1000 * BLOCK,
            sendControl: (m) => toOwner.push(m), sendTo: () => true
        });
        r.setPeerHave('friend', [0, 0]); // another viewer, with nothing useful yet
        r._noteReading(10);
        return toOwner.filter((m) => m.type === 'p2p-range-request').flatMap((m) => m.blocks);
    };
    const a = asked(0.1);
    const b = asked(0.6);
    assert.ok(a.length <= 8 && b.length <= 8, 'the owner gets only a few background blocks at a time');
    assert.ok(a.includes(11) && b.includes(11), 'the next blocks: in order, for both');
    const farA = a.filter((x) => x > 18);
    const farB = b.filter((x) => x > 18);
    assert.ok(farA.every((x) => !farB.includes(x)), `different parts further on: ${farA} / ${farB}`);
});

test('blocks other viewers have go to them; the owner is not asked for them', () => {
    const toOwner = [];
    const toPeers = [];
    const r = new P2PRangeReceiver({ streamNo: 5, fileSize: 400 * BLOCK, blockSize: BLOCK, fileName: 'film.mkv', swarm: true }, {
        ownerId: OWNER, swarm: true, seed: 0.5, bufferAhead: 100 * BLOCK, cacheLimit: 1000 * BLOCK,
        sendControl: (m) => toOwner.push(m), sendTo: (peerId, m) => { toPeers.push({ peerId, ...m }); return true; }
    });
    r.setPeerHave('a', [0, 399]);
    r._noteReading(0);
    const own = toOwner.filter((m) => m.type === 'p2p-range-request').flatMap((m) => m.blocks);
    const peer = toPeers.flatMap((m) => m.blocks);
    assert.equal(own.length, 0, `owner asked for ${own}`);
    assert.equal(peer.length, 12, 'as many as one viewer takes at a time');
    r.updatePeerHave('a', [], peer.slice(0, 2));
    assert.equal(r.peerHave.get('a')[peer[0]], 0);
});
