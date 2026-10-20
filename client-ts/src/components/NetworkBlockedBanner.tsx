import type { NetworkHint } from '../webrtc/networkHint';

export interface NetworkBlockedBannerProps {
  hint: NetworkHint | null;
  onDismiss: () => void;
}

/**
 * Stays on screen when a first connection to someone doesn't work because a network blocks direct
 * connections (3RTC has no relay server): what's wrong and what to try. Goes away when that
 * connection comes up, on leaving the room, or with Dismiss. (webrtc/networkHint.ts)
 */
export default function NetworkBlockedBanner({ hint, onDismiss }: NetworkBlockedBannerProps) {
  if (!hint) return null;
  return (
    <div className="network-blocked-banner" role="alert">
      <span className="network-blocked-icon" aria-hidden="true">
        ⚠️
      </span>
      <div className="network-blocked-text">
        <strong>{hint.toast}</strong>
        <span>{hint.message.replace(/^⚠️\s*/, '')}</span>
      </div>
      <button
        type="button"
        className="network-blocked-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
