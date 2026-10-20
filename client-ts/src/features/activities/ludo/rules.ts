/**
 * Ludo rules as a shared-state reducer (core/sharedState.js): runs on one peer, the authority,
 * which also rolls the dice, so nobody can fake a roll. Pure apart from Math.random / Date.now,
 * which only the authority calls; everyone else receives the result.
 *
 * Token progress (per colour, 4 tokens):
 *   -1        in base
 *   0..50     on the shared 52-square track, counted from the colour's start square
 *   51..55    in the colour's home column
 *   56        home (finished)
 * Absolute track square = (START[colour] + progress) % 52.
 */

export type LudoColor = 'red' | 'green' | 'yellow' | 'blue';

export const COLORS: LudoColor[] = ['red', 'green', 'yellow', 'blue']; // turn order (clockwise)
export const COLOR_NAMES: Record<LudoColor, string> = {
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue'
};

export const START: Record<LudoColor, number> = { red: 0, green: 13, yellow: 26, blue: 39 };
export const TRACK_LENGTH = 52;
export const LAST_TRACK = 50; // last square before the home column
export const HOME = 56;
const STAR_OFFSET = 8; // star (safe) square: 8 after each start square

export interface LudoRules {
  sixToLeave: boolean; // off: a 1 or a 6 brings a token out
  threeSixes: boolean; // three sixes in a row: the turn is lost
  safeStars: boolean; // star squares are safe (start squares always are)
  captureBonus: boolean; // capturing gives another turn
  homeBonus: boolean; // reaching home gives another turn
  awayMode: 'bot' | 'skip'; // a player who left: 'bot' (computer plays for them) or 'skip'
}

export const DEFAULT_RULES: LudoRules = {
  sixToLeave: true,
  threeSixes: true,
  safeStars: true,
  captureBonus: true,
  homeBonus: true,
  awayMode: 'bot'
};

const RULE_KEYS: (keyof LudoRules)[] = ['sixToLeave', 'threeSixes', 'safeStars', 'captureBonus', 'homeBonus'];

export interface LudoSeat {
  id: string;
  name: string;
  bot?: boolean;
  cid?: string;
}

export interface LudoEvent {
  kind: string;
  color?: LudoColor | null;
  token?: number;
  from?: number;
  to?: number;
  value?: number;
  captured?: Array<{ color: LudoColor; token: number }>;
}

export interface LudoState {
  phase: 'lobby' | 'playing' | 'over';
  rules: LudoRules;
  seats: Record<LudoColor, LudoSeat | null>;
  tokens: Record<LudoColor, number[]> | null;
  turn: LudoColor | null;
  dice: number | null;
  rolled: boolean;
  movable: number[];
  sixes: number;
  finished: LudoColor[];
  event: LudoEvent | null;
  seq: number;
  turnSince: number;
}

export const INITIAL: LudoState = {
  phase: 'lobby',
  rules: DEFAULT_RULES,
  seats: { red: null, green: null, yellow: null, blue: null },
  tokens: null,
  turn: null,
  dice: null,
  rolled: false,
  movable: [],
  sixes: 0,
  finished: [],
  event: null,
  seq: 0,
  turnSince: 0
};

export const absSquare = (color: LudoColor, progress: number): number =>
  (START[color] + progress) % TRACK_LENGTH;

export function isSafeSquare(abs: number, rules: LudoRules): boolean {
  for (const color of COLORS) {
    if (abs === START[color]) return true;
    if (rules.safeStars && abs === (START[color] + STAR_OFFSET) % TRACK_LENGTH) return true;
  }
  return false;
}

export const seatedColors = (state: LudoState): LudoColor[] =>
  COLORS.filter((c) => Boolean(state.seats[c]));

