import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P2PRangeReceiver } from '../../src/utils/p2pStreamer.js';

const BLOCK = 256 * 1024;

// A data packet the owner would send: 'RNG1' | streamNo | block | offset | bytes
function packet(streamNo, block, offset, length) {
    const buf = new ArrayBuffer(16 + length);
    const view = new DataView(buf);
    view.setUint32(0, 0x524E4731);
    view.setUint32(4, streamNo);
    view.setUint32(8, block);
    view.setUint32(12, offset);
    new Uint8Array(buf, 16).fill(block & 0xff);
    return buf;
}

function receiverWithBlocks(count, cacheLimit) {
    const sent = [];
    const r = new P2PRangeReceiver({ streamNo: 7, fileSize: count * BLOCK, blockSize: BLOCK, fileName: 'film.mp4' },
        { cacheLimit, sendControl: (m) => sent.push(m) });
    for (let b = 0; b < count; b++) {
        for (let off = 0; off < BLOCK; off += 16384) r.handleChunk(packet(7, b, off, 16384));
    }
    return { r, sent };
}

test('received blocks stay in memory while under the limit', async () => {
    const { r } = receiverWithBlocks(10, 100 * BLOCK);
    await r.read(9 * BLOCK, 1000);
    assert.equal(r.blocks.size, 10);
    assert.equal(r.cachedBytes, 10 * BLOCK);
});

test('over the limit, the blocks furthest from where the player reads are dropped', async () => {
    const { r } = receiverWithBlocks(20, 8 * BLOCK);
    const data = new Uint8Array(await r.read(19 * BLOCK + 10, 100));
    assert.equal(data[0], 19, 'the block being read is served');
    assert.ok(r.cachedBytes <= 8 * BLOCK, `cache ${r.cachedBytes / BLOCK} blocks`);
    assert.ok(r.blocks.has(19) && r.blocks.has(18), 'the block read and the one just behind it are kept');
    assert.ok(!r.blocks.has(0) && !r.blocks.has(1), 'the oldest ones are gone');
});

test('a dropped block is fetched again when the player goes back to it', async () => {
    const { r, sent } = receiverWithBlocks(20, 8 * BLOCK);
    await r.read(19 * BLOCK, 100);
    assert.ok(!r.blocks.has(0));
    const again = r.read(0, 100);
    const ask = sent.find((m) => m.type === 'p2p-range-request' && m.blocks.includes(0));
    assert.ok(ask, 'block 0 asked for again');
    for (let off = 0; off < BLOCK; off += 16384) r.handleChunk(packet(7, 0, off, 16384));
    assert.equal(new Uint8Array(await again)[0], 0);
    r.abort();
});

// The player reading through the service worker: one 'read' at a time over a MessagePort-like pair
function fakePort() {
    const port = { sent: [], onmessage: null, postMessage(m) { this.sent.push(m); }, close() { } };
    return port;
}

test('the background buffer fetches ahead of the player, but only up to its budget', async () => {
    const sent = [];
    const total = 400; // 100 MB file
    const r = new P2PRangeReceiver({ streamNo: 3, fileSize: total * BLOCK, blockSize: BLOCK, fileName: 'film.mp4' },
        { sendControl: (m) => sent.push(m), bufferAhead: 20 * BLOCK, cacheLimit: 200 * BLOCK });
    const port = fakePort();
    r.serve(port, 0, null);
    // The player reads 1 MB (4 blocks); the owner answers every request at once
    const answer = () => {
        for (const m of sent.splice(0)) {
            if (m.type !== 'p2p-range-request') continue;
            for (const b of m.blocks) for (let off = 0; off < BLOCK; off += 16384) r.handleChunk(packet(3, b, off, 16384));
        }
    };
    for (let i = 0; i < 4; i++) {
        const done = port.onmessage({ data: { type: 'read', want: BLOCK } });
        answer();
        await done;
    }
    for (let i = 0; i < 10; i++) answer(); // background top-ups as blocks arrive
    const have = [...r.blocks.entries()].filter(([, e]) => e.done).map(([b]) => b);
    const furthest = Math.max(...have);
    assert.ok(furthest >= 20, `buffered up to block ${furthest}`);
    assert.ok(furthest <= 4 + 20 + 8, `never more than the budget ahead (block ${furthest})`);
    r.abort();
});
