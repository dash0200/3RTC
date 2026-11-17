/**
 * Sketch: one person draws a word, everyone else guesses (rules.ts). The board is a whiteboard of
 * its own each turn (`act:<id>:t<turn>`): the drawer draws, the others watch it live. Guesses are
 * typed here, not in the room chat, so a right answer never spoils it for the others.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useRoom, useSharedState, useSharedPresence } from '../../../core/RoomContext';
import { releaseSharedStores } from '../../../core/sharedState';
import { useActivityStatus } from '../activityHost';
import { sound } from '../../../utils/sound';
import Whiteboard from '../whiteboard';
import { INITIAL, MAX_PLAYERS, ROUNDS, reducer, redact, totalTurns, type SketchAction, type SketchState } from './rules';
import './sketch.css';

const OPTIONS = { initial: INITIAL, reducer, redact };
const TICK_MS = 500;

export interface SketchProps {
  activityId: string;
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export default function Sketch({ activityId }: SketchProps): JSX.Element {
  const room = useRoom();
  const key = `act:${activityId}`;
  const [s, dispatch] = useSharedState<SketchState, SketchAction>(key, OPTIONS);
  const presence = useSharedPresence(key, OPTIONS);
  const selfId = room.getSelfId() || '';
  const myName = room.getSelf().username || 'Someone';
  const isAuthority = presence.authorityId === selfId;
  const joined = s.players.some((p) => p.id === selfId);
  const drawing = s.drawer === selfId;
  const nameOf = (id: string | null) => s.players.find((p) => p.id === id)?.name || 'Someone';
  const presentKey = presence.members.join(',');
  const here = useMemo(() => new Set(presentKey.split(',')), [presentKey]);

  // Opening it is joining it
  useEffect(() => {
    if (!joined && s.players.length < MAX_PLAYERS && selfId) dispatch({ kind: 'join', name: myName });
  }, [joined, s.players.length, selfId, myName, dispatch]);

  // The authority's app keeps time
  useEffect(() => {
    if (!isAuthority || s.phase === 'lobby' || s.phase === 'over') return undefined;
    const t = setInterval(() => dispatch({ kind: 'tick' }), TICK_MS);
    return () => clearInterval(t);
  }, [isAuthority, s.phase, dispatch]);

  const now = useClock(s.phase === 'picking' || s.phase === 'drawing' || s.phase === 'reveal');
  const secondsLeft = s.deadline ? Math.max(0, Math.ceil((s.deadline - now) / 1000)) : 0;

  // The board of this turn (the last one stays during the reveal); old turns' boards are let go
  const boardTurn = s.phase === 'reveal' ? s.turn - 1 : s.turn;
  const boardId = `${activityId}:t${boardTurn}`;
  const lastBoard = useRef(boardTurn);
  useEffect(() => {
    const old = lastBoard.current;
    if (old === boardTurn) return;
    lastBoard.current = boardTurn;
    releaseSharedStores(room.bus, (k) => k === `act:${activityId}:t${old}` || k.startsWith(`act:${activityId}:t${old}:`));
  }, [boardTurn, activityId, room.bus]);

  // Sounds: our turn to draw, someone got it, the reveal
  const prev = useRef({ phase: s.phase, guessed: s.guessed.length, drawer: s.drawer });
  useEffect(() => {
    const p = prev.current;
    if (s.phase === 'picking' && drawing && (p.phase !== 'picking' || p.drawer !== s.drawer)) {
      sound.playChime();
      try {
        navigator.vibrate?.(60);
      } catch {
        /* not supported */
      }
    } else if (s.guessed.length > p.guessed && s.phase === 'drawing') {
      sound.playPop();
    }
    prev.current = { phase: s.phase, guessed: s.guessed.length, drawer: s.drawer };
  }, [s.phase, s.guessed.length, s.drawer, drawing]);

  useActivityStatus({
    attention: s.phase === 'picking' && drawing,
    label: s.phase === 'picking' && drawing ? 'Your turn to draw' : s.phase === 'drawing' ? `${nameOf(s.drawer)} is drawing` : ''
  });

  // ---- guessing ----
  const [guess, setGuess] = useState('');
  const feedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.feed.length]);
  const iGuessed = s.guessed.includes(selfId);
  const canGuess = s.phase === 'drawing' && joined && !drawing && !iGuessed;
  const sendGuess = () => {
    const text = guess.trim();
    if (!text || !canGuess) return;
    dispatch({ kind: 'guess', text });
    setGuess('');
  };

  const turns = totalTurns(s);
  const round = Math.min(ROUNDS, Math.floor(s.turn / Math.max(1, s.players.length)) + 1);
  const ranked = [...s.players].sort((a, b) => b.score - a.score);
  const enoughPlayers = s.players.filter((p) => here.has(p.id)).length >= 2;

  // ---- what the top bar says ----
  let banner: JSX.Element;
  if (s.phase === 'lobby') {
    banner = <span>{s.players.length} player{s.players.length === 1 ? '' : 's'} ready{enoughPlayers ? '' : ' · needs 2 or more'}</span>;
  } else if (s.phase === 'picking') {
    banner = drawing ? <span>Pick a word to draw · {secondsLeft}s</span> : <span>{nameOf(s.drawer)} is picking a word… {secondsLeft}s</span>;
  } else if (s.phase === 'drawing') {
    banner = (
      <span className="sk-hint-row">
        <span className="sk-word" aria-label={drawing ? `Draw: ${s.word}` : `Hint: ${s.length} letters`}>
          {drawing ? s.word : s.hint.split('').map((c, i) => <span key={i} className={c === ' ' ? 'sk-gap' : 'sk-letter'}>{c === '_' ? '' : c}</span>)}
        </span>
        {!drawing && <span className="sk-len">{s.length}</span>}
        <span className={`sk-timer ${secondsLeft <= 10 ? 'is-low' : ''}`}>{secondsLeft}s</span>
      </span>
    );
  } else if (s.phase === 'reveal') {
    banner = <span>{s.revealed ? <>The word was <strong>{s.revealed}</strong></> : 'Next turn…'}</span>;
  } else {
    banner = <span>Game over · {ranked[0] ? `${ranked[0].name} wins!` : ''}</span>;
  }

  return (
    <div className="sk">
      <div className="sk-top">
        <span className="sk-round">{s.phase === 'lobby' || s.phase === 'over' ? 'Sketch' : `Round ${round} of ${ROUNDS}`}</span>
        <div className="sk-banner" aria-live="polite">{banner}</div>
        {(s.phase === 'picking' || s.phase === 'drawing') && drawing && (
          <button type="button" className="sk-btn sk-btn-quiet" onClick={() => dispatch({ kind: 'skip' })}>Skip</button>
        )}
      </div>

      <div className="sk-body">
        <div className="sk-board">
          {s.phase === 'lobby' || s.phase === 'over' ? (
            <div className="sk-center">
              {s.phase === 'over' && (
                <ol className="sk-podium">
                  {ranked.slice(0, 3).map((p, i) => (
                    <li key={p.id}><span className="sk-medal">{['🥇', '🥈', '🥉'][i]}</span> {p.name} <strong>{p.score}</strong></li>
                  ))}
                </ol>
              )}
              <p className="sk-lead">
                {s.phase === 'lobby'
                  ? `Take turns drawing a word while everyone else guesses. Everyone draws ${ROUNDS} times.`
                  : 'Thanks for playing!'}
              </p>
              {s.phase === 'lobby' ? (
                <button type="button" className="sk-btn sk-btn-primary" disabled={!joined || !enoughPlayers} onClick={() => dispatch({ kind: 'start' })}>
                  {enoughPlayers ? 'Start' : 'Waiting for players…'}
                </button>
              ) : (
                <button type="button" className="sk-btn sk-btn-primary" disabled={!joined} onClick={() => dispatch({ kind: 'again' })}>Play again</button>
              )}
            </div>
          ) : s.phase === 'picking' && drawing ? (
            <div className="sk-center">
              <p className="sk-lead">Pick a word to draw</p>
              <div className="sk-choices">
                {s.choices.map((w, i) => (
                  <button key={w} type="button" className="sk-btn sk-choice" onClick={() => dispatch({ kind: 'pick', index: i })}>{w}</button>
                ))}
              </div>
            </div>
          ) : s.phase === 'picking' ? (
            <div className="sk-center"><p className="sk-lead">{nameOf(s.drawer)} is picking a word…</p></div>
          ) : (
            <Whiteboard
              key={boardId}
              activityId={boardId}
              game
              readOnly={!drawing || s.phase !== 'drawing'}
              canClear={drawing}
              emptyText={drawing ? `Draw “${s.word}” (no letters!)` : `${nameOf(s.drawer)} is about to draw…`}
            />
          )}
        </div>

        <aside className="sk-side">
          <ul className="sk-players" aria-label="Scores">
            {ranked.map((p) => (
              <li key={p.id} className={`${p.id === s.drawer ? 'is-drawing' : ''} ${s.guessed.includes(p.id) ? 'is-done' : ''} ${here.has(p.id) ? '' : 'is-away'}`}>
                <span className="sk-pname">{p.id === s.drawer ? '✏️ ' : s.guessed.includes(p.id) ? '✅ ' : ''}{p.name}{p.id === selfId ? ' (you)' : ''}</span>
                <span className="sk-score">
                  {s.phase === 'reveal' && s.gained[p.id] ? <span className="sk-gain">+{s.gained[p.id]}</span> : null}
                  {p.score}
                </span>
              </li>
            ))}
          </ul>
          <div className="sk-feed" ref={feedRef} aria-live="polite">
            {s.feed.map((l, i) => (
              <div key={i} className={`sk-line sk-${l.kind}`}>
                {l.kind === 'guess' ? <><strong>{l.name}:</strong> {l.text}</> : l.text}
              </div>
            ))}
          </div>
          <form className="sk-guess" onSubmit={(e) => { e.preventDefault(); sendGuess(); }}>
            <input
              type="text"
              value={guess}
              maxLength={40}
              placeholder={drawing ? 'You are drawing' : iGuessed ? 'You got it!' : s.phase === 'drawing' ? 'Type your guess' : 'Guesses go here'}
              disabled={!canGuess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => e.stopPropagation() /* keep the room's keyboard shortcuts out of it */}
              aria-label="Your guess"
            />
            <button type="submit" className="sk-btn sk-btn-primary" disabled={!canGuess || !guess.trim()}>Guess</button>
          </form>
          {s.phase !== 'lobby' && s.phase !== 'over' && <div className="sk-turns">Turn {Math.min(s.turn + 1, turns)} of {turns}</div>}
        </aside>
      </div>
    </div>
  );
}
