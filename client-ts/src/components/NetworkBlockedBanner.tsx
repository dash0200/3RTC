import { useState } from 'react';
import type { NetworkHint } from '../webrtc/networkHint';

export interface NetworkBlockedBannerProps {
  hint: NetworkHint | null;
  onDismiss: () => void;
}

/**
 * Stays on screen when a first connection to someone doesn't work because a network blocks direct
 * connections (3RTC has no relay server): what's wrong and what to try. Goes away when that
 * connection comes up, on leaving the room, or with Dismiss. (webrtc/networkHint.ts)
 * Once the diagnosis is in (webrtc/iceDiagnosis.ts) it also says why, and offers the full log to
 * read or copy.
 */
export default function NetworkBlockedBanner({ hint, onDismiss }: NetworkBlockedBannerProps) {
  const [showLog, setShowLog] = useState(false);
  const [copiedLog, setCopiedLog] = useState<string | null>(null);
  const log = hint?.log;
  const copied = Boolean(log) && copiedLog === log;
  if (!hint) return null;

  const copyLog = async () => {
    if (!log) return;
    try {
      await navigator.clipboard.writeText(log);
      setCopiedLog(log);
    } catch {
      setShowLog(true); // no clipboard access: show it to select by hand
    }
  };

  return (
    <div className="network-blocked-banner" role="alert">
      <span className="network-blocked-icon" aria-hidden="true">
        ⚠️
      </span>
      <div className="network-blocked-text">
        <strong>{hint.toast}</strong>
        <span>{hint.message.replace(/^⚠️\s*/, '')}</span>
        {hint.why && (
          <span className="network-blocked-why">
            <b>Why: </b>
            {hint.why}
          </span>
        )}
        {log && (
          <div className="network-blocked-actions">
            <button type="button" onClick={() => setShowLog((v) => !v)}>
              {showLog ? 'Hide full log' : 'Show full log'}
            </button>
            <button type="button" onClick={copyLog}>
              {copied ? 'Copied ✓' : 'Copy full log'}
            </button>
          </div>
        )}
        {log && showLog && <pre className="network-blocked-log">{log}</pre>}
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
