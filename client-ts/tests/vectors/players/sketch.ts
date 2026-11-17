/** Sketch (`sketch/rules.ts`): joining, picking, guessing (right, close, wrong, odd text), hints
 * over time, skips, drawers leaving, and a new deciding app that doesn't know the word. */
import { INITIAL, reducer, redact, type SketchAction, type SketchState } from '../../../src/features/activities/sketch/rules.ts';
import type { People, Player } from '../vectors.ts';

const pick = <T,>(xs: T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)];

const ODD_GUESSES: unknown[] = ['', '   ', 'x'.repeat(60), 'Pízza', 'ＣＡＴ', 7, null, ['cat'], 'a  b\tc', 'ice-cream!', '日本語', '🙂🙂'];

/** Near misses of a word: one letter off, swapped case, accents, extra spaces. */
function nearly(word: string, rnd: () => number): string {
  const options = [
    word.toUpperCase(),
    `  ${word}  `,
    word.slice(0, -1),
    word.slice(1),
    `${word}s`,
    word.replace(/[aeiou]/, 'é'),
    word.replace(/ /g, '-'),
    word.split('').reverse().join('')
  ];
  return pick(options, rnd);
}

function candidates(s: SketchState, people: People, rnd: () => number): Array<{ by: string; action: SketchAction }> {
  const anyone = () => pick(people.ids, rnd);
  const self = people.host ?? [...people.ids.filter((id) => !people.absent?.includes(id))].sort()[0];
  const out: Array<{ by: string; action: SketchAction }> = [];
  if (s.phase === 'lobby') {
    for (let i = 0; i < 3; i++) out.push({ by: anyone(), action: { kind: 'join', name: pick(['Riya', ' x ', '', 'n'.repeat(30), 'a \t b', 5 as never, null as never], rnd) } });
    if (rnd() < 0.2) out.push({ by: anyone(), action: { kind: 'leave' } });
    for (let i = 0; i < 2; i++) out.push({ by: anyone(), action: { kind: 'start' } });
    if (rnd() < 0.1) out.push({ by: anyone(), action: { kind: pick(['pick', 'guess', 'tick', 'again', 'nope'], rnd), index: 0, text: 'cat' } as never });
    return out;
  }
  if (s.phase === 'over') {
    out.push({ by: anyone(), action: { kind: 'again' } });
    if (rnd() < 0.2) out.push({ by: self, action: { kind: 'tick' } });
    return out;
  }
  // ticks move the clock on (the authority's app sends one twice a second)
  for (let i = 0; i < 3; i++) out.push({ by: self, action: { kind: 'tick' } });
  if (rnd() < 0.1) out.push({ by: anyone(), action: { kind: 'tick' } });
  const drawer = s.drawer ?? anyone();
  if (s.phase === 'picking') {
    out.push({ by: drawer, action: { kind: 'pick', index: pick([0, 1, 2, 2, 3, -1, '1', 1.5, null, '01'] as never[], rnd) } });
    if (rnd() < 0.2) out.push({ by: anyone(), action: { kind: 'pick', index: 0 } });
  }
  if (s.phase === 'drawing') {
    const guessers = s.players.map((p) => p.id).filter((id) => id !== s.drawer);
    for (let i = 0; i < 4; i++) {
      const by = guessers.length ? pick(guessers, rnd) : anyone();
      const r = rnd();
      const text = r < 0.25 && s.word ? s.word : r < 0.55 && s.word ? nearly(s.word, rnd) : r < 0.85 ? pick(['cat', 'dog', 'house', 'tree', 'pizza'], rnd) : pick(ODD_GUESSES, rnd);
      out.push({ by, action: { kind: 'guess', text: text as string } });
    }
    if (rnd() < 0.15) out.push({ by: drawer, action: { kind: 'guess', text: s.word || 'x' } });
  }
  if ((s.phase === 'picking' || s.phase === 'drawing') && rnd() < 0.08) out.push({ by: pick([drawer, anyone()], rnd), action: { kind: 'skip' } });
  if (rnd() < 0.04) out.push({ by: anyone(), action: { kind: 'leave' } });
  if (rnd() < 0.04) out.push({ by: anyone(), action: { kind: 'join', name: 'Late' } });
  if (rnd() < 0.02) out.push({ by: anyone(), action: { kind: pick(['start', 'again'], rnd) } as never });
  return out;
}

/** A turn being drawn, as the host's copy had it (no word: Ana's app was deciding until now). */
const HANDED_OVER: SketchState = redact(
  {
    ...INITIAL,
    phase: 'drawing',
    players: [
      { id: 'p-host', name: 'Host', score: 0 },
      { id: 'p-ana', name: 'Ana', score: 75 },
      { id: 'p-ben', name: 'Ben', score: 0 }
    ],
    turn: 1,
    drawer: 'p-ben',
    word: 'ice cream',
    hint: '___ _____',
    length: 8,
    deadline: 1_700_000_060_000,
    turnStarted: 1_699_999_980_000,
    used: ['cat'],
    feed: [{ by: '', name: '', text: 'Ben is drawing', kind: 'info' }]
  },
  'p-host'
);

export const sketch: Player<SketchState, SketchAction> = {
  game: 'sketch',
  key: 'act:sketch',
  initial: INITIAL,
  reducer: (s, a, m) => reducer(s, a, m as never),
  redact,
  candidates,
  scripts: (people) => {
    const [h, a, b] = people.ids;
    const out: Array<{ name: string; steps: Array<[string, SketchAction]>; initial?: SketchState }> = [
      {
        name: 'a turn: pick, wrong, close, right, everyone got it',
        steps: [
          [h, { kind: 'join', name: 'Host' }], [a, { kind: 'join', name: '  Ana   Maria ' }], [b, { kind: 'join', name: '' }],
          [a, { kind: 'start' }], [h, { kind: 'tick' }], [h, { kind: 'pick', index: 1 }],
          [a, { kind: 'pick', index: 1 }], [a, { kind: 'guess', text: 'banana' }], [h, { kind: 'tick' }],
          [b, { kind: 'skip' }], [h, { kind: 'skip' }], [h, { kind: 'tick' }], [h, { kind: 'tick' }]
        ]
      }
    ];
    if (people.host === 'p-host') {
      out.push({
        name: 'a new deciding app ends the turn it has no word for',
        initial: HANDED_OVER,
        steps: [[a, { kind: 'guess', text: 'ice cream' }], [a, { kind: 'tick' }], [h, { kind: 'tick' }], [h, { kind: 'tick' }]]
      });
    }
    return out;
  },
  random: { games: 12, steps: 200 },
  rooms: [
    { ids: ['p-host', 'p-ana', 'p-ben'], host: 'p-host', clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ben': 'c-ben' } },
    { ids: ['p-host', 'p-ana', 'p-ben', 'p-cat'], host: 'p-host', absent: ['p-cat'], clients: {}, random: { games: 5, steps: 200 } },
    { ids: ['p-host', 'p-ana', 'p-ben', 'p-ana2'], host: null, absent: ['p-host', 'p-ana'], clients: { 'p-host': 'c-host', 'p-ana': 'c-ana', 'p-ana2': 'c-ana', 'p-ben': 'c-ben' }, random: { games: 5, steps: 200 } }
  ]
};
