/**
 * "Leave room 12345?" shown when Back is pressed in a room with nothing open on top.
 * Stay is the big, focused choice; Back again (or Escape, or tapping outside) also stays.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBackLayer } from '../core/backStack';

export interface LeaveRoomDialogProps {
  isOpen: boolean;
  roomId: string | null;
  isPlaying?: boolean;
  onStay: () => void;
  onLeave: () => void;
}

export default function LeaveRoomDialog({
  isOpen,
  roomId,
  isPlaying = false,
  onStay,
  onLeave
}: LeaveRoomDialogProps) {
  const stayRef = useRef<HTMLButtonElement | null>(null);
  useBackLayer(isOpen, onStay);

  useEffect(() => {
    if (!isOpen) return undefined;
    stayRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onStay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onStay]);

  // A real modal: everything else is out of reach (keyboard, screen readers) while it's open
  useEffect(() => {
    if (!isOpen) return undefined;
    const app = document.getElementById('root');
    app?.setAttribute('inert', '');
    return () => app?.removeAttribute('inert');
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div className="leave-dialog-backdrop" onClick={onStay} role="presentation">
      <div
        className="leave-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="leave-dialog-title">Leave room {roomId}?</h2>
        <p>
          {isPlaying
            ? "You'll stop watching with everyone. You can rejoin with the same code."
            : 'You can rejoin with the same code.'}
        </p>
        <div className="leave-dialog-actions">
          <button type="button" className="leave-dialog-stay" ref={stayRef} onClick={onStay}>
            Stay
          </button>
          <button type="button" className="leave-dialog-leave" onClick={onLeave}>
            Leave room
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
