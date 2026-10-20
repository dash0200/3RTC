/**
 * Chess rules with no dependencies: legal moves (castling, en passant, promotion), check, mate,
 * stalemate, draws, move names (SAN) and a small computer player. Pure: no React, no DOM.
 *
 * Board: a 64-character string, index 0 = a8 ... 63 = h1 (FEN order). '.' is empty, upper case
 * is White (PNBRQK), lower case is Black.
 */

export type ChessColor = 'w' | 'b';
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export interface Position {
  board: string;
  turn: ChessColor;
  /** 'KQkq' subset, '' for none */
  castling: string;
  /** en passant target square, -1 for none */
  ep: number;
  /** half-moves since the last capture or pawn move (fifty-move rule) */
  half: number;
  full: number;
}

export interface Move {
  from: number;
  to: number;
  promo?: PromotionPiece;
}

export const START_BOARD =
  'rnbqkbnr' + 'pppppppp' + '........' + '........' + '........' + '........' + 'PPPPPPPP' + 'RNBQKBNR';

export const START_POSITION: Position = {
  board: START_BOARD,
  turn: 'w',
  castling: 'KQkq',
  ep: -1,
  half: 0,
  full: 1
};

const FILES = 'abcdefgh';
export const fileOf = (sq: number): number => sq & 7;
export const rankOf = (sq: number): number => 8 - (sq >> 3); // 1..8
export const squareName = (sq: number): string => `${FILES[fileOf(sq)]}${rankOf(sq)}`;
export const squareFrom = (name: string): number => {
  const f = FILES.indexOf(name[0]);
  const r = Number(name[1]);
  return f < 0 || !(r >= 1 && r <= 8) ? -1 : (8 - r) * 8 + f;
};

export const colorOf = (piece: string): ChessColor | null =>
  piece === '.' ? null : piece === piece.toUpperCase() ? 'w' : 'b';
export const typeOf = (piece: string): string => piece.toLowerCase();
const other = (c: ChessColor): ChessColor => (c === 'w' ? 'b' : 'w');
const onBoard = (f: number, r: number): boolean => f >= 0 && f < 8 && r >= 0 && r < 8;
// rows/cols: row 0 = rank 8
const at = (row: number, col: number): number => row * 8 + col;

const KNIGHT = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]
];
const KING = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]
];
const DIAG = [
  [-1, -1], [-1, 1], [1, -1], [1, 1]
];
const ORTHO = [
  [-1, 0], [1, 0], [0, -1], [0, 1]
];

/** Is `sq` attacked by any piece of colour `by`? */
export function attacked(board: string, sq: number, by: ChessColor): boolean {
  const row = sq >> 3;
  const col = sq & 7;
  const own = (p: string, t: string): boolean => p !== '.' && colorOf(p) === by && typeOf(p) === t;
  // pawns: a white pawn attacks upward (row - 1), so it sits one row below the square
  const pr = by === 'w' ? row + 1 : row - 1;
  for (const dc of [-1, 1]) {
    if (onBoard(col + dc, pr) && own(board[at(pr, col + dc)], 'p')) return true;
  }
  for (const [dr, dc] of KNIGHT) {
    if (onBoard(col + dc, row + dr) && own(board[at(row + dr, col + dc)], 'n')) return true;
  }
  for (const [dr, dc] of KING) {
    if (onBoard(col + dc, row + dr) && own(board[at(row + dr, col + dc)], 'k')) return true;
  }
  for (const [dirs, kinds] of [
    [DIAG, 'bq'],
    [ORTHO, 'rq']
  ] as const) {
    for (const [dr, dc] of dirs) {
      let r = row + dr;
      let c = col + dc;
      while (onBoard(c, r)) {
        const p = board[at(r, c)];
        if (p !== '.') {
          if (colorOf(p) === by && kinds.includes(typeOf(p))) return true;
          break;
        }
        r += dr;
        c += dc;
      }
    }
  }
  return false;
}

export const kingSquare = (board: string, color: ChessColor): number =>
  board.indexOf(color === 'w' ? 'K' : 'k');

export const inCheck = (pos: Position, color: ChessColor = pos.turn): boolean => {
  const k = kingSquare(pos.board, color);
  return k >= 0 && attacked(pos.board, k, other(color));
};

