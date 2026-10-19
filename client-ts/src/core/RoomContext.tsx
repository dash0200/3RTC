/**
 * React access to the room: the bus, who we are, who is here, and app-wide notices.
 *
 *   const room = useRoom();                  // { bus, roomId, self, peers, notify, log, ... }
 *   usePeerMessage('reaction', (msg, from) => { ... });   // subscribe for the component's life
 *   const [state, dispatch] = useSharedState('chess', { initial, reducer });
 *
 * App creates the value once (see App.jsx) and wraps the layout in <RoomProvider>. Feature hooks
 * called inside App itself receive the same object as an argument instead of reading context.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react';
import type {
  BusEventName,
  PresenceInfo,
  Room,
  RoomBus,
  RoomContextValue,
  SharedStoreOptions
} from '../types';
import { getSharedStore } from './sharedState';

const RoomContext = createContext<RoomContextValue | null>(null);

export interface RoomProviderProps {
  value: RoomContextValue;
  children: ReactNode;
}

export function RoomProvider({ value, children }: RoomProviderProps) {
  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export function useRoom(): RoomContextValue {
  const room = useContext(RoomContext);
  if (!room) throw new Error('useRoom() must be used inside <RoomProvider>');
  return room;
}

/** Run `handler(msg, fromPeerId)` for every message of `type` while mounted. */
export function usePeerMessageOn<T = unknown>(
  bus: RoomBus,
  type: string,
  handler: (msg: T, fromPeerId: string) => void
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => bus.on<T>(type, (msg, from) => handlerRef.current(msg, from)), [bus, type]);
}

export function usePeerMessage<T = unknown>(
  type: string,
  handler: (msg: T, fromPeerId: string) => void
): void {
  usePeerMessageOn<T>(useRoom().bus, type, handler);
}

/** Run `handler(value)` on a local app event ('peer-open', 'peer-close', 'room-left', ...). */
export function useBusEventOn<T = unknown>(
  bus: RoomBus,
  event: BusEventName,
  handler: (value: T) => void
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => bus.onEvent<T>(event, (value) => handlerRef.current(value)), [bus, event]);
}

export function useBusEvent<T = unknown>(event: BusEventName, handler: (value: T) => void): void {
  useBusEventOn<T>(useRoom().bus, event, handler);
}

/** Shared room state (see core/sharedState.js). Returns [state, dispatch]. */
export function useSharedStateOn<S, A>(
  room: Room,
  key: string,
  options: SharedStoreOptions<S, A>
): [S, (action: A) => void] {
  const store = getSharedStore<S, A>(room.bus, room, key, options);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const dispatch = useCallback((action: A) => store.dispatch(action), [store]);
  return [state, dispatch];
}

export function useSharedState<S, A>(
  key: string,
  options: SharedStoreOptions<S, A>
): [S, (action: A) => void] {
  return useSharedStateOn<S, A>(useRoom(), key, options);
}

/**
 * Who has this shared store and who decides for it: { authorityId, members } (members: peer ids,
 * ours included). A game uses it for "is it my app that plays for the computers" and "who is here
 * to play" (people who left the game count as away). Call after useSharedState with the same key.
 */
export function useSharedPresence<S = unknown, A = unknown>(
  key: string,
  options?: SharedStoreOptions<S, A>
): PresenceInfo {
  const room = useRoom();
  const store = getSharedStore(
    room.bus,
    room,
    key,
    options ?? { initial: null as S, reducer: (s) => s }
  );
  return useSyncExternalStore(store.subscribePresence, store.getPresence, store.getPresence);
}
