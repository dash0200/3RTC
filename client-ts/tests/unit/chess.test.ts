import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  START_POSITION,
  botMove,
  fromFen,
  legalMoves,
  makeMove,
  san,
  squareFrom,
  toFen,
  type Position
} from '../../src/features/activities/chess/engine';
import {
  INITIAL,
  capturedPieces,
  reducer,
  type ChessAction,
  type ChessMeta,
  type ChessState
} from '../../src/features/activities/chess/rules';

function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  return moves.reduce((n, m) => n + perft(makeMove(pos, m), depth - 1), 0);
}

const fen = (f: string): Position => {
  const p = fromFen(f);
  assert.ok(p, `bad fen ${f}`);
  return p;
};
const mv = (from: string, to: string, promo?: 'q' | 'r' | 'b' | 'n') => ({
  from: squareFrom(from),
  to: squareFrom(to),
  ...(promo ? { promo } : {})
});

describe('chess engine: move generation (perft)', () => {
  it('start position', () => {
    assert.equal(perft(START_POSITION, 1), 20);
    assert.equal(perft(START_POSITION, 2), 400);
    assert.equal(perft(START_POSITION, 3), 8902);
  });
  it('kiwipete (castling, en passant, promotions, pins)', () => {
    const p = fen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
    assert.equal(perft(p, 1), 48);
    assert.equal(perft(p, 2), 2039);
  });
  it('position 3 (en passant discovered checks)', () => {
    const p = fen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
    assert.equal(perft(p, 3), 2812);
  });
  it('position 4 (promotions and castling under attack)', () => {
    const p = fen('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1');
    assert.equal(perft(p, 2), 264);
  });
  it('FEN round trip', () => {
    const f = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
    assert.equal(toFen(fen(f)), f);
  });
});

describe('chess engine: move names', () => {
  it('names castling, captures, checks and mate', () => {
    let p = START_POSITION;
    const names: string[] = [];
    for (const [a, b] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
      const m = mv(a, b);
      names.push(san(p, m));
      p = makeMove(p, m);
    }
    assert.deepEqual(names, ['f3', 'e5', 'g4', 'Qh4#']);
    assert.equal(legalMoves(p).length, 0);
    const k = fen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    assert.equal(san(k, mv('e1', 'g1')), 'O-O');
    assert.equal(san(k, mv('e1', 'c1')), 'O-O-O');
  });
  it('disambiguates and names promotions', () => {
    const p = fen('4k3/1P6/8/8/8/8/4K3/R6R w - - 0 1');
    assert.equal(san(p, mv('a1', 'd1')), 'Rad1');
    assert.equal(san(p, mv('b7', 'b8', 'q')), 'b8=Q+');
  });
});

// ---- the room reducer -----------------------------------------------------------------

const PRESENT = ['h', 'a', 'b', 'c'];
const meta = (by: string, extra: Partial<ChessMeta> = {}): ChessMeta => ({
  by,
  isHost: by === 'h',
  selfId: 'h',
  hostId: 'h',
  present: PRESENT,
  clientOf: (id) => `cid-${id}`,
  ...extra
});
const act = (state: ChessState, by: string, action: ChessAction, extra: Partial<ChessMeta> = {}): ChessState =>
  reducer(state, action, meta(by, extra));

function started(): ChessState {
  let s = act(INITIAL, 'a', { kind: 'sit', color: 'w', name: 'Asha' });
  s = act(s, 'b', { kind: 'sit', color: 'b', name: 'Ben' });
  return act(s, 'h', { kind: 'start' });
}
const play = (s: ChessState, by: string, from: string, to: string, promo?: 'q' | 'n'): ChessState =>
  act(s, by, { kind: 'move', ...mv(from, to, promo) });

