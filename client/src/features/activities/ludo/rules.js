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

export const COLORS = ['red', 'green', 'yellow', 'blue']; // turn order (clockwise)
export const COLOR_NAMES = { red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue' };
export const START = { red: 0, green: 13, yellow: 26, blue: 39 };
export const TRACK_LENGTH = 52;
export const LAST_TRACK = 50;   // last square before the home column
export const HOME = 56;
const STAR_OFFSET = 8;          // star (safe) square: 8 after each start square

export const DEFAULT_RULES = {
    sixToLeave: true,     // off: a 1 or a 6 brings a token out
    threeSixes: true,     // three sixes in a row: the turn is lost
    safeStars: true,      // star squares are safe (start squares always are)
    captureBonus: true,   // capturing gives another turn
    homeBonus: true,      // reaching home gives another turn
    awayMode: 'bot'       // a player who left: 'bot' (computer plays for them) or 'skip'
};

const RULE_KEYS = ['sixToLeave', 'threeSixes', 'safeStars', 'captureBonus', 'homeBonus'];

export const INITIAL = {
    phase: 'lobby',          // 'lobby' | 'playing' | 'over'
    rules: DEFAULT_RULES,
    seats: { red: null, green: null, yellow: null, blue: null }, // { id, name, bot? }
    tokens: null,            // { red: [p, p, p, p], ... } while playing
    turn: null,              // colour whose turn it is
    dice: null,              // last roll
    rolled: false,           // turn's player has rolled and must pick a token
    movable: [],             // tokens that may move with `dice`
    sixes: 0,                // sixes in a row this turn
    finished: [],            // colours in the order they finished
    event: null,             // what just happened (for animation and the status line)
    seq: 0,                  // bumps on every change; animation key
    turnSince: 0             // authority clock: when this turn started (timeouts)
};

export const absSquare = (color, progress) => (START[color] + progress) % TRACK_LENGTH;

export function isSafeSquare(abs, rules) {
    for (const color of COLORS) {
        if (abs === START[color]) return true;
        if (rules.safeStars && abs === (START[color] + STAR_OFFSET) % TRACK_LENGTH) return true;
    }
    return false;
}

export const seatedColors = (state) => COLORS.filter((c) => state.seats[c]);

/** Where a token would end up with roll `value`, or null if it can't move. */
export function targetOf(progress, value, rules) {
    if (progress === -1) {
        const canLeave = value === 6 || (!rules.sixToLeave && value === 1);
        return canLeave ? 0 : null;
    }
    if (progress >= HOME) return null;
    const next = progress + value;
    return next <= HOME ? next : null; // exact roll to reach home
}

export function movableTokens(state, color, value) {
    return state.tokens[color].map((p, i) => (targetOf(p, value, state.rules) === null ? -1 : i)).filter((i) => i >= 0);
}

const roll = () => 1 + Math.floor(Math.random() * 6);
const allHome = (tokens) => tokens.every((p) => p === HOME);

function nextColor(state, after) {
    const playing = seatedColors(state).filter((c) => !state.finished.includes(c));
    if (playing.length === 0) return null;
    const order = COLORS.filter((c) => playing.includes(c) || c === after);
    const i = order.indexOf(after);
    for (let k = 1; k <= order.length; k++) {
        const c = order[(i + k) % order.length];
        if (playing.includes(c)) return c;
    }
    return null;
}

const bump = (state, patch) => ({ ...state, ...patch, seq: state.seq + 1 });

function passTurn(state, patch = {}) {
    const turn = nextColor(state, state.turn);
    return bump(state, { rolled: false, movable: [], sixes: 0, turn, turnSince: Date.now(), ...patch });
}

/** Apply moving token `index` of the current colour by `state.dice`. */
function applyMove(state, index) {
    const color = state.turn;
    const value = state.dice;
    const from = state.tokens[color][index];
    const to = targetOf(from, value, state.rules);
    if (to === null) return state;

    const tokens = Object.fromEntries(Object.entries(state.tokens).map(([c, list]) => [c, [...list]]));
    tokens[color][index] = to;

    // Capture: opponents on the square we land on go back to base (not on safe squares)
    const captured = [];
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
    const event = { kind: captured.length ? 'capture' : reachedHome ? 'home' : 'move', color, token: index, from, to, value, captured };

    // Everyone but one is done: game over (the last one takes last place)
    const stillPlaying = seatedColors(state).filter((c) => !finished.includes(c));
    if (stillPlaying.length <= 1) {
        return bump(state, { tokens, finished: [...finished, ...stillPlaying], phase: 'over', turn: null, rolled: false, movable: [], event });
    }

    const bonus = !finished.includes(color) && (
        value === 6 ||
        (captured.length > 0 && state.rules.captureBonus) ||
        (reachedHome && state.rules.homeBonus)
    );
    const next = { ...state, tokens, finished, event };
    if (bonus) {
        return bump(next, { rolled: false, movable: [], sixes: value === 6 ? state.sixes : 0, turnSince: Date.now() });
    }
    return passTurn(next);
}

function doRoll(state) {
    const color = state.turn;
    const value = roll();
    const sixes = value === 6 ? state.sixes + 1 : 0;
    if (state.rules.threeSixes && sixes >= 3) {
        return passTurn(state, { dice: value, event: { kind: 'three-sixes', color, value } });
    }
    const withRoll = { ...state, dice: value, sixes };
    const movable = movableTokens(withRoll, color, value);
    if (movable.length === 0) {
        return passTurn(withRoll, { event: { kind: 'no-move', color, value } });
    }
    // Only one choice (or all choices end the same): move it straight away
    const targets = new Set(movable.map((i) => `${state.tokens[color][i]}`));
    if (movable.length === 1 || targets.size === 1) {
        return applyMove({ ...withRoll, rolled: true, movable }, movable[0]);
    }
    return bump(withRoll, { rolled: true, movable, event: { kind: 'roll', color, value } });
}

/** The computer's pick: capture > reach home > leave base > safe square > furthest-back token. */
export function botChoice(state) {
    const color = state.turn;
    const value = state.dice;
    let best = state.movable[0];
    let bestScore = -Infinity;
    for (const i of state.movable) {
        const from = state.tokens[color][i];
        const to = targetOf(from, value, state.rules);
        let score = 0;
        if (to === HOME) score += 80;
        if (from === -1) score += 50;
        if (to <= LAST_TRACK) {
            const abs = absSquare(color, to);
            const hits = COLORS.some((c) => c !== color && state.tokens[c]?.some((p) => p >= 0 && p <= LAST_TRACK && absSquare(c, p) === abs));
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

const canManage = (meta) => meta.isHost || !meta.hostId || !meta.present?.includes(meta.hostId);
const seatOf = (state, peerId) => COLORS.find((c) => state.seats[c] && !state.seats[c].bot && state.seats[c].id === peerId) || null;
const cleanName = (name, fallback) => String(name || '').trim().slice(0, 24) || fallback;

export function reducer(state, action, meta) {
    switch (action.kind) {
        // ---- lobby -----------------------------------------------------------------------
        case 'sit': {
            const color = action.color;
            if (!COLORS.includes(color)) return state;
            const current = state.seats[color];
            // A free seat, or (during a game) the seat of someone who left: take it over / come back
            const takeOver = current && !current.bot && !meta.present?.includes(current.id) && state.phase === 'playing';
            if (current && !takeOver) return state;
            if (state.phase === 'playing' && !takeOver) return state;
            const seats = { ...state.seats };
            const mine = seatOf(state, meta.by);
            if (mine && state.phase === 'lobby') seats[mine] = null; // switching colour
            if (mine && state.phase === 'playing') return state;    // already playing another colour
            seats[color] = { id: meta.by, name: cleanName(action.name, COLOR_NAMES[color]) };
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
            const value = action.kind === 'add-bot' ? { id: `bot-${action.color}`, name: 'Computer', bot: true } : null;
            return bump(state, { seats: { ...state.seats, [action.color]: value } });
        }
        case 'rules': {
            if (state.phase !== 'lobby' || !canManage(meta)) return state;
            const rules = { ...state.rules };
            for (const key of RULE_KEYS) if (typeof action.rules?.[key] === 'boolean') rules[key] = action.rules[key];
            if (action.rules?.awayMode === 'bot' || action.rules?.awayMode === 'skip') rules.awayMode = action.rules.awayMode;
            return bump(state, { rules });
        }
        case 'start': {
            if (state.phase !== 'lobby' || !canManage(meta)) return state;
            const colors = seatedColors(state);
            if (colors.length < 2) return state;
            const tokens = Object.fromEntries(colors.map((c) => [c, [-1, -1, -1, -1]]));
            const turn = colors[Math.floor(Math.random() * colors.length)];
            return bump(state, {
                phase: 'playing', tokens, turn, dice: null, rolled: false, movable: [], sixes: 0, finished: [],
                event: { kind: 'start', color: turn }, turnSince: Date.now()
            });
        }
        case 'again': {
            if (state.phase === 'lobby' || !canManage(meta)) return state;
            return bump(state, { ...INITIAL, rules: state.rules, seats: state.seats, seq: state.seq });
        }

        // ---- playing ---------------------------------------------------------------------
        case 'roll': {
            if (state.phase !== 'playing' || state.rolled) return state;
            const seat = state.seats[state.turn];
            if (!seat || seat.bot || seat.id !== meta.by) return state;
            return doRoll(state);
        }
        case 'move': {
            if (state.phase !== 'playing' || !state.rolled) return state;
            const seat = state.seats[state.turn];
            if (!seat || seat.bot || seat.id !== meta.by || !state.movable.includes(action.token)) return state;
            return applyMove(state, action.token);
        }
        // The authority's app plays for computers, people who left (awayMode) and idle players
        case 'auto': {
            if (state.phase !== 'playing' || meta.by !== meta.selfId || action.seq !== state.seq) return state;
            if (action.mode === 'skip') return passTurn(state, { event: { kind: 'skipped', color: state.turn } });
            if (!state.rolled) return doRoll(state);
            return applyMove(state, botChoice(state));
        }
        default:
            return state;
    }
}
