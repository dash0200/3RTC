/** Last Card (`lastcard/rules.ts`): lobbies, house rules, games with people and computers, calling
 * and catching, and a new deciding app getting the hands back (`resync` / `restore`). */
import {
  COLORS,
  INITIAL,
  card,
  playableCards,
  reducer,
  redact,
  seatOf,
  type LcAction,
  type LcState
} from '../../../src/features/activities/lastcard/rules.ts';
import { seeded, type People, type Player } from '../vectors.ts';

const pick = <T,>(xs: T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)];

function candidates(s: LcState, people: People, rnd: () => number): Array<{ by: string; action: LcAction }> {
  const anyone = () => pick(people.ids, rnd);
  const self = people.host ?? [...people.ids.filter((id) => !people.absent?.includes(id))].sort()[0];
  const out: Array<{ by: string; action: LcAction }> = [];
  if (s.phase === 'lobby') {
    for (let i = 0; i < 3; i++) out.push({ by: anyone(), action: { kind: 'join', name: pick(['Riya', ' x ', '', 'n'.repeat(30)], rnd) } });
    out.push({ by: anyone(), action: { kind: 'add-bot' } });
    if (rnd() < 0.3) out.push({ by: anyone(), action: { kind: 'leave' } });
    if (rnd() < 0.2) out.push({ by: anyone(), action: { kind: 'remove', seat: pick([0, 1, 2, 5], rnd) } });
    if (rnd() < 0.3) {
      const rules = rnd() < 0.5 ? { stacking: rnd() < 0.6 } : { drawToMatch: rnd() < 0.6 };
      out.push({ by: anyone(), action: { kind: 'rules', rules } });
    }
    for (let i = 0; i < 2; i++) out.push({ by: anyone(), action: { kind: 'start' } });
    if (rnd() < 0.1) out.push({ by: anyone(), action: { kind: pick(['play', 'nonsense', 'restore'], rnd), card: 3, cards: [1] } as never });
    return out;
  }
  if (s.phase === 'over') {
    out.push({ by: anyone(), action: { kind: 'again' } });
    if (rnd() < 0.2) out.push({ by: anyone(), action: { kind: 'draw' } });
    return out;
  }
  const p = s.players[s.turn];
  if (p && !p.bot && people.ids.includes(p.id)) {
    const ok = playableCards(s, s.turn);
    for (let i = 0; i < 4; i++) {
      if (ok.length && rnd() < 0.8) {
        const c = pick(ok, rnd);
        out.push({ by: p.id, action: card(c).color === 'w' ? { kind: 'play', card: c, color: pick(COLORS, rnd) } : { kind: 'play', card: c } });
      } else if (s.drewThisTurn) out.push({ by: p.id, action: { kind: 'pass' } });
      else out.push({ by: p.id, action: { kind: 'draw' } });
    }
    if (s.counts[s.turn] === 2 && rnd() < 0.7) out.push({ by: p.id, action: { kind: 'call' } });
    const hand = s.hands[s.turn] || [];
    if (hand.length && rnd() < 0.2) out.push({ by: p.id, action: { kind: 'play', card: pick(hand, rnd) } });
    if (rnd() < 0.1) out.push({ by: p.id, action: { kind: 'play', card: pick([200, -1, '3', 100], rnd) as never } });
    if (rnd() < 0.1) out.push({ by: p.id, action: { kind: 'pass' } });
  }
  if (s.exposed !== null) {
    const who = s.players[s.exposed];
    if (who && !who.bot) out.push({ by: who.id, action: { kind: 'call' } });
    for (let i = 0; i < 2; i++) out.push({ by: anyone(), action: { kind: 'catch', seat: s.exposed } });
    out.push({ by: self, action: { kind: 'auto', seq: s.seq, mode: 'catch' } });
  }
  for (let i = 0; i < (p?.bot ? 6 : 1); i++) out.push({ by: self, action: { kind: 'auto', seq: s.seq } });
  if (rnd() < 0.05) out.push({ by: anyone(), action: { kind: 'catch', seat: pick([0, 1, 2], rnd) } });
  if (rnd() < 0.05) out.push({ by: anyone(), action: { kind: 'call' } });
  if (rnd() < 0.05) out.push({ by: anyone(), action: { kind: 'auto', seq: s.seq } });
  if (rnd() < 0.03) out.push({ by: self, action: { kind: 'resync' } });
  if (rnd() < 0.03) out.push({ by: anyone(), action: { kind: 'join', name: 'Late' } });
  return out;
}

