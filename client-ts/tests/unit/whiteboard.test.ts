import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_INITIAL,
  CHUNK_MAX,
  INDEX_INITIAL,
  MAX_CHUNKS,
  chunkReducer,
  cleanStroke,
  hits,
  indexReducer,
  simplify,
  type Stroke
} from '../../src/features/activities/whiteboard/model';

const pen = (id: string, p: number[], extra: Partial<Stroke> = {}): Stroke => ({ id, by: 'Asha', k: 'pen', c: '#e5484d', w: 6, p, ...extra });
const host = { by: 'h', isHost: true, hostId: 'h', present: ['h', 'a'] };
const guest = { by: 'a', isHost: false, hostId: 'h', present: ['h', 'a'] };

describe('whiteboard strokes', () => {
  it('checks strokes from the network', () => {
    assert.ok(cleanStroke(pen('a', [0, 0, 10, 10])));
    assert.equal(cleanStroke(pen('a', [0, 0, 10])), null); // odd number of values
    assert.equal(cleanStroke(pen('a', [0, 0, 10, 10], { c: 'red' })), null);
    assert.equal(cleanStroke(pen('a', [0, 0, 99999, 10])), null);
    assert.equal(cleanStroke({ ...pen('a', [0, 0, 5, 5, 9, 9]), k: 'rect' }), null); // shapes have two points
    assert.equal(cleanStroke({ ...pen('a', [5, 5]), k: 'text', t: '  ' }), null);
    assert.deepEqual(cleanStroke({ ...pen('a', [5.4, 5.6]), k: 'text', t: 'hi' })?.p, [5, 6]);
  });

  it('adds without duplicates, removes by id, and caps a chunk', () => {
    let c = chunkReducer(CHUNK_INITIAL, { kind: 'add', strokes: [pen('a', [0, 0, 5, 5])] });
    assert.equal(c.strokes.length, 1);
    assert.equal(chunkReducer(c, { kind: 'add', strokes: [pen('a', [0, 0, 5, 5])] }), c);
    c = chunkReducer(c, { kind: 'add', strokes: [pen('b', [1, 1, 5, 5]), pen('c', [2, 2, 5, 5])] });
    assert.deepEqual(chunkReducer(c, { kind: 'remove', ids: ['b'] }).strokes.map((s) => s.id), ['a', 'c']);
    let big = CHUNK_INITIAL;
    for (let i = 0; i < 200; i++) big = chunkReducer(big, { kind: 'add', strokes: [pen(`s${i}`, [0, 0, 1, 1])] });
    assert.ok(big.strokes.length >= CHUNK_MAX && big.strokes.length <= 100);
  });

  it('grows once per full chunk; only the host clears', () => {
    const grown = indexReducer(INDEX_INITIAL, { kind: 'grow', from: 0 }, guest);
    assert.equal(grown.chunks, 2);
    assert.equal(indexReducer(grown, { kind: 'grow', from: 0 }, guest), grown); // the other person was a moment late
    assert.equal(indexReducer(grown, { kind: 'clear' }, guest), grown);
    const cleared = indexReducer(grown, { kind: 'clear', name: 'Host' }, host);
    assert.deepEqual([cleared.epoch, cleared.chunks, cleared.clearedBy], [1, 1, 'Host']);
    const hostAway = { ...guest, present: ['a'] };
    assert.equal(indexReducer(grown, { kind: 'clear' }, hostAway).epoch, 1);
    let many = INDEX_INITIAL;
    for (let i = 0; i < 80; i++) many = indexReducer(many, { kind: 'grow', from: many.chunks - 1 }, guest);
    assert.equal(many.chunks, MAX_CHUNKS);
  });

  it('simplifies straight runs and keeps corners', () => {
    const line: number[] = [];
    for (let x = 0; x <= 100; x++) line.push(x, 0);
    assert.deepEqual(simplify(line), [0, 0, 100, 0]);
    const corner = [...line, 100, 50, 100, 100];
    assert.deepEqual(simplify(corner), [0, 0, 100, 0, 100, 100]);
  });

  it('the eraser hits what it touches', () => {
    const s = pen('a', [0, 0, 100, 0]);
    assert.ok(hits(s, 50, 10, 10));
    assert.ok(!hits(s, 50, 40, 10));
    const box: Stroke = { ...s, k: 'rect', p: [0, 0, 100, 100] };
    assert.ok(hits(box, 100, 50, 5));
    assert.ok(!hits(box, 50, 50, 5)); // the inside of an empty box
    const text: Stroke = { ...s, k: 'text', w: 20, p: [10, 10], t: 'hello' };
    assert.ok(hits(text, 20, 20, 2));
  });
});
