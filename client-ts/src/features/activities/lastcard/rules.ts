/**
 * Last Card: the classic shedding card game (match the colour or the symbol, action cards, wilds),
 * for 2–10 players and the computer. This is the shared-state reducer; it runs on the authority.
 *
 * Secret cards: hands and the draw pile are only in the authority's copy. `redact` (passed to the
 * shared store) gives every other peer its own hand and nobody else's. If the authority changes
 * mid-game, the new one has only its own redacted copy: it sets `restoring`, each player sends
 * back the hand they hold ('restore'), and the rest (computer players, people away, the draw
 * pile) is dealt again from the cards nobody holds.
 */

export type CardColor = 'r' | 'y' | 'g' | 'b';
export type CardValue = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'S' | 'R' | 'D' | 'W' | 'F';
export interface Card {
  id: number;
  color: CardColor | 'w';
  value: CardValue;
}

export const COLORS: CardColor[] = ['r', 'y', 'g', 'b'];
export const COLOR_NAMES: Record<CardColor, string> = { r: 'Red', y: 'Yellow', g: 'Green', b: 'Blue' };
export const DECK_SIZE = 108;
export const HAND_SIZE = 7;
export const MAX_PLAYERS = 10;

/** 0–99: four colours × (one 0, two each of 1–9, Skip, Reverse, Draw Two); 100–103 Wild; 104–107 Wild Draw Four */
export function card(id: number): Card {
  if (id >= 104) return { id, color: 'w', value: 'F' };
  if (id >= 100) return { id, color: 'w', value: 'W' };
  const color = COLORS[Math.floor(id / 25)];
  const k = id % 25;
  if (k === 0) return { id, color, value: '0' };
  if (k <= 18) return { id, color, value: String(Math.ceil(k / 2)) as CardValue };
  return { id, color, value: (['S', 'R', 'D'] as const)[Math.floor((k - 19) / 2)] };
}

export const isWild = (id: number): boolean => id >= 100;
export const VALUE_NAMES: Partial<Record<CardValue, string>> = { S: 'Skip', R: 'Reverse', D: 'Draw Two', W: 'Wild', F: 'Wild Draw Four' };
export const cardName = (id: number): string => {
  const c = card(id);
  if (c.color === 'w') return VALUE_NAMES[c.value]!;
  return `${COLOR_NAMES[c.color]} ${VALUE_NAMES[c.value] ?? c.value}`;
};

export interface Player {
  id: string;
  name: string;
  cid?: string;
  bot?: boolean;
  wins: number;
}

export interface Rules {
  /** +2 on +2, +4 on anything owed: the next player takes the whole stack */
  stacking: boolean;
  /** draw until you get a card you can play */
  drawToMatch: boolean;
}

export interface LcEvent {
  kind: 'start' | 'play' | 'draw' | 'skip' | 'reverse' | 'take' | 'caught' | 'called' | 'win' | 'pass' | 'reshuffle' | 'restored';
  seat: number;
  card?: number;
  count?: number;
  target?: number;
  color?: CardColor;
}

export interface LcState {
  phase: 'lobby' | 'playing' | 'over';
  players: Player[];
  rules: Rules;
  /** per seat; null where this copy doesn't know (someone else's cards) */
  hands: (number[] | null)[];
  counts: number[];
  /** null where this copy doesn't know it (everyone but the authority) */
  drawPile: number[] | null;
  drawCount: number;
  discard: number[];
  color: CardColor;
  turn: number;
  dir: 1 | -1;
  /** cards the player whose turn it is must take (stacked +2/+4) */
  pendingDraw: number;
  /** the player drew this turn and may play that card or pass */
  drewThisTurn: boolean;
  /** pressed "Last card" before playing their second-to-last card */
  called: boolean[];
  /** seat that went down to one card without calling: anyone can catch them until the next move */
  exposed: number | null;
  winner: number | null;
  event: LcEvent | null;
  seq: number;
  turnSince: number;
  /** after the authority changed: waiting for players to send their hands back */
  restoring: boolean;
}

