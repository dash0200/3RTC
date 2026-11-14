/** Whiteboard (`whiteboard/model.ts`): the index (grow, clear, background) and a chunk of strokes
 * (adding, with every kind of bad stroke the network could bring, and erasing). */
import {
  CHUNK_INITIAL,
  INDEX_INITIAL,
  chunkReducer,
  indexReducer,
  type BoardIndex,
  type Chunk,
  type ChunkAction,
  type IndexAction
} from '../../../src/features/activities/whiteboard/model.ts';
import type { People, Player } from '../vectors.ts';

const pick = <T,>(xs: T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)];
const TOOLS = ['pen', 'hl', 'line', 'rect', 'ell', 'arrow', 'text'];

function indexCandidates(s: BoardIndex, people: People, rnd: () => number): Array<{ by: string; action: IndexAction }> {
  const anyone = () => pick(people.ids, rnd);
  return [
    { by: anyone(), action: { kind: 'grow', from: pick([s.chunks - 1, s.chunks - 1, s.chunks, 0, '0' as never], rnd) } },
    { by: anyone(), action: { kind: 'grow', from: s.chunks - 1 } },
    { by: anyone(), action: { kind: 'clear', name: pick(['Riya', '', 'n'.repeat(50), 7 as never, null as never], rnd) } },
    { by: anyone(), action: { kind: 'bg', bg: pick(['light', 'dark', 'blue' as never], rnd) } },
    { by: anyone(), action: { kind: pick(['nope', 'grow'], rnd) } as never }
  ];
}

let n = 0;
function stroke(rnd: () => number): unknown {
  const k = pick([...TOOLS, 'blob'], rnd);
  const len = k === 'pen' || k === 'hl' ? pick([2, 4, 10, 40, 3, 0], rnd) : k === 'text' ? pick([2, 2, 4], rnd) : pick([4, 4, 4, 6, 2], rnd);
  const p: unknown[] = Array.from({ length: len }, () => Math.round((rnd() * 2200 - 300) * 10) / 10);
  if (rnd() < 0.05) p[0] = pick(['12', null, 'x', true, [5]] as unknown[], rnd);
  const s: Record<string, unknown> = {
    id: rnd() < 0.03 ? pick(['', 'i'.repeat(41), 5], rnd) : `s${n++ % 40}`,
    by: pick(['Riya', 'Ana', '', 'b'.repeat(50), null, 3], rnd),
    k,
    c: pick(['#1F2937', '#e5484d', '#abc', 'red', '#12345G', '#ffffff'], rnd),
    w: pick([1, 3, 6.6, 0.5, 120, 121, '8', true, null], rnd),
    p: rnd() < 0.03 ? 'nope' : p
  };
  if (k === 'text') s.t = pick(['Hello', '  ', 'Line 1\nLine 2', 'x'.repeat(600), 5], rnd);
  if (rnd() < 0.02) return pick([null, 'x', [1, 2], 5], rnd);
  return s;
}

function chunkCandidates(s: Chunk, people: People, rnd: () => number): Array<{ by: string; action: ChunkAction }> {
  const anyone = () => pick(people.ids, rnd);
  const out: Array<{ by: string; action: ChunkAction }> = [];
  for (let i = 0; i < 4; i++) out.push({ by: anyone(), action: { kind: 'add', strokes: Array.from({ length: pick([1, 1, 2, 5], rnd) }, () => stroke(rnd)) as never } });
  if (s.strokes.length) out.push({ by: anyone(), action: { kind: 'remove', ids: [pick(s.strokes, rnd).id, ...(rnd() < 0.3 ? ['zz', 5 as never] : [])] } });
  if (rnd() < 0.05) out.push({ by: anyone(), action: { kind: 'remove', ids: 'all' as never } });
  if (rnd() < 0.05) out.push({ by: anyone(), action: { kind: 'add', strokes: 'x' as never } });
  if (rnd() < 0.08 && s.strokes.length > 10) out.push({ by: anyone(), action: { kind: 'remove', ids: s.strokes.slice(0, 8).map((x) => x.id) } });
  return out;
}

const ROOMS: People[] = [
  { ids: ['p-host', 'p-ana', 'p-ben'], host: 'p-host', clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ben': 'c-ben' } },
  { ids: ['p-host', 'p-ana', 'p-ben'], host: null, absent: ['p-host'], clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ben': 'c-ben' } }
];

export const whiteboardIndex: Player<BoardIndex, IndexAction> = {
  game: 'whiteboard',
  key: 'act:whiteboard',
  initial: INDEX_INITIAL,
  reducer: (s, a, m) => indexReducer(s, a, m as never),
  candidates: indexCandidates,
  random: { games: 3, steps: 120 },
  rooms: ROOMS
};

export const whiteboardChunk: Player<Chunk, ChunkAction> = {
  game: 'whiteboard-chunk',
  key: 'act:whiteboard:0:0',
  initial: CHUNK_INITIAL,
  reducer: (s, a) => chunkReducer(s, a),
  candidates: chunkCandidates,
  random: { games: 4, steps: 220 },
  rooms: ROOMS
};
