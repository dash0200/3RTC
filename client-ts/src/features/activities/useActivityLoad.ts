/**
 * Is the open activity loaded on this device? Not everyone wants to play or watch a game, so it
 * only loads for the person who started it, for whoever taps its bubble ("Join"), and after a
 * reload for someone who had it open. "Leave" unloads it again: the game's screen goes and its
 * shared state is dropped here (others stop counting us, see core/sharedState.js), so it takes no
 * memory or processing on this device. The game's code is downloaded the first time it's loaded.
 *
 * Shared state keys of an activity are `act:<id>` (and `act:<id>:...`): those are the ones
 * dropped, and answered with "gone" while the activity isn't loaded here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomBus } from '../../types';
import { answerForMissingStores, releaseSharedStores } from '../../core/sharedState';
import type { ActivityInfo } from './activityState';
import type { ActivityDefinition } from './registry';

const KEY = '3rtc_loaded_activity';
const readSaved = (): string | null => {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
};
const save = (value: string | null): void => {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* not kept: after a reload the game waits for a tap */
  }
};
export const activityStoreKey = (activityId: string): string => `act:${activityId}`;
const isActivityStore = (activityId: string) => (key: string): boolean =>
  key === activityStoreKey(activityId) || key.startsWith(`${activityStoreKey(activityId)}:`);

export interface UseActivityLoadProps {
  bus: RoomBus;
  activity: ActivityInfo | null;
  definition: ActivityDefinition | null;
  selfId: string | null;
  notify?: (msg: string) => void;
}

export interface UseActivityLoadReturn {
  loaded: boolean;
  load: () => void;
  leave: () => void;
}

/** `activity`: { id, startedBy, startedByName, startedAt } or null; `definition`: { name, icon }. */
export function useActivityLoad({
  bus,
  activity,
  definition,
  selfId,
  notify
}: UseActivityLoadProps): UseActivityLoadReturn {
  const activityKey = activity ? `${activity.id}:${activity.startedAt}` : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(readSaved);
  const loaded = Boolean(activityKey) && loadedKey === activityKey;
  const state = useRef<{ activity: ActivityInfo | null; loaded: boolean }>({ activity, loaded });
  state.current = { activity, loaded };

  // A new activity: open for the person who started it, an invitation for everyone else
  const seenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activityKey || seenRef.current === activityKey) return;
    seenRef.current = activityKey;
    if (activity && (activity.startedBy === selfId || readSaved() === activityKey)) {
      setLoadedKey(activityKey);
      return;
    }
    if (definition && activity) {
      const who = activity.startedByName || 'Someone';
      notify?.(`${definition.icon} ${who} started ${definition.name}: tap ${definition.icon} to join`);
    }
  }, [activityKey, activity, definition, selfId, notify]);

  // Remember it for a reload
  useEffect(() => {
    if (activityKey) save(loaded ? activityKey : null);
  }, [loaded, activityKey]);

  // Not loaded here: drop its shared state (we left it) and tell the others we don't have it
  useEffect(() => {
    if (!activity || loaded) return;
    releaseSharedStores(bus, isActivityStore(activity.id));
    bus.broadcast('room-state-gone', { key: activityStoreKey(activity.id) });
  }, [bus, activity, loaded]);

  // ...also to people who connect while it isn't loaded, and in answer to its messages
  useEffect(() => {
    const offAnswer = answerForMissingStores(bus, (key: string) => key.startsWith('act:'));
    const offOpen = bus.onEvent('peer-open', (peerId) => {
      const { activity: current, loaded: isLoaded } = state.current;
      if (current && !isLoaded) {
        bus.send(peerId as string, 'room-state-gone', { key: activityStoreKey(current.id) });
      }
    });
    return () => {
      offAnswer();
      offOpen();
    };
  }, [bus]);

  const load = useCallback(() => {
    if (activityKey) setLoadedKey(activityKey);
  }, [activityKey]);
  const leave = useCallback(() => setLoadedKey(null), []);

  return { loaded, load, leave };
}
