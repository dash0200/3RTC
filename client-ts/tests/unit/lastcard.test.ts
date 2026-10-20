import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL,
  DECK_SIZE,
  card,
  canPlay,
  botChoice,
  missingSecrets,
  redact,
  reducer,
  type LcAction,
  type LcMeta,
  type LcState
} from '../../src/features/activities/lastcard/rules';

const PRESENT = ['h', 'a', 'b', 'c'];
const meta = (by: string, extra: Partial<LcMeta> = {}): LcMeta => ({
  by, isHost: by === 'h', selfId: 'h', hostId: 'h', present: PRESENT, clientOf: (id) => `cid-${id}`, ...extra
});
const act = (s: LcState, by: string, a: LcAction, extra: Partial<LcMeta> = {}) => reducer(s, a, meta(by, extra));

// card ids by name: red 0 = 0, red 5 = 9/10, red skip = 19, red reverse = 21, red +2 = 23,
// yellow = 25.., green = 50.., blue = 75..; wild = 100, wild +4 = 104
const R5 = 9, R7 = 13, RS = 19, RR = 21, RD = 23, Y5 = 34, Y7 = 38, G2 = 53, B9 = 92, W = 100, F = 104;

function table(hands: number[][], extra: Partial<LcState> = {}): LcState {
  const used = new Set([...hands.flat(), R7]);
  const pile = Array.from({ length: DECK_SIZE }, (_, i) => i).filter((i) => !used.has(i));
  return {
    ...INITIAL,
    phase: 'playing',
    players: hands.map((_, i) => ({ id: ['a', 'b', 'c'][i], name: ['Asha', 'Ben', 'Cy'][i], wins: 0 })),
    hands,
    counts: hands.map((h) => h.length),
    drawPile: pile,
    drawCount: pile.length,
    discard: [R7],
    color: 'r',
    turn: 0,
    called: hands.map(() => false),
    seq: 10,
    ...extra
  };
}

describe('Last Card deck', () => {
  it('has the standard 108 cards', () => {
    const all = Array.from({ length: DECK_SIZE }, (_, i) => card(i));
    const count = (pred: (c: ReturnType<typeof card>) => boolean) => all.filter(pred).length;
    assert.equal(count((c) => c.value === '0'), 4);
    assert.equal(count((c) => c.value === '7'), 8);
    assert.equal(count((c) => c.value === 'S'), 8);
    assert.equal(count((c) => c.value === 'D'), 8);
    assert.equal(count((c) => c.value === 'W'), 4);
    assert.equal(count((c) => c.value === 'F'), 4);
    assert.deepEqual(card(R5), { id: R5, color: 'r', value: '5' });
    assert.deepEqual(card(Y7), { id: Y7, color: 'y', value: '7' });
  });
});

describe('Last Card lobby', () => {
  it('joins, adds computers, starts with 7 cards each and a number card up', () => {
    let s = act(INITIAL, 'a', { kind: 'join', name: 'Asha' });
    s = act(s, 'b', { kind: 'join', name: 'Ben' });
    assert.equal(act(s, 'c', { kind: 'add-bot' }), s); // only the host
    s = act(s, 'h', { kind: 'add-bot' });
    assert.equal(act(s, 'c', { kind: 'start' }), s); // a spectator can't start
    s = act(s, 'a', { kind: 'start' });
    assert.equal(s.phase, 'playing');
    assert.deepEqual(s.counts, [7, 7, 7]);
    assert.match(card(s.discard[0]).value, /\d/);
    const all = [...s.hands.flat() as number[], ...s.discard, ...s.drawPile!];
    assert.equal(new Set(all).size, DECK_SIZE);
  });
});

