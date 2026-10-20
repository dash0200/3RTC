/**
 * Tycoon: buy places, collect rent, build houses and hotels, trade, and don't go broke.
 * 2–6 players and the computer. This is the shared-state reducer (runs on the authority); dice
 * are rolled here. Board and cards: ./board.ts.
 */
import {
  GO_TO_JAIL,
  JAIL,
  JAIL_FINE,
  MAX_PLAYERS,
  PLAYER_COLORS,
  SPACES,
  START_CASH,
  START_PAY,
  STATIONS,
  STATION_RENT,
  SURPRISE,
  TOKENS,
  TREASURE,
  UTILITIES,
  UTILITY_TIMES,
  groupMembers,
  groupOf,
  isBuyable,
  priceOf,
  type TokenId,
  type TycoonCard
} from './board';

export interface Player {
  id: string;
  name: string;
  cid?: string;
  bot?: boolean;
  color: string;
  token: TokenId;
  cash: number;
  pos: number;
  /** 0: free; 1–3: turns spent in jail so far + 1 */
  jail: number;
  jailCards: ('s' | 't')[];
  bankrupt: boolean;
}

export interface Payee {
  to: number | null; // null: the bank
  amount: number;
}

export interface Debt {
  payees: Payee[];
  reason: string;
  /** what comes after paying: roll again (doubles) or end the turn */
  after: 'roll' | 'done';
}

export interface Trade {
  id: number;
  from: number;
  to: number;
  giveCash: number;
  giveProps: number[];
  getCash: number;
  getProps: number[];
}

export interface Rules {
  /** taxes and fines go into a pot that whoever lands on Chai Break collects */
  jackpot: boolean;
  /** end after this many rounds (0: play until one is left); the richest wins */
  rounds: number;
}

export interface Move {
  seat: number;
  from: number;
  to: number;
  /** a jump (card, jail) rather than walking */
  jump: boolean;
  seq: number;
}

export interface TyState {
  phase: 'lobby' | 'playing' | 'over';
  players: Player[];
  rules: Rules;
  owner: (number | null)[];
  houses: number[]; // 5 = hotel
  mortgaged: boolean[];
  turn: number;
  step: 'roll' | 'buy' | 'debt' | 'done';
  dice: [number, number] | null;
  doubles: number;
  /** doubles this roll: another roll after this turn's business */
  again: boolean;
  pendingBuy: number | null;
  debt: Debt | null;
  card: { deck: 's' | 't'; index: number; seat: number; seq: number } | null;
  decks: { s: number[]; t: number[] };
  pot: number;
  trade: Trade | null;
  log: string[];
  move: Move | null;
  winner: number | null;
  /** completed rounds (everyone had a turn) */
  round: number;
  seq: number;
  turnSince: number;
}

export const DEFAULT_RULES: Rules = { jackpot: false, rounds: 0 };
export const ROUND_OPTIONS = [0, 15, 30];
const EMPTY = SPACES.map(() => null as number | null);

export const INITIAL: TyState = {
  phase: 'lobby',
  players: [],
  rules: DEFAULT_RULES,
  owner: EMPTY,
  houses: SPACES.map(() => 0),
  mortgaged: SPACES.map(() => false),
  turn: 0,
  step: 'roll',
  dice: null,
  doubles: 0,
  again: false,
  pendingBuy: null,
  debt: null,
  card: null,
  decks: { s: [], t: [] },
  pot: 0,
  trade: null,
  log: [],
  move: null,
  winner: null,
  round: 0,
  seq: 0,
  turnSince: 0
};

export interface TyMeta {
  by: string;
  selfId?: string;
  isHost?: boolean;
  hostId?: string | null;
  present?: string[];
  clientOf?: (id: string) => string | null;
}

export type TyAction =
  | { kind: 'join'; name?: string; token?: TokenId }
  | { kind: 'leave' }
  | { kind: 'add-bot' }
  | { kind: 'remove'; seat: number }
  | { kind: 'token'; token: TokenId }
  | { kind: 'rules'; rules?: Partial<Rules> }
  | { kind: 'start' }
  | { kind: 'roll' }
  | { kind: 'pay-jail' }
  | { kind: 'jail-card' }
  | { kind: 'buy' }
  | { kind: 'skip' }
  | { kind: 'build'; pos: number }
  | { kind: 'sell'; pos: number }
  | { kind: 'mortgage'; pos: number }
  | { kind: 'unmortgage'; pos: number }
  | { kind: 'pay-debt' }
  | { kind: 'bankrupt' }
  | { kind: 'end-turn' }
  | { kind: 'trade'; to: number; giveCash?: number; giveProps?: number[]; getCash?: number; getProps?: number[] }
  | { kind: 'trade-answer'; accept: boolean }
  | { kind: 'trade-cancel' }
  | { kind: 'end-game' }
  | { kind: 'again' }
  | { kind: 'auto'; seq: number; mode?: 'turn' | 'trade' };

