import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  reducer,
  INITIAL,
  DEFAULT_RULES,
  HOME,
  absSquare,
  isSafeSquare,
  botChoice,
  START,
  type LudoState,
  type LudoAction,
  type LudoMeta,
  type LudoColor
} from '../../src/features/activities/ludo/rules';

const realRandom = Math.random;
afterEach(() => {
  Math.random = realRandom;
});

function rolls(...values: number[]) {
  const queue = [...values];
  Math.random = () => ((queue.length ? queue.shift()! : 1) - 1) / 6 + 0.01;
}

const PRESENT = ['h', 'a', 'b', 'c'];
const meta = (by: string, extra = {}): LudoMeta => ({
  by,
  isHost: by === 'h',
  selfId: 'h',
  hostId: 'h',
  present: PRESENT,
  settings: {},
  ...extra
});

const act = (state: LudoState, by: string, action: LudoAction, extra = {}): LudoState =>
  reducer(state, action, meta(by, extra));

function game({
  red = [-1, -1, -1, -1],
  yellow = [-1, -1, -1, -1],
  rules = {},
  turn = 'red' as LudoColor,
  dice = null as number | null,
  rolled = false,
  movable = [] as number[],
  sixes = 0
} = {}): LudoState {
  return {
    ...INITIAL,
    phase: 'playing',
    rules: { ...DEFAULT_RULES, ...rules },
    seats: {
      red: { id: 'h', name: 'Host' },
      green: null,
      yellow: { id: 'a', name: 'Asha' },
      blue: null
    },
    tokens: { red: [...red], yellow: [...yellow], green: [-1, -1, -1, -1], blue: [-1, -1, -1, -1] },
    turn,
    dice,
    rolled,
    movable,
    sixes,
    seq: 10
  };
}

describe('ludo: lobby', () => {
  it('people pick colours, can switch, and leave their seat', () => {
    let s = act(INITIAL, 'a', { kind: 'sit', color: 'green', name: 'Asha' });
    assert.equal(s.seats.green?.id, 'a');
    s = act(s, 'b', { kind: 'sit', color: 'green', name: 'Bo' });
    assert.equal(s.seats.green?.id, 'a', 'a taken seat stays taken');
    s = act(s, 'a', { kind: 'sit', color: 'blue', name: 'Asha' });
    assert.equal(s.seats.green, null);
    assert.equal(s.seats.blue?.id, 'a');
    s = act(s, 'a', { kind: 'stand' });
    assert.equal(s.seats.blue, null);
  });

  it('only the host adds computers, sets rules and starts (2+ players)', () => {
    let s = act(INITIAL, 'h', { kind: 'sit', color: 'red', name: 'Host' });
    assert.equal(act(s, 'a', { kind: 'add-bot', color: 'green' }).seats.green, null);
    assert.equal(act(s, 'h', { kind: 'start' }).phase, 'lobby', 'one player is not enough');
    s = act(s, 'h', { kind: 'add-bot', color: 'green' });
    assert.equal(s.seats.green?.bot, true);
    assert.equal(act(s, 'a', { kind: 'rules', rules: { safeStars: false } }).rules.safeStars, true);
    s = act(s, 'h', { kind: 'rules', rules: { safeStars: false, awayMode: 'skip' } });
    assert.equal(s.rules.safeStars, false);
    assert.equal(s.rules.awayMode, 'skip');
    assert.equal(act(s, 'a', { kind: 'start' }).phase, 'lobby');
    rolls(1);
    s = act(s, 'h', { kind: 'start' });
    assert.equal(s.phase, 'playing');
    assert.deepEqual(s.tokens.red, [-1, -1, -1, -1]);
    assert.ok(s.turn === 'red' || s.turn === 'green');
  });
});

describe('ludo: moving', () => {
  it('absSquare maps color relative tracks to board tracks', () => {
    assert.equal(absSquare('green', 0), 13);
    assert.equal(absSquare('blue', 13), 0);
  });

  it('isSafeSquare identifies start and star positions', () => {
    assert.equal(isSafeSquare(START.red, DEFAULT_RULES), true);
    assert.equal(isSafeSquare(20, DEFAULT_RULES), false);
  });

  it('botChoice picks sensible moves', () => {
    const s = game({ red: [0, -1, -1, -1], turn: 'red', dice: 6, rolled: true, movable: [0, 1] });
    const choice = botChoice(s);
    assert.ok(choice === 0 || choice === 1);
  });
});
