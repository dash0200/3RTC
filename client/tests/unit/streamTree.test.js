import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addViewer, detachViewer, markDirect } from '../../src/webrtc/streamTree.js';
import { RELAY_FANOUT } from '../../src/utils/p2pStreamer.js';

const parents = (tree) => Object.fromEntries([...tree].map(([id, n]) => [id, n.parent]));

describe('relay tree', () => {
    it(`the owner feeds ${RELAY_FANOUT} viewers, later ones go through a computer`, () => {
        const tree = new Map();
        for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) addViewer(tree, v, true);
        const p = parents(tree);
        assert.equal(Object.values(p).filter((x) => x === null).length, RELAY_FANOUT);
        for (const id of Object.keys(p)) {
            assert.ok(Object.values(p).filter((x) => x === id).length <= RELAY_FANOUT);
        }
    });

    it('phones never relay', () => {
        const tree = new Map();
        for (const [id, canRelay] of [['v1', true], ['phone', false], ['v3', true], ['v4', true]]) addViewer(tree, id, canRelay);
        assert.ok(!Object.values(parents(tree)).includes('phone'));
    });

    it("a viewer leaving sends its children to the owner", () => {
        const tree = new Map();
        for (const v of ['v1', 'v2', 'v3']) addViewer(tree, v, true);
        const parentOfV3 = tree.get('v3').parent;
        assert.notEqual(parentOfV3, null);
        detachViewer(tree, parentOfV3);
        assert.equal(tree.get('v3').parent, null);
    });

    it('unreachable viewers are not picked, and markDirect points at the owner', () => {
        const tree = new Map();
        addViewer(tree, 'v1', true);
        addViewer(tree, 'v2', true);
        assert.equal(addViewer(tree, 'v3', true, () => false), null);
        addViewer(tree, 'v4', true);
        markDirect(tree, 'v4');
        assert.equal(tree.get('v4').parent, null);
    });

    it('only phones: everyone is fed by the owner', () => {
        const tree = new Map();
        for (const v of ['p1', 'p2', 'p3']) addViewer(tree, v, false);
        assert.deepEqual(Object.values(parents(tree)), [null, null, null]);
    });
});
