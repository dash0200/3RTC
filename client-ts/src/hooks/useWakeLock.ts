/**
 * Keeps the screen on while `active` (in a room with a video loaded), so phones don't dim and
 * lock mid-video, which would also pause the stream. Uses the Screen Wake Lock API; browsers drop
 * the lock whenever the tab is hidden, so it is taken again when the page is visible. Does nothing
 * where the API isn't available.
 */
import { useEffect } from 'react';

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
    if (!active || !nav?.wakeLock?.request) return undefined;
    let lock: any = null;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      if (cancelled || lock || document.visibilityState !== 'visible') return;
      try {
        const sentinel = await nav.wakeLock.request('screen');
        if (cancelled) {
          sentinel.release().catch(() => { });
          return;
        }
        lock = sentinel;
        lock.addEventListener('release', () => { lock = null; });
      } catch {
        // denied (battery saver, iframe policy) or not supported: nothing to do
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      lock?.release().catch(() => { });
      lock = null;
    };
  }, [active]);
}
