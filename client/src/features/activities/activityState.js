/**
 * Which activity the room has open, as shared room state (key 'activity'). Pure: no React, so it
 * can be unit tested. The reducer runs on the authority (see core/sharedState.js).
 */
export const ACTIVITY_STATE_KEY = 'activity';

// current: { id, startedBy, startedByName, startedAt } | null
export const ACTIVITY_INITIAL = { current: null };

export function activityReducer(state, action, meta) {
    if (meta.settings?.playbackLock && !meta.isHost) return state; // host controls lock
    if (action.kind === 'start') {
        // Any well-formed id: a newer app in the room may know activities this one doesn't yet
        if (typeof action.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(action.id) || state.current?.id === action.id) return state;
        return { current: { id: action.id, startedBy: meta.by, startedByName: String(action.byName || '').slice(0, 40), startedAt: Date.now() } };
    }
    if (action.kind === 'stop') {
        return state.current ? { current: null } : state;
    }
    return state;
}
