/**
 * The Back button (phone back gesture, browser back) inside a room.
 *
 * While you're in a room one extra history entry (the "guard") sits on top of the room's own
 * entry, and the address carries the room code (?room=12345). Pressing Back lands on the room's
 * entry; we put the guard straight back (so the page never goes anywhere) and then:
 *   - close whatever is open on top: a sheet, a dialog, a picker... (the last one opened first)
 *   - with nothing open: ask whether to leave the room (onBackAtRoot)
 * Playing videos are never closed by Back: they have their own Exit button.
 *
 * Anything that opens on top registers itself while open:  useBackLayer(isOpen, close)
 * The room turns the guard on and off:                     useRoomBackGuard(roomId, onBackAtRoot)
 *
 * Browsers only let a page catch Back after the person has tapped something on it, which is
 * always true in a room.
 */

import { useEffect, useRef } from 'react';

export interface BackLayer {
  close: () => void;
}

const GUARD_STATE = { threeRtc: 'room-guard' };
const layers: BackLayer[] = []; // { close } in the order they opened
let rootHandler: (() => void) | null = null; // with nothing open
let guardOn = false;
let ignoreNextPop = false;
let urlAfterLeaving: string | null = null;
let urlToGuard: string | null = null; // a room entered while our step back was still on its way
let listening = false;

const isGuardState = (state: unknown): boolean =>
  typeof state === 'object' &&
  state !== null &&
  (state as Record<string, unknown>).threeRtc === GUARD_STATE.threeRtc;

function onPopState(): void {
  if (ignoreNextPop) {
    // Our own step back off the guard after leaving the room
    ignoreNextPop = false;
    if (urlToGuard !== null) {
      // ...and a room was entered meanwhile: guard it now
      history.replaceState(null, '', urlToGuard);
      history.pushState(GUARD_STATE, '', urlToGuard);
    } else if (urlAfterLeaving !== null) {
      history.replaceState(null, '', urlAfterLeaving);
    }
    urlToGuard = null;
    urlAfterLeaving = null;
    return;
  }
  if (!guardOn) return;
  // Stay on the page: put the guard back first
  history.pushState(GUARD_STATE, '', location.href);
  const top = layers.pop();
  if (top) top.close();
  else rootHandler?.();
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('popstate', onPopState);
}

/** In a room (`url` carries its code): Back stays in the app. */
export function enableRoomGuard(url: string): void {
  if (typeof window === 'undefined' || !window.history?.pushState) return;
  listen();
  if (ignoreNextPop) {
    // Still stepping back from the last room: finish that first (onPopState)
    guardOn = true;
    urlToGuard = url;
    return;
  }
  if (guardOn) {
    history.replaceState(GUARD_STATE, '', url);
    return;
  }
  guardOn = true;
  history.replaceState(null, '', url);
  history.pushState(GUARD_STATE, '', url);
}

/** Left the room: drop the guard and put the address back to `url`. */
export function disableRoomGuard(url: string): void {
  if (!guardOn || typeof window === 'undefined') return;
  guardOn = false;
  if (ignoreNextPop) {
    // The step back is already on its way
    urlToGuard = null;
    urlAfterLeaving = url;
    return;
  }
  if (isGuardState(history.state)) {
    // Step back off the guard so Back doesn't land on a dead entry later
    ignoreNextPop = true;
    urlAfterLeaving = url;
    history.back();
  } else {
    history.replaceState(null, '', url);
  }
}

/** This page's address (same-origin path) with ?room= set to `roomId`, or removed for null. */
export function addressWithRoom(
  roomId: string | number | null | undefined,
  href = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
): string {
  const url = new URL(href);
  url.pathname = url.pathname.replace(/\/{2,}/g, '/'); // '//?room=' would read as another site
  if (roomId) url.searchParams.set('room', String(roomId));
  else url.searchParams.delete('room');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Something open on top (sheet, dialog, picker): Back closes it while `isOpen`. */
export function useBackLayer(isOpen: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!isOpen) return undefined;
    const layer: BackLayer = { close: () => closeRef.current?.() };
    layers.push(layer);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [isOpen]);
}

/** The room: the guard is on while `roomId` is set; Back with nothing open calls onBackAtRoot. */
export function useRoomBackGuard(
  roomId: string | null | undefined,
  onBackAtRoot: () => void
): void {
  const handlerRef = useRef(onBackAtRoot);
  handlerRef.current = onBackAtRoot;
  useEffect(() => {
    rootHandler = () => handlerRef.current?.();
    return () => {
      rootHandler = null;
    };
  }, []);
  useEffect(() => {
    if (!roomId) return undefined;
    enableRoomGuard(addressWithRoom(roomId));
    return () => disableRoomGuard(addressWithRoom(null));
  }, [roomId]);
}

/** For tests: inspect currently active layer stack size. */
export const _openLayerCount = (): number => layers.length;