// ---- small helpers -------------------------------------------------------------------------

export const rupees = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;
const bump = (s: TyState, patch: Partial<TyState> = {}): TyState => ({ ...s, ...patch, seq: s.seq + 1 });
const canManage = (meta: TyMeta): boolean => Boolean(meta.isHost || !meta.hostId || !meta.present?.includes(meta.hostId));
export const seatOf = (s: TyState, peerId: string | null | undefined): number =>
  peerId ? s.players.findIndex((p) => !p.bot && p.id === peerId) : -1;
const cleanName = (name: unknown, fallback: string): string => String(name || '').trim().slice(0, 20) || fallback;
const withLog = (s: TyState, ...lines: string[]): TyState => ({ ...s, log: [...s.log, ...lines].slice(-14) });
const setPlayer = (s: TyState, seat: number, patch: Partial<Player>): TyState => ({
  ...s,
  players: s.players.map((p, i) => (i === seat ? { ...p, ...patch } : p))
});
const addCash = (s: TyState, seat: number, amount: number): TyState => setPlayer(s, seat, { cash: s.players[seat].cash + amount });
const rollDie = (): number => 1 + Math.floor(Math.random() * 6);

export function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const ownsGroup = (s: TyState, seat: number, pos: number): boolean => {
  const g = groupOf(pos);
  return Boolean(g && groupMembers(g).every((i) => s.owner[i] === seat));
};
const groupHasHouses = (s: TyState, pos: number): boolean => {
  const g = groupOf(pos);
  return Boolean(g && groupMembers(g).some((i) => s.houses[i] > 0));
};

/** Rent someone landing on `pos` pays now (diceTotal for utilities) */
export function rentOf(s: TyState, pos: number, diceTotal: number): number {
  const sp = SPACES[pos];
  const owner = s.owner[pos];
  if (owner === null || s.mortgaged[pos]) return 0;
  if (sp.kind === 'property') {
    const h = s.houses[pos];
    if (h > 0) return sp.rent[h];
    return ownsGroup(s, owner, pos) ? sp.rent[0] * 2 : sp.rent[0];
  }
  if (sp.kind === 'station') return STATION_RENT[STATIONS.filter((i) => s.owner[i] === owner).length - 1];
  if (sp.kind === 'utility') return diceTotal * UTILITY_TIMES[UTILITIES.filter((i) => s.owner[i] === owner).length - 1];
  return 0;
}

const houseCost = (pos: number): number => {
  const sp = SPACES[pos];
  return sp.kind === 'property' ? sp.house : 0;
};
export const mortgageValue = (pos: number): number => Math.round(priceOf(pos) / 2);
export const unmortgageCost = (pos: number): number => Math.round(mortgageValue(pos) * 1.1);

/** Everything a player has, at what the bank would give for it now */
export function raisable(s: TyState, seat: number): number {
  let total = s.players[seat].cash;
  SPACES.forEach((_, i) => {
    if (s.owner[i] !== seat) return;
    total += (s.houses[i] * houseCost(i)) / 2;
    if (!s.mortgaged[i]) total += mortgageValue(i);
  });
  return Math.floor(total);
}

/** Cash + places at price (half if mortgaged) + buildings at cost: who's richest */
export function netWorth(s: TyState, seat: number): number {
  let total = s.players[seat].cash;
  SPACES.forEach((_, i) => {
    if (s.owner[i] !== seat) return;
    total += s.mortgaged[i] ? mortgageValue(i) : priceOf(i);
    total += s.houses[i] * houseCost(i);
  });
  return total;
}

const active = (s: TyState): number[] => s.players.map((p, i) => (p.bankrupt ? -1 : i)).filter((i) => i >= 0);
const nextActive = (s: TyState, from: number): number => {
  const n = s.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (!s.players[i].bankrupt) return i;
  }
  return from;
};

// ---- paying ---------------------------------------------------------------------------------

/** Pay what's owed now if there's enough cash, else go into debt (raise money or go bankrupt) */
function charge(s: TyState, seat: number, payees: Payee[], reason: string): TyState {
  const total = payees.reduce((n, p) => n + p.amount, 0);
  if (total <= 0) return s;
  if (s.players[seat].cash >= total) return settle(s, seat, payees);
  return { ...s, step: 'debt', debt: { payees, reason, after: s.again ? 'roll' : 'done' } };
}

