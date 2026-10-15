/**
 * This browser's app id: the same across reloads and rejoins (the peer id changes each time the
 * page loads). Lets a game give a returning player their seat back. Not secret, not personal:
 * a random id kept in localStorage (a new one each load in private mode).
 */
const KEY = '3rtc_client_id';
let cached = null;

export function getClientId() {
    if (cached) return cached;
    try {
        cached = localStorage.getItem(KEY);
        if (!cached) {
            cached = crypto.randomUUID();
            localStorage.setItem(KEY, cached);
        }
    } catch {
        cached = cached || crypto.randomUUID();
    }
    return cached;
}
