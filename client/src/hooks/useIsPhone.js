import { useSyncExternalStore } from 'react';

/**
 * True on phones: narrow screens, plus phones held sideways (short touch screens), so rotating a
 * phone doesn't flip it into the desktop layout mid-video.
 */
const PHONE_QUERY = '(max-width: 768px), (hover: none) and (pointer: coarse) and (max-height: 500px)';

function subscribe(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => { };
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot() {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_QUERY).matches : false;
}

export function useIsPhone() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
