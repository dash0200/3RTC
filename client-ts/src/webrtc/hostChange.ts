/**
 * Whether a 'host' message from the server is worth telling people about, and how (pure, for tests):
 *   from set                 the host handed the room on (transfer-host)
 *   reason 'host-left'       the host left: the server made whoever was in the room longest the
 *                            host at once, standing in until the owner is back (from: null)
 *   reason 'host-returned'   the room's owner came back and is the host again (returned: true)
 *   neither                  just who the host is (joining, a quick reconnect): say nothing
 */
export function hostChangeNotice(msg: {
  hostPeerId?: string | null;
  from?: string;
  reason?: string;
}): { host: string; from: string | null; returned?: boolean } | null {
  if (!msg.hostPeerId) return null;
  if (msg.from) return { host: msg.hostPeerId, from: msg.from };
  if (msg.reason === 'host-left') return { host: msg.hostPeerId, from: null };
  if (msg.reason === 'host-returned') return { host: msg.hostPeerId, from: null, returned: true };
  return null;
}
