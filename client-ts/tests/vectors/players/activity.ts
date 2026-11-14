/** The open activity (`activityState.ts`): starts, stops, malformed ids, the host lock. */
import { ACTIVITY_INITIAL, activityReducer, type ActivityAction, type ActivityState } from '../../../src/features/activities/activityState.ts';
import type { Player } from '../vectors.ts';

const IDS = ['chess', 'ludo', 'lastcard', 'whiteboard', 'tycoon', 'sample-counter', 'new-game-2', 'Bad Id', '', 'x'.repeat(41)];
const NAMES: unknown[] = ['Riya', 'Darshan', '', 'n'.repeat(60), 7, null, undefined];

export const activity: Player<ActivityState, ActivityAction> = {
  game: 'activity',
  key: 'activity',
  initial: ACTIVITY_INITIAL,
  reducer: (s, a, m) => activityReducer(s, a, m as never),
  candidates: (_s, people, rnd) => {
    const by = people.ids[Math.floor(rnd() * people.ids.length)];
    const id = IDS[Math.floor(rnd() * IDS.length)];
    const byName = NAMES[Math.floor(rnd() * NAMES.length)] as string;
    return [
      { by, action: { kind: 'start', id, byName } },
      { by, action: { kind: 'stop' } },
      { by, action: { kind: 'nonsense' } as unknown as ActivityAction }
    ];
  },
  random: { games: 10, steps: 60 }
};
