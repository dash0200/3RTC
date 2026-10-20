/**
 * Chess in the room: two seats (White, Black), a computer for either seat, everyone else watches.
 * This is the shared-state reducer; it runs on the authority (see core/sharedState.ts). The chess
 * itself is in ./engine.ts.
 */
import {
  START_POSITION,
  botMove,
  findLegal,
  inCheck,
  insufficientMaterial,
  legalMoves,
  makeMove,
  positionKey,
  san,
  type ChessColor,
  type Move,
  type Position,
  type PromotionPiece
} from './engine';

export const COLORS: ChessColor[] = ['w', 'b'];
export const COLOR_NAMES: Record<ChessColor, string> = { w: 'White', b: 'Black' };

export interface ChessSeat {
  id: string;
  name: string;
  /** stable app id, so a reload or rejoin gets the seat back */
  cid?: string;
  bot?: boolean;
}

export interface PlayedMove extends Move {
  san: string;
}

export type ResultReason =
  | 'checkmate'
  | 'resign'
  | 'stalemate'
  | 'repetition'
  | 'fifty'
  | 'material'
  | 'agreed';

export interface ChessResult {
  winner: ChessColor | null;
  reason: ResultReason;
}

export interface ChessState {
  phase: 'lobby' | 'playing' | 'over';
  seats: Record<ChessColor, ChessSeat | null>;
  pos: Position;
  moves: PlayedMove[];
  /** positions since the last capture or pawn move, for threefold repetition */
  reps: string[];
  drawOffer: ChessColor | null;
  result: ChessResult | null;
  seq: number;
}

export const MAX_MOVES = 600; // half-moves kept (a game is drawn by the 50-move rule long before)

export const INITIAL: ChessState = {
  phase: 'lobby',
  seats: { w: null, b: null },
  pos: START_POSITION,
  moves: [],
  reps: [],
  drawOffer: null,
  result: null,
  seq: 0
};

export interface ChessMeta {
  by: string;
  selfId?: string;
  isHost?: boolean;
  hostId?: string | null;
  present?: string[];
  clientOf?: (id: string) => string | null;
}

export type ChessAction =
  | { kind: 'sit'; color: ChessColor; name?: string }
  | { kind: 'stand' }
  | { kind: 'add-bot'; color: ChessColor }
  | { kind: 'clear-seat'; color: ChessColor }
  | { kind: 'swap' }
  | { kind: 'start' }
  | { kind: 'move'; from: number; to: number; promo?: PromotionPiece }
  | { kind: 'resign' }
  | { kind: 'offer-draw' }
  | { kind: 'answer-draw'; accept: boolean }
  | { kind: 'hand-to-bot'; color: ChessColor }
  | { kind: 'again' }
  | { kind: 'auto'; seq: number };

const bump = (state: ChessState, patch: Partial<ChessState>): ChessState => ({
  ...state,
  ...patch,
  seq: state.seq + 1
});

const canManage = (meta: ChessMeta): boolean =>
  Boolean(meta.isHost || !meta.hostId || !meta.present?.includes(meta.hostId));

export const seatOf = (state: ChessState, peerId: string | null): ChessColor | null =>
  COLORS.find((c) => state.seats[c] && !state.seats[c]?.bot && state.seats[c]?.id === peerId) || null;

const cleanName = (name: unknown, fallback: string): string =>
  String(name || '').trim().slice(0, 24) || fallback;

const isColor = (c: unknown): c is ChessColor => c === 'w' || c === 'b';
const isSquare = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 64;

/** Play a legal move and settle the game if it ended. */
function play(state: ChessState, move: Move): ChessState {
  const pos = state.pos;
  const name = san(pos, move);
  const next = makeMove(pos, move);
  const moves = [...state.moves, { from: move.from, to: move.to, ...(move.promo ? { promo: move.promo } : {}), san: name }].slice(-MAX_MOVES);
  const key = positionKey(next);
  const reps = next.half === 0 ? [key] : [...state.reps, key].slice(-120);
  let result: ChessResult | null = null;
  if (!legalMoves(next).length) {
    result = inCheck(next) ? { winner: pos.turn, reason: 'checkmate' } : { winner: null, reason: 'stalemate' };
  } else if (insufficientMaterial(next.board)) {
    result = { winner: null, reason: 'material' };
  } else if (reps.filter((k) => k === key).length >= 3) {
    result = { winner: null, reason: 'repetition' };
  } else if (next.half >= 100) {
    result = { winner: null, reason: 'fifty' };
  }
  return bump(state, {
    pos: next,
    moves,
    reps,
    drawOffer: null,
    ...(result ? { result, phase: 'over' as const } : {})
  });
}