function settle(s0: TyState, seat: number, payees: Payee[]): TyState {
  let s = s0;
  for (const p of payees) {
    s = addCash(s, seat, -p.amount);
    if (p.to !== null) s = addCash(s, p.to, p.amount);
    else if (s.rules.jackpot) s = { ...s, pot: s.pot + p.amount };
  }
  return s;
}

function bankrupt(s0: TyState, seat: number): TyState {
  let s = s0;
  const payees = s.debt?.payees || [];
  const creditor = payees.length === 1 && payees[0].to !== null ? payees[0].to : null;
  const owner = [...s.owner];
  const houses = [...s.houses];
  const mortgaged = [...s.mortgaged];
  let buildingsValue = 0;
  SPACES.forEach((_, i) => {
    if (owner[i] !== seat) return;
    buildingsValue += (houses[i] * houseCost(i)) / 2;
    houses[i] = 0;
    if (creditor !== null) owner[i] = creditor;
    else {
      owner[i] = null;
      mortgaged[i] = false;
    }
  });
  const cash = s.players[seat].cash + Math.floor(buildingsValue);
  s = { ...s, owner, houses, mortgaged };
  if (creditor !== null) {
    s = addCash(s, creditor, Math.max(0, cash));
    const cards = s.players[seat].jailCards;
    s = setPlayer(s, creditor, { jailCards: [...s.players[creditor].jailCards, ...cards] });
  } else {
    // jail cards go back to their decks
    const decks = { s: [...s.decks.s], t: [...s.decks.t] };
    for (const c of s.players[seat].jailCards) decks[c].push((c === 's' ? SURPRISE : TREASURE).findIndex((x) => x.effect.type === 'jailFree'));
    s = { ...s, decks };
  }
  s = setPlayer(s, seat, { bankrupt: true, cash: 0, jailCards: [] });
  s = withLog(s, `💸 ${s.players[seat].name} went bankrupt${creditor !== null ? ` to ${s.players[creditor].name}` : ''}.`);
  const trade = s.trade && (s.trade.from === seat || s.trade.to === seat) ? null : s.trade;
  s = { ...s, debt: null, trade };
  const left = active(s);
  if (left.length <= 1) return bump(s, { phase: 'over', winner: left[0] ?? null, step: 'done' });
  if (s.turn === seat) return startTurn(s, nextActive(s, seat));
  return bump(s);
}

// ---- moving and landing -----------------------------------------------------------------------

const richest = (s: TyState): number => {
  const left = active(s);
  return left.reduce((b, i) => (netWorth(s, i) > netWorth(s, b) ? i : b), left[0]);
};

function startTurn(s: TyState, seat: number): TyState {
  // back round to the first seat still playing: a round is complete
  const first = active(s)[0];
  const round = s.phase === 'playing' && seat === first && s.log.length > 1 ? s.round + 1 : s.round;
  if (s.rules.rounds && round >= s.rules.rounds) {
    const winner = richest(s);
    return bump(withLog(s, `🏆 ${s.rules.rounds} rounds played: ${s.players[winner].name} is the richest.`), { phase: 'over', winner, round, trade: null, step: 'done' });
  }
  return bump(s, { turn: seat, step: 'roll', dice: null, doubles: 0, again: false, pendingBuy: null, debt: null, turnSince: Date.now(), round });
}

function sendToJail(s: TyState, seat: number): TyState {
  const from = s.players[seat].pos;
  const jailed = setPlayer(s, seat, { pos: JAIL, jail: 1 });
  return withLog({ ...jailed, again: false, step: 'done', move: { seat, from, to: JAIL, jump: true, seq: s.seq + 1 } }, `🚓 ${s.players[seat].name} went to jail.`);
}

/** Move to `to`; collect Start money when passing or landing on it (forward moves only) */
function moveTo(s: TyState, seat: number, to: number, jump: boolean, forward = true): TyState {
  const from = s.players[seat].pos;
  let next = setPlayer(s, seat, { pos: to });
  next = { ...next, move: { seat, from, to, jump, seq: s.seq + 1 } };
  if (forward && to < from) {
    next = addCash(next, seat, START_PAY);
    next = withLog(next, `🏁 ${s.players[seat].name} passed Start: +${rupees(START_PAY)}.`);
  }
  return next;
}