describe('Last Card play', () => {
  it('matches colour or symbol; wilds need a colour; only the player whose turn it is', () => {
    const s = table([[R5, Y7, G2, W], [Y5, B9]]);
    assert.ok(canPlay(s, R5) && canPlay(s, Y7) && canPlay(s, W));
    assert.ok(!canPlay(s, G2));
    assert.equal(act(s, 'b', { kind: 'play', card: Y5 }), s);
    assert.equal(act(s, 'a', { kind: 'play', card: G2 }), s);
    assert.equal(act(s, 'a', { kind: 'play', card: W }), s); // no colour picked
    const n = act(s, 'a', { kind: 'play', card: W, color: 'g' });
    assert.equal(n.color, 'g');
    assert.equal(n.turn, 1);
    assert.deepEqual(n.hands[0], [R5, Y7, G2]);
  });

  it('skip, reverse (a skip with two players), draw two', () => {
    const three = table([[RS, R5], [Y5, B9], [G2, Y7]]);
    assert.equal(act(three, 'a', { kind: 'play', card: RS }).turn, 2);
    const r3 = table([[RR, R5], [Y5, B9], [G2, Y7]]);
    const flipped = act(r3, 'a', { kind: 'play', card: RR });
    assert.equal(flipped.dir, -1);
    assert.equal(flipped.turn, 2);
    const two = table([[RR, R5], [Y5, B9]]);
    assert.equal(act(two, 'a', { kind: 'play', card: RR }).turn, 0); // goes again
    const d = act(three, 'a', { kind: 'play', card: R5 }); // just a normal card
    assert.equal(d.turn, 1);
    const plus = act(table([[RD, R5], [Y5, B9], [G2, Y7]]), 'a', { kind: 'play', card: RD });
    assert.equal(plus.counts[1], 4); // Ben took two
    assert.equal(plus.turn, 2); // and lost his turn
  });

  it('stacking: the next player can add a +2 or take them all', () => {
    const GD = 73; // green +2
    let s = table([[RD, R5], [GD, B9], [G2, Y7]], { rules: { stacking: true, drawToMatch: false } });
    s = act(s, 'a', { kind: 'play', card: RD });
    assert.equal(s.pendingDraw, 2);
    assert.equal(s.turn, 1);
    assert.equal(act(s, 'b', { kind: 'play', card: B9 }), s); // must stack or take
    const stacked = act(s, 'b', { kind: 'play', card: GD });
    assert.equal(stacked.pendingDraw, 4);
    const took = act(stacked, 'c', { kind: 'draw' });
    assert.equal(took.counts[2], 6);
    assert.equal(took.pendingDraw, 0);
    assert.equal(took.turn, 0);
  });

  it('draw: a playable card can be played (only that one) or kept with pass', () => {
    const s = table([[G2, B9], [Y5]], { drawPile: [R5, Y7] });
    const drew = act(s, 'a', { kind: 'draw' });
    assert.ok(drew.drewThisTurn);
    assert.equal(drew.turn, 0);
    assert.equal(act(drew, 'a', { kind: 'draw' }), drew); // only one draw
    const passed = act(drew, 'a', { kind: 'pass' });
    assert.equal(passed.turn, 1);
    const played = act(drew, 'a', { kind: 'play', card: R5 });
    assert.equal(played.turn, 1);
    // an unplayable draw ends the turn
    const miss = act(table([[G2], [Y5]], { drawPile: [B9] }), 'a', { kind: 'draw' });
    assert.equal(miss.turn, 1);
  });

  it('draw to match keeps drawing', () => {
    const s = table([[G2], [Y5]], { drawPile: [B9, Y5 + 1, R5], rules: { stacking: false, drawToMatch: true } });
    const n = act(s, 'a', { kind: 'draw' });
    assert.equal(n.counts[0], 4);
    assert.ok(n.drewThisTurn);
  });

  it('last card: forget to call and you can be caught; calling ahead protects you', () => {
    const s = table([[R5, G2], [Y5, B9, 60], [Y7, 77]]);
    const forgot = act(s, 'a', { kind: 'play', card: R5 });
    assert.equal(forgot.exposed, 0);
    const caught = act(forgot, 'c', { kind: 'catch', seat: 0 });
    assert.equal(caught.counts[0], 3);
    assert.equal(caught.exposed, null);
    const saved = act(forgot, 'a', { kind: 'call' });
    assert.equal(act(saved, 'c', { kind: 'catch', seat: 0 }), saved);
    const ahead = act(act(s, 'a', { kind: 'call' }), 'a', { kind: 'play', card: R5 });
    assert.equal(ahead.exposed, null);
    // the next move closes the chance
    const moved = act(forgot, 'b', { kind: 'play', card: Y5 });
    assert.equal(moved.exposed, null);
  });

  it('playing the last card wins and counts the win', () => {
    const s = table([[R5], [Y5, B9]]);
    const won = act(s, 'a', { kind: 'play', card: R5 });
    assert.equal(won.phase, 'over');
    assert.equal(won.winner, 0);
    assert.equal(won.players[0].wins, 1);
    const again = act(won, 'b', { kind: 'again' });
    assert.equal(again.phase, 'lobby');
    assert.equal(again.players[0].wins, 1);
  });

  it('reshuffles the discard pile when the draw pile runs out', () => {
    const s = table([[G2], [Y5]], { drawPile: [], discard: [B9, Y7, R7] });
    const n = act(s, 'a', { kind: 'draw' });
    assert.deepEqual(n.discard, [R7]);
    assert.equal(n.counts[0], 2);
  });
});

