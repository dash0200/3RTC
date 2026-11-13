/** Tycoon (`tycoon/rules.ts`): lobbies and tokens, rules, games with people and computers (buying,
 * rent, cards, jail, building, mortgages, debts and bankruptcy), trades, and the end. */
import { INITIAL, reducer, type TyAction, type TyState } from '../../../src/features/activities/tycoon/rules.ts';
import { SPACES, TOKENS, isBuyable } from '../../../src/features/activities/tycoon/board.ts';
import type { People, Player } from '../vectors.ts';

const pick = <T,>(xs: T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)];
const BUYABLE = SPACES.map((_, i) => i).filter(isBuyable);

function candidates(s: TyState, people: People, rnd: () => number): Array<{ by: string; action: TyAction }> {
  const anyone = () => pick(people.ids, rnd);
  const self = people.host ?? [...people.ids.filter((id) => !people.absent?.includes(id))].sort()[0];
  const out: Array<{ by: string; action: TyAction }> = [];
  const botsOnly = people.flavor === 'computers' || people.flavor === 'computers-long';
  const rounds = people.flavor === 'computers' ? 15 : 0;
  if (s.phase === 'lobby' && botsOnly) {
    // computers only, a set length: the host sets it up and the authority plays it to the end
    if (s.players.length < 3) return [{ by: self, action: { kind: 'add-bot' } }];
    if (s.rules.rounds !== rounds || !s.rules.jackpot) return [{ by: self, action: { kind: 'rules', rules: { rounds, jackpot: true } } }];
    return [{ by: self, action: { kind: 'start' } }];
  }
  if (s.phase === 'over' && botsOnly) return [];
  if (s.phase === 'lobby') {
    for (let i = 0; i < 3; i++) out.push({ by: anyone(), action: { kind: 'join', name: pick(['Riya', ' x ', '', 'n'.repeat(30)], rnd), ...(rnd() < 0.4 ? { token: pick([...TOKENS, 'rocket'] as never[], rnd) } : {}) } });
    out.push({ by: anyone(), action: { kind: 'add-bot' } });
    if (rnd() < 0.3) out.push({ by: anyone(), action: { kind: 'token', token: pick([...TOKENS, 'rocket'] as never[], rnd) } });
    if (rnd() < 0.2) out.push({ by: anyone(), action: { kind: 'leave' } });
    if (rnd() < 0.2) out.push({ by: anyone(), action: { kind: 'remove', seat: pick([0, 1, 4, 9], rnd) } });
    if (rnd() < 0.3) out.push({ by: anyone(), action: { kind: 'rules', rules: rnd() < 0.5 ? { jackpot: rnd() < 0.7 } : { rounds: pick([0, 15, 30, 7, '15', null] as never[], rnd) } } });
    for (let i = 0; i < 2; i++) out.push({ by: anyone(), action: { kind: 'start' } });
    return out;
  }
  if (s.phase === 'over') {
    out.push({ by: anyone(), action: { kind: 'again' } });
    return out;
  }
  const cur = s.players[s.turn];
  const humanTurn = cur && !cur.bot && people.ids.includes(cur.id);
  if (humanTurn) {
    const by = cur.id;
    const mine = BUYABLE.filter((i) => s.owner[i] === s.turn);
    switch (s.step) {
      case 'roll':
        for (let i = 0; i < 4; i++) out.push({ by, action: { kind: 'roll' } });
        if (cur.jail) out.push({ by, action: { kind: pick(['pay-jail', 'jail-card'] as const, rnd) } });
        break;
      case 'buy':
        for (let i = 0; i < 3; i++) out.push({ by, action: { kind: rnd() < 0.75 ? 'buy' : 'skip' } });
        break;
      case 'debt':
        out.push({ by, action: { kind: 'pay-debt' } });
        if (mine.length) for (let i = 0; i < 3; i++) out.push({ by, action: { kind: pick(['mortgage', 'sell'] as const, rnd), pos: pick(mine, rnd) } });
        if (rnd() < 0.3) out.push({ by, action: { kind: 'bankrupt' } });
        break;
      case 'done':
        for (let i = 0; i < 3; i++) out.push({ by, action: { kind: 'end-turn' } });
        break;
    }
    if (mine.length) {
      for (let i = 0; i < 2; i++) out.push({ by, action: { kind: 'build', pos: pick(mine, rnd) } });
      if (rnd() < 0.2) out.push({ by, action: { kind: pick(['mortgage', 'unmortgage', 'sell'] as const, rnd), pos: pick(mine, rnd) } });
    }
    if (rnd() < 0.05) out.push({ by, action: { kind: 'build', pos: pick([-1, 40, 1.5, 0, 12], rnd) } });
  }
  // trades: offers between people, to computers, answers, cancels
  if (!s.trade && rnd() < 0.25) {
    const by = anyone();
    const from = s.players.findIndex((p) => !p.bot && p.id === by);
    const to = Math.floor(rnd() * (s.players.length + 1));
    const theirs = BUYABLE.filter((i) => s.owner[i] === to);
    const mine = BUYABLE.filter((i) => s.owner[i] === from);
    out.push({
      by,
      action: {
        kind: 'trade',
        to,
        giveCash: pick([0, 100, 500, 2500, -5, 1e9], rnd),
        getCash: pick([0, 0, 200, 1000], rnd),
        giveProps: mine.length && rnd() < 0.6 ? [pick(mine, rnd)] : [],
        getProps: theirs.length && rnd() < 0.6 ? [pick(theirs, rnd)] : rnd() < 0.1 ? [pick([0, 99, 1], rnd)] : []
      }
    });
  }
  if (s.trade) {
    const to = s.players[s.trade.to];
    const from = s.players[s.trade.from];
    if (to && !to.bot) out.push({ by: to.id, action: { kind: 'trade-answer', accept: rnd() < 0.6 } });
    if (from && rnd() < 0.3) out.push({ by: from.id, action: { kind: 'trade-cancel' } });
    if (to?.bot) for (let i = 0; i < 2; i++) out.push({ by: self, action: { kind: 'auto', seq: s.seq, mode: 'trade' } });
  }
  for (let i = 0; i < (cur?.bot || !humanTurn ? 8 : 1); i++) out.push({ by: self, action: { kind: 'auto', seq: s.seq, mode: 'turn' } });
  if (rnd() < 0.03) out.push({ by: anyone(), action: { kind: 'auto', seq: s.seq } });
  if (rnd() < 0.004) out.push({ by: anyone(), action: { kind: 'end-game' } });
  if (rnd() < 0.03) out.push({ by: anyone(), action: { kind: 'join', name: 'Late' } });
  return out;
}

