/**
 * Tycoon for 2–6 players (people and the computer); everyone else watches. Rules: ./rules.ts
 * (runs on the authority), board and cards: ./board.ts, art: ./art.tsx and ./BoardView.tsx.
 * On the authority's app this also plays for computers, people who left and idle players.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useRoom, useSharedState, useSharedPresence } from '../../../core/RoomContext';
import { useActivityStatus } from '../activityHost';
import { sound } from '../../../utils/sound';
import { getClientId } from '../../../utils/clientId';
import { GROUP_COLORS, GROUP_NAMES, JAIL_FINE, SPACES, START_CASH, START_PAY, STATION_RENT, SURPRISE, TOKENS, TREASURE, UTILITY_TIMES, isBuyable, priceOf, groupOf, groupMembers, type GroupId, type TokenId } from './board';
import {
  INITIAL,
  ROUND_OPTIONS,
  buildBlock,
  mortgageValue,
  netWorth,
  ownsGroup,
  reducer,
  money,
  seatOf,
  unmortgageCost,
  type TyAction,
  type TyState
} from './rules';
import { BoardView } from './BoardView';
import { SpaceIcon, Token } from './art';
import './tycoon.css';

const BOT_STEP_MS = 1000;
const AWAY_MS = 5000;
const IDLE_MS = 60000;
const BOT_TRADE_MS = 2200;
const HOP_MS = 150;
const OPTIONS = { initial: INITIAL, reducer };

const TOKEN_NAMES: Record<TokenId, string> = { auto: 'Tuk-tuk', car: 'Car', scooter: 'Scooter', boat: 'Boat', plane: 'Plane', train: 'Train' };

// ---- title deed --------------------------------------------------------------------------------

function Deed({ s, pos, me, onAct, onClose }: { s: TyState; pos: number; me: number; onAct: (a: TyAction) => void; onClose: () => void }): JSX.Element {
  const sp = SPACES[pos];
  const owner = s.owner[pos];
  const mine = owner === me && me >= 0;
  const myTurn = s.phase === 'playing' && s.turn === me;
  const header = sp.kind === 'property' ? GROUP_COLORS[sp.group] : sp.kind === 'station' ? '#23252d' : sp.kind === 'utility' ? '#3aa0a5' : '#6b6e78';
  const g = groupOf(pos);
  const groupBuilt = g ? SPACES.some((x, i) => x.kind === 'property' && x.group === g && s.houses[i] > 0) : false;
  // Your coloured place: why you can't build on it yet (whole set, your turn, evenly, cash...)
  const whyNot = mine && sp.kind === 'property' && s.phase === 'playing' ? buildBlock(s, me, pos) : null;
  return (
    <div className="ty-modal" role="dialog" aria-label={sp.name} onClick={onClose}>
      <div className="ty-deed" onClick={(e) => e.stopPropagation()}>
        <div className="ty-deed-head" style={{ background: header }}>
          <span className="ty-deed-kicker">{sp.kind === 'property' ? sp.city : sp.kind === 'station' ? 'Transport' : sp.kind === 'utility' ? 'Utility' : ''}</span>
          <span className="ty-deed-name">{sp.name}</span>
        </div>
        {sp.kind === 'property' && (
          <table className="ty-deed-table">
            <tbody>
              <tr><td>Rent</td><td>{money(sp.rent[0])}</td></tr>
              <tr><td>Whole colour set</td><td>{money(sp.rent[0] * 2)}</td></tr>
              {[1, 2, 3, 4].map((h) => (
                <tr key={h} className={s.houses[pos] === h ? 'is-now' : ''}><td>With {h} house{h > 1 ? 's' : ''}</td><td>{money(sp.rent[h])}</td></tr>
              ))}
              <tr className={s.houses[pos] === 5 ? 'is-now' : ''}><td>With a hotel</td><td>{money(sp.rent[5])}</td></tr>
              <tr className="ty-deed-sep"><td>House / hotel costs</td><td>{money(sp.house)}</td></tr>
            </tbody>
          </table>
        )}
        {sp.kind === 'station' && (
          <table className="ty-deed-table">
            <tbody>
              {STATION_RENT.map((r, i) => <tr key={i}><td>Owning {i + 1} transport{i ? 's' : ''}</td><td>{money(r)}</td></tr>)}
            </tbody>
          </table>
        )}
        {sp.kind === 'utility' && (
          <p className="ty-deed-text">Rent is {UTILITY_TIMES[0]}× the dice roll, or {UTILITY_TIMES[1]}× if the same person owns both utilities.</p>
        )}
        {!isBuyable(pos) && <p className="ty-deed-text">{describeSpace(pos)}</p>}
        {isBuyable(pos) && (
          <div className="ty-deed-meta">
            <span>Price {money(priceOf(pos))}</span>
            <span>Mortgage {money(mortgageValue(pos))}</span>
          </div>
        )}
        {isBuyable(pos) && (
          <p className="ty-deed-owner">
            {owner === null ? 'For sale' : <>Owned by <b style={{ color: s.players[owner].color }}>{s.players[owner].name}</b>{s.mortgaged[pos] ? ' · mortgaged' : ''}</>}
          </p>
        )}
        {mine && whyNot && <p className="ty-deed-hint" data-testid="ty-build-hint">🏗️ {whyNot}</p>}
        {mine && myTurn && (
          <div className="ty-deed-actions">
            {sp.kind === 'property' && !whyNot && (
              <button type="button" className="ty-btn ty-btn-go" onClick={() => onAct({ kind: 'build', pos })}>Build {s.houses[pos] === 4 ? 'hotel' : 'house'} ({money(sp.house)})</button>
            )}
            {s.houses[pos] > 0 && <button type="button" className="ty-btn" onClick={() => onAct({ kind: 'sell', pos })}>Sell {s.houses[pos] === 5 ? 'hotel' : 'a house'} (+{money(houseHalf(pos))})</button>}
            {!s.mortgaged[pos] && !groupBuilt && <button type="button" className="ty-btn" onClick={() => onAct({ kind: 'mortgage', pos })}>Mortgage (+{money(mortgageValue(pos))})</button>}
            {s.mortgaged[pos] && s.step !== 'debt' && <button type="button" className="ty-btn" onClick={() => onAct({ kind: 'unmortgage', pos })}>Pay off mortgage ({money(unmortgageCost(pos))})</button>}
          </div>
        )}
        <button type="button" className="ty-btn ty-deed-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

const houseHalf = (pos: number): number => {
  const sp = SPACES[pos];
  return sp.kind === 'property' ? Math.floor(sp.house / 2) : 0;
};

function describeSpace(pos: number): string {
  const sp = SPACES[pos];
  switch (sp.kind) {
    case 'start': return `Collect ${money(START_PAY)} every time you pass or land here.`;
    case 'jail': return `Just visiting, unless you were sent here. To get out: pay ${money(JAIL_FINE)}, use a card, or roll doubles (three tries).`;
    case 'parking': return 'Take a break. With the Coffee Break pot rule on, collect every tax and fine paid so far.';
    case 'gotojail': return 'Go straight to Jail. You don’t pass Start.';
    case 'tax': return `Pay ${money(sp.amount)} to the bank.`;
    case 'surprise': return 'Draw a Surprise card.';
    case 'treasure': return 'Draw a Treasure card.';
    default: return '';
  }
}

// ---- how to play ------------------------------------------------------------------------------

/** The rules in plain words, opened from the lobby and from the table ("How to play") */
function HowToPlay({ onClose }: { onClose: () => void }): JSX.Element {
  const sets = (Object.keys(GROUP_COLORS) as GroupId[]).map((g) => ({ g, n: groupMembers(g).length }));
  return (
    <div className="ty-modal" role="dialog" aria-label="How to play Tycoon" onClick={onClose}>
      <div className="ty-guide" onClick={(e) => e.stopPropagation()}>
        <h4>How to play Tycoon</h4>
        <section>
          <h5>The goal</h5>
          <p>Buy places, charge rent, and be the last one with money. With a round limit (set in the lobby), the richest after the last round wins: cash, places and houses all count.</p>
        </section>
        <section>
          <h5>Your turn</h5>
          <ol>
            <li>Tap <b>🎲 Roll</b>. Your token moves that many spaces.</li>
            <li>Landed on a place nobody owns? <b>Buy</b> it, or say <b>No thanks</b>.</li>
            <li>Someone else’s place? You pay them rent, automatically.</li>
            <li>Build or make deals if you like, then tap <b>End turn</b>.</li>
          </ol>
          <p>Everyone starts with {money(START_CASH)} and gets {money(START_PAY)} each time they pass Start. Doubles: roll again. Three doubles in a row: straight to jail.</p>
        </section>
        <section className="ty-guide-build">
          <h5>🏗️ Building houses and hotels</h5>
          <ol>
            <li><b>Own every place of one colour.</b> Most colours have 3 places, brown and dark blue have 2. Buy them as you land on them, or trade for the missing ones.</li>
            <li>On your turn, tap one of those places: in <b>Your places</b> (a set that’s ready shows 🏗️) or on the board. Then tap <b>Build house</b>.</li>
            <li>Build <b>evenly</b>: every place in the set needs a house before any gets a second one.</li>
            <li>After 4 houses, the next one is a <b>hotel</b>: the highest rent there is.</li>
          </ol>
          <p>Each place’s card shows the house price and the rent at every step. If you can’t build, the card says why (a place still missing, not your turn, not enough cash, a mortgage to pay off). Owning a whole set doubles the rent even before you build.</p>
          <div className="ty-guide-sets">
            {sets.map(({ g, n }) => <span key={g}><i style={{ background: GROUP_COLORS[g] }} />{GROUP_NAMES[g]} · {n}</span>)}
          </div>
        </section>
        <section>
          <h5>Transport and utilities</h5>
          <p>Transport rent goes up with how many you own: {STATION_RENT.map((r) => money(r)).join(', ')}. Utilities charge {UTILITY_TIMES[0]}× the dice roll, or {UTILITY_TIMES[1]}× if you own both. You can’t build on these.</p>
        </section>
        <section>
          <h5>🤝 Deals</h5>
          <p>Tap <b>Make a deal</b> to offer places and cash to another player for theirs. They accept or decline. It’s the way to finish a colour set. Places in a set with houses on it can’t be traded.</p>
        </section>
        <section>
          <h5>Short of money</h5>
          <p><b>Mortgage</b> a place for half its price; it charges no rent until you pay that back (plus 10%). <b>Sell</b> houses for half what they cost. If you owe more than you have, raise the money and tap <b>Pay</b>. If you can’t, declare bankruptcy: you’re out, and what you own goes to the player you owed (or back to the bank).</p>
        </section>
        <section>
          <h5>Jail, cards and Coffee Break</h5>
          <p>To get out of jail: pay {money(JAIL_FINE)}, use a get-out card, or roll doubles (on the third try you pay and go). Surprise and Treasure cards bring money, fines or a trip somewhere. With the Coffee Break pot rule on, whoever lands on Coffee Break collects every tax and fine paid so far.</p>
        </section>
        <section>
          <h5>Left, or away from the keys?</h5>
          <p>If someone leaves, the game plays for them. If you don’t move for a minute, it plays your turn for you.</p>
        </section>
        <button type="button" className="ty-btn ty-btn-go ty-guide-close" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}

// ---- trades ------------------------------------------------------------------------------------

function TradeDialog({ s, me, onSend, onClose }: { s: TyState; me: number; onSend: (a: TyAction) => void; onClose: () => void }): JSX.Element {
  const others = s.players.map((p, i) => ({ p, i })).filter(({ p, i }) => i !== me && !p.bankrupt);
  const [to, setTo] = useState(others[0]?.i ?? -1);
  const [give, setGive] = useState<number[]>([]);
  const [get, setGet] = useState<number[]>([]);
  const [giveCash, setGiveCash] = useState(0);
  const [getCash, setGetCash] = useState(0);
  const tradable = (seat: number) =>
    SPACES.map((_, i) => i).filter((i) => s.owner[i] === seat && !(groupOf(i) && SPACES.some((x, k) => x.kind === 'property' && x.group === groupOf(i) && s.houses[k] > 0)));
  const toggle = (list: number[], set: (l: number[]) => void, i: number) => set(list.includes(i) ? list.filter((x) => x !== i) : [...list, i]);
  const Chip = ({ i, on, click }: { i: number; on: boolean; click: () => void }) => {
    const sp = SPACES[i];
    const color = sp.kind === 'property' ? GROUP_COLORS[sp.group] : '#6b6e78';
    return (
      <button type="button" className={`ty-chip${on ? ' is-on' : ''}`} onClick={click} style={{ ['--chip' as string]: color }}>
        <span className="ty-chip-dot" />
        {sp.name}
        {s.mortgaged[i] ? ' (M)' : ''}
      </button>
    );
  };
  const mine = tradable(me);
  const theirs = to >= 0 ? tradable(to) : [];
  const empty = !give.length && !get.length && !giveCash && !getCash;
  return (
    <div className="ty-modal" role="dialog" aria-label="Make a deal" onClick={onClose}>
      <div className="ty-trade" onClick={(e) => e.stopPropagation()}>
        <h4>Make a deal</h4>
        <label className="ty-field">
          With
          <select value={to} onChange={(e) => { setTo(Number(e.target.value)); setGet([]); setGetCash(0); }}>
            {others.map(({ p, i }) => <option key={i} value={i}>{p.name}</option>)}
          </select>
        </label>
        <div className="ty-trade-cols">
          <div>
            <div className="ty-trade-title">You give</div>
            <div className="ty-chips">{mine.length ? mine.map((i) => <Chip key={i} i={i} on={give.includes(i)} click={() => toggle(give, setGive, i)} />) : <span className="ty-muted">No places to trade</span>}</div>
            <label className="ty-field">Cash <input type="number" min={0} max={s.players[me]?.cash ?? 0} step={100} value={giveCash} onChange={(e) => setGiveCash(Math.max(0, Math.min(s.players[me]?.cash ?? 0, Number(e.target.value) || 0)))} /></label>
          </div>
          <div>
            <div className="ty-trade-title">You get</div>
            <div className="ty-chips">{theirs.length ? theirs.map((i) => <Chip key={i} i={i} on={get.includes(i)} click={() => toggle(get, setGet, i)} />) : <span className="ty-muted">No places to trade</span>}</div>
            <label className="ty-field">Cash <input type="number" min={0} max={s.players[to]?.cash ?? 0} step={100} value={getCash} onChange={(e) => setGetCash(Math.max(0, Math.min(s.players[to]?.cash ?? 0, Number(e.target.value) || 0)))} /></label>
          </div>
        </div>
        <div className="ty-row">
          <button type="button" className="ty-btn ty-btn-go" disabled={empty || to < 0} onClick={() => { onSend({ kind: 'trade', to, giveProps: give, getProps: get, giveCash, getCash }); onClose(); }}>Send offer</button>
          <button type="button" className="ty-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function tradeSummary(s: TyState): { give: string; get: string } {
  const t = s.trade!;
  const list = (props: number[], cash: number) => [...props.map((i) => SPACES[i].name), ...(cash ? [money(cash)] : [])].join(', ');
  return { give: list(t.giveProps, t.giveCash), get: list(t.getProps, t.getCash) };
}

// ---- the game ----------------------------------------------------------------------------------

export interface TycoonProps {
  activityId: string;
}

export default function Tycoon({ activityId }: TycoonProps): JSX.Element {
  const room = useRoom();
  const key = `act:${activityId}`;
  const [s, dispatch] = useSharedState<TyState, TyAction>(key, OPTIONS);
  const presence = useSharedPresence(key, OPTIONS);
  const selfId = room.getSelfId();
  const presentKey = presence.members.join(',');
  const present = useMemo(() => new Set(presentKey.split(',')), [presentKey]);
  const isAuthority = presence.authorityId === selfId;
  const hostId = room.getHostPeerId();
  const canManage = room.getSelf().isHost || !hostId || !present.has(hostId);
  const me = seatOf(s, selfId);
  const myTurn = s.phase === 'playing' && s.turn === me && me >= 0;
  const away = (seat: number) => Boolean(s.players[seat] && !s.players[seat].bot && !present.has(s.players[seat].id));
  const current = s.players[s.turn];

  // Back after the phone dropped out, a reload or a rejoin (a new peer id): your seat is yours
  // again, and the computer stops playing for you (the same app: its client id)
  const myCid = getClientId();
  const oldSeat = me < 0 ? s.players.findIndex((p, i) => !p.bot && p.cid === myCid && away(i)) : -1;
  const reclaimKey = oldSeat >= 0 ? `${oldSeat}:${s.players[oldSeat].id}` : '';
  useEffect(() => {
    if (!reclaimKey) return undefined;
    const ask = () => dispatch({ kind: 'join', name: room.getSelf().username });
    ask();
    // again in a moment if the first ask came before the others knew which app we are
    const t = setInterval(ask, 3000);
    return () => clearInterval(t);
  }, [reclaimKey, dispatch, room]);

  // ---- token walking ----
  const [shownPos, setShownPos] = useState<number[]>(() => s.players.map((p) => p.pos));
  const lastJump = useRef<number>(0);
  const walking = s.players.some((p, i) => (shownPos[i] ?? p.pos) !== p.pos);
  useEffect(() => {
    if (shownPos.length !== s.players.length) {
      setShownPos(s.players.map((p) => p.pos));
      return undefined;
    }
    if (!walking) return undefined;
    const jump = s.move && s.move.jump && s.move.seq !== lastJump.current ? s.move : null;
    const t = setTimeout(() => {
      if (jump) lastJump.current = jump.seq;
      setShownPos((prev) =>
        s.players.map((p, i) => {
          const at = prev[i] ?? p.pos;
          if (at === p.pos) return at;
          if (jump && jump.seat === i) return p.pos;
          // walk forward one space (backwards for "go back 3 spaces")
          const ahead = (p.pos - at + 40) % 40;
          return (at + (ahead <= 20 ? 1 : -1) + 40) % 40;
        })
      );
    }, jump ? 350 : HOP_MS);
    return () => clearTimeout(t);
  }, [s.players, s.move, shownPos, walking]);

  // ---- dice ----
  const diceKey = s.dice ? `${s.dice[0]}${s.dice[1]}:${s.log.length}` : '';
  const [rolling, setRolling] = useState(false);
  const prevDice = useRef(diceKey);
  useEffect(() => {
    if (!diceKey || prevDice.current === diceKey) return undefined;
    prevDice.current = diceKey;
    setRolling(true);
    sound.playPop();
    const t = setTimeout(() => setRolling(false), 520);
    return () => clearTimeout(t);
  }, [diceKey]);

  // your turn: chime
  const turnKey = `${s.turn}:${s.round}:${s.phase}`;
  const prevTurn = useRef(turnKey);
  useEffect(() => {
    if (prevTurn.current === turnKey) return;
    prevTurn.current = turnKey;
    if (myTurn) {
      sound.playChime();
      try {
        navigator.vibrate?.(60);
      } catch {
        /* not supported */
      }
    }
  }, [turnKey, myTurn]);

  // ---- the card just drawn ----
  const [cardSeen, setCardSeen] = useState(s.card?.seq ?? 0);
  const showCard = s.card && s.card.seq !== cardSeen && !walking ? s.card : null;
  useEffect(() => {
    if (!showCard) return undefined;
    const t = setTimeout(() => setCardSeen(showCard.seq), 4500);
    return () => clearTimeout(t);
  }, [showCard]);

  // ---- authority: computers, people away, idle players, offers to computers ----
  useEffect(() => {
    if (!isAuthority || s.phase !== 'playing' || !current) return undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (s.trade && s.players[s.trade.to]?.bot) timers.push(setTimeout(() => dispatch({ kind: 'auto', seq: s.seq, mode: 'trade' }), BOT_TRADE_MS));
    else {
      const delay = current.bot ? BOT_STEP_MS + (walking ? 900 : 0) : away(s.turn) ? AWAY_MS : IDLE_MS;
      timers.push(setTimeout(() => dispatch({ kind: 'auto', seq: s.seq, mode: 'turn' }), delay));
    }
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthority, s.phase, s.seq, s.turn, s.trade, present, walking]);

  // ---- local UI ----
  const [deed, setDeed] = useState<number | null>(null);
  const [trading, setTrading] = useState(false);
  const [guide, setGuide] = useState(false);
  const [confirmBankrupt, setConfirmBankrupt] = useState(-1);

  const incoming = s.phase === 'playing' && s.trade && s.trade.to === me ? s.trade : null;
  const outgoing = s.trade && s.trade.from === me ? s.trade : null;
  const debtTotal = s.debt ? s.debt.payees.reduce((n, p) => n + p.amount, 0) : 0;

  useActivityStatus({
    attention: Boolean(myTurn || incoming),
    color: current?.color || '',
    label: incoming ? 'A deal for you' : myTurn ? (s.step === 'debt' ? 'Pay up!' : s.step === 'buy' ? 'Buy it?' : s.step === 'roll' ? 'Roll!' : 'End your turn') : ''
  });

  // ---- lobby -----------------------------------------------------------------------------------------
  if (s.phase === 'lobby') {
    const joined = me >= 0;
    const taken = new Set(s.players.map((p) => p.token));
    return (
      <div className="ty ty-lobby">
        <div className="ty-lobby-card">
          <div className="ty-lobby-head">
            <svg viewBox="-30 0 260 70" className="ty-lobby-logo" aria-hidden="true">
              <text x={100} y={52} textAnchor="middle" fontSize={50} fontWeight={900} fill="#e0393e" stroke="#23252d" strokeWidth={3} paintOrder="stroke" fontFamily="'Bricolage Grotesque Variable', 'Figtree Variable', sans-serif">TYCOON</text>
            </svg>
            <p className="ty-muted">Buy famous streets around the world, collect rent, build houses and hotels, make deals. Last one standing wins.</p>
            <button type="button" className="ty-btn ty-btn-sm ty-guide-btn" onClick={() => setGuide(true)}>📖 How to play</button>
          </div>
          <ul className="ty-players">
            {s.players.map((p, i) => (
              <li key={p.id} className="ty-player-row">
                <Token token={p.token} color={p.color} size={32} />
                <span className="ty-player-name">{p.name}{p.id === selfId ? ' (you)' : ''}{away(i) && <span className="ty-tag">away</span>}</span>
                {(p.id === selfId || canManage) && (
                  <button type="button" className="ty-btn ty-btn-sm" onClick={() => dispatch(p.id === selfId ? { kind: 'leave' } : { kind: 'remove', seat: i })}>{p.id === selfId ? 'Leave' : 'Remove'}</button>
                )}
              </li>
            ))}
            {!s.players.length && <li className="ty-muted">Nobody yet.</li>}
          </ul>
          {joined && (
            <div className="ty-token-pick" role="group" aria-label="Your token">
              {TOKENS.map((t) => (
                <button key={t} type="button" className={`ty-token-btn${s.players[me].token === t ? ' is-on' : ''}`} disabled={taken.has(t) && s.players[me].token !== t} onClick={() => dispatch({ kind: 'token', token: t })} aria-label={TOKEN_NAMES[t]} title={TOKEN_NAMES[t]}>
                  <Token token={t} color={s.players[me].color} size={34} ghost={taken.has(t) && s.players[me].token !== t} />
                </button>
              ))}
            </div>
          )}
          <div className="ty-row">
            {!joined && s.players.length < 6 && <button type="button" className="btn btn-primary" onClick={() => dispatch({ kind: 'join', name: room.getSelf().username })}>Join the game</button>}
            {canManage && s.players.length < 6 && <button type="button" className="ty-btn" onClick={() => dispatch({ kind: 'add-bot' })}>+ Computer</button>}
          </div>
          <div className="ty-rules">
            <div className="ty-rules-title">House rules{canManage ? '' : ' (the host sets these)'}</div>
            <label className="ty-rule"><input type="checkbox" checked={s.rules.jackpot} disabled={!canManage} onChange={(e) => dispatch({ kind: 'rules', rules: { jackpot: e.target.checked } })} /><span>Coffee Break pot: taxes and fines pile up for whoever lands on Coffee Break</span></label>
            <div className="ty-rule">
              <span>Game length</span>
              <select value={s.rules.rounds} disabled={!canManage} onChange={(e) => dispatch({ kind: 'rules', rules: { rounds: Number(e.target.value) } })}>
                {ROUND_OPTIONS.map((r) => <option key={r} value={r}>{r ? `${r} rounds, then richest wins` : 'Until one player is left'}</option>)}
              </select>
            </div>
          </div>
          {canManage || joined ? (
            <button type="button" className="btn btn-primary ty-start" disabled={s.players.length < 2} onClick={() => dispatch({ kind: 'start' })}>{s.players.length < 2 ? 'Need 2 players' : `Start (${s.players.length} players)`}</button>
          ) : (
            <p className="ty-muted">A player or the host starts the game.</p>
          )}
        </div>
        {guide && <HowToPlay onClose={() => setGuide(false)} />}
      </div>
    );
  }

  // ---- table -------------------------------------------------------------------------------------------
  const myPlaces = me >= 0 ? SPACES.map((_, i) => i).filter((i) => s.owner[i] === me) : [];
  const canBuildNow = myTurn && myPlaces.some((i) => !buildBlock(s, me, i));
  const status = (() => {
    if (s.phase === 'over') return s.winner === me ? 'You won! 🏆' : `${s.players[s.winner ?? 0]?.name} won! 🏆`;
    if (!current) return '';
    if (!myTurn) {
      if (current.bot) return `${current.name} is playing…`;
      if (away(s.turn)) return `${current.name} left: playing for them shortly.`;
      return `${current.name}'s turn.`;
    }
    switch (s.step) {
      case 'roll': return current.jail ? 'You’re in jail: roll doubles, pay, or use a card.' : s.doubles ? 'Doubles! Roll again.' : 'Your turn: roll the dice.';
      case 'buy': return `Buy ${SPACES[s.pendingBuy!].name} for ${money(priceOf(s.pendingBuy!))}?`;
      case 'debt': return `You owe ${money(debtTotal)} (${s.debt?.reason}). Sell houses or mortgage places, then pay.`;
      default: return canBuildNow ? 'You can build: tap a place marked 🏗️ in Your places. Or make a deal, or end your turn.' : 'Make a deal, or end your turn.';
    }
  })();

  const card = showCard ? (showCard.deck === 's' ? SURPRISE : TREASURE)[showCard.index] : null;

  return (
    <div className={`ty ty-phase-${s.phase}`}>
      <div className="ty-board-wrap">
        <BoardView s={s} shownPos={shownPos} rolling={rolling} highlight={s.step === 'buy' && s.pendingBuy !== null && !walking ? s.pendingBuy : null} onSpace={setDeed} />
        {showCard && card && (
          <button type="button" className={`ty-card ty-card-${showCard.deck}`} onClick={() => setCardSeen(showCard.seq)} aria-label="Close card">
            <span className="ty-card-head">
              <svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true"><SpaceIcon kind={showCard.deck === 's' ? 'surprise' : 'treasure'} x={0} y={0} s={40} /></svg>
              {showCard.deck === 's' ? 'SURPRISE' : 'TREASURE'}
            </span>
            <span className="ty-card-text">{card.text}</span>
            <span className="ty-card-who">{s.players[showCard.seat]?.name}</span>
          </button>
        )}
      </div>

      <aside className="ty-panel">
        <div className="ty-turn" style={{ ['--turn' as string]: current?.color || '#888' }}>
          <p className="ty-status" data-testid="ty-status" aria-live="polite">{status}</p>
          {myTurn && !walking && (
            <div className="ty-actions">
              {s.step === 'roll' && <button type="button" className="ty-btn ty-btn-go ty-btn-big" onClick={() => dispatch({ kind: 'roll' })}>🎲 Roll</button>}
              {s.step === 'roll' && current.jail > 0 && current.cash >= JAIL_FINE && <button type="button" className="ty-btn" onClick={() => dispatch({ kind: 'pay-jail' })}>Pay {money(JAIL_FINE)}</button>}
              {s.step === 'roll' && current.jail > 0 && current.jailCards.length > 0 && <button type="button" className="ty-btn" onClick={() => dispatch({ kind: 'jail-card' })}>Use card</button>}
              {s.step === 'buy' && (
                <>
                  <button type="button" className="ty-btn ty-btn-go ty-btn-big" disabled={current.cash < priceOf(s.pendingBuy!)} onClick={() => dispatch({ kind: 'buy' })}>Buy {money(priceOf(s.pendingBuy!))}</button>
                  <button type="button" className="ty-btn" onClick={() => dispatch({ kind: 'skip' })}>No thanks</button>
                  <button type="button" className="ty-btn ty-btn-sm" onClick={() => setDeed(s.pendingBuy)}>Details</button>
                </>
              )}
              {s.step === 'debt' && (
                <>
                  <button type="button" className="ty-btn ty-btn-go" disabled={current.cash < debtTotal} onClick={() => dispatch({ kind: 'pay-debt' })}>Pay {money(debtTotal)}</button>
                  {confirmBankrupt === s.seq ? (
                    <button type="button" className="ty-btn ty-btn-danger" onClick={() => dispatch({ kind: 'bankrupt' })}>Yes, I’m bankrupt</button>
                  ) : (
                    <button type="button" className="ty-btn" onClick={() => setConfirmBankrupt(s.seq)}>Declare bankruptcy</button>
                  )}
                </>
              )}
              {s.step === 'done' && <button type="button" className="ty-btn ty-btn-go ty-btn-big" onClick={() => dispatch({ kind: 'end-turn' })}>End turn</button>}
            </div>
          )}
          {s.phase === 'over' && (canManage || me >= 0) && (
            <div className="ty-actions"><button type="button" className="btn btn-primary" onClick={() => dispatch({ kind: 'again' })}>Play again</button></div>
          )}
        </div>

        {incoming && (() => {
          const t = tradeSummary(s);
          return (
            <div className="ty-offer" role="alert">
              <b>{s.players[incoming.from].name}</b> {t.give && t.get ? <>offers {t.give} for your {t.get}.</> : t.give ? <>offers you {t.give}.</> : <>asks you for {t.get}.</>}
              <div className="ty-row">
                <button type="button" className="ty-btn ty-btn-go" onClick={() => dispatch({ kind: 'trade-answer', accept: true })}>Accept</button>
                <button type="button" className="ty-btn" onClick={() => dispatch({ kind: 'trade-answer', accept: false })}>Decline</button>
              </div>
            </div>
          );
        })()}
        {outgoing && (
          <div className="ty-offer">
            Waiting for {s.players[outgoing.to].name} to answer your offer…
            <div className="ty-row"><button type="button" className="ty-btn ty-btn-sm" onClick={() => dispatch({ kind: 'trade-cancel' })}>Withdraw</button></div>
          </div>
        )}

        <ul className="ty-standings">
          {s.players.map((p, i) => (
            <li key={p.id} className={`ty-standing${i === s.turn && s.phase === 'playing' ? ' is-turn' : ''}${p.bankrupt ? ' is-out' : ''}${s.winner === i ? ' is-winner' : ''}`} style={{ ['--pc' as string]: p.color }}>
              <Token token={p.token} color={p.color} size={28} ghost={p.bankrupt} />
              <span className="ty-standing-main">
                <span className="ty-standing-name">{p.name}{i === me ? ' (you)' : ''}{away(i) && <span className="ty-tag">away</span>}{p.jail > 0 && <span className="ty-tag">in jail</span>}</span>
                <span className="ty-standing-sub">{p.bankrupt ? 'bankrupt' : `${SPACES.filter((_, k) => s.owner[k] === i).length} places · worth ${money(netWorth(s, i))}`}</span>
              </span>
              <span className="ty-cash">{money(p.cash)}</span>
            </li>
          ))}
        </ul>

        {me >= 0 && !s.players[me].bankrupt && s.phase === 'playing' && (
          <>
            <div className="ty-section-title">
              Your places
              {!s.trade && <button type="button" className="ty-btn ty-btn-sm" onClick={() => setTrading(true)}>🤝 Make a deal</button>}
            </div>
            <div className="ty-chips">
              {myPlaces.length ? myPlaces.map((i) => {
                const sp = SPACES[i];
                return (
                  <button key={i} type="button" className={`ty-chip${s.mortgaged[i] ? ' is-mortgaged' : ''}${sp.kind === 'property' && ownsGroup(s, me, i) ? ' is-set' : ''}`} style={{ ['--chip' as string]: sp.kind === 'property' ? GROUP_COLORS[sp.group] : '#6b6e78' }} onClick={() => setDeed(i)}
                    title={sp.kind === 'property' && ownsGroup(s, me, i) ? 'You own the whole colour set: tap to build houses' : undefined}>
                    <span className="ty-chip-dot" />
                    {sp.name}
                    {sp.kind === 'property' && ownsGroup(s, me, i) && s.houses[i] === 0 && <span className="ty-chip-set" aria-label="whole set: you can build"> 🏗️</span>}
                    {s.houses[i] === 5 ? ' 🏨' : s.houses[i] ? ` ${'🏠'.repeat(s.houses[i])}` : ''}
                  </button>
                );
              }) : <span className="ty-muted">None yet. Tap any space on the board for details. Own every place of one colour to build houses.</span>}
            </div>
          </>
        )}

        <ol className="ty-log" aria-label="What happened">
          {s.log.slice(-6).reverse().map((l, i) => <li key={`${s.log.length}-${i}`}>{l}</li>)}
        </ol>

        <div className="ty-row">
          <button type="button" className="ty-btn ty-btn-sm ty-guide-btn" onClick={() => setGuide(true)}>📖 How to play</button>
          {canManage && s.phase === 'playing' && (
            <button type="button" className="ty-btn ty-btn-sm ty-end" onClick={() => dispatch({ kind: 'end-game' })}>End game now (richest wins)</button>
          )}
        </div>
      </aside>

      {deed !== null && <Deed s={s} pos={deed} me={me} onAct={dispatch} onClose={() => setDeed(null)} />}
      {trading && me >= 0 && <TradeDialog s={s} me={me} onSend={dispatch} onClose={() => setTrading(false)} />}
      {guide && <HowToPlay onClose={() => setGuide(false)} />}
    </div>
  );
}