function pseudoMoves(pos: Position): Move[] {
  const { board, turn } = pos;
  const moves: Move[] = [];
  const enemy = other(turn);
  const add = (from: number, to: number, pawn = false): void => {
    if (pawn && (rankOf(to) === 8 || rankOf(to) === 1)) {
      for (const promo of ['q', 'r', 'b', 'n'] as PromotionPiece[]) moves.push({ from, to, promo });
    } else {
      moves.push({ from, to });
    }
  };
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (p === '.' || colorOf(p) !== turn) continue;
    const row = sq >> 3;
    const col = sq & 7;
    const t = typeOf(p);
    if (t === 'p') {
      const dir = turn === 'w' ? -1 : 1;
      const startRow = turn === 'w' ? 6 : 1;
      const one = row + dir;
      if (onBoard(col, one) && board[at(one, col)] === '.') {
        add(sq, at(one, col), true);
        const two = row + 2 * dir;
        if (row === startRow && board[at(two, col)] === '.') moves.push({ from: sq, to: at(two, col) });
      }
      for (const dc of [-1, 1]) {
        if (!onBoard(col + dc, one)) continue;
        const to = at(one, col + dc);
        const target = board[to];
        if ((target !== '.' && colorOf(target) === enemy) || to === pos.ep) add(sq, to, true);
      }
    } else if (t === 'n' || t === 'k') {
      for (const [dr, dc] of t === 'n' ? KNIGHT : KING) {
        if (!onBoard(col + dc, row + dr)) continue;
        const to = at(row + dr, col + dc);
        if (colorOf(board[to]) !== turn) moves.push({ from: sq, to });
      }
    } else {
      const dirs = t === 'b' ? DIAG : t === 'r' ? ORTHO : [...DIAG, ...ORTHO];
      for (const [dr, dc] of dirs) {
        let r = row + dr;
        let c = col + dc;
        while (onBoard(c, r)) {
          const to = at(r, c);
          const target = board[to];
          if (target === '.') moves.push({ from: sq, to });
          else {
            if (colorOf(target) === enemy) moves.push({ from: sq, to });
            break;
          }
          r += dr;
          c += dc;
        }
      }
    }
  }
  // Castling: king and rook unmoved (rights), squares between empty, king not in, through or
  // into check
  const home = turn === 'w' ? 60 : 4; // e1 / e8
  const kingSide = turn === 'w' ? 'K' : 'k';
  const queenSide = turn === 'w' ? 'Q' : 'q';
  if (board[home] === (turn === 'w' ? 'K' : 'k') && !attacked(board, home, enemy)) {
    if (
      pos.castling.includes(kingSide) &&
      board[home + 1] === '.' &&
      board[home + 2] === '.' &&
      board[home + 3] === (turn === 'w' ? 'R' : 'r') &&
      !attacked(board, home + 1, enemy) &&
      !attacked(board, home + 2, enemy)
    ) {
      moves.push({ from: home, to: home + 2 });
    }
    if (
      pos.castling.includes(queenSide) &&
      board[home - 1] === '.' &&
      board[home - 2] === '.' &&
      board[home - 3] === '.' &&
      board[home - 4] === (turn === 'w' ? 'R' : 'r') &&
      !attacked(board, home - 1, enemy) &&
      !attacked(board, home - 2, enemy)
    ) {
      moves.push({ from: home, to: home - 2 });
    }
  }
  return moves;
}

/** The position after `move` (assumed pseudo-legal for pos.turn). */
export function makeMove(pos: Position, move: Move): Position {
  const b = pos.board.split('');
  const piece = b[move.from];
  const t = typeOf(piece);
  const captured = b[move.to];
  let ep = -1;
  b[move.to] = move.promo ? (pos.turn === 'w' ? move.promo.toUpperCase() : move.promo) : piece;
  b[move.from] = '.';
  if (t === 'p') {
    if (move.to === pos.ep) b[move.to + (pos.turn === 'w' ? 8 : -8)] = '.'; // en passant
    if (Math.abs(move.to - move.from) === 16) ep = (move.to + move.from) / 2;
  }
  if (t === 'k' && Math.abs(move.to - move.from) === 2) {
    // castling: move the rook too
    if (move.to > move.from) {
      b[move.from + 1] = b[move.from + 3];
      b[move.from + 3] = '.';
    } else {
      b[move.from - 1] = b[move.from - 4];
      b[move.from - 4] = '.';
    }
  }
  let castling = pos.castling;
  const drop = (sq: number): void => {
    const lost: Record<number, string> = { 60: 'KQ', 4: 'kq', 63: 'K', 56: 'Q', 7: 'k', 0: 'q' };
    if (lost[sq]) castling = castling.replace(new RegExp(`[${lost[sq]}]`, 'g'), '');
  };
  drop(move.from);
  drop(move.to);
  const irreversible = t === 'p' || captured !== '.';
  return {
    board: b.join(''),
    turn: other(pos.turn),
    castling,
    ep,
    half: irreversible ? 0 : pos.half + 1,
    full: pos.turn === 'b' ? pos.full + 1 : pos.full
  };
}

