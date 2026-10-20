export interface RejoinInfo {
  roomId: string;
  wasHost?: boolean;
  onRejoin: () => void;
  onDismiss: () => void;
}

export interface RejoinCardProps {
  rejoin?: RejoinInfo | null;
}

/** "You were in room 12345 · Rejoin" on the home screens (utils/lastRoom.js). */
export default function RejoinCard({ rejoin }: RejoinCardProps) {
  if (!rejoin) return null;
  return (
    <div className="rejoin-card" role="region" aria-label="Rejoin your last room">
      <div className="rejoin-card-text">
        You were in room <strong>{rejoin.roomId}</strong>
        <small>{rejoin.wasHost ? 'Your room: get it back with the same code' : 'Jump back in'}</small>
      </div>
      <button type="button" className="rejoin-card-btn" onClick={rejoin.onRejoin}>Rejoin</button>
      <button type="button" className="rejoin-card-dismiss" onClick={rejoin.onDismiss} aria-label="Dismiss" title="Dismiss">×</button>
    </div>
  );
}
