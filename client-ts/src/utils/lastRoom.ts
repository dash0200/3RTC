/**
 * The room you were last in (for "Rejoin room 12345" on the home screen): kept for 30 minutes
 * after you were last seen in it, whether you left with the button, by Back, or the tab closed.
 */
const KEY = '3rtc_last_room';
export const LAST_ROOM_FRESH_MS = 30 * 60 * 1000;

export interface LastRoomRecord {
  roomId: string;
  wasHost: boolean;
  at: number;
  hostToken?: string;
}
export type SavedLastRoom = LastRoomRecord;

/** `hostToken`: the server's proof that we were the host (needed to get the room back as host). */
export function saveLastRoom(roomId: string | number, wasHost: boolean, hostToken: string | null = null): void {
  try {
    const record: LastRoomRecord = {
      roomId: String(roomId),
      wasHost: Boolean(wasHost),
      at: Date.now(),
      ...(wasHost && typeof hostToken === 'string' ? { hostToken } : {})
    };
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    /* private mode */
  }
}

export function readLastRoom(now = Date.now()): LastRoomRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as LastRoomRecord;
    if (rec && typeof rec.roomId === 'string' && /^\d{5}$/.test(rec.roomId) && now - rec.at < LAST_ROOM_FRESH_MS) {
      return rec;
    }
  } catch {
    /* unreadable */
  }
  return null;
}

export function forgetLastRoom(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

/** Two saved rooms are the same record (so state can keep the one it has). */
export function sameLastRoom(a: LastRoomRecord | null, b: LastRoomRecord | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.roomId === b.roomId && a.wasHost === b.wasHost && a.at === b.at && a.hostToken === b.hostToken;
}