export const DEFAULT_RULES: Rules = { stacking: false, drawToMatch: false };

export const INITIAL: LcState = {
  phase: 'lobby',
  players: [],
  rules: DEFAULT_RULES,
  hands: [],
  counts: [],
  drawPile: [],
  drawCount: 0,
  discard: [],
  color: 'r',
  turn: 0,
  dir: 1,
  pendingDraw: 0,
  drewThisTurn: false,
  called: [],
  exposed: null,
  winner: null,
  event: null,
  seq: 0,
  turnSince: 0,
  restoring: false
};

export interface LcMeta {
  by: string;
  selfId?: string;
  isHost?: boolean;
  hostId?: string | null;
  present?: string[];
  clientOf?: (id: string) => string | null;
}

export type LcAction =
  | { kind: 'join'; name?: string }
  | { kind: 'leave' }
  | { kind: 'add-bot' }
  | { kind: 'remove'; seat: number }
  | { kind: 'rules'; rules?: Partial<Rules> }
  | { kind: 'start' }
  | { kind: 'play'; card: number; color?: CardColor }
  | { kind: 'draw' }
  | { kind: 'pass' }
  | { kind: 'call' }
  | { kind: 'catch'; seat: number }
  | { kind: 'again' }
  | { kind: 'resync' }
  | { kind: 'restore'; cards: number[] }
  | { kind: 'auto'; seq: number; mode?: 'play' | 'catch' | 'rebuild' };

// ---- helpers --------------------------------------------------------------------------------

