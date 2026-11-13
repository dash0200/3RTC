/** Ludo (`ludo/rules.ts`): lobbies, house rules, games with people and computers, idle skips. */
import { INITIAL, reducer, type LudoAction, type LudoColor, type LudoState } from '../../../src/features/activities/ludo/rules.ts';
import type { People, Player } from '../vectors.ts';

const pick = <T,>(xs: T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)];
const COLORS: LudoColor[] = ['red', 'green', 'yellow', 'blue'];
const RULES = ['sixToLeave', 'threeSixes', 'safeStars', 'captureBonus', 'homeBonus'];

function candidates(s: LudoState, people: People, rnd: () => number): Array<{ by: string; action: LudoAction }> {
  const anyone = () => pick(people.ids, rnd);
  const self = people.host ?? [...people.ids.filter((id) => !people.absent?.includes(id))].sort()[0];
  const out: Array<{ by: string; action: LudoAction }> = [];
  if (s.phase === 'lobby') {
    for (let i = 0; i < 3; i++) out.push({ by: anyone(), action: { kind: 'sit', color: pick(COLORS, rnd), name: pick(['Riya', ' x ', '', 'n'.repeat(30)], rnd) } });
    out.push({ by: anyone(), action: { kind: 'add-bot', color: pick(COLORS, rnd) } });
    out.push({ by: anyone(), action: { kind: 'add-bot', color: pick(COLORS, rnd) } });
    if (rnd() < 0.3) out.push({ by: anyone(), action: { kind: 'clear-seat', color: pick(COLORS, rnd) } });
    if (rnd() < 0.3) out.push({ by: anyone(), action: { kind: 'stand' } });
    const r: Record<string, unknown> = { [pick(RULES, rnd)]: rnd() < 0.5 };
    if (rnd() < 0.3) r.awayMode = pick(['bot', 'skip', 'nope'], rnd);
    if (rnd() < 0.2) out.push({ by: anyone(), action: { kind: 'rules', rules: r } as LudoAction });
    for (let i = 0; i < 3; i++) out.push({ by: anyone(), action: { kind: 'start' } });
    out.push({ by: anyone(), action: { kind: pick(['sit', 'nonsense'], rnd), color: 'purple' } as never });
    return out;
  }
  if (s.phase === 'over') {
    out.push({ by: anyone(), action: { kind: 'again' } });
    return out;
  }
  const seat = s.turn ? s.seats[s.turn] : null;
  if (seat && !seat.bot) {
    for (let i = 0; i < 6; i++) {
      if (!s.rolled) out.push({ by: seat.id, action: { kind: 'roll' } });
      else out.push({ by: seat.id, action: { kind: 'move', token: s.movable.length ? pick(s.movable, rnd) : 0 } });
    }
    out.push({ by: seat.id, action: { kind: 'move', token: pick([0, 1, 2, 3, 7, '1'] as never[], rnd) } });
    out.push({ by: anyone(), action: { kind: 'roll' } });
  }
  for (let i = 0; i < (seat?.bot ? 8 : 1); i++) out.push({ by: self, action: { kind: 'auto', seq: s.seq } });
  if (rnd() < 0.05) out.push({ by: self, action: { kind: 'auto', seq: s.seq, mode: 'skip' } });
  if (rnd() < 0.05) out.push({ by: anyone(), action: { kind: 'auto', seq: s.seq } });
  if (rnd() < 0.05) out.push({ by: anyone(), action: { kind: 'sit', color: pick(COLORS, rnd), name: 'Late' } });
  if (rnd() < 0.01) out.push({ by: anyone(), action: { kind: 'again' } });
  return out;
}

export const ludo: Player<LudoState, LudoAction> = {
  game: 'ludo',
  key: 'act:ludo',
  initial: INITIAL,
  reducer: (s, a, m) => reducer(s, a, m as never),
  candidates,
  scripts: (people) => {
    const [h, a] = people.ids;
    return [{
      name: 'two people and two computers, house rules off',
      steps: [[h, { kind: 'sit', color: 'red', name: 'Host' }], [a, { kind: 'sit', color: 'yellow', name: 'Ana' }],
        [h, { kind: 'add-bot', color: 'green' }], [h, { kind: 'add-bot', color: 'blue' }],
        [h, { kind: 'rules', rules: { sixToLeave: false, safeStars: false, awayMode: 'skip' } }], [h, { kind: 'start' }]]
    }];
  },
  random: { games: 7, steps: 300 },
  rooms: [
    { ids: ['p-host', 'p-ana', 'p-ben'], host: 'p-host', clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ben': 'c-ben' } },
    { ids: ['p-host', 'p-ana', 'p-ben', 'p-ana2'], host: null, absent: ['p-host', 'p-ana'], clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ana2': 'c-ana', 'p-ben': 'c-ben' } }
  ]
};
