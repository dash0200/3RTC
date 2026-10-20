/**
 * Which activity the room has open, as shared room state (key 'activity'). Pure: no React, so it
 * can be unit tested. The reducer runs on the authority (see core/sharedState.js).
 */

export const ACTIVITY_STATE_KEY = 'activity';

export interface ActivityInfo {
  id: string;
  startedBy: string;
  startedByName: string;
  startedAt: number;
}

export interface ActivityState {
  current: ActivityInfo | null;
}

export const ACTIVITY_INITIAL: ActivityState = { current: null };

export type ActivityAction =
  | { kind: 'start'; id: string; byName?: string }
  | { kind: 'stop' };

export interface ActivityMeta {
  by: string;
  isHost?: boolean;
  settings?: { playbackLock?: boolean };
}

export function activityReducer(
  state: ActivityState,
  action: ActivityAction,
  meta: ActivityMeta
): ActivityState {
  if (meta.settings?.playbackLock && !meta.isHost) return state; // host controls lock
  if (action.kind === 'start') {
    // Any well-formed id: a newer app in the room may know activities this one doesn't yet
    if (
      typeof action.id !== 'string' ||
      !/^[a-z0-9-]{1,40}$/.test(action.id) ||
      state.current?.id === action.id
    ) {
      return state;
    }
    return {
      current: {
        id: action.id,
        startedBy: meta.by,
        startedByName: String(action.byName || '').slice(0, 40),
        startedAt: Date.now()
      }
    };
  }
  if (action.kind === 'stop') {
    return state.current ? { current: null } : state;
  }
  return state;
}