export function reducer(state: ChessState, action: ChessAction, meta: ChessMeta): ChessState {
  switch (action.kind) {
    // ---- lobby -----------------------------------------------------------------------
    case 'sit': {
      const color = action.color;
      if (!isColor(color)) return state;
      const current = state.seats[color];
      const cid = meta.clientOf?.(meta.by) || null;
      const away = Boolean(current && !current.bot && !meta.present?.includes(current.id));
      // Your own seat after a reload or rejoin (same app, new connection): yours again
      const comingBack = Boolean(away && cid && current?.cid === cid);
      // During a game, the seat of someone who left can be taken over
      const takeOver = comingBack || (away && state.phase === 'playing');
      if (current && !takeOver) return state;
      if (state.phase === 'over' && !comingBack) return state;
      if (state.phase === 'playing' && !takeOver) return state;
      const seats = { ...state.seats };
      const mine = seatOf(state, meta.by);
      if (mine && (state.phase === 'lobby' || comingBack)) seats[mine] = null; // switching side
      else if (mine) return state; // already playing the other side
      seats[color] = {
        id: meta.by,
        name: comingBack && current ? current.name : cleanName(action.name, COLOR_NAMES[color]),
        ...(cid ? { cid } : {})
      };
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
      if (state.phase !== 'lobby' || !canManage(meta) || !isColor(action.color)) return state;
      const seat = state.seats[action.color];
      if (action.kind === 'add-bot' && seat) return state;
      const value = action.kind === 'add-bot' ? { id: `bot-${action.color}`, name: 'Computer', bot: true } : null;
      return bump(state, { seats: { ...state.seats, [action.color]: value } });
    }
    case 'swap': {
      if (state.phase !== 'lobby') return state;
      const mine = seatOf(state, meta.by);
      if (!canManage(meta) && !mine) return state;
      return bump(state, { seats: { w: state.seats.b, b: state.seats.w } });
    }
    case 'start': {
      if (state.phase !== 'lobby' || !state.seats.w || !state.seats.b) return state;
      if (!canManage(meta) && !seatOf(state, meta.by)) return state;
      return bump(state, {
        phase: 'playing',
        pos: START_POSITION,
        moves: [],
        reps: [positionKey(START_POSITION)],
        drawOffer: null,
        result: null
      });
    }

    // ---- playing ---------------------------------------------------------------------
    case 'move': {
      if (state.phase !== 'playing') return state;
      const seat = state.seats[state.pos.turn];
      if (!seat || seat.bot || seat.id !== meta.by) return state;
      if (!isSquare(action.from) || !isSquare(action.to)) return state;
      const promo = ['q', 'r', 'b', 'n'].includes(action.promo as string) ? action.promo : undefined;
      const move = findLegal(state.pos, { from: action.from, to: action.to, promo });
      return move ? play(state, move) : state;
    }
    case 'resign': {
      const mine = seatOf(state, meta.by);
      if (state.phase !== 'playing' || !mine) return state;
      return bump(state, { phase: 'over', result: { winner: mine === 'w' ? 'b' : 'w', reason: 'resign' }, drawOffer: null });
    }
    case 'offer-draw': {
      const mine = seatOf(state, meta.by);
      if (state.phase !== 'playing' || !mine || state.drawOffer) return state;
      const rival = state.seats[mine === 'w' ? 'b' : 'w'];
      // The computer doesn't take draws
      if (rival?.bot) return state;
      return bump(state, { drawOffer: mine });
    }
    case 'answer-draw': {
      const mine = seatOf(state, meta.by);
      if (state.phase !== 'playing' || !mine || !state.drawOffer) return state;
      if (state.drawOffer === mine) {
        // taking back your own offer
        return action.accept ? state : bump(state, { drawOffer: null });
      }
      if (!action.accept) return bump(state, { drawOffer: null });
      return bump(state, { phase: 'over', result: { winner: null, reason: 'agreed' }, drawOffer: null });
    }
    // Someone left mid-game: the host (or anyone, if the host is away) can let the computer finish
    case 'hand-to-bot': {
      if (state.phase !== 'playing' || !isColor(action.color)) return state;
      const seat = state.seats[action.color];
      if (!seat || seat.bot || meta.present?.includes(seat.id)) return state;
      if (!canManage(meta) && !seatOf(state, meta.by)) return state;
      return bump(state, {
        seats: { ...state.seats, [action.color]: { id: `bot-${action.color}`, name: 'Computer', bot: true } }
      });
    }
    case 'again': {
      if (state.phase !== 'over') return state;
      if (!canManage(meta) && !seatOf(state, meta.by)) return state;
      // Rematch: same players, colours swapped
      return bump(state, { ...INITIAL, seats: { w: state.seats.b, b: state.seats.w }, seq: state.seq });
    }
    // The authority's app plays the computer's moves
    case 'auto': {
      if (state.phase !== 'playing' || meta.by !== meta.selfId || action.seq !== state.seq) return state;
      if (!state.seats[state.pos.turn]?.bot) return state;
      const move = botMove(state.pos);
      return move ? play(state, move) : state;
    }
    default:
      return state;
  }
}

/** Pieces taken so far, by the colour that lost them (from the board, so always right). */
export function capturedPieces(board: string): Record<ChessColor, string[]> {
  const full: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const out: Record<ChessColor, string[]> = { w: [], b: [] };
  for (const color of COLORS) {
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const ch = color === 'w' ? t.toUpperCase() : t;
      const left = board.split('').filter((p) => p === ch).length;
      // promotions can leave more than the starting count: nothing missing then
      for (let i = left; i < full[t]; i++) out[color].push(t);
    }
  }
  return out;
}