export function legalMoves(pos: Position): Move[] {
  return pseudoMoves(pos).filter((m) => !inCheck(makeMove(pos, m), pos.turn));
}

export const sameMove = (a: Move, b: Move): boolean =>
  a.from === b.from && a.to === b.to && (a.promo || '') === (b.promo || '');

/** The legal move matching `move` (promotion defaults to queen), or null. */
export function findLegal(pos: Position, move: Move): Move | null {
  const wanted = { ...move, promo: move.promo };
  const all = legalMoves(pos).filter((m) => m.from === wanted.from && m.to === wanted.to);
  if (!all.length) return null;
  if (all.length === 1 && !all[0].promo) return all[0];
  return all.find((m) => m.promo === (wanted.promo || 'q')) || null;
}

/** Standard algebraic name of a legal move, e.g. Nf3, exd5, O-O, e8=Q+, Qh4#. */
export function san(pos: Position, move: Move): string {
  const piece = pos.board[move.from];
  const t = typeOf(piece);
  let name: string;
  if (t === 'k' && Math.abs(move.to - move.from) === 2) {
    name = move.to > move.from ? 'O-O' : 'O-O-O';
  } else {
    const capture = pos.board[move.to] !== '.' || (t === 'p' && move.to === pos.ep);
    if (t === 'p') {
      name = `${capture ? `${FILES[fileOf(move.from)]}x` : ''}${squareName(move.to)}`;
      if (move.promo) name += `=${move.promo.toUpperCase()}`;
    } else {
      const rivals = legalMoves(pos).filter(
        (m) => m.to === move.to && m.from !== move.from && pos.board[m.from] === piece
      );
      let dis = '';
      if (rivals.length) {
        const sameFile = rivals.some((m) => fileOf(m.from) === fileOf(move.from));
        const sameRank = rivals.some((m) => rankOf(m.from) === rankOf(move.from));
        if (!sameFile) dis = FILES[fileOf(move.from)];
        else if (!sameRank) dis = String(rankOf(move.from));
        else dis = squareName(move.from);
      }
      name = `${t.toUpperCase()}${dis}${capture ? 'x' : ''}${squareName(move.to)}`;
    }
  }
  const next = makeMove(pos, move);
  if (inCheck(next)) name += legalMoves(next).length ? '+' : '#';
  return name;
}

/** Neither side can possibly mate: K v K, K+minor v K, K+B v K+B with bishops on one colour. */
export function insufficientMaterial(board: string): boolean {
  const pieces: { t: string; sq: number }[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (p === '.' || typeOf(p) === 'k') continue;
    const t = typeOf(p);
    if (t === 'p' || t === 'r' || t === 'q') return false;
    pieces.push({ t, sq });
  }
  if (pieces.length <= 1) return true;
  if (pieces.every((p) => p.t === 'b')) {
    const shade = (sq: number): number => ((sq >> 3) + (sq & 7)) % 2;
    return pieces.every((p) => shade(p.sq) === shade(pieces[0].sq));
  }
  return false;
}

/** Key for threefold repetition (en passant counts only when a capture is really possible). */
export function positionKey(pos: Position): string {
  let ep = '-';
  if (pos.ep >= 0 && legalMoves(pos).some((m) => m.to === pos.ep && typeOf(pos.board[m.from]) === 'p')) {
    ep = squareName(pos.ep);
  }
  return `${pos.board} ${pos.turn} ${pos.castling || '-'} ${ep}`;
}

export function toFen(pos: Position): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let row = '';
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = pos.board[r * 8 + c];
      if (p === '.') empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += p;
      }
    }
    rows.push(row + (empty || ''));
  }
  return `${rows.join('/')} ${pos.turn} ${pos.castling || '-'} ${pos.ep >= 0 ? squareName(pos.ep) : '-'} ${pos.half} ${pos.full}`;
}

