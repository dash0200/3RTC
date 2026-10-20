/**
 * Last Card for 2–10 players (people and the computer); everyone else watches. Rules and
 * dealing: ./rules.ts (runs on the authority). Each app only receives its own hand (`redact`).
 * This file draws the table, and on the authority's app plays for computers, people who left and
 * players who went idle, and rebuilds the hidden cards if the authority changed mid-game.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useRoom, useSharedState, useSharedPresence } from '../../../core/RoomContext';
import { useActivityStatus } from '../activityHost';
import { sound } from '../../../utils/sound';
import {
  COLORS,
  COLOR_NAMES,
  INITIAL,
  MAX_PLAYERS,
  card,
  cardName,
  isWild,
  missingSecrets,
  playableCards,
  redact,
  reducer,
  seatOf,
  topCard,
  type CardColor,
  type LcAction,
  type LcEvent,
  type LcState
} from './rules';
import { CARD_COLORS, CardBack, CardFace } from './cards';
import './lastcard.css';

const BOT_DELAY_MS = 1100;
const AWAY_DELAY_MS = 5000;
const IDLE_DELAY_MS = 45000;
const CATCH_DELAY_MS = 2600;
const REBUILD_AFTER_MS = 6000;

const OPTIONS = { initial: INITIAL, reducer, redact };

function eventText(e: LcEvent | null, name: (seat: number) => string, me: number): string {
  if (!e) return '';
  const who = (seat: number) => (seat === me ? 'You' : name(seat));
  const whom = (seat: number) => (seat === me ? 'you' : name(seat));
  switch (e.kind) {
    case 'start':
      return `${cardName(e.card!)} starts the pile.`;
    case 'play': {
      const c = e.card !== undefined ? card(e.card) : null;
      let text = `${who(e.seat)} played ${cardName(e.card!)}`;
      if (e.color) text += ` → ${COLOR_NAMES[e.color]}`;
      if (e.count && e.target !== undefined) text += `. ${who(e.target)} ${e.target === me ? 'take' : 'takes'} ${e.count} and ${e.target === me ? 'are' : 'is'} skipped`;
      else if (c?.value === 'S' && e.target !== undefined) text += `. ${who(e.target)} ${e.target === me ? 'are' : 'is'} skipped`;
      else if (c?.value === 'R' && e.target !== undefined) text += `. ${who(e.target)} ${e.target === me ? 'are' : 'is'} skipped`;
      else if (c?.value === 'R') text += '. Direction reversed';
      return `${text}.`;
    }
    case 'draw':
      return `${who(e.seat)} drew ${e.count === 1 ? 'a card' : `${e.count} cards`}.`;
    case 'take':
      return `${who(e.seat)} took ${e.count} cards.`;
    case 'pass':
      return `${who(e.seat)} kept the card and passed.`;
    case 'called':
      return `${who(e.seat)} called “Last card!”`;
    case 'caught':
      return `${who(e.seat)} caught ${whom(e.target!)} not calling “Last card”: +2 cards.`;
    case 'restored':
      return 'Cards restored after a reconnect. Play on!';
    case 'win':
      return `${who(e.seat)} won!`;
    default:
      return '';
  }
}

function ColorPicker({ onPick, onCancel }: { onPick: (c: CardColor) => void; onCancel: () => void }): JSX.Element {
  return (
    <div className="lc-picker" role="dialog" aria-label="Pick a colour">
      <div className="lc-picker-card">
        <span className="lc-picker-title">Pick a colour</span>
        <div className="lc-picker-row">
          {COLORS.map((c) => (
            <button key={c} type="button" className="lc-picker-btn" style={{ background: CARD_COLORS[c] }} aria-label={COLOR_NAMES[c]} onClick={() => onPick(c)} />
          ))}
        </div>
        <button type="button" className="lc-mini-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export interface LastCardProps {
  activityId: string;
}

export default function LastCard({ activityId }: LastCardProps): JSX.Element {
  const room = useRoom();
  const key = `act:${activityId}`;
  const [s, dispatch] = useSharedState<LcState, LcAction>(key, OPTIONS);
  const presence = useSharedPresence(key, OPTIONS);
  const selfId = room.getSelfId();
  const presentKey = presence.members.join(',');
  const present = useMemo(() => new Set(presentKey.split(',')), [presentKey]);
  const isAuthority = presence.authorityId === selfId;
  const hostId = room.getHostPeerId();
  const canManage = room.getSelf().isHost || !hostId || !present.has(hostId);
  const me = seatOf(s, selfId);
  const myHand = me >= 0 ? s.hands[me] : null;
  const myTurn = s.phase === 'playing' && !s.restoring && me === s.turn;
  const name = (seat: number): string => s.players[seat]?.name || `Player ${seat + 1}`;
  const away = (seat: number): boolean => Boolean(s.players[seat] && !s.players[seat].bot && !present.has(s.players[seat].id));

  // Remember our hand: if the game's authority changes, we send it back
  const handRef = useRef<number[] | null>(null);
  if (myHand) handRef.current = myHand;
  useEffect(() => {
    if (s.phase === 'playing' && s.restoring && me >= 0 && !s.hands[me] && handRef.current) {
      dispatch({ kind: 'restore', cards: handRef.current });
    }
  }, [s.phase, s.restoring, s.seq, me, s.hands, dispatch]);

  // Authority only: notice missing cards, play for computers / away / idle, let computers catch
  const missing = isAuthority && missingSecrets(s);
  useEffect(() => {
    if (!missing || s.restoring) return;
    dispatch({ kind: 'resync' });
  }, [missing, s.restoring, dispatch]);
  useEffect(() => {
    if (!isAuthority || s.phase !== 'playing') return undefined;
    if (s.restoring) {
      const t = setTimeout(() => dispatch({ kind: 'auto', seq: s.seq, mode: 'rebuild' }), REBUILD_AFTER_MS);
      return () => clearTimeout(t);
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const player = s.players[s.turn];
    if (player) {
      const delay = player.bot ? BOT_DELAY_MS : !present.has(player.id) ? AWAY_DELAY_MS : IDLE_DELAY_MS;
      timers.push(setTimeout(() => dispatch({ kind: 'auto', seq: s.seq, mode: 'play' }), delay));
    }
    if (s.exposed !== null && s.players.some((p, i) => p.bot && i !== s.exposed)) {
      timers.push(setTimeout(() => dispatch({ kind: 'auto', seq: s.seq, mode: 'catch' }), CATCH_DELAY_MS));
    }
    return () => timers.forEach(clearTimeout);
  }, [isAuthority, s.phase, s.restoring, s.seq, s.turn, s.players, s.exposed, present, dispatch]);

  // Sounds: a flick for every card, a chime when it becomes your turn
  const prevSeq = useRef(s.seq);
  useEffect(() => {
    if (prevSeq.current === s.seq) return;
    prevSeq.current = s.seq;
    if (myTurn && s.event?.seat !== me) {
      sound.playChime();
      try {
        navigator.vibrate?.(60);
      } catch {
        /* not supported */
      }
    } else if (s.event?.kind === 'play' || s.event?.kind === 'draw') {
      sound.playPop();
    }
  }, [s.seq, myTurn, me, s.event]);

  const [picking, setPicking] = useState<{ seq: number; card: number } | null>(null);
  const pickingCard = picking && picking.seq === s.seq ? picking.card : null;

  const playable = useMemo(() => new Set(myTurn ? playableCards(s, me) : []), [s, me, myTurn]);
  const play = (id: number): void => {
    if (!playable.has(id)) return;
    if (isWild(id)) setPicking({ seq: s.seq, card: id });
    else dispatch({ kind: 'play', card: id });
  };

  const exposedOther = s.exposed !== null && s.exposed !== me && me >= 0;
  const canCallAhead = myTurn && s.counts[me] === 2 && !s.called[me];
  const mustCall = s.exposed === me;

  useActivityStatus({
    attention: myTurn || mustCall,
    color: s.phase === 'playing' ? CARD_COLORS[s.color] : '',
    label: mustCall ? 'Say “Last card!”' : myTurn ? (s.pendingDraw ? `Stack or take ${s.pendingDraw}` : 'Your turn') : ''
  });

  // ---- lobby ------------------------------------------------------------------------------------
  if (s.phase === 'lobby') {
    const joined = me >= 0;
    return (
      <div className="lc lc-lobby">
        <div className="lc-lobby-card">
          <div className="lc-lobby-head">
            <div className="lc-lobby-cards" aria-hidden="true">
              <CardFace id={34} className="lc-lobby-c1" />
              <CardFace id={104} className="lc-lobby-c2" />
              <CardFace id={73} className="lc-lobby-c3" />
            </div>
            <div>
              <h3 className="lc-title">Last Card</h3>
              <p className="lc-muted">Match the colour or the symbol. First to empty their hand wins. Say “Last card!” when you're down to one.</p>
            </div>
          </div>
          <ul className="lc-players">
            {s.players.map((p, i) => (
              <li key={p.id} className="lc-player-row">
                <span className="lc-avatar" aria-hidden="true">{p.bot ? '🤖' : p.name.slice(0, 1).toUpperCase()}</span>
                <span className="lc-player-name">
                  {p.name}
                  {p.id === selfId ? ' (you)' : ''}
                  {away(i) && <span className="lc-tag">away</span>}
                  {p.wins > 0 && <span className="lc-tag lc-tag-win">{p.wins} win{p.wins === 1 ? '' : 's'}</span>}
                </span>
                {(p.id === selfId || canManage) && (
                  <button type="button" className="lc-mini-btn" onClick={() => dispatch(p.id === selfId ? { kind: 'leave' } : { kind: 'remove', seat: i })}>
                    {p.id === selfId ? 'Leave' : 'Remove'}
                  </button>
                )}
              </li>
            ))}
            {!s.players.length && <li className="lc-muted">Nobody yet.</li>}
          </ul>
          <div className="lc-row">
            {!joined && s.players.length < MAX_PLAYERS && (
              <button type="button" className="btn btn-primary" onClick={() => dispatch({ kind: 'join', name: room.getSelf().username })}>Join the game</button>
            )}
            {canManage && s.players.length < MAX_PLAYERS && (
              <button type="button" className="lc-mini-btn" onClick={() => dispatch({ kind: 'add-bot' })}>+ Computer</button>
            )}
          </div>
          <div className="lc-rules">
            <div className="lc-rules-title">House rules{canManage ? '' : ' (the host sets these)'}</div>
            <label className="lc-rule">
              <input type="checkbox" checked={s.rules.stacking} disabled={!canManage} onChange={(e) => dispatch({ kind: 'rules', rules: { stacking: e.target.checked } })} />
              <span>Stacking: answer +2 with +2 (or +4), the next player takes them all</span>
            </label>
            <label className="lc-rule">
              <input type="checkbox" checked={s.rules.drawToMatch} disabled={!canManage} onChange={(e) => dispatch({ kind: 'rules', rules: { drawToMatch: e.target.checked } })} />
              <span>Draw until you get a card you can play</span>
            </label>
          </div>
          {canManage || joined ? (
            <button type="button" className="btn btn-primary lc-start" disabled={s.players.length < 2} onClick={() => dispatch({ kind: 'start' })}>
              {s.players.length < 2 ? 'Need 2 players' : `Deal (${s.players.length} players)`}
            </button>
          ) : (
            <p className="lc-muted">A player or the host deals.</p>
          )}
        </div>
      </div>
    );
  }

  // ---- table ------------------------------------------------------------------------------------
  const top = topCard(s);
  const order = s.players.map((_, i) => i);
  // opponents in play order, starting after me (or from seat 0 for watchers)
  const start = me >= 0 ? me : -1;
  const others = order.map((_, k) => (start + 1 + k) % s.players.length).filter((i) => i !== me);
  const status = (() => {
    if (s.phase === 'over') return s.winner === me ? 'You won! 🎉' : `${name(s.winner!)} won!`;
    if (s.restoring) return 'Someone reconnected: getting everyone’s cards back…';
    if (myTurn) {
      if (s.pendingDraw) return playable.size ? `Stack a draw card or take ${s.pendingDraw}.` : `Take ${s.pendingDraw} cards.`;
      if (s.drewThisTurn) return playable.size ? 'Play the card you drew, or keep it.' : 'Your turn.';
      return playable.size ? 'Your turn: play a card or draw.' : 'Nothing to play: draw a card.';
    }
    if (s.players[s.turn]?.bot) return `${name(s.turn)} is thinking…`;
    if (away(s.turn)) return `${name(s.turn)} left: playing for them shortly.`;
    return `${name(s.turn)}'s turn.`;
  })();
  const handCount = myHand?.length ?? 0;
  const overlap = handCount > 7 ? Math.min(0.72, 0.38 + (handCount - 7) * 0.035) : 0.38;

  return (
    <div className={`lc lc-phase-${s.phase}${myTurn ? ' is-my-turn' : ''}`}>
      <div className="lc-opponents">
        {others.map((i) => (
          <div key={s.players[i].id} className={`lc-opp${s.turn === i && s.phase === 'playing' ? ' is-turn' : ''}${s.winner === i ? ' is-winner' : ''}`}>
            <span className="lc-avatar" aria-hidden="true">{s.players[i].bot ? '🤖' : s.players[i].name.slice(0, 1).toUpperCase()}</span>
            <div className="lc-opp-main">
              <span className="lc-opp-name">
                {s.players[i].name}
                {away(i) && <span className="lc-tag">away</span>}
              </span>
              <span className="lc-opp-count">
                <span className="lc-mini-backs" aria-hidden="true">
                  {Array.from({ length: Math.min(5, s.counts[i] ?? 0) }, (_, k) => <span key={k} />)}
                </span>
                {s.counts[i] ?? 0} card{s.counts[i] === 1 ? '' : 's'}
              </span>
            </div>
            {s.counts[i] === 1 && s.exposed !== i && <span className="lc-tag lc-tag-last">Last card!</span>}
            {s.exposed === i && exposedOther && (
              <button type="button" className="lc-catch-btn" onClick={() => dispatch({ kind: 'catch', seat: i })}>Catch!</button>
            )}
          </div>
        ))}
      </div>

      <div className="lc-center">
        <button
          type="button"
          className={`lc-draw${myTurn && !s.drewThisTurn ? ' can-draw' : ''}`}
          disabled={!myTurn || s.drewThisTurn}
          onClick={() => dispatch({ kind: 'draw' })}
          aria-label={s.pendingDraw && myTurn ? `Take ${s.pendingDraw} cards` : 'Draw a card'}
        >
          <CardBack className="lc-card lc-draw-under" />
          <CardBack className="lc-card" />
          <span className="lc-pile-count">{s.drawCount}</span>
        </button>
        <div className="lc-discard" style={{ ['--lc-ring' as string]: CARD_COLORS[s.color] }}>
          {s.discard.slice(-3, -1).map((id, k) => (
            <CardFace key={`${id}-${k}`} id={id} className={`lc-card lc-under lc-under-${k}`} />
          ))}
          {top !== null && <CardFace key={`${top}-${s.discard.length}`} id={top} className="lc-card lc-top" />}
          <span className="lc-color-dot" title={`Colour: ${COLOR_NAMES[s.color]}`} />
        </div>
        <div className="lc-dir" aria-label={s.dir === 1 ? 'Clockwise' : 'Anticlockwise'}>
          {s.dir === 1 ? '↻' : '↺'}
          {s.pendingDraw > 0 && <span className="lc-pending">+{s.pendingDraw}</span>}
        </div>
      </div>

      <div className="lc-status-row">
        <p className="lc-status" data-testid="lc-status" aria-live="polite">
          {status}
          {s.phase !== 'over' && <span className="lc-event">{eventText(s.event, name, me)}</span>}
        </p>
        <div className="lc-actions">
          {myTurn && s.drewThisTurn && (
            <button type="button" className="lc-mini-btn" onClick={() => dispatch({ kind: 'pass' })}>Keep it</button>
          )}
          {myTurn && !s.drewThisTurn && (
            <button type="button" className="lc-mini-btn" onClick={() => dispatch({ kind: 'draw' })}>
              {s.pendingDraw ? `Take ${s.pendingDraw}` : 'Draw'}
            </button>
          )}
          {(canCallAhead || mustCall) && (
            <button type="button" className={`lc-call-btn${mustCall ? ' is-urgent' : ''}`} onClick={() => dispatch({ kind: 'call' })}>
              Last card!
            </button>
          )}
          {s.phase === 'over' && (canManage || me >= 0) && (
            <button type="button" className="btn btn-primary" onClick={() => dispatch({ kind: 'again' })}>Play again</button>
          )}
        </div>
      </div>

      {me >= 0 ? (
        <div className="lc-hand" style={{ ['--lc-overlap' as string]: String(overlap) }} aria-label="Your cards">
          {(myHand || []).map((id, k) => {
            const ok = playable.has(id);
            const drawn = s.drewThisTurn && myTurn && k === (myHand?.length ?? 0) - 1;
            return (
              <button
                key={id}
                type="button"
                className={`lc-hand-card${ok ? ' is-playable' : ''}${drawn ? ' is-drawn' : ''}`}
                disabled={!ok}
                onClick={() => play(id)}
                aria-label={cardName(id)}
              >
                <CardFace id={id} className="lc-card" />
              </button>
            );
          })}
          {!myHand && <p className="lc-muted">Getting your cards…</p>}
        </div>
      ) : (
        <p className="lc-muted lc-watching">You're watching this game.</p>
      )}

      {s.phase === 'over' && (
        <div className="lc-scores">
          {s.players.map((p, i) => (
            <span key={p.id} className={`lc-score${s.winner === i ? ' is-winner' : ''}`}>
              {p.name}: {p.wins}
            </span>
          ))}
        </div>
      )}

      {pickingCard !== null && (
        <ColorPicker
          onPick={(c) => {
            dispatch({ kind: 'play', card: pickingCard, color: c });
            setPicking(null);
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </div>
  );
}
