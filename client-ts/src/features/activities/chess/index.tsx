/**
 * Chess for two (people or the computer); everyone else in the room watches. Rules: ./engine.ts
 * and ./rules.ts (runs on the authority). This file draws the board (vector pieces from
 * ./pieces.tsx), handles tap and drag moves, animates moves, and on the authority's app plays the
 * computer's moves.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { getClientId } from '../../../utils/clientId';
import { useRoom, useSharedState, useSharedPresence } from '../../../core/RoomContext';
import { useActivityStatus } from '../activityHost';
import { sound } from '../../../utils/sound';
import {
  COLORS,
  COLOR_NAMES,
  INITIAL,
  capturedPieces,
  reducer,
  seatOf,
  type ChessAction,
  type ChessState,
  type ResultReason
} from './rules';
import {
  PIECE_VALUE,
  colorOf,
  inCheck,
  kingSquare,
  legalMoves,
  typeOf,
  type ChessColor,
  type Move,
  type PromotionPiece
} from './engine';
import { Piece, PieceIcon } from './pieces';
import './chess.css';

const BOT_DELAY_MS = 700;
const SQ = 100; // one square in board units
const FILES = 'abcdefgh';

const REASONS: Record<ResultReason, string> = {
  checkmate: 'by checkmate',
  resign: 'by resignation',
  stalemate: 'Stalemate: a draw',
  repetition: 'Draw by threefold repetition',
  fifty: 'Draw by the fifty-move rule',
  material: 'Draw: not enough pieces left to mate',
  agreed: 'Draw agreed'
};

// ---- Board -----------------------------------------------------------------------------

interface BoardProps {
  state: ChessState;
  flipped: boolean;
  /** this person may move pieces of this colour now */
  canMove: ChessColor | null;
  onMove: (move: Move) => void;
}

interface Drag {
  from: number;
  x: number;
  y: number;
  moved: boolean;
}

/** Where a square is drawn (board units, top-left) */
function squareXY(sq: number, flipped: boolean): { x: number; y: number } {
  const row = sq >> 3;
  const col = sq & 7;
  return flipped ? { x: (7 - col) * SQ, y: (7 - row) * SQ } : { x: col * SQ, y: row * SQ };
}

/** The animations for the last move: piece square -> where it came from (rook too, when castling) */
function lastMoveSlides(state: ChessState): Map<number, number> {
  const slides = new Map<number, number>();
  const last = state.moves[state.moves.length - 1];
  if (!last) return slides;
  slides.set(last.to, last.from);
  if (last.san.startsWith('O-O')) {
    const kingSide = last.to > last.from;
    slides.set(kingSide ? last.from + 1 : last.from - 1, kingSide ? last.from + 3 : last.from - 4);
  }
  return slides;
}

