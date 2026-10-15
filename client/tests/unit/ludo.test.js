import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reducer, INITIAL, DEFAULT_RULES, HOME, absSquare, isSafeSquare, botChoice, START } from '../../src/features/activities/ludo/rules.js';

// ---- helpers ---------------------------------------------------------------------------------
const realRandom = Math.random;
afterEach(() => { Math.random = realRandom; });
/** Next dice rolls (and other random picks) come out as `values` (1..6). */
function rolls(...values) {
    const queue = [...values];
    Math.random = () => ((queue.length ? queue.shift() : 1) - 1) / 6 + 0.01;
}
const PRESENT = ['h', 'a', 'b', 'c'];
const meta = (by, extra = {}) => ({ by, isHost: by === 'h', selfId: 'h', hostId: 'h', present: PRESENT, settings: {}, ...extra });
const act = (state, by, action, extra) => reducer(state, action, meta(by, extra));

/** A game in progress between host (red) and a (yellow), red to play, with tokens as given. */
function game({ red = [-1, -1, -1, -1], yellow = [-1, -1, -1, -1], rules = {}, turn = 'red', dice = null, rolled = false, movable = [], sixes = 0 } = {}) {
    return {
        ...INITIAL,
        phase: 'playing',
        rules: { ...DEFAULT_RULES, ...rules },
        seats: { red: { id: 'h', name: 'Host' }, green: null, yellow: { id: 'a', name: 'Asha' }, blue: null },
        tokens: { red: [...red], yellow: [...yellow] },
        turn, dice, rolled, movable, sixes, seq: 10
    };
}

describe('ludo: lobby', () => {
    it('people pick colours, can switch, and leave their seat', () => {
        let s = act(INITIAL, 'a', { kind: 'sit', color: 'green', name: 'Asha' });
        assert.equal(s.seats.green.id, 'a');
        s = act(s, 'b', { kind: 'sit', color: 'green', name: 'Bo' });
        assert.equal(s.seats.green.id, 'a', 'a taken seat stays taken');
        s = act(s, 'a', { kind: 'sit', color: 'blue', name: 'Asha' });
        assert.equal(s.seats.green, null);
        assert.equal(s.seats.blue.id, 'a');
        s = act(s, 'a', { kind: 'stand' });
        assert.equal(s.seats.blue, null);
    });

    it('only the host adds computers, sets rules and starts (2+ players)', () => {
        let s = act(INITIAL, 'h', { kind: 'sit', color: 'red', name: 'Host' });
        assert.equal(act(s, 'a', { kind: 'add-bot', color: 'green' }).seats.green, null);
        assert.equal(act(s, 'h', { kind: 'start' }).phase, 'lobby', 'one player is not enough');
        s = act(s, 'h', { kind: 'add-bot', color: 'green' });
        assert.equal(s.seats.green.bot, true);
        assert.equal(act(s, 'a', { kind: 'rules', rules: { safeStars: false } }).rules.safeStars, true);
        s = act(s, 'h', { kind: 'rules', rules: { safeStars: false, awayMode: 'skip', bogus: 1 } });
        assert.equal(s.rules.safeStars, false);
        assert.equal(s.rules.awayMode, 'skip');
        assert.equal(act(s, 'a', { kind: 'start' }).phase, 'lobby');
        rolls(1);
        s = act(s, 'h', { kind: 'start' });
        assert.equal(s.phase, 'playing');
        assert.deepEqual(s.tokens.red, [-1, -1, -1, -1]);
        assert.ok(['red', 'green'].includes(s.turn));
    });

    it('with the host away, players can run the lobby themselves', () => {
        const s = act(INITIAL, 'a', { kind: 'add-bot', color: 'green' }, { present: ['a', 'b'] });
        assert.equal(s.seats.green.bot, true);
    });

    it('default rules are the usual Indian ones; the computer plays for players who left', () => {
        assert.deepEqual(DEFAULT_RULES, { sixToLeave: true, threeSixes: true, safeStars: true, captureBonus: true, homeBonus: true, awayMode: 'bot' });
    });
});

