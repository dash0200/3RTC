/**
 * Sketch: one person draws a word, everyone else guesses it (pure, for tests).
 *
 * Shared state `act:sketch` (this reducer, run by the authority). The board is a whiteboard of its
 * own per turn (`act:sketch:t<turn>`): only the drawer draws on it.
 *
 *   lobby    people join; anyone starts with 2 or more
 *   picking  the drawer picks one of 3 words (PICK_MS; the first one if time runs out)
 *   drawing  DRAW_MS to guess; a letter of the hint shows at half time and at three quarters;
 *            ends early once everyone has it
 *   reveal   the word and the points, REVEAL_MS, then the next drawer
 *   over     after everyone has drawn ROUNDS times: the scores; "Play again" goes back to the lobby
 *
 * Secrets: `redact` sends the word (and the 3 choices) only to the drawer until it's revealed. Only
 * the authority holds it; if the authority changes mid-turn, the new one may not know the word: it
 * ends that turn without points (`tick` with no word) and play goes on.
 *
 * Time: the authority's app sends `tick` about twice a second (accepted only from the authority);
 * deadlines are on its clock.
 */
import { WORDS } from './words';

export const PICK_MS = 15_000;
export const DRAW_MS = 80_000;
export const REVEAL_MS = 5_000;
export const ROUNDS = 2;
export const MAX_PLAYERS = 10;
const FEED_MAX = 40;
const GUESS_MAX = 40;

export type Phase = 'lobby' | 'picking' | 'drawing' | 'reveal' | 'over';

export interface Player {
  id: string;
  name: string;
  score: number;
}

export interface FeedLine {
  /** who (peer id), '' for the game itself */
  by: string;
  name: string;
  text: string;
  kind: 'guess' | 'correct' | 'close' | 'info';
}

export interface SketchState {
  phase: Phase;
  players: Player[];
  /** turns played so far (also the board's key) */
  turn: number;
  drawer: string | null;
  /** the 3 words to pick from (drawer only) */
  choices: string[];
  /** the word (drawer only, until the reveal) */
  word: string;
  /** what guessers see: "_ _ a _" */
  hint: string;
  /** word length for everyone (letters only), so guessers know the size */
  length: number;
  deadline: number;
  turnStarted: number;
  /** who guessed it this turn, in order */
  guessed: string[];
  /** points this turn, shown at the reveal */
  gained: Record<string, number>;
  /** the last word, once revealed */
  revealed: string;
  /** words played this game (added at each reveal, so never a secret) */
  used: string[];
  feed: FeedLine[];
}

export const INITIAL: SketchState = {
  phase: 'lobby',
  players: [],
  turn: 0,
  drawer: null,
  choices: [],
  word: '',
  hint: '',
  length: 0,
  deadline: 0,
  turnStarted: 0,
  guessed: [],
  gained: {},
  revealed: '',
  used: [],
  feed: []
};

export type SketchAction =
  | { kind: 'join'; name?: string }
  | { kind: 'leave' }
  | { kind: 'start' }
  | { kind: 'pick'; index: number }
  | { kind: 'guess'; text: string }
  | { kind: 'skip' }
  | { kind: 'again' }
  | { kind: 'tick' };

export interface SketchMeta {
  by: string;
  isHost?: boolean;
  selfId?: string;
  hostId?: string | null;
  present?: string[];
}

// ---- words and guesses ----------------------------------------------------------------------

/** How a guess is compared: lower case, letters and digits only, spaces squeezed. */
export function normalize(text: string): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Edit distance, stopping early once it's over `max`. */
export function distance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/** The hint: letters as "_", spaces kept, and the letters at `shown` positions. */
export function hintFor(word: string, shown: number[] = []): string {
  return [...word].map((ch, i) => (ch === ' ' ? ' ' : shown.includes(i) ? ch : '_')).join('');
}

/** Letter positions shown at this point of the turn: one at half time, two at three quarters. */
export function shownLetters(word: string, elapsedShare: number, seed: number): number[] {
  const letters = [...word].map((ch, i) => (ch === ' ' ? -1 : i)).filter((i) => i >= 0);
  const count = Math.min(letters.length - 1, elapsedShare >= 0.75 ? 2 : elapsedShare >= 0.5 ? 1 : 0);
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const pick = letters[(seed * 7 + k * 13) % letters.length];
    if (!out.includes(pick)) out.push(pick);
  }
  return out;
}

