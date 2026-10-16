/**
 * Ludo for 2–4 players; everyone else in the room watches. Rules and dice: ./rules.js (runs on
 * the authority). This file draws the board and the panel, animates moves, and, on the
 * authority's app only, plays for computers, people who left and players who went idle.
 */
import { getClientId } from '../../../utils/clientId';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoom, useSharedState } from '../../../core/RoomContext';
import { useActivityStatus } from '../activityHost';
import { sound } from '../../../utils/sound';
import { COLORS, COLOR_NAMES, INITIAL, HOME, reducer, seatedColors } from './rules';
import { TRACK, BASE_ORIGIN, center, coloredSquares, tokenPoint, pathOf, placeTokens } from './board';
import './ludo.css';

const BOT_DELAY_MS = 900;      // a computer's roll / move
const AWAY_DELAY_MS = 4000;    // someone who left: play or skip for them after this
const IDLE_DELAY_MS = 30000;   // a player who doesn't act: their turn is played for them
const HOP_MS = 130;

const RULE_LABELS = [
    ['sixToLeave', 'Six needed to leave base', 'Off: a 1 or a 6 brings a token out'],
    ['threeSixes', 'Three sixes in a row lose the turn', ''],
    ['safeStars', 'Star squares are safe', 'Start squares are always safe'],
    ['captureBonus', 'Extra turn for a capture', ''],
    ['homeBonus', 'Extra turn for reaching home', '']
];

const PIPS = { 1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]], 4: [[0, 0], [2, 0], [0, 2], [2, 2]], 5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]], 6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]] };

function Dice({ value, rolling, color }) {
    return (
        <svg className={`ludo-dice ${rolling ? 'is-rolling' : ''}`} viewBox="0 0 3 3" aria-label={value ? `Dice: ${value}` : 'Dice'} role="img">
            <rect x="0.08" y="0.08" width="2.84" height="2.84" rx="0.5" className={`ludo-dice-face ludo-c-${color || 'none'}`} />
            {(PIPS[value] || []).map(([x, y]) => <circle key={`${x}${y}`} cx={0.6 + x * 0.9} cy={0.6 + y * 0.9} r="0.27" className="ludo-dice-pip" />)}
        </svg>
    );
}

/** Token positions as drawn: the moving token hops square by square, the rest jump. */
function useShownTokens(state) {
    const [shown, setShown] = useState(state.tokens);
    const timers = useRef([]);
    const lastSeq = useRef(state.seq);
    useEffect(() => {
        timers.current.forEach(clearTimeout);
        timers.current = [];
        const ev = state.event;
        const moved = lastSeq.current !== state.seq && ev && ['move', 'capture', 'home'].includes(ev.kind) && state.tokens;
        lastSeq.current = state.seq;
        if (!moved || !shown || shown[ev.color]?.[ev.token] !== ev.from) {
            setShown(state.tokens);
            return undefined;
        }
        const steps = pathOf(ev.from, ev.to);
        steps.forEach((p, i) => {
            timers.current.push(setTimeout(() => {
                setShown((prev) => (prev ? { ...prev, [ev.color]: prev[ev.color].map((v, k) => (k === ev.token ? p : v)) } : prev));
                if (i < steps.length - 1) sound.playReactionPop();
            }, HOP_MS * (i + 1)));
        });
        timers.current.push(setTimeout(() => {
            setShown(state.tokens);
            if (ev.kind === 'capture' || ev.kind === 'home') sound.playChime();
            else sound.playPop();
        }, HOP_MS * (steps.length + 1)));
        return () => timers.current.forEach(clearTimeout);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state.seq]);
    return shown;
}