describe('ludo: turns and dice', () => {
    it("only the player whose turn it is can roll; the dice come from the deciding app", () => {
        const s = game();
        assert.equal(act(s, 'a', { kind: 'roll' }), s);
        rolls(4);
        const after = act(s, 'h', { kind: 'roll' });
        assert.equal(after.dice, 4);
    });

    it('a six is needed to leave base; without one the turn passes', () => {
        rolls(3);
        const s = act(game(), 'h', { kind: 'roll' });
        assert.equal(s.event.kind, 'no-move');
        assert.equal(s.turn, 'yellow');
    });

    it('a six brings a token out (one choice: moves by itself) and gives another turn', () => {
        rolls(6);
        const s = act(game(), 'h', { kind: 'roll' });
        assert.equal(s.tokens.red.filter((p) => p === 0).length, 1);
        assert.equal(s.turn, 'red');
        assert.equal(s.rolled, false);
        assert.equal(s.sixes, 1);
    });

    it('with "six to leave" off, a 1 brings a token out too', () => {
        rolls(1);
        const s = act(game({ rules: { sixToLeave: false } }), 'h', { kind: 'roll' });
        assert.equal(s.tokens.red.filter((p) => p === 0).length, 1);
        assert.equal(s.turn, 'yellow', 'a 1 gives no extra turn');
    });

    it('with two choices the player picks; others and illegal tokens are refused', () => {
        rolls(3);
        let s = act(game({ red: [5, 10, -1, -1] }), 'h', { kind: 'roll' });
        assert.equal(s.rolled, true);
        assert.deepEqual(s.movable, [0, 1]);
        assert.equal(act(s, 'a', { kind: 'move', token: 0 }), s);
        assert.equal(act(s, 'h', { kind: 'move', token: 2 }), s);
        s = act(s, 'h', { kind: 'move', token: 1 });
        assert.equal(s.tokens.red[1], 13);
        assert.equal(s.turn, 'yellow');
    });

    it('three sixes in a row lose the turn (rule on), keep it (rule off)', () => {
        rolls(6);
        let s = act(game({ red: [5, -1, -1, -1], sixes: 2 }), 'h', { kind: 'roll' });
        assert.equal(s.event.kind, 'three-sixes');
        assert.equal(s.turn, 'yellow');
        assert.equal(s.tokens.red[0], 5);
        rolls(6);
        s = act(game({ red: [5, -1, -1, -1], sixes: 2, rules: { threeSixes: false } }), 'h', { kind: 'roll' });
        assert.notEqual(s.event.kind, 'three-sixes');
    });
});

