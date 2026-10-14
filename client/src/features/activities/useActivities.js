/**
 * Which activity the room has open (one at a time), as shared room state, so everyone, including
 * people who join later, sees the same one. Anyone can start or close it; with the host controls
 * lock on, only the host can.
 */
import { useCallback, useMemo } from 'react';
import { useSharedStateOn } from '../../core/RoomContext';
import { ACTIVITIES, findActivity } from './registry';
import { ACTIVITY_STATE_KEY, ACTIVITY_INITIAL, activityReducer } from './activityState';

// Shared state (core/sharedState.js) arrived with message format version 2
const MIN_PROTOCOL = 2;

export function useActivities({ room, hostControls, peopleCount }) {
    const [state, dispatch] = useSharedStateOn(room, ACTIVITY_STATE_KEY, { initial: ACTIVITY_INITIAL, reducer: activityReducer });
    const current = state.current;
    const definition = current ? findActivity(current.id) : null;

    const start = useCallback((id) => {
        if (hostControls.isLockedForMe()) {
            room.notify('🔒 Only the host can start activities right now');
            return;
        }
        // Activities need everyone's app to be from this version or later; the deciding app most of all
        const authority = room.getAuthorityId();
        if (authority && room.peerProtocol(authority) < MIN_PROTOCOL) {
            room.notify(`${room.peerName(authority) || 'The host'} needs to refresh 3RTC to play together`);
            return;
        }
        dispatch({ kind: 'start', id, byName: room.getSelf().username });
    }, [dispatch, hostControls, room]);

    const stop = useCallback(() => {
        if (hostControls.isLockedForMe()) {
            room.notify('🔒 Only the host can close the activity right now');
            return;
        }
        dispatch({ kind: 'stop' });
    }, [dispatch, hostControls, room]);

    // What the menus show
    const menu = useMemo(() => ACTIVITIES.map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.icon,
        description: a.description,
        isOpen: current?.id === a.id,
        disabledReason: peopleCount < (a.minPeople || 1) ? `Needs ${a.minPeople} people in the room` : null
    })), [current?.id, peopleCount]);

    return { current, definition, menu, start, stop };
}