function Board({ state, shown, myColor, onMoveToken }) {
    const squares = useMemo(() => coloredSquares(), []);
    const canPick = state.phase === 'playing' && state.rolled && state.turn === myColor;
    // Tokens sharing a square are spread out; the ones you can move come last (drawn on top)
    const movableSet = new Set(canPick ? state.movable.map((i) => `${myColor}${i}`) : []);
    const placed = shown ? placeTokens(shown, movableSet) : [];
    return (
        <svg className="ludo-board" viewBox="0 0 15 15" role="img" aria-label="Ludo board">
            <rect x="0" y="0" width="15" height="15" className="ludo-board-bg" />
            {/* the cross of track squares */}
            {Array.from({ length: 15 }, (_, x) => Array.from({ length: 15 }, (_, y) => {
                const onCross = (x >= 6 && x <= 8) !== (y >= 6 && y <= 8) && ((x >= 6 && x <= 8) || (y >= 6 && y <= 8));
                return onCross ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" className="ludo-cell" /> : null;
            }))}
            {squares.map(({ cell, color, star, start }) => (
                star
                    ? <text key={`s${cell}`} x={cell[0] + 0.5} y={cell[1] + 0.72} className="ludo-star" textAnchor="middle">★</text>
                    : <rect key={`c${cell}${start ? 's' : ''}`} x={cell[0]} y={cell[1]} width="1" height="1" className={`ludo-cell ludo-c-${color}`} />
            ))}
            {/* bases */}
            {COLORS.map((color) => {
                const [bx, by] = BASE_ORIGIN[color];
                const active = state.turn === color;
                return (
                    <g key={color}>
                        <rect x={bx} y={by} width="6" height="6" className={`ludo-base ludo-c-${color} ${active ? 'is-turn' : ''}`} />
                        <rect x={bx + 0.8} y={by + 0.8} width="4.4" height="4.4" rx="0.5" className="ludo-base-inner" />
                        {[[1.9, 1.9], [4.1, 1.9], [1.9, 4.1], [4.1, 4.1]].map(([sx, sy]) => (
                            <circle key={`${sx}${sy}`} cx={bx + sx} cy={by + sy} r="0.5" className={`ludo-slot ludo-c-${color}`} />
                        ))}
                    </g>
                );
            })}
            {/* home: four triangles */}
            <polygon points="6,6 7.5,7.5 6,9" className="ludo-c-red ludo-tri" />
            <polygon points="6,6 9,6 7.5,7.5" className="ludo-c-green ludo-tri" />
            <polygon points="9,6 9,9 7.5,7.5" className="ludo-c-yellow ludo-tri" />
            <polygon points="6,9 9,9 7.5,7.5" className="ludo-c-blue ludo-tri" />
            {/* start arrows */}
            {COLORS.map((color) => {
                const [x, y] = center(TRACK[{ red: 0, green: 13, yellow: 26, blue: 39 }[color]]);
                return <circle key={`a${color}`} cx={x} cy={y} r="0.14" className="ludo-start-dot" />;
            })}
            {/* tokens */}
            {placed.map(({ color, i, p, x, y, r }) => {
                const movable = movableSet.has(`${color}${i}`);
                return (
                    <g
                        key={`${color}${i}`}
                        className={`ludo-token ${movable ? 'is-movable' : ''}`}
                        transform={`translate(${x} ${y})`}
                        onClick={movable ? () => onMoveToken(i) : undefined}
                        role={movable ? 'button' : undefined}
                        aria-label={movable ? `Move ${COLOR_NAMES[color]} token ${i + 1}` : undefined}
                        data-token={`${color}-${i}`}
                        data-progress={p}
                    >
                        {movable && <circle r={Math.max(r + 0.22, 0.5)} className="ludo-token-hit" />}
                        {movable && <circle r={r + (r < 0.3 ? 0.08 : 0.2)} className="ludo-token-ring" />}
                        <circle r={r} className={`ludo-token-body ludo-c-${color}`} />
                        <circle r={r * 0.45} className="ludo-token-dot" />
                    </g>
                );
            })}
        </svg>
    );
}

function statusText(state, myColor, nameOf) {
    const ev = state.event;
    const who = (c) => (c === myColor ? 'You' : nameOf(c));
    if (state.phase === 'lobby') return 'Pick a colour to play. 2 to 4 players; everyone else watches.';
    if (state.phase === 'over') return `${who(state.finished[0])} ${state.finished[0] === myColor ? 'win' : 'wins'}! 🎉`;
    let last = '';
    if (ev?.kind === 'no-move') last = `${who(ev.color)} rolled ${ev.value}: no move. `;
    else if (ev?.kind === 'three-sixes') last = `${who(ev.color)} rolled three sixes: turn lost. `;
    else if (ev?.kind === 'capture') last = `${who(ev.color)} captured ${ev.captured.map((c) => nameOf(c.color)).join(', ')}! `;
    else if (ev?.kind === 'home') last = `${who(ev.color)} got a token home! `;
    else if (ev?.kind === 'skipped') last = `${who(ev.color)} is away: turn skipped. `;
    const now = state.turn === myColor
        ? (state.rolled ? `Pick a token to move ${state.dice}.` : 'Your turn: roll the dice.')
        : `${nameOf(state.turn)}'s turn.`;
    return last + now;
}

