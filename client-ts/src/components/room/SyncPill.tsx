import type { ConnectedPeer } from '../../types';

export interface SyncPillProps {
  connectedPeers?: ConnectedPeer[];
  isHost?: boolean;
  isPhone?: boolean;
}

/**
 * "In sync · Priya is the host" on the video (Figma). Playback changes from anyone reach everyone,
 * so the calm, steady state is what this says; who did what goes to the chat's activity.
 */
export default function SyncPill({ connectedPeers = [], isHost = false, isPhone = false }: SyncPillProps) {
  const host = isHost ? null : connectedPeers.find((p) => p.isHost);
  const who = isHost ? 'you’re the host' : host ? `${host.username} is the host` : '';
  return (
    <span className="rd-sync-pill" role="status">
      <span className="rd-sync-dot" aria-hidden="true" />
      {isPhone || !who ? 'In sync' : `In sync · ${who}`}
    </span>
  );
}
