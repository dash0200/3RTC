/**
 * Development-only example activity (listed only in dev builds): a shared counter with a move
 * history. It is the smallest complete use of the activity API and is what the activity tests
 * drive. Copy this folder to start a new activity.
 */
import { useSharedState, useRoom } from '../../../core/RoomContext';
import type { JSX } from 'react';

interface CounterState {
  count: number;
  last: { by: string; name: string; step: number } | null;
}

const initial: CounterState = { count: 0, last: null };

type CounterAction =
  | { kind: 'add'; step: number; name?: string }
  | { kind: 'reset' };

interface CounterMeta {
  by: string;
  isHost?: boolean;
}

function reducer(state: CounterState, action: CounterAction, meta: CounterMeta): CounterState {
  switch (action.kind) {
    case 'add': {
      const step = Number(action.step);
      if (!Number.isInteger(step) || Math.abs(step) > 10) return state; // reject bad input
      return {
        count: state.count + step,
        last: { by: meta.by, name: String(action.name || '').slice(0, 40), step }
      };
    }
    case 'reset':
      return meta.isHost ? initial : state; // only the host may reset
    default:
      return state;
  }
}

export interface SampleCounterProps {
  activityId: string;
}

export default function SampleCounter({ activityId }: SampleCounterProps): JSX.Element {
  const room = useRoom();
  const [state, dispatch] = useSharedState<CounterState, CounterAction>(`act:${activityId}`, {
    initial,
    reducer
  });
  const name = room.getSelf().username;

  return (
    <div className="activity-sample">
      <div className="activity-sample-count" data-testid="sample-count">
        {state.count}
      </div>
      <div className="activity-sample-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => dispatch({ kind: 'add', step: -1, name })}
        >
          −1
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => dispatch({ kind: 'add', step: 1, name })}
        >
          +1
        </button>
        {room.getSelf().isHost && (
          <button type="button" className="btn btn-secondary" onClick={() => dispatch({ kind: 'reset' })}>
            Reset
          </button>
        )}
      </div>
      <p className="activity-sample-last" data-testid="sample-last">
        {state.last
          ? `${state.last.name || 'Someone'} ${state.last.step > 0 ? 'added' : 'took'} ${Math.abs(state.last.step)}`
          : 'Nobody has pressed anything yet'}
      </p>
    </div>
  );
}
