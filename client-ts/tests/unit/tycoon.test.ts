import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL, netWorth, reducer, rentOf, type TyAction, type TyMeta, type TyState } from '../../src/features/activities/tycoon/rules';
import { JAIL, SPACES, START_CASH, START_PAY } from '../../src/features/activities/tycoon/board';

const realRandom = Math.random;
afterEach(() => {
  Math.random = realRandom;
});
/** Next dice: each value 1–6 (other random calls get 0.5) */
function dice(...values: number[]) {
  const queue = [...values];
  Math.random = () => (queue.length ? (queue.shift()! - 1) / 6 + 0.01 : 0.5);
}

const PRESENT = ['h', 'a', 'b'];
const meta = (by: string, extra: Partial<TyMeta> = {}): TyMeta => ({ by, isHost: by === 'h', selfId: 'h', hostId: 'h', present: PRESENT, clientOf: (id) => `cid-${id}`, ...extra });
const act = (s: TyState, by: string, a: TyAction, extra: Partial<TyMeta> = {}) => reducer(s, a, meta(by, extra));

function game(): TyState {
  let s = act(INITIAL, 'a', { kind: 'join', name: 'Asha' });
  s = act(s, 'b', { kind: 'join', name: 'Ben' });
  Math.random = () => 0.01; // Asha goes first
  s = act(s, 'a', { kind: 'start' });
  Math.random = realRandom;
  return s;
}
const withPlayers = (s: TyState, patch: Partial<TyState['players'][number]>[]): TyState => ({
  ...s,
  players: s.players.map((p, i) => ({ ...p, ...(patch[i] || {}) }))
});

describe('Tycoon setup', () => {
  it('two players, starting cash, distinct tokens and colours, 40 spaces', () => {
    const s = game();
    assert.equal(SPACES.length, 40);
    assert.equal(s.phase, 'playing');
    assert.equal(s.turn, 0);
    assert.deepEqual(s.players.map((p) => p.cash), [START_CASH, START_CASH]);
    assert.notEqual(s.players[0].token, s.players[1].token);
    assert.notEqual(s.players[0].color, s.players[1].color);
  });
});