describe('chess room', () => {
  it('seats two players and starts', () => {
    const s = started();
    assert.equal(s.phase, 'playing');
    assert.equal(s.seats.w?.name, 'Asha');
    assert.equal(s.seats.b?.id, 'b');
  });
  it('a spectator cannot start or move; only the side to move can move', () => {
    let s = act(INITIAL, 'a', { kind: 'sit', color: 'w' });
    s = act(s, 'b', { kind: 'sit', color: 'b' });
    assert.equal(act(s, 'c', { kind: 'start' }), s);
    s = act(s, 'h', { kind: 'start' });
    assert.equal(play(s, 'c', 'e2', 'e4'), s);
    assert.equal(play(s, 'b', 'e7', 'e5'), s);
    assert.equal(play(s, 'a', 'e2', 'e5'), s); // illegal
    const n = play(s, 'a', 'e2', 'e4');
    assert.equal(n.moves[0].san, 'e4');
    assert.equal(n.pos.turn, 'b');
  });
  it('finds checkmate', () => {
    let s = started();
    s = play(s, 'a', 'f2', 'f3');
    s = play(s, 'b', 'e7', 'e5');
    s = play(s, 'a', 'g2', 'g4');
    s = play(s, 'b', 'd8', 'h4');
    assert.equal(s.phase, 'over');
    assert.deepEqual(s.result, { winner: 'b', reason: 'checkmate' });
    assert.equal(play(s, 'a', 'e2', 'e4'), s);
  });
  it('threefold repetition draws', () => {
    let s = started();
    for (let i = 0; i < 2; i++) {
      s = play(s, 'a', 'g1', 'f3');
      s = play(s, 'b', 'g8', 'f6');
      s = play(s, 'a', 'f3', 'g1');
      s = play(s, 'b', 'f6', 'g8');
    }
    assert.deepEqual(s.result, { winner: null, reason: 'repetition' });
  });
  it('promotion: defaults to a queen, accepts an underpromotion', () => {
    const base = { ...started(), pos: fen('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1'), reps: [] };
    const q = play(base, 'a', 'b7', 'b8');
    assert.equal(q.pos.board[squareFrom('b8')], 'Q');
    const n = play(base, 'a', 'b7', 'b8', 'n');
    assert.equal(n.pos.board[squareFrom('b8')], 'N');
  });
  it('resign and draw offers', () => {
    const s = started();
    assert.deepEqual(act(s, 'b', { kind: 'resign' }).result, { winner: 'w', reason: 'resign' });
    assert.equal(act(s, 'c', { kind: 'resign' }), s);
    const offered = act(s, 'a', { kind: 'offer-draw' });
    assert.equal(offered.drawOffer, 'w');
    assert.equal(act(offered, 'a', { kind: 'answer-draw', accept: true }), offered); // not your own
    assert.equal(act(offered, 'b', { kind: 'answer-draw', accept: false }).drawOffer, null);
    assert.deepEqual(act(offered, 'b', { kind: 'answer-draw', accept: true }).result, { winner: null, reason: 'agreed' });
    // a move clears an open offer
    assert.equal(play(offered, 'a', 'e2', 'e4').drawOffer, null);
  });
  it('the computer plays only via the authority, for its own turn', () => {
    let s = act(INITIAL, 'a', { kind: 'sit', color: 'w' });
    s = act(s, 'h', { kind: 'add-bot', color: 'b' });
    s = act(s, 'a', { kind: 'start' });
    s = play(s, 'a', 'e2', 'e4');
    assert.equal(act(s, 'a', { kind: 'auto', seq: s.seq }), s); // not the authority
    assert.equal(act(s, 'h', { kind: 'auto', seq: s.seq - 1 }), s); // stale
    const n = act(s, 'h', { kind: 'auto', seq: s.seq });
    assert.equal(n.moves.length, 2);
    assert.equal(n.pos.turn, 'w');
  });
  it('a player coming back gets the seat back; a left seat can be taken over', () => {
    const s = started();
    const gone = { present: ['h', 'b', 'c', 'a2'], clientOf: (id: string) => (id === 'a2' ? 'cid-a' : `cid-${id}`) };
    const back = act(s, 'a2', { kind: 'sit', color: 'w' }, gone);
    assert.equal(back.seats.w?.id, 'a2');
    assert.equal(back.seats.w?.name, 'Asha');
    const taken = act(s, 'c', { kind: 'sit', color: 'w', name: 'Cy' }, { present: ['h', 'b', 'c'] });
    assert.equal(taken.seats.w?.name, 'Cy');
    assert.equal(act(s, 'c', { kind: 'sit', color: 'w' }), s); // still here: not free
  });
  it('rematch swaps colours', () => {
    const over = act(started(), 'a', { kind: 'resign' });
    const again = act(over, 'b', { kind: 'again' });
    assert.equal(again.phase, 'lobby');
    assert.equal(again.seats.w?.id, 'b');
    assert.equal(again.seats.b?.id, 'a');
  });
  it('counts captured pieces', () => {
    const c = capturedPieces(fen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').board);
    assert.equal(c.w.length, 15);
    assert.equal(c.b[0], 'q');
  });
});

describe('computer player', () => {
  it('takes a free queen and finds mate in one, quickly', () => {
    const free = fen('4k3/8/8/3q4/8/8/8/3QK3 w - - 0 1');
    assert.deepEqual(botMove(free, 2, () => 0), mv('d1', 'd5'));
    const mate = fen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    assert.deepEqual(botMove(mate, 2, () => 0), mv('a1', 'a8'));
    const t0 = Date.now();
    botMove(fen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'));
    assert.ok(Date.now() - t0 < 4000, `slow: ${Date.now() - t0}ms`);
  });
});