const TURN_COLORS = { red: '#e53935', green: '#2e9e48', yellow: '#f2b705', blue: '#1e7fe0' };

export default function Ludo({ activityId }) {
    const room = useRoom();
    const [state, dispatch] = useSharedState(`act:${activityId}`, { initial: INITIAL, reducer });
    const selfId = room.getSelfId();
    const presentKey = [selfId, ...room.peers.map((p) => p.peerId)].sort().join(',');
    const present = useMemo(() => new Set(presentKey.split(',')), [presentKey]);
    const myColor = COLORS.find((c) => state.seats[c] && !state.seats[c].bot && state.seats[c].id === selfId) || null;
    const isAuthority = room.getAuthorityId() === selfId;
    const canManage = room.isHost || !room.getHostPeerId();
    const shown = useShownTokens(state);
    const nameOf = (c) => state.seats[c]?.name || COLOR_NAMES[c];
    const seatAway = (c) => state.seats[c] && !state.seats[c].bot && !present.has(state.seats[c].id);

    // The dice animation: on every new roll. The result shows in the roller's colour for a moment
    // (even when the turn passed straight on, e.g. no move), then the dice takes the colour of
    // whoever's turn it is, empty until they roll.
    const [rolling, setRolling] = useState(false);
    const [showingRoll, setShowingRoll] = useState(false);
    const lastRoll = state.event && 'value' in state.event ? state.event : null;
    const rollSeq = lastRoll ? state.seq : null;
    useEffect(() => {
        if (rollSeq === null) return undefined;
        setRolling(true);
        setShowingRoll(true);
        const t = setTimeout(() => setRolling(false), 450);
        const t2 = setTimeout(() => setShowingRoll(false), 1600);
        return () => {
            clearTimeout(t);
            clearTimeout(t2);
        };
    }, [rollSeq]);
    const diceColor = (showingRoll && lastRoll ? lastRoll.color : state.turn) || null;
    const diceValue = showingRoll && lastRoll ? lastRoll.value : (state.rolled ? state.dice : null);

    // Your turn: a buzz on phones and a chime
    const myTurn = state.phase === 'playing' && state.turn === myColor && !state.rolled;
    // Shrunk to a small window or a bubble: it glows / pulses in your colour when you have a move
    const needsMe = state.phase === 'playing' && state.turn === myColor && (!state.rolled || state.movable.length > 0);
    useActivityStatus({
        attention: needsMe,
        color: state.phase === 'playing' && state.turn ? TURN_COLORS[state.turn] : '',
        label: needsMe ? (state.rolled ? 'Move a token' : 'Your turn') : ''
    });
    useEffect(() => {
        if (!myTurn) return;
        try { navigator.vibrate?.(70); } catch { /* not supported */ }
        sound.playChime();
    }, [myTurn, state.seq]);

    // Authority only: play for computers, people who left, and idle players
    useEffect(() => {
        if (!isAuthority || state.phase !== 'playing' || !state.turn) return undefined;
        const seat = state.seats[state.turn];
        if (!seat) return undefined;
        let delay = IDLE_DELAY_MS;
        let mode = 'bot';
        if (seat.bot) delay = BOT_DELAY_MS;
        else if (!present.has(seat.id)) {
            delay = AWAY_DELAY_MS;
            mode = state.rules.awayMode;
        }
        const t = setTimeout(() => dispatch({ kind: 'auto', mode, seq: state.seq }), delay);
        return () => clearTimeout(t);
    }, [isAuthority, state.phase, state.turn, state.seq, state.seats, state.rules.awayMode, present, dispatch]);

    const sit = (color) => dispatch({ kind: 'sit', color, name: room.username });

    // Back after a reload or rejoin: the seat you had (the same app) is yours again, automatically
    const myCid = getClientId();
    const myOldSeat = !myColor ? COLORS.find((c) => seatAway(c) && state.seats[c].cid === myCid) || null : null;
    const reclaimKey = myOldSeat ? `${myOldSeat}:${state.seats[myOldSeat].id}` : '';
    useEffect(() => {
        if (!reclaimKey) return;
        dispatch({ kind: 'sit', color: reclaimKey.split(':')[0], name: room.username });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reclaimKey]);
    const seated = seatedColors(state);

    return (
        <div className={`ludo ludo-phase-${state.phase}`}>
            <div className="ludo-board-wrap">
                <Board state={state} shown={shown} myColor={myColor} onMoveToken={(token) => dispatch({ kind: 'move', token })} />
            </div>
            <aside className="ludo-panel">
                <p className="ludo-status" data-testid="ludo-status" aria-live="polite">{statusText(state, myColor, nameOf)}</p>

                {state.phase === 'playing' && (
                    <div className="ludo-dice-row">
                        <Dice value={diceValue} rolling={rolling} color={diceColor} />
                        {myTurn ? (
                            <button type="button" className="btn btn-primary ludo-roll-btn" onClick={() => dispatch({ kind: 'roll' })}>Roll</button>
                        ) : (
                            <span className="ludo-dice-note">{state.turn === myColor ? 'Tap a glowing token' : myColor ? 'Wait for your turn' : 'Watching'}</span>
                        )}
                    </div>
                )}

                <ul className="ludo-seats">
                    {COLORS.map((color) => {
                        const seat = state.seats[color];
                        const home = state.tokens?.[color]?.filter((p) => p >= HOME).length ?? 0;
                        const place = state.finished.indexOf(color);
                        const away = seatAway(color);
                        return (
                            <li key={color} className={`ludo-seat ${state.turn === color ? 'is-turn' : ''}`}>
                                <span className={`ludo-seat-dot ludo-c-${color}`} aria-hidden="true" />
                                <span className="ludo-seat-name">
                                    {seat ? (seat.id === selfId ? `${seat.name} (you)` : seat.name) : <em>Free</em>}
                                    {away && <span className="ludo-tag">away</span>}
                                    {place >= 0 && <span className="ludo-tag ludo-tag-place">#{place + 1}</span>}
                                </span>
                                {state.phase !== 'lobby' && seat && <span className="ludo-seat-home">{home}/4 home</span>}
                                {state.phase === 'lobby' && !seat && (
                                    <span className="ludo-seat-actions">
                                        <button type="button" className="ludo-mini-btn" onClick={() => sit(color)}>{myColor ? 'Switch' : 'Sit'}</button>
                                        {canManage && <button type="button" className="ludo-mini-btn" onClick={() => dispatch({ kind: 'add-bot', color })}>+ Computer</button>}
                                    </span>
                                )}
                                {state.phase === 'lobby' && seat && (seat.id === selfId || canManage) && (
                                    <button type="button" className="ludo-mini-btn" onClick={() => dispatch(seat.id === selfId ? { kind: 'stand' } : { kind: 'clear-seat', color })}>
                                        {seat.id === selfId ? 'Leave' : 'Remove'}
                                    </button>
                                )}
                                {state.phase === 'playing' && away && !myColor && (
                                    <button type="button" className="ludo-mini-btn" onClick={() => sit(color)}>Take seat</button>
                                )}
                            </li>
                        );
                    })}
                </ul>

                {state.phase === 'lobby' && (
                    <div className="ludo-rules">
                        <div className="ludo-rules-title">Rules{canManage ? '' : ' (the host sets these)'}</div>
                        {RULE_LABELS.map(([key, label, hint]) => (
                            <label key={key} className="ludo-rule" title={hint}>
                                <input type="checkbox" checked={state.rules[key]} disabled={!canManage}
                                    onChange={(e) => dispatch({ kind: 'rules', rules: { [key]: e.target.checked } })} />
                                <span>{label}</span>
                            </label>
                        ))}
                        <div className="ludo-rules-title">If a player leaves</div>
                        {[['bot', 'The computer plays for them'], ['skip', 'Skip their turns']].map(([value, label]) => (
                            <label key={value} className="ludo-rule">
                                <input type="radio" name="ludo-away" checked={state.rules.awayMode === value} disabled={!canManage}
                                    onChange={() => dispatch({ kind: 'rules', rules: { awayMode: value } })} />
                                <span>{label}</span>
                            </label>
                        ))}
                        {canManage ? (
                            <button type="button" className="btn btn-primary ludo-start-btn" disabled={seated.length < 2} onClick={() => dispatch({ kind: 'start' })}>
                                {seated.length < 2 ? 'Need 2 players' : `Start game (${seated.length} players)`}
                            </button>
                        ) : (
                            <p className="ludo-hint">The host starts the game.</p>
                        )}
                    </div>
                )}

                {state.phase === 'over' && (
                    <div className="ludo-over">
                        <ol>{state.finished.map((c) => <li key={c}><span className={`ludo-seat-dot ludo-c-${c}`} /> {nameOf(c)}</li>)}</ol>
                        {canManage && <button type="button" className="btn btn-primary" onClick={() => dispatch({ kind: 'again' })}>Play again</button>}
                    </div>
                )}
            </aside>
        </div>
    );
}