function drawCard(s0: TyState, seat: number, deck: 's' | 't', diceTotal: number): TyState {
  let s = s0;
  let order = s.decks[deck];
  if (!order.length) order = shuffle((deck === 's' ? SURPRISE : TREASURE).map((_, i) => i));
  const [index, ...rest] = order;
  const cards = deck === 's' ? SURPRISE : TREASURE;
  const c: TycoonCard = cards[index];
  const keep = c.effect.type === 'jailFree';
  s = { ...s, decks: { ...s.decks, [deck]: keep ? rest : [...rest, index] }, card: { deck, index, seat, seq: s.seq + 1 } };
  s = withLog(s, `${deck === 's' ? '❓' : '🎁'} ${s.players[seat].name}: “${c.text}”`);
  const e = c.effect;
  switch (e.type) {
    case 'money':
      return e.amount >= 0 ? addCash(s, seat, e.amount) : charge(s, seat, [{ to: null, amount: -e.amount }], 'card');
    case 'each': {
      const others = active(s).filter((i) => i !== seat);
      if (e.amount < 0) return charge(s, seat, others.map((to) => ({ to, amount: -e.amount })), 'card');
      // the others pay what they can
      for (const i of others) {
        const pay = Math.min(s.players[i].cash, e.amount);
        s = addCash(addCash(s, i, -pay), seat, pay);
      }
      return s;
    }
    case 'moveTo':
      return land(moveTo(s, seat, e.to, true), seat, diceTotal, 1);
    case 'back': {
      const to = (s.players[seat].pos - e.spaces + 40) % 40;
      return land(moveTo(s, seat, to, false, false), seat, diceTotal, 1);
    }
    case 'nearest': {
      const list = e.what === 'station' ? STATIONS : UTILITIES;
      const pos = s.players[seat].pos;
      const to = list.find((i) => i > pos) ?? list[0];
      return land(moveTo(s, seat, to, true), seat, diceTotal, e.what === 'station' ? 2 : -1);
    }
    case 'jail':
      return sendToJail(s, seat);
    case 'jailFree':
      return setPlayer(s, seat, { jailCards: [...s.players[seat].jailCards, deck] });
    case 'repairs': {
      let cost = 0;
      SPACES.forEach((_, i) => {
        if (s.owner[i] !== seat) return;
        cost += s.houses[i] === 5 ? e.hotel : s.houses[i] * e.house;
      });
      return cost ? charge(s, seat, [{ to: null, amount: cost }], 'repairs') : s;
    }
    default:
      return s;
  }
}

/**
 * What landing on the player's space does. `rentFactor`: 2 for "pay double" cards, −1 for the
 * "10× the dice" utility card.
 */
function land(s0: TyState, seat: number, diceTotal: number, rentFactor = 1): TyState {
  let s = s0;
  const pos = s.players[seat].pos;
  const sp = SPACES[pos];
  const name = s.players[seat].name;
  if (isBuyable(pos)) {
    const owner = s.owner[pos];
    if (owner === null) return { ...s, step: 'buy', pendingBuy: pos };
    if (owner === seat || s.mortgaged[pos] || s.players[owner].bankrupt) return s;
    let rent = rentOf(s, pos, diceTotal);
    if (rentFactor === 2) rent *= 2;
    if (rentFactor === -1) rent = diceTotal * 100;
    s = withLog(s, `🏠 ${name} owes ${s.players[owner].name} ${rupees(rent)} rent for ${sp.name}.`);
    return charge(s, seat, [{ to: owner, amount: rent }], `rent for ${sp.name}`);
  }
  switch (sp.kind) {
    case 'tax':
      s = withLog(s, `🧾 ${name} pays ${sp.name}: ${rupees(sp.amount)}.`);
      return charge(s, seat, [{ to: null, amount: sp.amount }], sp.name);
    case 'surprise':
      return drawCard(s, seat, 's', diceTotal);
    case 'treasure':
      return drawCard(s, seat, 't', diceTotal);
    case 'gotojail':
      return sendToJail(s, seat);
    case 'parking':
      if (s.rules.jackpot && s.pot > 0) {
        const pot = s.pot;
        return withLog(addCash({ ...s, pot: 0 }, seat, pot), `☕ ${name} won the Chai Break pot: ${rupees(pot)}!`);
      }
      return s;
    default:
      return s;
  }
}

/** After moving: what the player does next */
const afterLanding = (s: TyState): TyState => {
  if (s.step === 'buy' || s.step === 'debt' || s.phase !== 'playing') return bump(s);
  return bump(s, { step: s.again && !s.players[s.turn].jail ? 'roll' : 'done' });
};

