/**
 * Development-only example activity (listed only in dev builds): a shared counter with a move
 * history. It is the smallest complete use of the activity API and is what the activity tests
 * drive. Copy this folder to start a new activity.
 *
 * - useSharedState(key, { initial, reducer }) gives every person the same state; the reducer runs
 *   on one peer (the authority) and decides what's allowed.
 * - meta.by is who really sent the action; meta.isHost whether that peer is the host.
 */
import { useSharedState, useRoom } from '../../../core/RoomContext';

const initial = { count: 0, last: null };

function reducer(state, action, meta) {
    switch (action.kind) {
        case 'add': {
            const step = Number(action.step);
            if (!Number.isInteger(step) || Math.abs(step) > 10) return state; // reject bad input
            return { count: state.count + step, last: { by: meta.by, name: String(action.name || '').slice(0, 40), step } };
        }
        case 'reset':
            return meta.isHost ? initial : state; // only the host may reset
        default:
            return state;
    }
}

export default function SampleCounter({ activityId }) {
    const room = useRoom();
    const [state, dispatch] = useSharedState(`act:${activityId}`, { initial, reducer });
    const name = room.username;
    return (
        <div className="activity-sample">
            <div className="activity-sample-count" data-testid="sample-count">{state.count}</div>
            <div className="activity-sample-actions">
                <button type="button" className="btn btn-secondary" onClick={() => dispatch({ kind: 'add', step: -1, name })}>−1</button>
                <button type="button" className="btn btn-primary" onClick={() => dispatch({ kind: 'add', step: 1, name })}>+1</button>
                {room.isHost && (
                    <button type="button" className="btn btn-secondary" onClick={() => dispatch({ kind: 'reset' })}>Reset</button>
                )}
            </div>
            <p className="activity-sample-last" data-testid="sample-last">
                {state.last ? `${state.last.name || 'Someone'} ${state.last.step > 0 ? 'added' : 'took'} ${Math.abs(state.last.step)}` : 'Nobody has pressed anything yet'}
            </p>
        </div>
    );
}