describe('Tycoon turns', () => {
  it('roll, land on a place, buy it; only the player whose turn it is', () => {
    let s = game();
    dice(1, 2);
    assert.equal(act(s, 'b', { kind: 'roll' }), s);
    s = act(s, 'a', { kind: 'roll' });
    assert.equal(s.players[0].pos, 3); // Laad Bazaar
    assert.equal(s.step, 'buy');
    s = act(s, 'a', { kind: 'buy' });
    assert.equal(s.owner[3], 0);
    assert.equal(s.players[0].cash, START_CASH - 600);
    assert.equal(s.step, 'done');
    s = act(s, 'a', { kind: 'end-turn' });
    assert.equal(s.turn, 1);
  });

  it('rent: base, doubled for a full group, then with houses', () => {
    const s0 = game();
    const owner = [...s0.owner];
    owner[1] = 0;
    owner[3] = 0;
    let s = { ...s0, owner };
    assert.equal(rentOf(s, 3, 7), 80); // full group, no houses: double 40
    s = { ...s, houses: s.houses.map((h, i) => (i === 3 ? 2 : h)) };
    assert.equal(rentOf(s, 3, 7), 600);
    // Ben lands and pays
    s = { ...s, turn: 1, step: 'roll' };
    dice(1, 2);
    s = act(s, 'b', { kind: 'roll' });
    assert.equal(s.players[1].cash, START_CASH - 600);
    assert.equal(s.players[0].cash, START_CASH + 600);
  });

  it('doubles roll again; three doubles go to jail', () => {
    let s = game();
    dice(2, 2);
    s = act(s, 'a', { kind: 'roll' }); // to 4: Income Tax
    assert.equal(s.step, 'roll');
    dice(3, 3);
    s = act(s, 'a', { kind: 'roll' }); // to 10: just visiting
    dice(1, 1);
    s = act(s, 'a', { kind: 'roll' });
    assert.equal(s.players[0].pos, JAIL);
    assert.equal(s.players[0].jail, 1);
    assert.equal(s.step, 'done');
  });

  it('jail: pay the fine, or doubles get you out, third miss pays and moves', () => {
    let s = withPlayers(game(), [{ pos: JAIL, jail: 1 }]);
    assert.equal(act(s, 'a', { kind: 'pay-jail' }).players[0].jail, 0);
    dice(1, 2);
    s = act(s, 'a', { kind: 'roll' });
    assert.equal(s.players[0].pos, JAIL);
    assert.equal(s.players[0].jail, 2);
    s = { ...s, step: 'roll', turn: 0 };
    s = withPlayers(s, [{ jail: 3 }]);
    dice(1, 2);
    s = act(s, 'a', { kind: 'roll' });
    assert.equal(s.players[0].jail, 0);
    assert.equal(s.players[0].pos, 13);
  });

  it('passing Start pays', () => {
    let s = withPlayers(game(), [{ pos: 38 }]);
    dice(1, 2);
    s = act(s, 'a', { kind: 'roll' });
    assert.equal(s.players[0].pos, 1);
    assert.equal(s.players[0].cash, START_CASH + START_PAY);
  });

  it('builds evenly on a full group only, sells back at half', () => {
    const s0 = game();
    const owner = [...s0.owner];
    owner[1] = 0;
    let s = { ...s0, owner };
    assert.equal(act(s, 'a', { kind: 'build', pos: 1 }), s); // not the whole group
    owner[3] = 0;
    s = { ...s, owner: [...owner] };
    s = act(s, 'a', { kind: 'build', pos: 1 });
    assert.equal(s.houses[1], 1);
    assert.equal(act(s, 'a', { kind: 'build', pos: 1 }), s); // build the other one first
    s = act(s, 'a', { kind: 'build', pos: 3 });
    s = act(s, 'a', { kind: 'build', pos: 1 });
    assert.deepEqual([s.houses[1], s.houses[3]], [2, 1]);
    const cash = s.players[0].cash;
    s = act(s, 'a', { kind: 'sell', pos: 1 });
    assert.equal(s.players[0].cash, cash + 250);
    assert.equal(act(s, 'a', { kind: 'mortgage', pos: 1 }), s); // houses in the group
  });

  it('debt: raise money, or go bankrupt and hand everything to the creditor', () => {
    const s0 = game();
    const owner = [...s0.owner];
    owner[39] = 1;
    owner[37] = 1;
    owner[6] = 0;
    let s: TyState = { ...s0, owner, houses: s0.houses.map((h, i) => (i === 39 ? 5 : i === 37 ? 5 : h)) };
    s = withPlayers(s, [{ pos: 36, cash: 1000 }]);
    dice(1, 2);
    s = act(s, 'a', { kind: 'roll' }); // Marine Drive with a hotel: 20,000
    assert.equal(s.step, 'debt');
    assert.equal(act(s, 'a', { kind: 'end-turn' }), s);
    s = act(s, 'a', { kind: 'mortgage', pos: 6 });
    assert.equal(s.players[0].cash, 1500);
    s = act(s, 'a', { kind: 'bankrupt' });
    assert.equal(s.phase, 'over');
    assert.equal(s.winner, 1);
    assert.equal(s.owner[6], 1);
    assert.equal(s.mortgaged[6], true);
  });

  it('trades: offer, accept; can’t trade places with buildings', () => {
    const s0 = game();
    const owner = [...s0.owner];
    owner[5] = 0;
    owner[12] = 1;
    let s = { ...s0, owner };
    s = act(s, 'a', { kind: 'trade', to: 1, giveProps: [5], getProps: [12], getCash: 500 });
    assert.ok(s.trade);
    assert.equal(act(s, 'a', { kind: 'trade-answer', accept: true }), s); // not Asha's to answer
    s = act(s, 'b', { kind: 'trade-answer', accept: true });
    assert.equal(s.owner[5], 1);
    assert.equal(s.owner[12], 0);
    assert.equal(s.players[0].cash, START_CASH + 500);
    const built = { ...s, owner: s.owner.map((o, i) => (i === 1 || i === 3 ? 0 : o)), houses: s.houses.map((h, i) => (i === 1 ? 1 : h)) };
    assert.equal(act(built, 'a', { kind: 'trade', to: 1, giveProps: [3], getCash: 100 }), built);
  });

  it('cards: Surprise/Treasure apply their effect', () => {
    let s = withPlayers(game(), [{ pos: 0 }]);
    s = { ...s, decks: { ...s.decks, t: [1, ...s.decks.t.filter((x) => x !== 1)] } }; // bank error +2000
    dice(1, 1);
    s = act(s, 'a', { kind: 'roll' }); // to 2: Treasure
    assert.equal(s.players[0].cash, START_CASH + 2000);
    assert.equal(s.card?.deck, 't');
  });

  it('ending early: richest wins', () => {
    const s0 = game();
    const s = act({ ...s0, owner: s0.owner.map((o, i) => (i === 39 ? 1 : o)) }, 'h', { kind: 'end-game' });
    assert.equal(s.winner, 1);
    assert.ok(netWorth(s, 1) > netWorth(s, 0));
  });
});

describe('Tycoon computer', () => {
  it('plays whole games against itself without getting stuck', () => {
    let s = act(INITIAL, 'h', { kind: 'add-bot' });
    s = act(s, 'h', { kind: 'add-bot' });
    s = act(s, 'h', { kind: 'add-bot' });
    s = act(s, 'h', { kind: 'start' });
    let moves = 0;
    while (s.phase === 'playing' && moves < 6000) {
      const next = act(s, 'h', { kind: 'auto', seq: s.seq, mode: 'turn' });
      assert.notEqual(next, s, `stuck at step ${s.step}`);
      s = next;
      moves++;
      // money never goes negative
      for (const p of s.players) assert.ok(p.cash >= 0, `${p.name} has ${p.cash}`);
    }
    // somebody built something along the way, or the game finished
    assert.ok(s.phase === 'over' || s.houses.some((h) => h > 0) || moves === 6000);
  });
});

describe('Tycoon round limit', () => {
  it('ends after the chosen number of rounds; the richest wins', () => {
    let s = act(INITIAL, 'h', { kind: 'add-bot' });
    s = act(s, 'h', { kind: 'add-bot' });
    s = act(s, 'h', { kind: 'rules', rules: { rounds: 15 } });
    s = act(s, 'h', { kind: 'start' });
    let guard = 0;
    while (s.phase === 'playing' && guard++ < 5000) s = act(s, 'h', { kind: 'auto', seq: s.seq });
    assert.equal(s.phase, 'over');
    assert.ok(s.round >= 15 || s.players.filter((p) => !p.bankrupt).length === 1);
  });
});