function roll(s0: TyState, seat: number): TyState {
  let s = s0;
  const a = rollDie();
  const b = rollDie();
  const total = a + b;
  const doubles = a === b;
  const p = s.players[seat];
  s = { ...s, dice: [a, b], card: null };
  if (p.jail) {
    if (doubles) {
      s = withLog(setPlayer(s, seat, { jail: 0 }), `🎲 ${p.name} rolled doubles and walks out of jail.`);
      s = { ...s, again: false };
    } else if (p.jail >= 3) {
      // third try: pay and go
      s = withLog(setPlayer(s, seat, { jail: 0 }), `🎲 ${p.name} pays ${rupees(JAIL_FINE)} to leave jail.`);
      s = { ...s, again: false };
      s = charge(s, seat, [{ to: null, amount: JAIL_FINE }], 'jail fine');
      if (s.step === 'debt') return bump(s); // pays first, then moves on its next turn
    } else {
      s = setPlayer(s, seat, { jail: p.jail + 1 });
      return bump(withLog(s, `🎲 ${p.name} rolled ${a} + ${b}: still in jail.`), { step: 'done', again: false });
    }
  } else if (doubles) {
    const count = s.doubles + 1;
    if (count >= 3) return bump(sendToJail({ ...s, doubles: count }, seat));
    s = { ...s, doubles: count, again: true };
  } else {
    s = { ...s, again: false };
  }
  s = withLog(s, `🎲 ${p.name} rolled ${a} + ${b} = ${total}${doubles && !p.jail ? ' (doubles!)' : ''}.`);
  const to = (s.players[seat].pos + total) % 40;
  s = moveTo(s, seat, to, false);
  if (to === GO_TO_JAIL) return bump(sendToJail(s, seat));
  return afterLanding(land(s, seat, total));
}

// ---- trades ---------------------------------------------------------------------------------

function tradeValid(s: TyState, t: Trade): boolean {
  const from = s.players[t.from];
  const to = s.players[t.to];
  if (!from || !to || from.bankrupt || to.bankrupt || t.from === t.to) return false;
  if (t.giveCash < 0 || t.getCash < 0 || t.giveCash > from.cash || t.getCash > to.cash) return false;
  if (!t.giveProps.length && !t.getProps.length && !t.giveCash && !t.getCash) return false;
  const ok = (list: number[], seat: number) =>
    list.every((i) => Number.isInteger(i) && isBuyable(i) && s.owner[i] === seat && !groupHasHouses(s, i)) && new Set(list).size === list.length;
  return ok(t.giveProps, t.from) && ok(t.getProps, t.to);
}

function doTrade(s0: TyState, t: Trade): TyState {
  let s = s0;
  const owner = [...s.owner];
  for (const i of t.giveProps) owner[i] = t.to;
  for (const i of t.getProps) owner[i] = t.from;
  s = { ...s, owner };
  s = addCash(addCash(s, t.from, t.getCash - t.giveCash), t.to, t.giveCash - t.getCash);
  return withLog(s, `🤝 ${s.players[t.from].name} and ${s.players[t.to].name} made a deal.`);
}

/** How a computer values a trade offered to it (positive: good for it) */
export function botTradeScore(s: TyState, t: Trade): number {
  const seat = t.to;
  let score = t.giveCash - t.getCash;
  const value = (i: number) => priceOf(i) * (s.mortgaged[i] ? 0.5 : 1);
  for (const i of t.giveProps) score += value(i) * 1.1;
  for (const i of t.getProps) {
    score -= value(i) * 1.3;
    // never break up its own full group, never hand over a group-completer cheaply
    if (ownsGroup(s, seat, i)) score -= 100000;
    const g = groupOf(i);
    if (g && groupMembers(g).every((m) => m === i || s.owner[m] === t.from)) score -= priceOf(i) * 1.5;
  }
  return score;
}

// ---- the computer ---------------------------------------------------------------------------

const RESERVE = 2000;

/** One money step for a computer in debt: sell a house, else mortgage something; null if nothing left */
function botRaise(s: TyState, seat: number): TyState | null {
  const mine = SPACES.map((_, i) => i).filter((i) => s.owner[i] === seat);
  const built = mine.filter((i) => s.houses[i] > 0).sort((a, b) => s.houses[b] - s.houses[a]);
  for (const i of built) {
    const next = reducerCore(s, { kind: 'sell', pos: i }, seat);
    if (next !== s) return next;
  }
  const plain = mine.filter((i) => !s.mortgaged[i] && !groupHasHouses(s, i)).sort((a, b) => priceOf(a) - priceOf(b));
  for (const i of plain) {
    const next = reducerCore(s, { kind: 'mortgage', pos: i }, seat);
    if (next !== s) return next;
  }
  return null;
}