/** Where a token would end up with roll `value`, or null if it can't move. */
export function targetOf(progress: number, value: number, rules: LudoRules): number | null {
  if (progress === -1) {
    const canLeave = value === 6 || (!rules.sixToLeave && value === 1);
    return canLeave ? 0 : null;
  }
  if (progress >= HOME) return null;
  const next = progress + value;
  return next <= HOME ? next : null; // exact roll to reach home
}

export function movableTokens(state: LudoState, color: LudoColor, value: number): number[] {
  if (!state.tokens || !state.tokens[color]) return [];
  return state.tokens[color]
    .map((p, i) => (targetOf(p, value, state.rules) === null ? -1 : i))
    .filter((i) => i >= 0);
}

const roll = (): number => 1 + Math.floor(Math.random() * 6);
const allHome = (tokens: number[]): boolean => tokens.every((p) => p === HOME);

function nextColor(state: LudoState, after: LudoColor | null): LudoColor | null {
  const playing = seatedColors(state).filter((c) => !state.finished.includes(c));
  if (playing.length === 0) return null;
  const order = COLORS.filter((c) => playing.includes(c) || c === after);
  const i = after ? order.indexOf(after) : -1;
  for (let k = 1; k <= order.length; k++) {
    const c = order[(i + k) % order.length];
    if (playing.includes(c)) return c;
  }
  return null;
}

const bump = (state: LudoState, patch: Partial<LudoState>): LudoState => ({
  ...state,
  ...patch,
  seq: state.seq + 1
});

function passTurn(state: LudoState, patch: Partial<LudoState> = {}): LudoState {
  const turn = nextColor(state, state.turn);
  return bump(state, { rolled: false, movable: [], sixes: 0, turn, turnSince: Date.now(), ...patch });
}

/** Apply moving token `index` of the current colour by `state.dice`. */
function applyMove(state: LudoState, index: number): LudoState {
  const color = state.turn;
  if (!color || !state.dice || !state.tokens) return state;
  const value = state.dice;
  const from = state.tokens[color][index];
  const to = targetOf(from, value, state.rules);
  if (to === null) return state;

  const tokens = Object.fromEntries(
    Object.entries(state.tokens).map(([c, list]) => [c, [...list]])
  ) as Record<LudoColor, number[]>;
  tokens[color][index] = to;

  // Capture: opponents on the square we land on go back to base (not on safe squares)
  const captured: Array<{ color: LudoColor; token: number }> = [];
  if (to <= LAST_TRACK) {
    const abs = absSquare(color, to);
    if (!isSafeSquare(abs, state.rules)) {
      for (const other of COLORS) {
        if (other === color || !tokens[other]) continue;
        tokens[other].forEach((p, i) => {
          if (p >= 0 && p <= LAST_TRACK && absSquare(other, p) === abs) {
            tokens[other][i] = -1;
            captured.push({ color: other, token: i });
          }
        });
      }
    }
  }

  const reachedHome = to === HOME;
  let finished = state.finished;
  if (allHome(tokens[color]) && !finished.includes(color)) finished = [...finished, color];
  const event: LudoEvent = {
    kind: captured.length ? 'capture' : reachedHome ? 'home' : 'move',
    color,
    token: index,
    from,
    to,
    value,
    captured
  };

  // Everyone but one is done: game over (the last one takes last place)
  const stillPlaying = seatedColors(state).filter((c) => !finished.includes(c));
  if (stillPlaying.length <= 1) {
    return bump(state, {
      tokens,
      finished: [...finished, ...stillPlaying],
      phase: 'over',
      turn: null,
      rolled: false,
      movable: [],
      event
    });
  }

  const bonus =
    !finished.includes(color) &&
    (value === 6 ||
      (captured.length > 0 && state.rules.captureBonus) ||
      (reachedHome && state.rules.homeBonus));
  const next: LudoState = { ...state, tokens, finished, event };
  if (bonus) {
    return bump(next, {
      rolled: false,
      movable: [],
      sixes: value === 6 ? state.sixes : 0,
      turnSince: Date.now()
    });
  }
  return passTurn(next);
}

