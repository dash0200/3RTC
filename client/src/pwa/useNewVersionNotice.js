/**
 * Tells the user once when a newer build of 3RTC has been deployed (checks /version.json every
 * 10 minutes and when the tab comes back into view). Reloading picks it up.
 */
import { useEffect } from 'react';
import { BUILD, compareBuilds } from '../version';

const CHECK_EVERY_MS = 10 * 60 * 1000;

export function useNewVersionNotice(notify) {
    useEffect(() => {
        if (BUILD.number === 'dev' || typeof fetch !== 'function') return undefined;
        let told = false;
        const check = async () => {
            if (told || document.visibilityState !== 'visible') return;
            try {
                const res = await fetch('/version.json', { cache: 'no-store' });
                if (!res.ok) return;
                const latest = await res.json();
                if (compareBuilds(BUILD.number, latest?.number) < 0) {
                    told = true;
                    notify(`🆕 A new version of 3RTC is out (build ${latest.number}). Reload the page to update.`);
                }
            } catch { /* offline */ }
        };
        const first = setTimeout(check, 20000);
        const timer = setInterval(check, CHECK_EVERY_MS);
        document.addEventListener('visibilitychange', check);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
            document.removeEventListener('visibilitychange', check);
        };
    }, [notify]);
}