describe('ludo: captures, safe squares, home', () => {
    // red progress p is on the absolute square p; yellow progress q is on (26 + q) % 52
    it('landing on an opponent sends it home and gives another turn', () => {
        const target = 20; // abs 20, not safe
        assert.equal(isSafeSquare(target, DEFAULT_RULES), false);
        rolls(4);
        let s = act(game({ red: [16, -1, -1, -1], yellow: [target - 26 + 52, -1, -1, -1] }), 'h', { kind: 'roll' });
        assert.equal(s.event.kind, 'capture');
        assert.equal(s.tokens.yellow[0], -1);
        assert.equal(s.turn, 'red');
        rolls(4);
        s = act(game({ red: [16, -1, -1, -1], yellow: [46, -1, -1, -1], rules: { captureBonus: false } }), 'h', { kind: 'roll' });
        assert.equal(s.tokens.yellow[0], -1);
        assert.equal(s.turn, 'yellow', 'no bonus with the rule off');
    });

    it('star squares are safe (rule on), start squares always', () => {
        const star = (START.red + 8) % 52; // abs 8
        const yellowOnStar = (star - 26 + 52) % 52;
        rolls(3);
        let s = act(game({ red: [5, -1, -1, -1], yellow: [yellowOnStar, -1, -1, -1] }), 'h', { kind: 'roll' });
        assert.equal(s.tokens.yellow[0], yellowOnStar, 'safe on a star');
        rolls(3);
        s = act(game({ red: [5, -1, -1, -1], yellow: [yellowOnStar, -1, -1, -1], rules: { safeStars: false } }), 'h', { kind: 'roll' });
        assert.equal(s.tokens.yellow[0], -1, 'stars off: captured');
        // yellow sitting on green's start square (abs 13) is safe from red
        rolls(3);
        s = act(game({ red: [10, -1, -1, -1], yellow: [(13 - 26 + 52) % 52, -1, -1, -1], rules: { safeStars: false } }), 'h', { kind: 'roll' });
        assert.equal(s.tokens.yellow[0], 39);
    });

    it('tokens in the home column are never captured, and home needs the exact roll', () => {
        rolls(3);
        let s = act(game({ red: [54, -1, -1, -1] }), 'h', { kind: 'roll' });
        assert.equal(s.event.kind, 'no-move');
        assert.equal(s.tokens.red[0], 54);
        rolls(2);
        s = act(game({ red: [54, -1, -1, -1] }), 'h', { kind: 'roll' });
        assert.equal(s.tokens.red[0], HOME);
        assert.equal(s.turn, 'red', 'extra turn for reaching home');
    });

    it('the first to bring all four home wins; with two players the game ends', () => {
        rolls(1);
        const s = act(game({ red: [HOME, HOME, HOME, 55], yellow: [3, -1, -1, -1] }), 'h', { kind: 'roll' });
        assert.equal(s.phase, 'over');
        assert.deepEqual(s.finished, ['red', 'yellow']);
    });

    it('track squares line up with each colour start', () => {
        assert.equal(absSquare('green', 0), 13);
        assert.equal(absSquare('blue', 13), 0);
    });
});

describe('ludo: computers, people who leave, play again', () => {
    it('"auto" is only taken from the deciding app, for the current state', () => {
        const s = { ...game(), seats: { ...game().seats, red: { id: 'bot-red', name: 'Computer', bot: true } } };
        assert.equal(reducer(s, { kind: 'auto', mode: 'bot', seq: s.seq }, meta('a')), s, 'from someone else');
        assert.equal(reducer(s, { kind: 'auto', mode: 'bot', seq: 3 }, meta('h')), s, 'stale');
        rolls(6);
        const after = reducer(s, { kind: 'auto', mode: 'bot', seq: s.seq }, meta('h'));
        assert.equal(after.tokens.red.filter((p) => p === 0).length, 1);
        assert.equal(reducer(s, { kind: 'roll' }, meta('bot-red')), s, "nobody can roll for a computer");
    });

    it('skip mode passes the turn of someone who left', () => {
        const s = game({ turn: 'yellow' });
        const after = reducer(s, { kind: 'auto', mode: 'skip', seq: s.seq }, meta('h'));
        assert.equal(after.turn, 'red');
        assert.equal(after.event.kind, 'skipped');
    });

    it('the computer prefers a capture', () => {
        const s = game({ red: [2, 16, -1, -1], yellow: [46, -1, -1, -1], dice: 4, rolled: true, movable: [0, 1] });
        assert.equal(botChoice(s), 1); // 16 + 4 = 20 lands on yellow
    });

    it('a seat whose player left can be taken during the game, not one whose player is here', () => {
        const s = game();
        assert.equal(act(s, 'b', { kind: 'sit', color: 'yellow', name: 'Bo' }).seats.yellow.id, 'a');
        const away = act(s, 'b', { kind: 'sit', color: 'yellow', name: 'Bo' }, { present: ['h', 'b'] });
        assert.equal(away.seats.yellow.id, 'b');
        assert.deepEqual(away.tokens.yellow, s.tokens.yellow, 'the tokens stay as they were');
    });

    it('play again goes back to the lobby with the same seats and rules', () => {
        const over = { ...game({ rules: { safeStars: false } }), phase: 'over', finished: ['red', 'yellow'] };
        assert.equal(act(over, 'a', { kind: 'again' }), over);
        const s = act(over, 'h', { kind: 'again' });
        assert.equal(s.phase, 'lobby');
        assert.equal(s.seats.yellow.id, 'a');
        assert.equal(s.rules.safeStars, false);
        assert.equal(s.tokens, null);
    });
});

