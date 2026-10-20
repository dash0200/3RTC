import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import QuickPicksBrowser from './QuickPicksBrowser';
import type { QuickPickVideo } from '../utils/quickPicks';

export interface QuickPicksModalProps {
  isOpen: boolean;
  onClose?: () => void;
  onQueue?: (video: QuickPickVideo) => void;
  queuedIds?: string[];
}

/** Quick Watch while something is playing: pick videos to add to the shared queue. */
export default function QuickPicksModal({
  isOpen,
  onClose,
  onQueue,
  queuedIds
}: QuickPicksModalProps) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  // Rendered into <body> so the chat sidebar's layout can't clip or offset it
  return createPortal(
    <div
      className="qp-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        className="qp-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add from Quick Watch"
      >
        <div className="qp-modal-head">
          <div>
            <div className="qp-modal-title">Add to queue</div>
            <div className="qp-modal-sub">
              Click a video to line it up. It plays after the current one.
            </div>
          </div>
          <button type="button" className="qp-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="qp-modal-body">
          <QuickPicksBrowser onQueue={onQueue} queuedIds={queuedIds} cardAction="queue" />
        </div>
      </div>
    </div>,
    document.body
  );
}
