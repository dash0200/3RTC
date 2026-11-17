/**
 * Whether a 'host' message from the server is worth telling people about, and how (pure, for tests):
 *   from set                 the host handed the room on (transfer-host)
 *   reason 'host-left'       the host left and didn't come back in time; the server picked whoever
 *                            was in the room longest (from: null)
 *   neither                  just who the host is (joining, the host coming back): say nothing
 */
export function hostChangeNotice(msg: {
  hostPeerId?: string | null;
  from?: string;
  reason?: string;
}): { host: string; from: string | null } | null {
  if (!msg.hostPeerId) return null;
  if (msg.from) return { host: msg.hostPeerId, from: msg.from };
  if (msg.reason === 'host-left') return { host: msg.hostPeerId, from: null };
  return null;
}
