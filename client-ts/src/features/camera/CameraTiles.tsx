import { memo, useEffect, useRef, useState } from 'react';
import type { RemoteCamera } from './useCamera';
import { SELF_CAMERA } from './spotlight';

/**
 * Everyone's camera (features/camera/useCamera.ts): a row of small tiles just above the dock on a
 * computer, a strip above the chat on a phone (never over the stage's own controls). Ours is mirrored, like a mirror. A click on a
 * tile shows that camera on the stage, for you only (features/camera/spotlight.ts); a second click
 * takes it off. The whole set can be hidden (it comes back when a camera turns on).
 */
function VideoTile({ stream, name, mirrored, onStage, onClick }: {
  stream: MediaStream;
  name: string;
  mirrored?: boolean;
  onStage?: boolean;
  onClick?: () => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch(() => {
      // autoplay of a muted video is always allowed; a failure here means it's not ready yet
    });
  }, [stream]);
  return (
    <button
      type="button"
      className={`camera-tile ${onStage ? 'is-on-stage' : ''}`}
      onClick={onClick}
      aria-pressed={onStage}
      title={onStage ? `${name}: back to the stage` : `${name}: show on the stage`}
      aria-label={`${name}’s camera${onStage ? ', on the stage' : ''}`}
    >
      <video ref={ref} className={mirrored ? 'is-mirrored' : ''} autoPlay playsInline muted />
      <span className="camera-tile-name">{name}</span>
    </button>
  );
}

const Tile = memo(VideoTile);

export interface CameraTilesProps {
  layout?: 'desktop' | 'phone';
  localStream: MediaStream | null;
  remote: RemoteCamera[];
  nameOf: (peerId: string) => string;
  /** The camera on the stage (a peer id, or SELF_CAMERA), if any */
  spotlight?: string | null;
  /** A tile was clicked */
  onSpotlight?: (key: string) => void;
}

export default function CameraTiles({ layout = 'desktop', localStream, remote, nameOf, spotlight = null, onSpotlight }: CameraTilesProps) {
  // Hidden at how many cameras: one more turning on brings the tiles back
  const [hiddenAt, setHiddenAt] = useState<number | null>(null);
  const count = remote.length + (localStream ? 1 : 0);
  const hidden = hiddenAt !== null && count <= hiddenAt;

  if (count === 0) return null;
  if (hidden) {
    return (
      <button type="button" className={`camera-tiles-show camera-tiles--${layout}`} onClick={() => setHiddenAt(null)}>
        Show cameras ({count})
      </button>
    );
  }
  return (
    <div className={`camera-tiles camera-tiles--${layout}`} role="group" aria-label="Cameras">
      {remote.map((c) => (
        <Tile
          key={c.peerId}
          stream={c.stream}
          name={nameOf(c.peerId)}
          onStage={spotlight === c.peerId}
          onClick={onSpotlight ? () => onSpotlight(c.peerId) : undefined}
        />
      ))}
      {localStream && (
        <Tile
          stream={localStream}
          name="You"
          mirrored
          onStage={spotlight === SELF_CAMERA}
          onClick={onSpotlight ? () => onSpotlight(SELF_CAMERA) : undefined}
        />
      )}
      <button
        type="button"
        className="camera-tiles-hide"
        onClick={() => setHiddenAt(count)}
        title="Hide cameras"
        aria-label="Hide cameras"
      >
        ✕
      </button>
    </div>
  );
}
