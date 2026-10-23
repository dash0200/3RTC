/** Invite links for a room (used by the invite panel, the phone's Share, and the QR code). */

/**
 * Detect server tag ('orc', 'gcp', 'local') from a signaling WebSocket URL.
 */
export function getServerTag(signalUrl: string | null | undefined): string {
  if (!signalUrl) return '';
  if (signalUrl.includes('orc.3rtc.me')) return 'orc';
  if (signalUrl.includes('gcp.3rtc.me')) return 'gcp';
  if (signalUrl.includes('localhost') || signalUrl.includes('127.0.0.1')) return 'local';
  return '';
}

/**
 * Constructs the clean mobile join URL with optional server affinity (?s=orc | ?s=gcp)
 */
export function getMobileJoinUrl(
  roomId: string | number | null | undefined,
  customHost: string | null = null,
  fromName = '',
  serverTag = ''
): string {
  const cleanRoom = String(roomId || '').trim();
  // "Priya invited you": the inviter's name rides along in the link (no server lookup needed)
  const from = String(fromName || '').trim();
  const fromPart = from && !/^User_\d+$/.test(from) ? `&from=${encodeURIComponent(from.slice(0, 24))}` : '';
  const serverPart = serverTag ? `&s=${encodeURIComponent(serverTag)}` : '';
  if (typeof window === 'undefined') {
    return `https://3rtc.me/?room=${cleanRoom}${fromPart}${serverPart}`;
  }

  const origin = customHost ? customHost : window.location.origin;
  const pathname = window.location.pathname.endsWith('/') ? window.location.pathname : `${window.location.pathname}/`;
  return `${origin}${pathname}?room=${cleanRoom}${fromPart}${serverPart}`;
}