export const tycoon: Player<TyState, TyAction> = {
  game: 'tycoon',
  key: 'act:tycoon',
  initial: INITIAL,
  reducer: (s, a, m) => reducer(s, a, m as never),
  candidates,
  scripts: (people) => {
    const [h, a] = people.ids;
    if (people.flavor) return [];
    return [
      {
        name: 'jackpot, 15 rounds, a person and two computers',
        steps: [[h, { kind: 'join', name: 'Host', token: 'boat' }], [a, { kind: 'join', name: 'Ana', token: 'boat' }], [a, { kind: 'token', token: 'plane' }],
          [h, { kind: 'add-bot' }], [h, { kind: 'rules', rules: { jackpot: true } }], [h, { kind: 'rules', rules: { rounds: 15 } }], [a, { kind: 'start' }]]
      }
    ];
  },
  random: { games: 3, steps: 340 },
  rooms: [
    { ids: ['p-host', 'p-ana', 'p-ben'], host: 'p-host', clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ben': 'c-ben' } },
    { ids: ['p-host', 'p-ana', 'p-ben', 'p-ana2'], host: null, absent: ['p-host', 'p-ana'], clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ana2': 'c-ana', 'p-ben': 'c-ben' } },
    { ids: ['p-host'], host: 'p-host', clients: { 'p-host': 'c-host' }, flavor: 'computers', random: { games: 1, steps: 200 } },
    { ids: ['p-host'], host: 'p-host', clients: { 'p-host': 'c-host' }, flavor: 'computers-long', random: { games: 2, steps: 600 } }
  ]
};