describe('Last Card computer and secrets', () => {
  it('the computer plays something legal, keeps wilds, and picks its main colour', () => {
    const s = table([[W, R5, Y7], [Y5]]);
    const pick = botChoice(s, 0);
    assert.ok(pick && pick.card !== W);
    const onlyWild = botChoice(table([[W, B9, B9 + 1, G2], [Y5]]), 0);
    assert.deepEqual(onlyWild, { card: W, color: 'b' });
  });

  it('auto moves come only from the authority, for the current seq', () => {
    const s = table([[G2], [Y5]], { drawPile: [B9] });
    assert.equal(act(s, 'a', { kind: 'auto', seq: s.seq }), s);
    assert.equal(act(s, 'h', { kind: 'auto', seq: s.seq - 1 }), s);
    assert.equal(act(s, 'h', { kind: 'auto', seq: s.seq }).turn, 1);
  });

  it('redact shows a player their own hand only, and no draw pile', () => {
    const s = table([[R5, G2], [Y5, B9]]);
    const forBen = redact(s, 'b');
    assert.deepEqual(forBen.hands, [null, [Y5, B9]]);
    assert.equal(forBen.drawPile, null);
    assert.deepEqual(forBen.counts, [2, 2]);
    assert.deepEqual(redact(s, 'zz').hands, [null, null]);
  });

  it('a new authority gets the hands back and deals the rest again', () => {
    const full = table([[R5, G2], [Y5, B9], [Y7, 77]], {
      players: [{ id: 'a', name: 'A', wins: 0 }, { id: 'b', name: 'B', wins: 0 }, { id: 'bot', name: 'C', bot: true, wins: 0 }]
    });
    // the new authority ('a') only has its own copy
    const mine = redact(full, 'a');
    assert.ok(missingSecrets(mine));
    const m = (by: string) => ({ selfId: 'a', present: ['a', 'b'], by });
    let s = reducer(mine, { kind: 'resync' }, m('a'));
    assert.ok(s.restoring);
    assert.equal(reducer(s, { kind: 'play', card: R5 }, m('a')), s); // nothing moves meanwhile
    assert.equal(reducer(s, { kind: 'restore', cards: [Y5] }, m('b')), s); // wrong count
    assert.equal(reducer(s, { kind: 'restore', cards: [R5, Y5] }, m('b')), s); // someone else's card
    s = reducer(s, { kind: 'restore', cards: [Y5, B9] }, m('b'));
    assert.ok(!s.restoring);
    assert.deepEqual(s.hands[1], [Y5, B9]);
    assert.equal(s.hands[2]!.length, 2); // the computer's hand dealt again
    const all = [...s.hands.flat() as number[], ...s.discard, ...s.drawPile!];
    assert.equal(new Set(all).size, DECK_SIZE);
  });
});
