/**
 * Golden vectors for the desktop app's game rules (desktop/docs/BUILD_SPEC.md 6.11): plays
 * scripted and random games through the web app's own reducers and writes every step, so the
 * Rust port (desktop/crates/games) can be checked against them exactly.
 *
 *   npx tsx tests/vectors/vectors.ts            # every game
 *   npx tsx tests/vectors/vectors.ts chess      # one
 *
 * Output: desktop/crates/games/vectors/<game>.json
 *   { game, key, cases: [{ name, initial, steps: [{ action, meta, next }] }] }
 * `next` is the state after the action, or null when the reducer rejected it (returned the
 * same state). `meta` is what the reducer was given, plus `now` (what Date.now() returned) and
 * `randoms` (what Math.random() returned, in order). States and actions are plain JSON.
 *
 * Each game supplies a `Player` (players/<game>.ts): the actions a person (or a confused one)
 * could send in a state, the people in the room, and scripted openings.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VectorMeta {
  by: string;
  isHost: boolean;
  selfId: string;
  hostId: string | null;
  present: string[];
  clients: Record<string, string>;
  playbackLock: boolean;
  now: number;
  randoms: number[];
}

export interface Step {
  action: unknown;
  meta: VectorMeta;
  next: unknown;
  /** games with secrets: what each person in the room may see of `next` (on some steps) */
  views?: Record<string, unknown>;
}

export interface Case {
  name: string;
  initial: unknown;
  steps: Step[];
  /** starts from a state other than the game's initial one (a script's `initial`) */
  custom?: boolean;
}

/** The people in a vector room: peer ids, the host (or null), lasting app ids. */
export interface People {
  ids: string[];
  host: string | null;
  clients: Record<string, string>;
  /** ids that act but aren't connected (gone: their seat shows "away") */
  absent?: string[];
  /** this room's random games: how many and their longest run (default: the player's) */
  random?: { games: number; steps: number };
  /** for the player's own use (e.g. a room of computers only) */
  flavor?: string;
}

export interface Player<S = unknown, A = unknown> {
  game: string;
  key: string;
  initial: S;
  reducer: (state: S, action: A, meta: Record<string, unknown>) => S;
  /** Candidate actions in `state`, each with who sends it (a few bad ones mixed in). */
  candidates: (state: S, people: People, rnd: () => number) => Array<{ by: string; action: A }>;
  /** Scripted games: named lists of [by, action], optionally from another starting state. */
  scripts?: (people: People) => Array<{ name: string; steps: Array<[string, A]>; initial?: S }>;
  /** Games with secrets: the copy of a state a peer may see (recorded on every few steps). */
  redact?: (state: S, peer: string) => S;
  /** How many random games, and their longest run. */
  random?: { games: number; steps: number };
  /** Rooms to play in (default: one host and two guests). */
  rooms?: People[];
}

/** A seeded generator (mulberry32), so a run writes the same file every time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_ROOM: People = {
  ids: ['p-host', 'p-ana', 'p-ben'],
  host: 'p-host',
  clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ben': 'c-ben' }
};

/**
 * Runs one action through the reducer as the authority would, recording the clock and the
 * random numbers it used. The authority is the host if there is one, else the smallest id.
 */
let viewTick = 0;

export function step<S, A>(player: Player<S, A>, people: People, state: S, by: string, action: A, clock: { now: number }, rnd: () => number): { step: Step; state: S } {
  const here = people.ids.filter((id) => !people.absent?.includes(id));
  const selfId = people.host ?? [...here].sort()[0];
  const randoms: number[] = [];
  const realRandom = Math.random;
  const realNow = Date.now;
  clock.now += 1 + Math.floor(rnd() * 5000);
  const now = clock.now;
  Math.random = () => {
    const r = rnd();
    randoms.push(r);
    return r;
  };
  Date.now = () => now;
  const meta = {
    by,
    isHost: by === people.host,
    selfId,
    hostId: people.host,
    present: [selfId, ...here.filter((id) => id !== selfId)],
    clientOf: (id: string) => people.clients[id] ?? null,
    settings: { playbackLock: false }
  };
  // the web app's store sends states as JSON; a reducer rejects by returning its input itself
  const before = JSON.stringify(state);
  const input = JSON.parse(before) as S;
  let next: S | undefined;
  try {
    next = player.reducer(input, JSON.parse(JSON.stringify(action ?? null)) as A, meta);
  } catch {
    next = input; // a throwing reducer rejects (sharedState.ts)
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
  const accepted = next !== undefined && next !== input;
  const out: Step = {
    action,
    meta: {
      by,
      isHost: meta.isHost,
      selfId,
      hostId: people.host,
      present: meta.present,
      clients: people.clients,
      playbackLock: false,
      now,
      randoms
    },
    next: accepted ? JSON.parse(JSON.stringify(next ?? null)) : null
  };
  if (accepted && player.redact && viewTick++ % 4 === 0) {
    const views: Record<string, unknown> = {};
    for (const id of people.ids) views[id] = JSON.parse(JSON.stringify(player.redact(JSON.parse(JSON.stringify(next)) as S, id)));
    out.views = views;
  }
  return { step: out, state: accepted ? (JSON.parse(JSON.stringify(next)) as S) : state };
}

export function play<S, A>(player: Player<S, A>, seed = 1): Case[] {
  const rnd = seeded(seed);
  viewTick = 0;
  const cases: Case[] = [];
  const rooms = player.rooms ?? [DEFAULT_ROOM];
  for (const people of rooms) {
    for (const script of player.scripts?.(people) ?? []) {
      const clock = { now: 1_700_000_000_000 };
      let state = JSON.parse(JSON.stringify(script.initial ?? player.initial)) as S;
      const c: Case = { name: script.name, initial: state, steps: [], ...(script.initial ? { custom: true } : {}) };
      for (const [by, action] of script.steps) {
        const r = step(player, people, state, by, action, clock, rnd);
        c.steps.push(r.step);
        state = r.state;
      }
      cases.push(c);
    }
    const { games, steps } = people.random ?? player.random ?? { games: 20, steps: 200 };
    for (let g = 0; g < games; g++) {
      const clock = { now: 1_700_000_000_000 + g * 1000 };
      let state = JSON.parse(JSON.stringify(player.initial)) as S;
      const c: Case = { name: `random ${people.ids.length} people #${g + 1}`, initial: state, steps: [] };
      for (let n = 0; n < steps; n++) {
        const options = player.candidates(state, people, rnd);
        if (!options.length) break;
        const pick = options[Math.floor(rnd() * options.length)];
        const r = step(player, people, state, pick.by, pick.action, clock, rnd);
        c.steps.push(r.step);
        state = r.state;
      }
      cases.push(c);
    }
  }
  return cases;
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../../desktop/crates/games/vectors');

export function write<S, A>(player: Player<S, A>): void {
  const cases = play(player);
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${player.game}.json`);
  writeFileSync(file, JSON.stringify({ game: player.game, key: player.key, cases }) + '\n');
  const steps = cases.reduce((n, c) => n + c.steps.length, 0);
  const rejected = cases.reduce((n, c) => n + c.steps.filter((s) => s.next === null).length, 0);
  console.log(`${player.game}: ${cases.length} games, ${steps} steps (${rejected} rejected) -> ${file}`);
}