export function shuffle(cards: number[], random: () => number = Math.random): number[] {
  const a = [...cards];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const bump = (s: LcState, patch: Partial<LcState>): LcState => ({ ...s, ...patch, seq: s.seq + 1 });

const canManage = (meta: LcMeta): boolean => Boolean(meta.isHost || !meta.hostId || !meta.present?.includes(meta.hostId));

export const seatOf = (s: LcState, peerId: string | null | undefined): number =>
  peerId ? s.players.findIndex((p) => !p.bot && p.id === peerId) : -1;

const cleanName = (name: unknown, fallback: string): string => String(name || '').trim().slice(0, 24) || fallback;

export const nextSeat = (s: LcState, from = s.turn, steps = 1): number => {
  const n = s.players.length;
  return (((from + s.dir * steps) % n) + n) % n;
};

export const topCard = (s: LcState): number | null => (s.discard.length ? s.discard[s.discard.length - 1] : null);

/** Can `id` go on the pile now? (`afterDraw`: only the card just drawn may be played) */
export function canPlay(s: LcState, id: number): boolean {
  const top = topCard(s);
  if (top === null) return true;
  const c = card(id);
  const t = card(top);
  if (s.pendingDraw > 0) {
    if (!s.rules.stacking) return false;
    if (c.value === 'F') return true;
    return c.value === 'D' && t.value === 'D';
  }
  if (c.color === 'w') return true;
  return c.color === s.color || c.value === t.value;
}

export function playableCards(s: LcState, seat: number): number[] {
  const hand = s.hands[seat];
  if (!hand) return [];
  if (s.drewThisTurn) {
    const drawn = hand[hand.length - 1];
    return drawn !== undefined && canPlay(s, drawn) ? [drawn] : [];
  }
  return hand.filter((id) => canPlay(s, id));
}

/** Take `n` cards off the draw pile, reshuffling the discard pile (all but the top) when it runs out */
function takeCards(s: LcState, n: number): { cards: number[]; drawPile: number[]; discard: number[]; reshuffled: boolean } {
  let drawPile = [...(s.drawPile || [])];
  let discard = [...s.discard];
  const cards: number[] = [];
  let reshuffled = false;
  for (let i = 0; i < n; i++) {
    if (!drawPile.length && discard.length > 1) {
      const top = discard[discard.length - 1];
      drawPile = shuffle(discard.slice(0, -1));
      discard = [top];
      reshuffled = true;
    }
    const next = drawPile.shift();
    if (next === undefined) break; // every card is in someone's hand
    cards.push(next);
  }
  return { cards, drawPile, discard, reshuffled };
}

function giveCards(s: LcState, seat: number, n: number): LcState {
  const got = takeCards(s, n);
  const hands = [...s.hands];
  hands[seat] = [...(hands[seat] || []), ...got.cards];
  const counts = [...s.counts];
  counts[seat] = hands[seat]!.length;
  return {
    ...s,
    hands,
    counts,
    drawPile: got.drawPile,
    drawCount: got.drawPile.length,
    discard: got.discard,
    called: s.called.map((c, i) => (i === seat ? false : c))
  };
}

const startTurn = (s: LcState, seat: number, patch: Partial<LcState> = {}): LcState =>
  bump(s, { turn: seat, drewThisTurn: false, turnSince: Date.now(), ...patch });

/** Someone other than the exposed player moved: the chance to catch them is over */
const closeExposure = (s: LcState, seat: number): LcState => (s.exposed !== null && s.exposed !== seat ? { ...s, exposed: null } : s);

function deal(s: LcState): LcState {
  let pile = shuffle(Array.from({ length: DECK_SIZE }, (_, i) => i));
  const n = s.players.length;
  const hands: number[][] = Array.from({ length: n }, () => []);
  for (let r = 0; r < HAND_SIZE; r++) for (let p = 0; p < n; p++) hands[p].push(pile.shift()!);
  // the first card on the pile is a number card
  let i = pile.findIndex((id) => /\d/.test(card(id).value));
  if (i < 0) i = 0;
  const first = pile[i];
  pile = [...pile.slice(0, i), ...pile.slice(i + 1)];
  const turn = Math.floor(Math.random() * n);
  return bump(s, {
    phase: 'playing',
    hands,
    counts: hands.map((h) => h.length),
    drawPile: pile,
    drawCount: pile.length,
    discard: [first],
    color: card(first).color as CardColor,
    turn,
    dir: 1,
    pendingDraw: 0,
    drewThisTurn: false,
    called: hands.map(() => false),
    exposed: null,
    winner: null,
    event: { kind: 'start', seat: turn, card: first },
    turnSince: Date.now(),
    restoring: false
  });
}

/** Play a card that's been checked as legal */
function playCard(s0: LcState, seat: number, id: number, chosen?: CardColor): LcState {
  let s = closeExposure(s0, seat);
  const c = card(id);
  const hands = [...s.hands];
  hands[seat] = hands[seat]!.filter((x) => x !== id);
  const counts = [...s.counts];
  counts[seat] = hands[seat]!.length;
  const left = counts[seat];
  const called = [...s.called];
  const exposed = left === 1 && !called[seat] ? seat : s.exposed === seat ? null : s.exposed;
  called[seat] = false;
  s = {
    ...s,
    hands,
    counts,
    called,
    exposed,
    discard: [...s.discard, id],
    color: c.color === 'w' ? chosen! : c.color,
    drewThisTurn: false
  };
  if (left === 0) {
    const players = s.players.map((p, i) => (i === seat ? { ...p, wins: p.wins + 1 } : p));
    return bump(s, { phase: 'over', winner: seat, players, exposed: null, pendingDraw: 0, event: { kind: 'win', seat, card: id } });
  }
  const event: LcEvent = { kind: 'play', seat, card: id, ...(c.color === 'w' ? { color: chosen } : {}) };
  const twoPlayers = s.players.length === 2;
  switch (c.value) {
    case 'S':
      return startTurn(s, nextSeat(s, seat, 2), { event: { ...event, target: nextSeat(s, seat) } });
    case 'R':
      if (twoPlayers) return startTurn(s, seat, { event: { ...event, target: nextSeat(s, seat) } });
      {
        const flipped = { ...s, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 };
        return startTurn(flipped, nextSeat(flipped, seat), { event });
      }
    case 'D':
    case 'F': {
      const owed = s.pendingDraw + (c.value === 'D' ? 2 : 4);
      const victim = nextSeat(s, seat);
      if (s.rules.stacking) return startTurn(s, victim, { pendingDraw: owed, event });
      // no stacking: they take the cards and lose their turn
      const given = giveCards({ ...s, pendingDraw: 0 }, victim, owed);
      return startTurn(given, nextSeat(given, victim), { pendingDraw: 0, event: { ...event, target: victim, count: owed } });
    }
    default:
      return startTurn(s, nextSeat(s, seat), { event });
  }
}

function drawFor(s0: LcState, seat: number): LcState {
  let s = closeExposure(s0, seat);
  if (s.pendingDraw > 0) {
    const owed = s.pendingDraw;
    s = giveCards({ ...s, pendingDraw: 0 }, seat, owed);
    return startTurn(s, nextSeat(s, seat), { event: { kind: 'take', seat, count: owed } });
  }
  let drawn = 0;
  for (;;) {
    const before = s.hands[seat]!.length;
    s = giveCards(s, seat, 1);
    if (s.hands[seat]!.length === before) break; // nothing left to draw
    drawn++;
    const got = s.hands[seat]![s.hands[seat]!.length - 1];
    if (canPlay(s, got)) return bump(s, { drewThisTurn: true, event: { kind: 'draw', seat, count: drawn } });
    if (!s.rules.drawToMatch || drawn >= 30) break;
  }
  return startTurn(s, nextSeat(s, seat), { event: { kind: 'draw', seat, count: drawn } });
}

// ---- the computer --------------------------------------------------------------------------

/** What the computer (or the app, for someone away) does now: a card to play, or null to draw/pass */
export function botChoice(s: LcState, seat: number): { card: number; color?: CardColor } | null {
  const options = playableCards(s, seat);
  if (!options.length) return null;
  const hand = s.hands[seat] || [];
  const next = nextSeat(s, seat);
  const nextIsClose = (s.counts[next] ?? 9) <= 2;
  const score = (id: number): number => {
    const c = card(id);
    let v = 0;
    if (c.color === 'w') v -= 20; // keep wilds for later
    if (c.value === 'F') v -= 10;
    if (/[SRD]/.test(c.value)) v += nextIsClose ? 30 : 5;
    if (c.value === 'F' && nextIsClose) v += 45;
    if (c.color !== 'w') v += hand.filter((h) => card(h).color === c.color).length; // play from the biggest colour
    return v;
  };
  const best = [...options].sort((a, b) => score(b) - score(a))[0];
  if (!isWild(best)) return { card: best };
  const tally: Record<CardColor, number> = { r: 0, y: 0, g: 0, b: 0 };
  for (const h of hand) if (h !== best && card(h).color !== 'w') tally[card(h).color as CardColor]++;
  const color = COLORS.reduce((a, b) => (tally[b] > tally[a] ? b : a), COLORS[Math.floor(Math.random() * 4)]);
  return { card: best, color };
}

/** Deal again what this copy doesn't know: hands nobody sent back, and the draw pile */
function rebuild(s: LcState): LcState {
  const known = new Set<number>([...s.discard, ...s.hands.flatMap((h) => h || [])]);
  let pool = shuffle(Array.from({ length: DECK_SIZE }, (_, i) => i).filter((id) => !known.has(id)));
  const hands = s.hands.map((h, i) => {
    if (h) return h;
    const n = s.counts[i] ?? 0;
    const mine = pool.slice(0, n);
    pool = pool.slice(n);
    return mine;
  });
  return bump(s, {
    hands,
    counts: hands.map((h) => h.length),
    drawPile: pool,
    drawCount: pool.length,
    restoring: false,
    turnSince: Date.now(),
    event: { kind: 'restored', seat: s.turn }
  });
}

/** Is this copy missing secrets it needs to run the game (it just became the authority)? */
export const missingSecrets = (s: LcState): boolean =>
  s.phase === 'playing' && (s.drawPile === null || s.hands.some((h, i) => h === null && (s.counts[i] ?? 0) > 0));

// ---- the reducer -----------------------------------------------------------------------------

export function reducer(s: LcState, action: LcAction, meta: LcMeta): LcState {
  switch (action.kind) {
    // ---- lobby ------------------------------------------------------------------------------
    case 'join': {
      const cid = meta.clientOf?.(meta.by) || null;
      const back = s.players.findIndex((p) => !p.bot && p.id !== meta.by && cid && p.cid === cid && !meta.present?.includes(p.id));
      if (back >= 0) {
        // Same app after a reload or rejoin: your seat (and your cards) again
        const players = s.players.map((p, i) => (i === back ? { ...p, id: meta.by } : p));
        return bump(s, { players });
      }
      if (s.phase !== 'lobby' || seatOf(s, meta.by) >= 0 || s.players.length >= MAX_PLAYERS) return s;
      const player: Player = { id: meta.by, name: cleanName(action.name, `Player ${s.players.length + 1}`), wins: 0, ...(cid ? { cid } : {}) };
      return bump(s, { players: [...s.players, player] });
    }
    case 'leave': {
      const seat = seatOf(s, meta.by);
      if (s.phase !== 'lobby' || seat < 0) return s;
      return bump(s, { players: s.players.filter((_, i) => i !== seat) });
    }
    case 'add-bot': {
      if (s.phase !== 'lobby' || !canManage(meta) || s.players.length >= MAX_PLAYERS) return s;
      const n = s.players.filter((p) => p.bot).length + 1;
      return bump(s, { players: [...s.players, { id: `bot-${s.seq}-${n}`, name: `Computer ${n}`, bot: true, wins: 0 }] });
    }
    case 'remove': {
      if (s.phase !== 'lobby' || !canManage(meta) || !s.players[action.seat]) return s;
      return bump(s, { players: s.players.filter((_, i) => i !== action.seat) });
    }
    case 'rules': {
      if (s.phase !== 'lobby' || !canManage(meta)) return s;
      const rules = { ...s.rules };
      if (typeof action.rules?.stacking === 'boolean') rules.stacking = action.rules.stacking;
      if (typeof action.rules?.drawToMatch === 'boolean') rules.drawToMatch = action.rules.drawToMatch;
      return bump(s, { rules });
    }
    case 'start': {
      if (s.phase !== 'lobby' || s.players.length < 2) return s;
      if (!canManage(meta) && seatOf(s, meta.by) < 0) return s;
      return deal(s);
    }
    case 'again': {
      if (s.phase !== 'over') return s;
      if (!canManage(meta) && seatOf(s, meta.by) < 0) return s;
      return bump(s, { ...INITIAL, players: s.players, rules: s.rules, seq: s.seq });
    }

    // ---- after the authority changed --------------------------------------------------------
    case 'resync': {
      // the new authority's own app noticed it is missing cards
      if (meta.by !== meta.selfId || !missingSecrets(s) || s.restoring) return s;
      return bump(s, { restoring: true });
    }
    case 'restore': {
      const seat = seatOf(s, meta.by);
      if (!s.restoring || seat < 0 || s.hands[seat] !== null || !Array.isArray(action.cards)) return s;
      const cards = action.cards.map((x) => Number(x));
      const taken = new Set<number>([...s.discard, ...s.hands.flatMap((h) => h || [])]);
      const valid =
        cards.length === s.counts[seat] &&
        new Set(cards).size === cards.length &&
        cards.every((id) => Number.isInteger(id) && id >= 0 && id < DECK_SIZE && !taken.has(id));
      if (!valid) return s;
      const hands = [...s.hands];
      hands[seat] = cards;
      const next = { ...s, hands };
      // everyone here who plays has sent theirs: deal the rest
      const waiting = next.players.some((p, i) => !p.bot && next.hands[i] === null && meta.present?.includes(p.id) && (next.counts[i] ?? 0) > 0);
      return waiting ? bump(next, {}) : rebuild(next);
    }

    // ---- playing ------------------------------------------------------------------------------
    case 'play': {
      const seat = seatOf(s, meta.by);
      if (s.phase !== 'playing' || s.restoring || seat < 0 || seat !== s.turn) return s;
      const id = Number(action.card);
      if (!s.hands[seat]?.includes(id) || !playableCards(s, seat).includes(id)) return s;
      if (isWild(id) && !COLORS.includes(action.color as CardColor)) return s;
      return playCard(s, seat, id, action.color);
    }
    case 'draw': {
      const seat = seatOf(s, meta.by);
      if (s.phase !== 'playing' || s.restoring || seat < 0 || seat !== s.turn || s.drewThisTurn) return s;
      return drawFor(s, seat);
    }
    case 'pass': {
      const seat = seatOf(s, meta.by);
      if (s.phase !== 'playing' || s.restoring || seat !== s.turn || !s.drewThisTurn) return s;
      return startTurn(closeExposure(s, seat), nextSeat(s, seat), { event: { kind: 'pass', seat } });
    }
    case 'call': {
      const seat = seatOf(s, meta.by);
      if (s.phase !== 'playing' || seat < 0) return s;
      if (s.exposed === seat) return bump(s, { exposed: null, event: { kind: 'called', seat } });
      // calling ahead: on your turn with two cards left
      if (seat === s.turn && s.counts[seat] === 2 && !s.called[seat]) {
        return bump(s, { called: s.called.map((c, i) => (i === seat ? true : c)), event: { kind: 'called', seat } });
      }
      return s;
    }
    case 'catch': {
      const by = seatOf(s, meta.by);
      const target = Number(action.seat);
      if (s.phase !== 'playing' || s.restoring || by < 0 || by === target || s.exposed !== target) return s;
      const given = giveCards({ ...s, exposed: null }, target, 2);
      return bump(given, { event: { kind: 'caught', seat: by, target, count: 2 } });
    }

    // ---- the authority's app plays for computers, people away and idle players --------------
    case 'auto': {
      if (s.phase !== 'playing' || meta.by !== meta.selfId) return s;
      if (action.mode === 'rebuild') return s.restoring && action.seq === s.seq ? rebuild(s) : s;
      if (s.restoring || action.seq !== s.seq) return s;
      if (action.mode === 'catch') {
        // a computer player catches someone who forgot to call
        const catcher = s.players.findIndex((p, i) => p.bot && i !== s.exposed);
        if (s.exposed === null || catcher < 0) return s;
        const target = s.exposed;
        const given = giveCards({ ...s, exposed: null }, target, 2);
        return bump(given, { event: { kind: 'caught', seat: catcher, target, count: 2 } });
      }
      const seat = s.turn;
      if (!s.hands[seat]) return s;
      let state = s;
      // computers always call in time
      if (s.players[seat].bot && s.counts[seat] === 2) state = { ...state, called: state.called.map((c, i) => (i === seat ? true : c)) };
      const choice = botChoice(state, seat);
      if (choice) return playCard(state, seat, choice.card, choice.color);
      if (state.drewThisTurn) return startTurn(closeExposure(state, seat), nextSeat(state, seat), { event: { kind: 'pass', seat } });
      const after = drawFor(state, seat);
      // drew something playable: play it right away
      if (after.drewThisTurn && after.turn === seat) {
        const again = botChoice(after, seat);
        if (again) return playCard(after, seat, again.card, again.color);
        return startTurn(after, nextSeat(after, seat), { event: { kind: 'pass', seat } });
      }
      return after;
    }
    default:
      return s;
  }
}

/** The copy of the state `peerId` may see: their own hand, nobody else's, no draw pile */
export function redact(s: LcState, peerId: string): LcState {
  const seat = seatOf(s, peerId);
  return {
    ...s,
    hands: s.hands.map((h, i) => (i === seat ? h : null)),
    drawPile: null
  };
}