export function fromFen(fen: string): Position | null {
  const [placement, turn, castling = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  const rows = placement?.split('/') || [];
  if (rows.length !== 8 || (turn !== 'w' && turn !== 'b')) return null;
  let board = '';
  for (const row of rows) {
    let line = '';
    for (const ch of row) line += /\d/.test(ch) ? '.'.repeat(Number(ch)) : ch;
    if (line.length !== 8 || /[^.pnbrqkPNBRQK]/.test(line)) return null;
    board += line;
  }
  return {
    board,
    turn,
    castling: castling === '-' ? '' : castling,
    ep: ep === '-' ? -1 : squareFrom(ep),
    half: Number(half) || 0,
    full: Number(full) || 1
  };
}

// ---- Computer player -------------------------------------------------------------------

export const PIECE_VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Small positional nudges (from White's side, row 0 = rank 8): centre knights and bishops,
// push pawns, keep the king tucked away early on
const CENTER = [0, 1, 2, 3, 3, 2, 1, 0];
function squareBonus(t: string, sq: number, color: ChessColor): number {
  const row = color === 'w' ? sq >> 3 : 7 - (sq >> 3);
  const col = sq & 7;
  switch (t) {
    case 'p':
      return (6 - row) * 8 + (col >= 2 && col <= 5 ? 6 : 0) * (row <= 4 ? 1 : 0);
    case 'n':
      return (CENTER[col] + CENTER[row]) * 6 - 10;
    case 'b':
      return (CENTER[col] + CENTER[row]) * 3;
    case 'q':
      return (CENTER[col] + CENTER[row]) * 1;
    case 'k':
      return row === 7 && (col <= 2 || col >= 6) ? 20 : row === 7 ? 0 : -15;
    default:
      return 0;
  }
}

/** Score for the side to move. */
function evaluate(pos: Position): number {
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = pos.board[sq];
    if (p === '.') continue;
    const c = colorOf(p)!;
    const t = typeOf(p);
    const v = PIECE_VALUE[t] + squareBonus(t, sq, c);
    score += c === pos.turn ? v : -v;
  }
  return score;
}

const MATE = 100000;

function ordered(pos: Position, moves: Move[]): Move[] {
  const gain = (m: Move): number => {
    const victim = pos.board[m.to];
    return (victim === '.' ? 0 : PIECE_VALUE[typeOf(victim)] * 10 - PIECE_VALUE[typeOf(pos.board[m.from])]) +
      (m.promo === 'q' ? 800 : 0);
  };
  return moves.map((m) => [gain(m), m] as const).sort((a, b) => b[0] - a[0]).map(([, m]) => m);
}

class OutOfTime extends Error {}

function search(
  pos: Position,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  deadline: number
): number {
  if (depth === 0) {
    // In check at the horizon: look one move further, so mates and forced replies are seen
    if (ply > 5 || !inCheck(pos)) return evaluate(pos);
    depth = 1;
  }
  if (Date.now() > deadline) throw new OutOfTime();
  const moves = legalMoves(pos);
  if (!moves.length) return inCheck(pos) ? -MATE + ply : 0;
  for (const m of ordered(pos, moves)) {
    const score = -search(makeMove(pos, m), depth - 1, -beta, -alpha, ply + 1, deadline);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

/**
 * The computer's move: a short look-ahead with a little randomness among near-equal moves, so it
 * plays sensibly (takes free pieces, sees mate in one, avoids hanging its queen) but is beatable.
 * It looks one move deeper while time allows (`budgetMs`), so it never freezes the app that runs
 * it (the room's authority, who may be watching a video).
 */
export function botMove(
  pos: Position,
  depth = 2,
  random: () => number = Math.random,
  budgetMs = 160
): Move | null {
  const moves = ordered(pos, legalMoves(pos));
  if (!moves.length) return null;
  const noise = moves.map(() => random() * 18);
  const deadline = Date.now() + budgetMs;
  let best: Move = moves[0];
  for (let d = 0; d <= depth; d++) {
    try {
      let top = -Infinity;
      let pick = moves[0];
      moves.forEach((m, i) => {
        const s = -search(makeMove(pos, m), d, -MATE, MATE, 1, d === 0 ? Infinity : deadline) + noise[i];
        if (s > top) {
          top = s;
          pick = m;
        }
      });
      best = pick;
    } catch (e) {
      if (e instanceof OutOfTime) break;
      throw e;
    }
  }
  return best;
}