/** A game three people and a computer are playing, run with fixed random numbers. */
function midGame(): LcState {
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = seeded(99);
  Date.now = () => 1_699_999_000_000;
  try {
    const meta = (by: string) => ({
      by,
      selfId: 'p-ana',
      isHost: by === 'p-host',
      hostId: 'p-host',
      present: ['p-ana', 'p-host', 'p-ben'],
      clientOf: (id: string) => ({ 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ben': 'c-ben' })[id] ?? null
    });
    let s = INITIAL;
    s = reducer(s, { kind: 'join', name: 'Host' }, meta('p-host'));
    s = reducer(s, { kind: 'join', name: 'Ana' }, meta('p-ana'));
    s = reducer(s, { kind: 'join', name: 'Ben' }, meta('p-ben'));
    s = reducer(s, { kind: 'add-bot' }, meta('p-host'));
    s = reducer(s, { kind: 'start' }, meta('p-host'));
    for (let i = 0; i < 6; i++) s = reducer(s, { kind: 'auto', seq: s.seq }, meta('p-ana'));
    return s;
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
}

export const lastcard: Player<LcState, LcAction> = {
  game: 'lastcard',
  key: 'act:lastcard',
  initial: INITIAL,
  reducer: (s, a, m) => reducer(s, a, m as never),
  redact,
  candidates,
  scripts: (people) => {
    const [h, a, b] = people.ids;
    const out: Array<{ name: string; steps: Array<[string, LcAction]>; initial?: LcState }> = [
      {
        name: 'stacking and draw-to-match with a computer',
        steps: [[h, { kind: 'join', name: 'Host' }], [a, { kind: 'join', name: 'Ana' }], [h, { kind: 'add-bot' }],
          [h, { kind: 'rules', rules: { stacking: true, drawToMatch: true } }], [a, { kind: 'start' }], [b, { kind: 'start' }]]
      }
    ];
    if (people.host === 'p-host') {
      // The deciding app was Ana's; now it is the host's, which has only its own copy.
      const full = midGame();
      const hand = (id: string) => full.hands[seatOf(full, id)]!;
      const mine = redact(full, 'p-host');
      const back: Array<[string, LcAction]> = [
        ['p-ana', { kind: 'restore', cards: hand('p-ana') }],
        ['p-ben', { kind: 'resync' }],
        ['p-host', { kind: 'resync' }],
        ['p-host', { kind: 'resync' }],
        ['p-ben', { kind: 'restore', cards: hand('p-ben').slice(1) }],
        ['p-ben', { kind: 'restore', cards: hand('p-host') }],
        ['p-ben', { kind: 'restore', cards: hand('p-ben').map(String) as never }],
        ['p-ben', { kind: 'restore', cards: hand('p-ben') }],
        ['p-ben', { kind: 'play', card: hand('p-ben')[0] }],
        ['p-ana', { kind: 'restore', cards: [...hand('p-ana').slice(1), hand('p-ana')[0]] }]
      ];
      out.push({ name: 'a new deciding app gets the hands back', initial: mine, steps: back });
      out.push({
        name: 'a new deciding app deals again what nobody sent',
        initial: mine,
        steps: [['p-host', { kind: 'resync' }], ['p-ana', { kind: 'restore', cards: hand('p-ana') }],
          ['p-host', { kind: 'auto', seq: mine.seq, mode: 'rebuild' }], ['p-host', { kind: 'auto', seq: mine.seq + 2, mode: 'rebuild' }],
          ['p-host', { kind: 'auto', seq: mine.seq + 3 }]]
      });
    }
    return out;
  },
  random: { games: 6, steps: 220 },
  rooms: [
    { ids: ['p-host', 'p-ana', 'p-ben'], host: 'p-host', clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ben': 'c-ben' } },
    { ids: ['p-host', 'p-ana', 'p-ben', 'p-ana2'], host: null, absent: ['p-host', 'p-ana'], clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ana2': 'c-ana', 'p-ben': 'c-ben' } }
  ]
};
