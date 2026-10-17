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
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, useCallback } from 'react';
import { getSharedStore } from './sharedState';

const RoomContext = createContext(null);

export function RoomProvider({ value, children }) {
    return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export function useRoom() {
    const room = useContext(RoomContext);
    if (!room) throw new Error('useRoom() must be used inside <RoomProvider>');
    return room;
}

/** Run `handler(msg, fromPeerId)` for every message of `type` while mounted. */
export function usePeerMessageOn(bus, type, handler) {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    useEffect(() => bus.on(type, (msg, from) => handlerRef.current(msg, from)), [bus, type]);
}

export function usePeerMessage(type, handler) {
    usePeerMessageOn(useRoom().bus, type, handler);
}

/** Run `handler(value)` on a local app event ('peer-open', 'peer-close', 'room-left', ...). */
export function useBusEventOn(bus, event, handler) {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    useEffect(() => bus.onEvent(event, (value) => handlerRef.current(value)), [bus, event]);
}

export function useBusEvent(event, handler) {
    useBusEventOn(useRoom().bus, event, handler);
}

/** Shared room state (see core/sharedState.js). Returns [state, dispatch]. */
export function useSharedStateOn(room, key, options) {
    const store = getSharedStore(room.bus, room, key, options);
    const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
    const dispatch = useCallback((action) => store.dispatch(action), [store]);
    return [state, dispatch];
}

export function useSharedState(key, options) {
    return useSharedStateOn(useRoom(), key, options);
}

/**
 * Who has this shared store and who decides for it: { authorityId, members } (members: peer ids,
 * ours included). A game uses it for "is it my app that plays for the computers" and "who is here
 * to play" (people who left the game count as away). Call after useSharedState with the same key.
 */
export function useSharedPresence(key, options) {
    const store = getSharedStore(useRoom().bus, useRoom(), key, options);
    return useSyncExternalStore(store.subscribePresence, store.getPresence, store.getPresence);
}