/** Build where it can afford to while keeping a reserve */
function botBuild(s0: TyState, seat: number): TyState {
  let s = s0;
  for (let guard = 0; guard < 20; guard++) {
    const options = SPACES.map((_, i) => i)
      .filter((i) => s.owner[i] === seat && SPACES[i].kind === 'property' && ownsGroup(s, seat, i))
      .sort((a, b) => s.houses[a] - s.houses[b] || priceOf(b) - priceOf(a));
    const pick = options.find((i) => s.players[seat].cash - houseCost(i) >= RESERVE && reducerCore(s, { kind: 'build', pos: i }, seat) !== s);
    if (pick === undefined) break;
    s = reducerCore(s, { kind: 'build', pos: pick }, seat);
  }
  // pay off mortgages when rich
  for (const i of SPACES.map((_, k) => k)) {
    if (s.owner[i] === seat && s.mortgaged[i] && s.players[seat].cash - unmortgageCost(i) >= RESERVE * 2) {
      s = reducerCore(s, { kind: 'unmortgage', pos: i }, seat);
    }
  }
  return s;
}

function botTurn(s: TyState): TyState {
  const seat = s.turn;
  const p = s.players[seat];
  switch (s.step) {
    case 'debt': {
      let next = s;
      for (let guard = 0; guard < 80; guard++) {
        const total = next.debt!.payees.reduce((n, x) => n + x.amount, 0);
        if (next.players[seat].cash >= total) return reducerCore(next, { kind: 'pay-debt' }, seat);
        const raised = botRaise(next, seat);
        if (!raised) break;
        next = raised;
      }
      return reducerCore(next, { kind: 'bankrupt' }, seat);
    }
    case 'buy': {
      const pos = s.pendingBuy!;
      const price = priceOf(pos);
      const g = groupOf(pos);
      const completes = g ? groupMembers(g).every((i) => i === pos || s.owner[i] === seat) : false;
      const buy = !p.bot ? false : p.cash - price >= RESERVE || (completes && p.cash >= price);
      return reducerCore(s, { kind: buy ? 'buy' : 'skip' }, seat);
    }
    case 'roll': {
      let next = p.bot ? botBuild(s, seat) : s;
      if (next.players[seat].jail) {
        if (next.players[seat].jailCards.length) next = reducerCore(next, { kind: 'jail-card' }, seat);
        else if (next.players[seat].cash >= JAIL_FINE + RESERVE) next = reducerCore(next, { kind: 'pay-jail' }, seat);
      }
      return reducerCore(next, { kind: 'roll' }, seat);
    }
    case 'done': {
      const next = p.bot ? botBuild(s, seat) : s;
      return reducerCore(next, { kind: 'end-turn' }, seat);
    }
    default:
      return s;
  }
}

// ---- the reducer ------------------------------------------------------------------------------