/** Three different words, not used in this game yet if possible. */
export function pickChoices(rand: () => number, avoid: string[] = []): string[] {
  const pool = WORDS.filter((w) => !avoid.includes(w));
  const from = pool.length >= 3 ? pool : WORDS;
  const out: string[] = [];
  while (out.length < 3) {
    const w = from[Math.floor(rand() * from.length) % from.length];
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** Points for guessing: more the sooner it is, 50 to 100. */
export function guessPoints(remainingShare: number): number {
  return 50 + Math.round(50 * Math.max(0, Math.min(1, remainingShare)));
}
export const DRAWER_POINTS = 25;

// ---- the reducer ----------------------------------------------------------------------------

const cleanName = (name: unknown) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Someone';
const addFeed = (s: SketchState, line: FeedLine): FeedLine[] => [...s.feed, line].slice(-FEED_MAX);
const fromAuthority = (meta: SketchMeta) => Boolean(meta.selfId) && meta.by === meta.selfId;

/** Players still here (connected and in the game). */
function here(s: SketchState, meta: SketchMeta): Player[] {
  return meta.present ? s.players.filter((p) => meta.present!.includes(p.id)) : s.players;
}

/** Turns in a game: everyone draws ROUNDS times. */
export function totalTurns(s: SketchState): number {
  return s.players.length * ROUNDS;
}

/** The next drawer after `drawer`, skipping people who left. */
function nextDrawer(s: SketchState, meta: SketchMeta): string | null {
  const ids = here(s, meta).map((p) => p.id);
  if (ids.length === 0) return null;
  const order = s.players.map((p) => p.id);
  const at = s.drawer ? order.indexOf(s.drawer) : -1;
  for (let step = 1; step <= order.length; step++) {
    const id = order[(at + step + order.length) % order.length];
    if (ids.includes(id)) return id;
  }
  return null;
}

function startTurn(s: SketchState, meta: SketchMeta, now: number, rand: () => number): SketchState {
  if (s.turn >= totalTurns(s) || here(s, meta).length < 2) {
    return { ...s, phase: 'over', drawer: null, choices: [], word: '', hint: '', length: 0, deadline: 0 };
  }
  const drawer = nextDrawer(s, meta);
  if (!drawer) return { ...s, phase: 'over' };
  return {
    ...s,
    phase: 'picking',
    drawer,
    choices: pickChoices(rand, s.used),
    word: '',
    hint: '',
    length: 0,
    guessed: [],
    gained: {},
    deadline: now + PICK_MS,
    turnStarted: now
  };
}

function beginDrawing(s: SketchState, word: string, now: number): SketchState {
  return {
    ...s,
    phase: 'drawing',
    word,
    choices: [],
    hint: hintFor(word),
    length: word.replace(/ /g, '').length,
    deadline: now + DRAW_MS,
    turnStarted: now,
    feed: addFeed(s, { by: '', name: '', text: `${s.players.find((p) => p.id === s.drawer)?.name || 'Someone'} is drawing`, kind: 'info' })
  };
}

function endTurn(s: SketchState, reason: string, now: number): SketchState {
  const word = s.word;
  return {
    ...s,
    phase: 'reveal',
    revealed: word,
    word: '',
    choices: [],
    hint: word ? hintFor(word, [...word].map((_, i) => i)) : '',
    turn: s.turn + 1,
    used: word ? [...s.used, word].slice(-200) : s.used,
    deadline: now + REVEAL_MS,
    turnStarted: 0,
    feed: addFeed(s, { by: '', name: '', text: word ? `${reason} The word was “${word}”.` : reason, kind: 'info' })
  };
}

export interface ReducerDeps {
  now: () => number;
  rand: () => number;
}

const realDeps: ReducerDeps = { now: () => Date.now(), rand: () => Math.random() };

export function makeReducer(deps: ReducerDeps = realDeps) {
  return function reducer(s: SketchState, a: SketchAction, meta: SketchMeta): SketchState {
    const now = deps.now();
    const me = s.players.find((p) => p.id === meta.by);
    switch (a?.kind) {
      case 'join': {
        if (me || s.players.length >= MAX_PLAYERS) return s;
        // late joiners play from the next turn on
        return { ...s, players: [...s.players, { id: meta.by, name: cleanName(a.name), score: 0 }] };
      }
      case 'leave': {
        if (!me) return s;
        const players = s.players.filter((p) => p.id !== meta.by);
        const next = { ...s, players };
        if (s.drawer === meta.by && (s.phase === 'picking' || s.phase === 'drawing')) {
          return endTurn({ ...next, drawer: null }, `${me.name} left.`, now);
        }
        return next;
      }
      case 'start': {
        if (s.phase !== 'lobby' || !me || here(s, meta).length < 2) return s;
        const fresh: SketchState = { ...s, turn: 0, drawer: null, players: s.players.map((p) => ({ ...p, score: 0 })), feed: [], revealed: '', used: [] };
        return startTurn(fresh, meta, now, deps.rand);
      }
      case 'pick': {
        if (s.phase !== 'picking' || meta.by !== s.drawer) return s;
        const word = s.choices[a.index];
        if (typeof word !== 'string') return s;
        return beginDrawing(s, word, now);
      }
      case 'skip': {
        // the drawer gives up the turn
        if ((s.phase !== 'picking' && s.phase !== 'drawing') || meta.by !== s.drawer) return s;
        return endTurn(s, `${me?.name || 'The drawer'} skipped.`, now);
      }
      case 'guess': {
        if (s.phase !== 'drawing' || !me || meta.by === s.drawer || s.guessed.includes(meta.by)) return s;
        const text = String(a.text ?? '').slice(0, GUESS_MAX).trim();
        if (!text) return s;
        if (!s.word) return s; // the authority doesn't know the word (it changed): tick ends the turn
        const guess = normalize(text);
        const target = normalize(s.word);
        if (guess === target) {
          const points = guessPoints((s.deadline - now) / DRAW_MS);
          const players = s.players.map((p) =>
            p.id === meta.by ? { ...p, score: p.score + points } : p.id === s.drawer ? { ...p, score: p.score + DRAWER_POINTS } : p
          );
          const gained = {
            ...s.gained,
            [meta.by]: (s.gained[meta.by] || 0) + points,
            ...(s.drawer ? { [s.drawer]: (s.gained[s.drawer] || 0) + DRAWER_POINTS } : {})
          };
          const next: SketchState = {
            ...s,
            players,
            gained,
            guessed: [...s.guessed, meta.by],
            feed: addFeed(s, { by: meta.by, name: me.name, text: `${me.name} guessed it!`, kind: 'correct' })
          };
          const guessers = here(next, meta).filter((p) => p.id !== s.drawer);
          return guessers.every((p) => next.guessed.includes(p.id)) ? endTurn(next, 'Everyone got it!', now) : next;
        }
        const close = target.length >= 4 && distance(guess, target, 1) <= 1;
        return {
          ...s,
          feed: addFeed(s, close
            ? { by: meta.by, name: me.name, text: `${me.name} is close!`, kind: 'close' }
            : { by: meta.by, name: me.name, text, kind: 'guess' })
        };
      }
      case 'again': {
        if (s.phase !== 'over' || !me) return s;
        return { ...INITIAL, players: s.players.map((p) => ({ ...p, score: 0 })) };
      }
      case 'tick': {
        if (!fromAuthority(meta)) return s;
        if (s.phase === 'picking') {
          if (!s.drawer || !(meta.present ?? [s.drawer]).includes(s.drawer)) return endTurn(s, 'The drawer left.', now);
          if (!s.choices.length) return endTurn(s, 'That turn was lost.', now);
          if (now >= s.deadline) return beginDrawing(s, s.choices[0], now);
          return s;
        }
        if (s.phase === 'drawing') {
          if (!s.word) return endTurn(s, 'That turn was lost (someone else is keeping score now).', now);
          if (!s.drawer || !(meta.present ?? [s.drawer]).includes(s.drawer)) return endTurn(s, 'The drawer left.', now);
          if (now >= s.deadline) return endTurn(s, 'Time’s up!', now);
          const share = 1 - (s.deadline - now) / DRAW_MS;
          const hint = hintFor(s.word, shownLetters(s.word, share, s.turn + s.word.length));
          return hint === s.hint ? s : { ...s, hint };
        }
        if (s.phase === 'reveal') return now >= s.deadline ? startTurn(s, meta, now, deps.rand) : s;
        return s;
      }
      default:
        return s;
    }
  };
}

export const reducer = makeReducer();

/** What a peer is sent: the word and the choices only to the drawer, until the reveal. */
export function redact(s: SketchState, peerId: string): SketchState {
  if (peerId === s.drawer) return s;
  if (!s.word && !s.choices.length) return s;
  return { ...s, word: '', choices: [] };
}
