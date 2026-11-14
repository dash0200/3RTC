/** The development example counter (`sample/index.tsx`): steps in and out of range, resets. */
import type { Player } from '../vectors.ts';

// the reducer isn't exported from the component file: the same rules, kept in step by the e2e tests
interface CounterState { count: number; last: { by: string; name: string; step: number } | null }
type CounterAction = { kind: 'add'; step: unknown; name?: unknown } | { kind: 'reset' };
const initial: CounterState = { count: 0, last: null };
function reducer(state: CounterState, action: CounterAction, meta: { by: string; isHost?: boolean }): CounterState {
  switch (action.kind) {
    case 'add': {
      const step = Number(action.step);
      if (!Number.isInteger(step) || Math.abs(step) > 10) return state;
      return { count: state.count + step, last: { by: meta.by, name: String(action.name || '').slice(0, 40), step } };
    }
    case 'reset':
      return meta.isHost ? initial : state;
    default:
      return state;
  }
}

const STEPS: unknown[] = [1, -1, 10, -10, 11, 2.5, 'x', 0];
const NAMES: unknown[] = ['Riya', 'Darshan', '', 'n'.repeat(50)];

export const sample: Player<CounterState, CounterAction> = {
  game: 'sample-counter',
  key: 'act:sample-counter',
  initial,
  reducer: (s, a, m) => reducer(s, a, m as never),
  candidates: (_s, people, rnd) => {
    const by = people.ids[Math.floor(rnd() * people.ids.length)];
    return [
      ...STEPS.map((step) => ({ by, action: { kind: 'add', step, name: NAMES[Math.floor(rnd() * NAMES.length)] } as CounterAction })),
      { by, action: { kind: 'reset' } }
    ];
  },
  random: { games: 5, steps: 80 }
};