/** Turn actions for `seat` (also used by the computer) */
function reducerCore(s: TyState, a: TyAction, seat: number): TyState {
  if (s.phase !== 'playing' || seat < 0 || s.players[seat]?.bankrupt) return s;
  const myTurn = seat === s.turn;
  const p = s.players[seat];
  switch (a.kind) {
    case 'roll':
      if (!myTurn || s.step !== 'roll') return s;
      return roll(s, seat);
    case 'pay-jail':
      if (!myTurn || s.step !== 'roll' || !p.jail || p.cash < JAIL_FINE) return s;
      return bump(withLog(settle(setPlayer(s, seat, { jail: 0 }), seat, [{ to: null, amount: JAIL_FINE }]), `🔓 ${p.name} paid ${rupees(JAIL_FINE)} to leave jail.`));
    case 'jail-card': {
      if (!myTurn || s.step !== 'roll' || !p.jail || !p.jailCards.length) return s;
      const [card, ...restCards] = p.jailCards;
      const deck = card === 's' ? SURPRISE : TREASURE;
      const index = deck.findIndex((x) => x.effect.type === 'jailFree');
      const freed = setPlayer(s, seat, { jail: 0, jailCards: restCards });
      return bump(withLog({ ...freed, decks: { ...s.decks, [card]: [...s.decks[card], index] } }, `🔓 ${p.name} used a get-out-of-jail card.`));
    }
    case 'buy': {
      const pos = s.pendingBuy;
      if (!myTurn || s.step !== 'buy' || pos === null || p.cash < priceOf(pos)) return s;
      const owner = [...s.owner];
      owner[pos] = seat;
      const bought = withLog(addCash({ ...s, owner, pendingBuy: null, step: 'roll' }, seat, -priceOf(pos)), `🔑 ${p.name} bought ${SPACES[pos].name} for ${rupees(priceOf(pos))}.`);
      return bump(bought, { step: s.again && !p.jail ? 'roll' : 'done' });
    }
    case 'skip':
      if (!myTurn || s.step !== 'buy') return s;
      return bump(s, { pendingBuy: null, step: s.again && !p.jail ? 'roll' : 'done' });
    case 'build': {
      const pos = a.pos;
      if (!myTurn || s.step === 'debt' || SPACES[pos]?.kind !== 'property' || s.owner[pos] !== seat || !ownsGroup(s, seat, pos)) return s;
      const g = groupMembers(groupOf(pos)!);
      if (g.some((i) => s.mortgaged[i]) || s.houses[pos] >= 5 || p.cash < houseCost(pos)) return s;
      if (s.houses[pos] > Math.min(...g.map((i) => s.houses[i]))) return s; // build evenly
      const houses = [...s.houses];
      houses[pos] += 1;
      return bump(withLog(addCash({ ...s, houses }, seat, -houseCost(pos)), `🏗️ ${p.name} built ${houses[pos] === 5 ? 'a hotel' : 'a house'} on ${SPACES[pos].name}.`));
    }
    case 'sell': {
      const pos = a.pos;
      if (!myTurn || s.owner[pos] !== seat || s.houses[pos] <= 0) return s;
      const g = groupMembers(groupOf(pos)!);
      if (s.houses[pos] < Math.max(...g.map((i) => s.houses[i]))) return s; // sell evenly
      const houses = [...s.houses];
      houses[pos] -= 1;
      return bump(addCash({ ...s, houses }, seat, Math.floor(houseCost(pos) / 2)));
    }
    case 'mortgage': {
      const pos = a.pos;
      if (!myTurn || s.owner[pos] !== seat || s.mortgaged[pos] || groupHasHouses(s, pos)) return s;
      const mortgaged = [...s.mortgaged];
      mortgaged[pos] = true;
      return bump(withLog(addCash({ ...s, mortgaged }, seat, mortgageValue(pos)), `🏦 ${p.name} mortgaged ${SPACES[pos].name}.`));
    }
    case 'unmortgage': {
      const pos = a.pos;
      if (!myTurn || s.step === 'debt' || s.owner[pos] !== seat || !s.mortgaged[pos] || p.cash < unmortgageCost(pos)) return s;
      const mortgaged = [...s.mortgaged];
      mortgaged[pos] = false;
      return bump(addCash({ ...s, mortgaged }, seat, -unmortgageCost(pos)));
    }
    case 'pay-debt': {
      if (!myTurn || s.step !== 'debt' || !s.debt) return s;
      const total = s.debt.payees.reduce((n, x) => n + x.amount, 0);
      if (p.cash < total) return s;
      const paid = settle(s, seat, s.debt.payees);
      return bump(paid, { debt: null, step: s.debt.after === 'roll' && !p.jail ? 'roll' : 'done' });
    }
    case 'bankrupt':
      if (!myTurn || s.step !== 'debt') return s;
      return bankrupt(s, seat);
    case 'end-turn':
      if (!myTurn || s.step !== 'done') return s;
      return startTurn(s, nextActive(s, seat));
    default:
      return s;
  }
}

