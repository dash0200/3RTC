/** Chess (`chess/rules.ts`): lobby moves, games against people and the computer, bad moves. */
import { INITIAL, reducer, type ChessAction, type ChessState } from '../../../src/features/activities/chess/rules.ts';
import { legalMoves, squareFrom, type ChessColor } from '../../../src/features/activities/chess/engine.ts';
import type { People, Player } from '../vectors.ts';

const pick = <T,>(xs: T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)];
const COLORS: ChessColor[] = ['w', 'b'];
const NAMES: unknown[] = ['Riya', '  Darshan  ', '', 'n'.repeat(30), 42, null];

function candidates(s: ChessState, people: People, rnd: () => number): Array<{ by: string; action: ChessAction }> {
  const anyone = () => pick(people.ids, rnd);
  const self = people.host ?? [...people.ids.filter((id) => !people.absent?.includes(id))].sort()[0];
  const out: Array<{ by: string; action: ChessAction }> = [];
  const odd = () => {
    // now and then: nonsense and things that aren't allowed
    out.push({ by: anyone(), action: { kind: pick(['sit', 'add-bot', 'clear-seat'] as const, rnd), color: pick(['w', 'b', 'x', 1] as never[], rnd) } as ChessAction });
    out.push({ by: anyone(), action: { kind: 'move', from: pick([0, 12, 64, -1, 2.5, '12'] as never[], rnd), to: pick([20, 28, 99] as never[], rnd) } as ChessAction });
    out.push({ by: anyone(), action: { kind: 'nonsense' } as never });
  };
  if (s.phase === 'lobby') {
    for (let i = 0; i < 3; i++) out.push({ by: anyone(), action: { kind: 'sit', color: pick(COLORS, rnd), name: pick(NAMES, rnd) as string } });
    out.push({ by: anyone(), action: { kind: 'stand' } });
    out.push({ by: anyone(), action: { kind: 'add-bot', color: pick(COLORS, rnd) } });
    if (rnd() < 0.3) out.push({ by: anyone(), action: { kind: 'clear-seat', color: pick(COLORS, rnd) } });
    out.push({ by: anyone(), action: { kind: 'swap' } });
    for (let i = 0; i < 3; i++) out.push({ by: anyone(), action: { kind: 'start' } });
    odd();
    return out;
  }
  if (s.phase === 'over') {
    out.push({ by: anyone(), action: { kind: 'again' } });
    out.push({ by: anyone(), action: { kind: 'sit', color: pick(COLORS, rnd) } });
    odd();
    return out;
  }
  const turn = s.pos.turn;
  const seat = s.seats[turn];
  if (seat?.bot) {
    // the deciding app plays the computer (sometimes a stale or someone else's "auto")
    for (let i = 0; i < 8; i++) out.push({ by: self, action: { kind: 'auto', seq: s.seq } });
    out.push({ by: anyone(), action: { kind: 'auto', seq: s.seq } });
    out.push({ by: self, action: { kind: 'auto', seq: s.seq - 1 } });
  } else if (seat) {
    const moves = legalMoves(s.pos);
    for (let i = 0; i < 12 && moves.length; i++) {
      const m = pick(moves, rnd);
      out.push({ by: seat.id, action: { kind: 'move', from: m.from, to: m.to, ...(m.promo ? { promo: m.promo } : rnd() < 0.3 ? { promo: pick(['n', 'q', 'k'] as never[], rnd) } : {}) } });
    }
    if (moves.length) out.push({ by: anyone(), action: { kind: 'move', from: moves[0].from, to: moves[0].to } });
  }
  if (rnd() < 0.05) out.push({ by: anyone(), action: { kind: 'resign' } });
  if (rnd() < 0.08) out.push({ by: anyone(), action: { kind: 'offer-draw' } });
  if (s.drawOffer) out.push({ by: anyone(), action: { kind: 'answer-draw', accept: rnd() < 0.4 } });
  if (rnd() < 0.1) out.push({ by: anyone(), action: { kind: 'hand-to-bot', color: pick(COLORS, rnd) } });
  if (rnd() < 0.1) out.push({ by: anyone(), action: { kind: 'sit', color: pick(COLORS, rnd), name: 'Late' } });
  if (rnd() < 0.2) odd();
  return out;
}

const sq = squareFrom;
const mv = (from: string, to: string, promo?: string): ChessAction => ({ kind: 'move', from: sq(from), to: sq(to), ...(promo ? { promo } : {}) }) as ChessAction;

export const chess: Player<ChessState, ChessAction> = {
  game: 'chess',
  key: 'act:chess',
  initial: INITIAL,
  reducer: (s, a, m) => reducer(s, a, m as never),
  candidates,
  scripts: (people) => {
    const [h, a] = people.ids;
    const seat: Array<[string, ChessAction]> = [[h, { kind: 'sit', color: 'w', name: 'Host' }], [a, { kind: 'sit', color: 'b', name: 'Ana' }], [h, { kind: 'start' }]];
    return [
      {
        name: "scholar's mate",
        steps: [...seat, [h, mv('e2', 'e4')], [a, mv('e7', 'e5')], [h, mv('d1', 'h5')], [a, mv('b8', 'c6')], [h, mv('f1', 'c4')], [a, mv('g8', 'f6')], [h, mv('h5', 'f7')], [h, { kind: 'again' }]]
      },
      {
        name: 'castling, en passant, promotion',
        steps: [...seat, [h, mv('e2', 'e4')], [a, mv('a7', 'a6')], [h, mv('e4', 'e5')], [a, mv('d7', 'd5')], [h, mv('e5', 'd6')], [a, mv('a6', 'a5')],
          [h, mv('g1', 'f3')], [a, mv('a5', 'a4')], [h, mv('f1', 'e2')], [a, mv('a4', 'a3')], [h, mv('e1', 'g1')], [a, mv('a3', 'b2')], [h, mv('d6', 'c7')],
          [a, mv('b2', 'a1', 'n')], [h, mv('c7', 'd8', 'q')], [a, mv('e8', 'd8')], [h, { kind: 'offer-draw' }], [a, { kind: 'answer-draw', accept: true }]]
      },
      {
        name: 'against the computer',
        steps: [[h, { kind: 'sit', color: 'w' }], [h, { kind: 'add-bot', color: 'b' }], [a, { kind: 'start' }], [h, { kind: 'start' }],
          [h, mv('e2', 'e4')], [h, { kind: 'auto', seq: 4 }], [h, mv('d2', 'd4')], [h, { kind: 'auto', seq: 6 }], [h, mv('g1', 'f3')], [h, { kind: 'auto', seq: 8 }], [h, { kind: 'resign' }]]
      }
    ];
  },
  random: { games: 10, steps: 140 },
  rooms: [
    { ids: ['p-host', 'p-ana', 'p-ben'], host: 'p-host', clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ben': 'c-ben' } },
    // the host away; Ana sat and then lost her connection, and is back as p-ana2
    { ids: ['p-host', 'p-ana', 'p-ben', 'p-ana2'], host: null, absent: ['p-host', 'p-ana'], clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ana2': 'c-ana', 'p-ben': 'c-ben' } }
  ]
};