function Board({ state, flipped, canMove, onMove }: BoardProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = `chess-clip-${useId().replace(/:/g, '')}`;
  // What's picked up belongs to one position: a new one (any move) puts it down
  const [picked, setPicked] = useState<{ seq: number; sq: number | null }>({ seq: -1, sq: null });
  const [dragged, setDragged] = useState<{ seq: number; drag: Drag | null }>({ seq: -1, drag: null });
  const [promoting, setPromoting] = useState<{ seq: number; move: Move | null }>({ seq: -1, move: null });
  const selected = picked.seq === state.seq ? picked.sq : null;
  const drag = dragged.seq === state.seq ? dragged.drag : null;
  const promotion = promoting.seq === state.seq ? promoting.move : null;
  const setSelected = (sq: number | null): void => setPicked({ seq: state.seq, sq });
  const setDrag = (d: Drag | null): void => setDragged({ seq: state.seq, drag: d });
  const setPromotion = (move: Move | null): void => setPromoting({ seq: state.seq, move });
  // A move made here by dragging is already where it belongs: don't slide it in again
  const droppedRef = useRef<string>('');

  const { pos } = state;
  const legal = useMemo(() => (canMove ? legalMoves(pos) : []), [pos, canMove]);
  const from = drag?.from ?? selected;
  const targets = useMemo(
    () => new Set(from === null ? [] : legal.filter((m) => m.from === from).map((m) => m.to)),
    [legal, from]
  );

  const last = state.moves[state.moves.length - 1] || null;
  const slides = useMemo(() => lastMoveSlides(state), [state]);
  const lastKey = last ? `${last.from}-${last.to}` : '';
  const skipSlide = droppedRef.current === `${state.moves.length}:${lastKey}`;
  const checkSq = state.phase !== 'lobby' && inCheck(pos) ? kingSquare(pos.board, pos.turn) : -1;

  const pointSquare = (e: { clientX: number; clientY: number }): { sq: number; x: number; y: number } | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const col = Math.floor(pt.x / SQ);
    const row = Math.floor(pt.y / SQ);
    if (col < 0 || col > 7 || row < 0 || row > 7) return { sq: -1, x: pt.x, y: pt.y };
    const sq = flipped ? (7 - row) * 8 + (7 - col) : row * 8 + col;
    return { sq, x: pt.x, y: pt.y };
  };

  const tryMove = (to: number, viaDrag: boolean): boolean => {
    if (from === null) return false;
    const options = legal.filter((m) => m.from === from && m.to === to);
    if (!options.length) return false;
    if (options.some((m) => m.promo)) {
      setPromotion({ from, to });
      return true;
    }
    if (viaDrag) droppedRef.current = `${state.moves.length + 1}:${from}-${to}`;
    onMove(options[0]);
    return true;
  };

  const mine = (sq: number): boolean => sq >= 0 && canMove !== null && colorOf(pos.board[sq]) === canMove;

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!canMove || promotion || e.button > 0) return;
    const hit = pointSquare(e);
    if (!hit) return;
    if (selected !== null && targets.has(hit.sq)) {
      tryMove(hit.sq, false);
      return;
    }
    if (mine(hit.sq)) {
      e.preventDefault();
      svgRef.current?.setPointerCapture(e.pointerId);
      setDrag({ from: hit.sq, x: hit.x, y: hit.y, moved: false });
      setSelected(hit.sq);
    } else {
      setSelected(null);
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drag) return;
    const hit = pointSquare(e);
    if (!hit) return;
    const moved = drag.moved || Math.hypot(hit.x - drag.x, hit.y - drag.y) > 12;
    setDrag({ ...drag, x: hit.x, y: hit.y, moved });
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drag) return;
    const hit = pointSquare(e);
    const wasDrag = drag.moved;
    setDrag(null);
    if (!hit || !wasDrag) return; // a tap: the piece stays selected
    if (hit.sq !== drag.from && !tryMove(hit.sq, true)) setSelected(null);
  };

  const squares: JSX.Element[] = [];
  const marks: JSX.Element[] = [];
  const pieces: JSX.Element[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const { x, y } = squareXY(sq, flipped);
    const light = ((sq >> 3) + (sq & 7)) % 2 === 0;
    squares.push(<rect key={sq} x={x} y={y} width={SQ} height={SQ} className={light ? 'chess-sq-light' : 'chess-sq-dark'} />);
    if (last && (sq === last.from || sq === last.to)) {
      marks.push(<rect key={`l${sq}`} x={x} y={y} width={SQ} height={SQ} className="chess-mark-last" />);
    }
    if (sq === from) marks.push(<rect key={`s${sq}`} x={x} y={y} width={SQ} height={SQ} className="chess-mark-selected" />);
    if (sq === checkSq) marks.push(<rect key={`c${sq}`} x={x} y={y} width={SQ} height={SQ} className="chess-mark-check" />);
    const piece = pos.board[sq];
    if (piece !== '.' && !(drag?.moved && drag.from === sq)) {
      const slideFrom = !skipSlide ? slides.get(sq) : undefined;
      const origin = slideFrom !== undefined ? squareXY(slideFrom, flipped) : null;
      pieces.push(
        <g
          key={origin ? `${sq}:${state.seq}` : `${sq}`}
          className={`chess-piece${origin ? ' is-sliding' : ''}${mine(sq) ? ' is-mine' : ''}`}
          style={origin ? ({ '--dx': `${origin.x - x}px`, '--dy': `${origin.y - y}px` } as CSSProperties) : undefined}
        >
          <Piece type={typeOf(piece)} color={colorOf(piece)!} x={x + 4} y={y + 4} size={92} />
        </g>
      );
    }
  }
  const hints: JSX.Element[] = [];
  targets.forEach((sq) => {
    const { x, y } = squareXY(sq, flipped);
    const capture = pos.board[sq] !== '.' || (typeOf(pos.board[from ?? 0]) === 'p' && sq === pos.ep);
    hints.push(
      capture ? (
        <circle key={`h${sq}`} cx={x + 50} cy={y + 50} r={44} className="chess-hint-capture" />
      ) : (
        <circle key={`h${sq}`} cx={x + 50} cy={y + 50} r={15} className="chess-hint" />
      )
    );
  });

  const promoColor = pos.turn;
  return (
    <div className="chess-board-box">
      <svg
        ref={svgRef}
        className={`chess-board${canMove ? ' can-move' : ''}`}
        viewBox="-34 0 834 834"
        role="img"
        aria-label="Chess board"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={800} height={800} rx={10} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          {squares}
          {marks}
        </g>
        {Array.from({ length: 8 }, (_, i) => (
          <text key={`r${i}`} x={-17} y={i * SQ + 58} className="chess-coord">
            {flipped ? i + 1 : 8 - i}
          </text>
        ))}
        {Array.from({ length: 8 }, (_, i) => (
          <text key={`f${i}`} x={i * SQ + 50} y={828} className="chess-coord">
            {flipped ? FILES[7 - i] : FILES[i]}
          </text>
        ))}
        <g>{hints}</g>
        <g>{pieces}</g>
        {drag?.moved && pos.board[drag.from] !== '.' && (
          <g className="chess-piece is-dragging">
            <Piece
              type={typeOf(pos.board[drag.from])}
              color={colorOf(pos.board[drag.from])!}
              x={drag.x - 55}
              y={drag.y - 60}
              size={110}
            />
          </g>
        )}
      </svg>
      {promotion && (
        <div className="chess-promo" role="dialog" aria-label="Promote to">
          <div className="chess-promo-card">
            <span className="chess-promo-title">Promote to</span>
            <div className="chess-promo-row">
              {(['q', 'r', 'b', 'n'] as PromotionPiece[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="chess-promo-btn"
                  aria-label={{ q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[t]}
                  onClick={() => {
                    onMove({ ...promotion, promo: t });
                    setPromotion(null);
                  }}
                >
                  <PieceIcon type={t} color={promoColor} />
                </button>
              ))}
            </div>
            <button type="button" className="chess-mini-btn" onClick={() => setPromotion(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Panel pieces ----------------------------------------------------------------------

/** The pieces a player has taken (of `color`), and how far ahead in material they are */
function Captured({ pieces, color, advantage }: { pieces: string[]; color: ChessColor; advantage: number }): JSX.Element {
  return (
    <span className="chess-captured">
      {pieces.map((t, i) => (
        <PieceIcon key={i} type={t} color={color} className="chess-captured-icon" />
      ))}
      {advantage > 0 && <span className="chess-adv">+{advantage}</span>}
    </span>
  );
}

function MoveList({ state }: { state: ChessState }): JSX.Element | null {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.moves.length]);
  if (!state.moves.length) return null;
  const rows: [string, string | undefined][] = [];
  for (let i = 0; i < state.moves.length; i += 2) rows.push([state.moves[i].san, state.moves[i + 1]?.san]);
  return (
    <ol className="chess-moves" ref={listRef} data-testid="chess-moves">
      {rows.map(([w, b], i) => (
        <li key={i}>
          <span className="chess-move-no">{i + 1}.</span>
          <span className="chess-move">{w}</span>
          <span className="chess-move">{b || ''}</span>
        </li>
      ))}
    </ol>
  );
}

// ---- Board turned around (this device only) ------------------------------------------------

const FLIP_KEY = '3rtc_chess_flip';
let flipMemory = false; // when storage isn't available
const readFlip = (): boolean => {
  try {
    const saved = localStorage.getItem(FLIP_KEY);
    if (saved !== null) return saved === '1';
  } catch {
    /* no storage: the in-memory value */
  }
  return flipMemory;
};
const saveFlip = (value: boolean): void => {
  flipMemory = value;
  try {
    localStorage.setItem(FLIP_KEY, value ? '1' : '0');
  } catch {
    /* kept in memory for this session */
  }
};

// ---- The game ----------------------------------------------------------------------------

export interface ChessProps {
  activityId: string;
}

export default function Chess({ activityId }: ChessProps): JSX.Element {
  const room = useRoom();
  const key = `act:${activityId}`;
  const [state, dispatch] = useSharedState<ChessState, ChessAction>(key, { initial: INITIAL, reducer });
  const presence = useSharedPresence(key, { initial: INITIAL, reducer });
  const selfId = room.getSelfId();
  const presentKey = presence.members.join(',');
  const present = useMemo(() => new Set(presentKey.split(',')), [presentKey]);
  const isAuthority = presence.authorityId === selfId;
  const hostId = room.getHostPeerId();
  const canManage = room.getSelf().isHost || !hostId || !present.has(hostId);
  const myColor = seatOf(state, selfId);
  const turn = state.pos.turn;
  const nameOf = (c: ChessColor): string => state.seats[c]?.name || COLOR_NAMES[c];
  const seatAway = (c: ChessColor): boolean =>
    Boolean(state.seats[c] && !state.seats[c]?.bot && !present.has(state.seats[c]!.id));

  // Black plays from the top of the board; spectators can turn it around
  // The game remounts when it moves between views (sidebar, window, full), so the turn of the
  // board is kept outside it: the same after a view change or a reload
  const [flipView, setFlipViewState] = useState(readFlip);
  const setFlipView = (update: (v: boolean) => boolean): void =>
    setFlipViewState((v) => {
      const next = update(v);
      saveFlip(next);
      return next;
    });
  const flipped = myColor ? (myColor === 'b') !== flipView : flipView;
  // "Resign?" asks once; any move or the game ending takes the question away
  const [resignAsked, setResignAsked] = useState(-1);
  const confirmResign = resignAsked === state.seq;
  const setConfirmResign = (ask: boolean): void => setResignAsked(ask ? state.seq : -1);

  const myTurn = state.phase === 'playing' && myColor === turn;
  const drawToMe = state.phase === 'playing' && myColor !== null && state.drawOffer !== null && state.drawOffer !== myColor;

  useActivityStatus({
    attention: myTurn || drawToMe,
    color: state.phase === 'playing' ? (turn === 'w' ? '#f4f4ee' : '#7a9f57') : '',
    label: drawToMe ? 'Draw offered' : myTurn ? (inCheck(state.pos) ? 'Check! Your move' : 'Your move') : ''
  });

  // Sounds: a click for every move, a chime (and a buzz on phones) when it becomes your move
  const movesCount = state.moves.length;
  const myTurnRef = useRef(myTurn);
  myTurnRef.current = myTurn;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!movesCount) return;
    if (myTurnRef.current) {
      sound.playChime();
      try {
        navigator.vibrate?.(60);
      } catch {
        /* not supported */
      }
    } else {
      sound.playPop();
    }
  }, [movesCount]);

  // Authority only: the computer's moves
  useEffect(() => {
    if (!isAuthority || state.phase !== 'playing' || !state.seats[turn]?.bot) return undefined;
    const t = setTimeout(() => dispatch({ kind: 'auto', seq: state.seq }), BOT_DELAY_MS);
    return () => clearTimeout(t);
  }, [isAuthority, state.phase, state.seq, state.seats, turn, dispatch]);

  // Back after a reload or rejoin: the seat you had is yours again
  const myCid = getClientId();
  const myOldSeat = !myColor ? COLORS.find((c) => seatAway(c) && state.seats[c]?.cid === myCid) || null : null;
  const reclaimKey = myOldSeat ? `${myOldSeat}:${state.seats[myOldSeat]?.id}` : '';
  useEffect(() => {
    if (!reclaimKey) return;
    dispatch({ kind: 'sit', color: reclaimKey.split(':')[0] as ChessColor, name: room.getSelf().username });
  }, [reclaimKey, dispatch, room]);

  const sit = (color: ChessColor) => dispatch({ kind: 'sit', color, name: room.getSelf().username });

  const captured = capturedPieces(state.pos.board);
  const material = (c: ChessColor): number => captured[c].reduce((n, t) => n + PIECE_VALUE[t] / 100, 0);
  // What each side has taken = the other side's losses
  const taken = (c: ChessColor): string[] => captured[c === 'w' ? 'b' : 'w'];
  const advantage = (c: ChessColor): number => Math.round(material(c === 'w' ? 'b' : 'w') - material(c));

  const status = (): string => {
    if (state.phase === 'lobby') {
      if (!state.seats.w || !state.seats.b) return myColor ? 'Waiting for an opponent.' : 'Pick a side to play, or watch.';
      return 'Both seats taken. Ready to start.';
    }
    if (state.phase === 'over' && state.result) {
      const { winner, reason } = state.result;
      if (!winner) return `${REASONS[reason]}.`;
      const who = myColor === winner ? 'You win' : `${nameOf(winner)} wins`;
      return `${who} ${REASONS[reason]}.`;
    }
    const check = inCheck(state.pos) ? 'Check! ' : '';
    if (myTurn) return `${check}Your move.`;
    if (state.seats[turn]?.bot) return `${check}The computer is thinking…`;
    if (seatAway(turn)) return `${check}${nameOf(turn)} left the game.`;
    return `${check}${nameOf(turn)} to move.`;
  };

  // Seats shown in board order: top player first
  const topColor: ChessColor = flipped ? 'w' : 'b';
  const seatOrder: ChessColor[] = [topColor, topColor === 'w' ? 'b' : 'w'];

  return (
    <div className={`chess chess-phase-${state.phase}`}>
      <div className="chess-board-wrap">
        <Board
          state={state}
          flipped={flipped}
          canMove={myTurn ? myColor : null}
          onMove={(m) => dispatch({ kind: 'move', from: m.from, to: m.to, ...(m.promo ? { promo: m.promo } : {}) })}
        />
      </div>
      <aside className="chess-panel">
        <p className="chess-status" data-testid="chess-status" aria-live="polite">
          {status()}
        </p>

        <ul className="chess-seats">
          {seatOrder.map((color) => {
            const seat = state.seats[color];
            const away = seatAway(color);
            return (
              <li key={color} className={`chess-seat${state.phase === 'playing' && turn === color ? ' is-turn' : ''}`}>
                <span className={`chess-seat-chip chess-chip-${color}`} aria-hidden="true">
                  <PieceIcon type="k" color={color} />
                </span>
                <span className="chess-seat-main">
                  <span className="chess-seat-name">
                    {seat ? (seat.id === selfId ? `${seat.name} (you)` : seat.name) : <em>{COLOR_NAMES[color]}: free</em>}
                    {away && <span className="chess-tag">away</span>}
                    {state.result?.winner === color && <span className="chess-tag chess-tag-win">winner</span>}
                  </span>
                  {state.phase !== 'lobby' && <Captured pieces={taken(color)} color={color === 'w' ? 'b' : 'w'} advantage={advantage(color)} />}
                </span>
                {state.phase === 'lobby' && !seat && (
                  <span className="chess-seat-actions">
                    <button type="button" className="chess-mini-btn" onClick={() => sit(color)}>
                      {myColor ? 'Switch' : 'Play'}
                    </button>
                    {canManage && (
                      <button type="button" className="chess-mini-btn" onClick={() => dispatch({ kind: 'add-bot', color })}>
                        + Computer
                      </button>
                    )}
                  </span>
                )}
                {state.phase === 'lobby' && seat && (seat.id === selfId || canManage) && (
                  <button
                    type="button"
                    className="chess-mini-btn"
                    onClick={() => dispatch(seat.id === selfId ? { kind: 'stand' } : { kind: 'clear-seat', color })}
                  >
                    {seat.id === selfId ? 'Leave' : 'Remove'}
                  </button>
                )}
                {state.phase === 'playing' && away && (
                  <span className="chess-seat-actions">
                    {!myColor && (
                      <button type="button" className="chess-mini-btn" onClick={() => sit(color)}>
                        Take seat
                      </button>
                    )}
                    {(canManage || myColor) && (
                      <button type="button" className="chess-mini-btn" onClick={() => dispatch({ kind: 'hand-to-bot', color })}>
                        Computer plays
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {state.phase === 'lobby' && (
          <div className="chess-actions">
            {(canManage || myColor) && state.seats.w && state.seats.b && (
              <button type="button" className="chess-mini-btn" onClick={() => dispatch({ kind: 'swap' })}>
                Swap colours
              </button>
            )}
            {canManage || myColor ? (
              <button
                type="button"
                className="btn btn-primary chess-start-btn"
                disabled={!state.seats.w || !state.seats.b}
                onClick={() => dispatch({ kind: 'start' })}
              >
                {state.seats.w && state.seats.b ? 'Start game' : 'Need 2 players'}
              </button>
            ) : (
              <p className="chess-hint">A player or the host starts the game.</p>
            )}
          </div>
        )}

        {drawToMe && (
          <div className="chess-offer" role="alert">
            <span>{nameOf(state.drawOffer!)} offers a draw.</span>
            <span className="chess-offer-btns">
              <button type="button" className="btn btn-primary" onClick={() => dispatch({ kind: 'answer-draw', accept: true })}>
                Accept
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => dispatch({ kind: 'answer-draw', accept: false })}>
                Decline
              </button>
            </span>
          </div>
        )}

        <MoveList state={state} />

        <div className="chess-actions">
          {state.phase === 'playing' && myColor && (
            <>
              {state.drawOffer === myColor ? (
                <button type="button" className="chess-mini-btn" onClick={() => dispatch({ kind: 'answer-draw', accept: false })}>
                  Cancel draw offer
                </button>
              ) : (
                !state.drawOffer &&
                !state.seats[myColor === 'w' ? 'b' : 'w']?.bot && (
                  <button type="button" className="chess-mini-btn" onClick={() => dispatch({ kind: 'offer-draw' })}>
                    Offer draw
                  </button>
                )
              )}
              {confirmResign ? (
                <>
                  <button type="button" className="chess-mini-btn is-danger" onClick={() => dispatch({ kind: 'resign' })}>
                    Yes, resign
                  </button>
                  <button type="button" className="chess-mini-btn" onClick={() => setConfirmResign(false)}>
                    Keep playing
                  </button>
                </>
              ) : (
                <button type="button" className="chess-mini-btn" onClick={() => setConfirmResign(true)}>
                  Resign
                </button>
              )}
            </>
          )}
          {state.phase !== 'lobby' && (
            <button type="button" className="chess-mini-btn" onClick={() => setFlipView((v) => !v)} aria-label="Turn the board around">
              ⇅ Flip
            </button>
          )}
          {state.phase === 'over' && (canManage || myColor) && (
            <button type="button" className="btn btn-primary" onClick={() => dispatch({ kind: 'again' })}>
              Rematch
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
