import { memo, useEffect, useRef, useState } from 'react';
import type { RemoteCamera } from './useCamera';

/**
 * Everyone's camera (features/camera/useCamera.ts): a row of small tiles just above the dock on a
 * computer, a strip above the chat on a phone (never over the stage's own controls). Ours is mirrored, like a mirror. A tile can be made
 * bigger with a click, and the whole set hidden (it comes back when a camera turns on).
 */
function VideoTile({ stream, name, mirrored, big, onClick }: {
  stream: MediaStream;
  name: string;
  mirrored?: boolean;
  big?: boolean;
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
      className={`camera-tile ${big ? 'is-big' : ''}`}
      onClick={onClick}
      title={big ? `${name}: make smaller` : `${name}: make bigger`}
      aria-label={`${name}’s camera${big ? ', enlarged' : ''}`}
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
}

export default function CameraTiles({ layout = 'desktop', localStream, remote, nameOf }: CameraTilesProps) {
  const [big, setBig] = useState<string | null>(null);
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
  const toggleBig = (key: string) => setBig((b) => (b === key ? null : key));
  return (
    <div className={`camera-tiles camera-tiles--${layout}`} role="group" aria-label="Cameras">
      {remote.map((c) => (
        <Tile
          key={c.peerId}
          stream={c.stream}
          name={nameOf(c.peerId)}
          big={big === c.peerId}
          onClick={() => toggleBig(c.peerId)}
        />
      ))}
      {localStream && (
        <Tile stream={localStream} name="You" mirrored big={big === 'me'} onClick={() => toggleBig('me')} />
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