// ---- drawing tokens that share a square ----
import { placeTokens } from '../../src/features/activities/ludo/board.js';

const base = { red: [-1, -1, -1, -1], green: [-1, -1, -1, -1], yellow: [-1, -1, -1, -1], blue: [-1, -1, -1, -1] };
const at = (list, color, i) => list.find((t) => t.color === color && t.i === i);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

it('tokens on the same square are spread out so each stays visible', () => {
    // red 0 and 1 on red's start square, green 0 there too (13 squares behind green's start)
    const shown = { ...base, red: [0, 0, -1, -1], green: [39, -1, -1, -1] };
    const placed = placeTokens(shown);
    const a = at(placed, 'red', 0); const b = at(placed, 'red', 1); const c = at(placed, 'green', 0);
    for (const [x, y] of [[a, b], [a, c], [b, c]]) {
        assert.ok(dist(x, y) >= Math.min(x.r, y.r) * 1.4, `centres ${dist(x, y).toFixed(2)} apart, radius ${x.r}`);
    }
    assert.ok(a.r < 0.36, 'smaller than a token alone');
});

it('the tokens you can move are drawn last (on top)', () => {
    const shown = { ...base, red: [0, 0, -1, -1], green: [39, -1, -1, -1] };
    const placed = placeTokens(shown, new Set(['red0', 'red1']));
    const last = placed.slice(-2).map((t) => `${t.color}${t.i}`).sort();
    assert.deepEqual(last, ['red0', 'red1']);
    // nothing movable: every token still drawn once
    assert.equal(placeTokens(shown).length, 16);
});

it('a token alone keeps its full size and place', () => {
    const placed = placeTokens({ ...base, red: [5, -1, -1, -1] });
    const t = at(placed, 'red', 0);
    assert.equal(t.r, 0.36);
});

describe('ludo: coming back after a reload or rejoin', () => {
    const cids = { h: 'app-h', h2: 'app-h', a: 'app-a', x: 'app-x' };
    const m = (by, present) => ({ clientOf: (id) => cids[id] || null, present });
    it('your seat is yours again (lobby): same app, new connection', () => {
        let s = act(INITIAL, 'h', { kind: 'sit', color: 'red', name: 'Host' }, m('h', ['h', 'a']));
        s = act(s, 'a', { kind: 'sit', color: 'blue', name: 'Asha' }, m('a', ['h', 'a']));
        assert.equal(s.seats.red.cid, 'app-h');
        // The host reloads: new peer id h2; someone else can't take the red seat in the lobby
        assert.equal(act(s, 'x', { kind: 'sit', color: 'red', name: 'X' }, m('x', ['h2', 'a', 'x'])), s);
        const back = act(s, 'h2', { kind: 'sit', color: 'red', name: 'Host' }, { ...m('h2', ['h2', 'a']), isHost: true });
        assert.deepEqual(back.seats.red, { id: 'h2', name: 'Host', cid: 'app-h' });
        assert.equal(back.seats.blue.id, 'a', 'the others keep their colours');
    });
    it('during a game too, with the tokens as they were', () => {
        const s = { ...game({ red: [5, -1, -1, -1] }), seats: { red: { id: 'h', name: 'Host', cid: 'app-h' }, green: null, yellow: { id: 'a', name: 'Asha', cid: 'app-a' }, blue: null } };
        const back = act(s, 'h2', { kind: 'sit', color: 'red', name: 'Host' }, m('h2', ['h2', 'a']));
        assert.equal(back.seats.red.id, 'h2');
        assert.deepEqual(back.tokens.red, [5, -1, -1, -1]);
        assert.equal(back.turn, 'red');
        // while the old connection is still there, nobody takes it
        assert.equal(act(s, 'h2', { kind: 'sit', color: 'red', name: 'Host' }, m('h2', ['h', 'h2', 'a'])), s);
    });
});
