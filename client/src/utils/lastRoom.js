/**
 * The room you were last in (for "Rejoin room 12345" on the home screen): kept for 30 minutes
 * after you were last seen in it, whether you left with the button, by Back, or the tab closed.
 */
const KEY = '3rtc_last_room';
export const LAST_ROOM_FRESH_MS = 30 * 60 * 1000;

/** `hostToken`: the server's proof that we were the host (needed to get the room back as host). */
export function saveLastRoom(roomId, wasHost, hostToken = null) {
    try {
        localStorage.setItem(KEY, JSON.stringify({
            roomId: String(roomId), wasHost: Boolean(wasHost), at: Date.now(),
            ...(wasHost && typeof hostToken === 'string' ? { hostToken } : {})
        }));
    } catch { /* private mode */ }
}

export function readLastRoom(now = Date.now()) {
    try {
        const rec = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (rec && /^\d{5}$/.test(rec.roomId) && now - rec.at < LAST_ROOM_FRESH_MS) return rec;
    } catch { /* unreadable */ }
    return null;
}

export function forgetLastRoom() {
    try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}