function doRoll(state: LudoState): LudoState {
  const color = state.turn;
  if (!color || !state.tokens) return state;
  const value = roll();
  const sixes = value === 6 ? state.sixes + 1 : 0;
  if (state.rules.threeSixes && sixes >= 3) {
    return passTurn(state, { dice: value, event: { kind: 'three-sixes', color, value } });
  }
  const withRoll: LudoState = { ...state, dice: value, sixes };
  const movable = movableTokens(withRoll, color, value);
  if (movable.length === 0) {
    return passTurn(withRoll, { event: { kind: 'no-move', color, value } });
  }
  // Only one choice (or all choices end the same): move it straight away
  const targets = new Set(movable.map((i) => `${state.tokens![color][i]}`));
  if (movable.length === 1 || targets.size === 1) {
    return applyMove({ ...withRoll, rolled: true, movable }, movable[0]);
  }
  return bump(withRoll, { rolled: true, movable, event: { kind: 'roll', color, value } });
}

/** The computer's pick: capture > reach home > leave base > safe square > furthest-back token. */
export function botChoice(state: LudoState): number {
  const color = state.turn;
  if (!color || !state.dice || !state.tokens || state.movable.length === 0) return 0;
  const value = state.dice;
  let best = state.movable[0];
  let bestScore = -Infinity;
  for (const i of state.movable) {
    const from = state.tokens[color][i];
    const to = targetOf(from, value, state.rules);
    if (to === null) continue;
    let score = 0;
    if (to === HOME) score += 80;
    if (from === -1) score += 50;
    if (to <= LAST_TRACK) {
      const abs = absSquare(color, to);
      const hits = COLORS.some(
        (c) =>
          c !== color &&
          state.tokens![c]?.some((p) => p >= 0 && p <= LAST_TRACK && absSquare(c, p) === abs)
      );
      if (hits && !isSafeSquare(abs, state.rules)) score += 100;
      if (isSafeSquare(abs, state.rules)) score += 15;
    } else if (to > LAST_TRACK) {
      score += 30; // into the home column: can't be captured any more
    }
    score += (HOME - from) / 10; // keep tokens moving together
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export interface LudoMeta {
  by: string;
  selfId?: string;
  isHost?: boolean;
  hostId?: string | null;
  present?: string[];
  clientOf?: (id: string) => string | null;
}

const canManage = (meta: LudoMeta): boolean =>
  Boolean(meta.isHost || !meta.hostId || !meta.present?.includes(meta.hostId));

const seatOf = (state: LudoState, peerId: string): LudoColor | null =>
  COLORS.find((c) => state.seats[c] && !state.seats[c]?.bot && state.seats[c]?.id === peerId) || null;

const cleanName = (name: unknown, fallback: string): string =>
  String(name || '').trim().slice(0, 24) || fallback;

export type LudoAction =
  | { kind: 'sit'; color: LudoColor; name?: string }
  | { kind: 'stand' }
  | { kind: 'add-bot'; color: LudoColor }
  | { kind: 'clear-seat'; color: LudoColor }
  | { kind: 'rules'; rules?: Partial<LudoRules> }
  | { kind: 'start' }
  | { kind: 'again' }
  | { kind: 'roll' }
  | { kind: 'move'; token: number }
  | { kind: 'auto'; seq: number; mode?: 'skip' | 'bot' };

export function reducer(state: LudoState, action: LudoAction, meta: LudoMeta): LudoState {
  switch (action.kind) {
    // ---- lobby -----------------------------------------------------------------------
    case 'sit': {
      const color = action.color;
      if (!COLORS.includes(color)) return state;
      const current = state.seats[color];
      const cid = meta.clientOf?.(meta.by) || null;
      const away = current && !current.bot && !meta.present?.includes(current.id);
      // Your own seat, after a reload or rejoin (same app, new connection): always yours again
      const comingBack = away && cid && current.cid === cid;
      // A free seat, or (during a game) the seat of someone who left: take it over
      const takeOver = comingBack || (away && state.phase === 'playing');
      if (current && !takeOver) return state;
      if (state.phase === 'playing' && !takeOver) return state;
      const seats = { ...state.seats };
      const mine = seatOf(state, meta.by);
      if (mine && (state.phase === 'lobby' || comingBack)) seats[mine] = null; // switching colour
      else if (mine && state.phase === 'playing') return state; // already playing another colour
      seats[color] = {
        id: meta.by,
        name: comingBack ? current.name : cleanName(action.name, COLOR_NAMES[color]),
        ...(cid ? { cid } : {})
      };
      return bump(state, { seats });
    }
    case 'stand': {
      if (state.phase !== 'lobby') return state;
      const mine = seatOf(state, meta.by);
      if (!mine) return state;
      return bump(state, { seats: { ...state.seats, [mine]: null } });
    }
    case 'add-bot':
    case 'clear-seat': {
      if (state.phase !== 'lobby' || !canManage(meta) || !COLORS.includes(action.color)) return state;
      const seat = state.seats[action.color];
      if (action.kind === 'add-bot' && seat) return state;
      const value =
        action.kind === 'add-bot' ? { id: `bot-${action.color}`, name: 'Computer', bot: true } : null;
      return bump(state, { seats: { ...state.seats, [action.color]: value } });
    }
    case 'rules': {
      if (state.phase !== 'lobby' || !canManage(meta)) return state;
      const rules = { ...state.rules };
      for (const key of RULE_KEYS) {
        if (typeof action.rules?.[key] === 'boolean') {
          (rules as Record<string, unknown>)[key] = action.rules[key];
        }
      }
      if (action.rules?.awayMode === 'bot' || action.rules?.awayMode === 'skip') {
        rules.awayMode = action.rules.awayMode;
      }
      return bump(state, { rules });
    }
    case 'start': {
      if (state.phase !== 'lobby' || !canManage(meta)) return state;
      const colors = seatedColors(state);
      if (colors.length < 2) return state;
      const tokens = Object.fromEntries(colors.map((c) => [c, [-1, -1, -1, -1]])) as Record<
        LudoColor,
        number[]
      >;
      const turn = colors[Math.floor(Math.random() * colors.length)];
      return bump(state, {
        phase: 'playing',
        tokens,
        turn,
        dice: null,
        rolled: false,
        movable: [],
        sixes: 0,
        finished: [],
        event: { kind: 'start', color: turn },
        turnSince: Date.now()
      });
    }
    case 'again': {
      if (state.phase === 'lobby' || !canManage(meta)) return state;
      return bump(state, { ...INITIAL, rules: state.rules, seats: state.seats, seq: state.seq });
    }

    // ---- playing ---------------------------------------------------------------------
    case 'roll': {
      if (state.phase !== 'playing' || state.rolled || !state.turn) return state;
      const seat = state.seats[state.turn];
      if (!seat || seat.bot || seat.id !== meta.by) return state;
      return doRoll(state);
    }
    case 'move': {
      if (state.phase !== 'playing' || !state.rolled || !state.turn) return state;
      const seat = state.seats[state.turn];
      if (!seat || seat.bot || seat.id !== meta.by || !state.movable.includes(action.token)) return state;
      return applyMove(state, action.token);
    }
    // The authority's app plays for computers, people who left (awayMode) and idle players
    case 'auto': {
      if (state.phase !== 'playing' || meta.by !== meta.selfId || action.seq !== state.seq) return state;
      if (action.mode === 'skip') {
        return passTurn(state, { event: { kind: 'skipped', color: state.turn } });
      }
      if (!state.rolled) return doRoll(state);
      return applyMove(state, botChoice(state));
    }
    default:
      return state;
  }
}
