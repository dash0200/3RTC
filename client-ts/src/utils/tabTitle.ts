/**
 * The browser tab's title: what's going on in the room, most useful first, so a glance at the tab
 * (or the taskbar, while gaming in another window) tells you whether you're needed.
 *
 *   ⚠️ Reconnecting… · Room 12345          the connection dropped
 *   🎲 Your turn · Ludo                     a game is waiting for you
 *   (2) 💬 Riya: are you there?             messages while you were away from the tab
 *   🔊 Riya is talking                      voice
 *   ♟️ Riya started Chess · join in         a game you haven't opened
 *   ▶ Lofi beats to study to               the video
 *   🖍️ Whiteboard · Room 12345              a game, nothing needed from you
 *   Room 12345 · with Riya, Ben             otherwise
 *
 * Pure: the TabTitle component feeds it and sets document.title.
 */

export const APP_NAME = '3RTC';

export interface TitleInput {
  roomId: string | null;
  /** names of the others in the room */
  others: string[];
  reconnecting?: boolean;
  /** an open game: needs you (attention) with what for ("Your turn", "A deal for you") */
  game?: { name: string; icon?: string; attention?: boolean; label?: string } | null;
  /** a game someone started that isn't open here */
  invite?: { name: string; icon?: string; by?: string } | null;
  /** who's talking right now (not you) */
  talking?: string[];
  /** video / screen share title */
  nowPlaying?: string;
  /** messages that came while the tab was in the background, and the last one */
  unread?: number;
  lastMessage?: { name: string; text: string } | null;
}

const cut = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export function talkingText(names: string[]): string {
  if (names.length === 1) return `${cut(names[0], 20)} is talking`;
  if (names.length === 2) return `${cut(names[0], 14)} & ${cut(names[1], 14)} are talking`;
  return `${cut(names[0], 14)} +${names.length - 1} talking`;
}

function withWhom(others: string[]): string {
  if (!others.length) return 'waiting for friends';
  if (others.length <= 2) return `with ${others.map((n) => cut(n, 16)).join(', ')}`;
  return `with ${cut(others[0], 16)} +${others.length - 1}`;
}

/** The main line (without the unread count and the app name) */
export function titleLine(t: TitleInput): string {
  const room = `Room ${t.roomId}`;
  if (t.reconnecting) return `⚠️ Reconnecting… · ${room}`;
  if (t.game?.attention) return `${t.game.icon || '🎮'} ${cut(t.game.label || 'Your turn', 22)} · ${t.game.name}`;
  if (t.unread && t.lastMessage) return `💬 ${cut(t.lastMessage.name, 14)}: ${cut(t.lastMessage.text || '📷 photo', 34)}`;
  if (t.talking?.length) return `🔊 ${talkingText(t.talking)}`;
  if (t.invite) return `${t.invite.icon || '🎮'} ${t.invite.by ? `${cut(t.invite.by, 16)} started ` : ''}${t.invite.name} · join in`;
  if (t.nowPlaying) return `▶ ${cut(t.nowPlaying, 44)}`;
  if (t.game) return `${t.game.icon || '🎮'} ${t.game.name} · ${room}`;
  return `${room} · ${withWhom(t.others)}`;
}

/** The whole title, or null outside a room (the page's own title then) */
export function composeTitle(t: TitleInput): string | null {
  if (!t.roomId) return null;
  const count = t.unread ? `(${t.unread > 9 ? '9+' : t.unread}) ` : '';
  return `${count}${titleLine(t)} — ${APP_NAME}`;
}