export function reducer(s: TyState, a: TyAction, meta: TyMeta): TyState {
  switch (a.kind) {
    // ---- lobby ------------------------------------------------------------------------------
    case 'join': {
      const cid = meta.clientOf?.(meta.by) || null;
      const back = s.players.findIndex((p) => !p.bot && p.id !== meta.by && cid && p.cid === cid && !meta.present?.includes(p.id));
      if (back >= 0) return bump(setPlayer(s, back, { id: meta.by }));
      if (s.phase !== 'lobby' || seatOf(s, meta.by) >= 0 || s.players.length >= MAX_PLAYERS) return s;
      const taken = new Set(s.players.map((p) => p.token));
      const token = a.token && TOKENS.includes(a.token) && !taken.has(a.token) ? a.token : TOKENS.find((t) => !taken.has(t))!;
      const usedColors = new Set(s.players.map((p) => p.color));
      const color = PLAYER_COLORS.find((c) => !usedColors.has(c))!;
      const player: Player = {
        id: meta.by, name: cleanName(a.name, `Player ${s.players.length + 1}`), color, token, cash: START_CASH, pos: 0, jail: 0, jailCards: [], bankrupt: false,
        ...(cid ? { cid } : {})
      };
      return bump(s, { players: [...s.players, player] });
    }
    case 'leave': {
      const seat = seatOf(s, meta.by);
      if (s.phase !== 'lobby' || seat < 0) return s;
      return bump(s, { players: s.players.filter((_, i) => i !== seat) });
    }
    case 'add-bot': {
      if (s.phase !== 'lobby' || !canManage(meta) || s.players.length >= MAX_PLAYERS) return s;
      const taken = new Set(s.players.map((p) => p.token));
      const usedColors = new Set(s.players.map((p) => p.color));
      const n = s.players.filter((p) => p.bot).length + 1;
      const bot: Player = {
        id: `bot-${s.seq}`, name: `Computer ${n}`, bot: true, color: PLAYER_COLORS.find((c) => !usedColors.has(c))!,
        token: TOKENS.find((t) => !taken.has(t))!, cash: START_CASH, pos: 0, jail: 0, jailCards: [], bankrupt: false
      };
      return bump(s, { players: [...s.players, bot] });
    }
    case 'remove':
      if (s.phase !== 'lobby' || !canManage(meta) || !s.players[a.seat]) return s;
      return bump(s, { players: s.players.filter((_, i) => i !== a.seat) });
    case 'token': {
      const seat = seatOf(s, meta.by);
      if (s.phase !== 'lobby' || seat < 0 || !TOKENS.includes(a.token) || s.players.some((p, i) => i !== seat && p.token === a.token)) return s;
      return bump(setPlayer(s, seat, { token: a.token }));
    }
    case 'rules': {
      if (s.phase !== 'lobby' || !canManage(meta)) return s;
      const rules = { ...s.rules };
      if (typeof a.rules?.jackpot === 'boolean') rules.jackpot = a.rules.jackpot;
      if (ROUND_OPTIONS.includes(Number(a.rules?.rounds))) rules.rounds = Number(a.rules?.rounds);
      return bump(s, { rules });
    }
    case 'start': {
      if (s.phase !== 'lobby' || s.players.length < 2) return s;
      if (!canManage(meta) && seatOf(s, meta.by) < 0) return s;
      const players = s.players.map((p) => ({ ...p, cash: START_CASH, pos: 0, jail: 0, jailCards: [], bankrupt: false }));
      const first = Math.floor(Math.random() * players.length);
      const fresh: TyState = {
        ...INITIAL,
        rules: s.rules,
        players,
        phase: 'playing',
        decks: { s: shuffle(SURPRISE.map((_, i) => i)), t: shuffle(TREASURE.map((_, i) => i)) },
        log: [`🎉 Game on! ${players[first].name} goes first.`],
        seq: s.seq
      };
      return startTurn(fresh, first);
    }
    case 'again':
      if (s.phase !== 'over' || (!canManage(meta) && seatOf(s, meta.by) < 0)) return s;
      return bump({ ...INITIAL, players: s.players, rules: s.rules, seq: s.seq });
    case 'end-game': {
      if (s.phase !== 'playing' || !canManage(meta)) return s;
      const winner = richest(s);
      return bump(withLog(s, `🏆 Game ended: ${s.players[winner].name} is the richest.`), { phase: 'over', winner, trade: null });
    }

    // ---- trades (anyone, any time) ------------------------------------------------------------
    case 'trade': {
      const from = seatOf(s, meta.by);
      if (s.phase !== 'playing' || from < 0 || s.trade) return s;
      const t: Trade = {
        id: s.seq,
        from,
        to: Number(a.to),
        giveCash: Math.floor(Number(a.giveCash) || 0),
        getCash: Math.floor(Number(a.getCash) || 0),
        giveProps: (a.giveProps || []).map(Number),
        getProps: (a.getProps || []).map(Number)
      };
      if (!tradeValid(s, t)) return s;
      return bump(withLog(s, `🤝 ${s.players[from].name} offered ${s.players[t.to].name} a deal.`), { trade: t });
    }
    case 'trade-answer': {
      const seat = seatOf(s, meta.by);
      if (!s.trade || seat !== s.trade.to) return s;
      if (!a.accept) return bump(withLog(s, `🙅 ${s.players[seat].name} said no to the deal.`), { trade: null });
      if (!tradeValid(s, s.trade)) return bump(s, { trade: null });
      return bump(doTrade(s, s.trade), { trade: null });
    }
    case 'trade-cancel': {
      const seat = seatOf(s, meta.by);
      if (!s.trade || seat !== s.trade.from) return s;
      return bump(s, { trade: null });
    }

    // ---- the authority's app plays for computers, people who left and idle players ---------------
    case 'auto': {
      if (s.phase !== 'playing' || meta.by !== meta.selfId || a.seq !== s.seq) return s;
      if (a.mode === 'trade') {
        if (!s.trade || !s.players[s.trade.to]?.bot) return s;
        const yes = botTradeScore(s, s.trade) > 0 && tradeValid(s, s.trade);
        const done = yes ? doTrade(s, s.trade) : withLog(s, `🙅 ${s.players[s.trade.to].name} said no to the deal.`);
        return bump(done, { trade: null });
      }
      return botTurn(s);
    }

    // ---- turn actions -------------------------------------------------------------------------
    default:
      return reducerCore(s, a, seatOf(s, meta.by));
  }
}
