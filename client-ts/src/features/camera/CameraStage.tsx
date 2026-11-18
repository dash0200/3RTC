import { useEffect, useRef } from 'react';

/**
 * A camera filling the stage (features/camera/spotlight.ts), on top of whatever plays there, which
 * keeps running. "Back to the stage", Esc, or a click on the same tile takes it away.
 */
export default function CameraStage({ stream, name, mirrored, onClose }: {
  stream: MediaStream;
  name: string;
  mirrored?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch(() => {
      // a muted video may always play; a failure means it isn't ready yet
    });
  }, [stream]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="camera-stage" role="region" aria-label={`${name}’s camera`}>
      <video ref={ref} className={mirrored ? 'is-mirrored' : ''} autoPlay playsInline muted />
      <span className="camera-stage-name">{name}</span>
      <button type="button" className="camera-stage-close" onClick={onClose} title="Back to the stage">
        ✕ Back to the stage
      </button>
    </div>
  );
}
