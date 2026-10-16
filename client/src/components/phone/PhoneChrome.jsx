import React from 'react';

/** Phone top bar: logo, room code (tap to copy), connection status (tap for network details). */
export function PhoneTopBar({ roomId, onCopyRoom, networkStats, isP2PConnected, signalStatus, onOpenNetworkHud, playbackLock = false }) {
  const ping = networkStats?.avgPingMs;
  let status;
  if (roomId) {
    // Plain words; the numbers live in the connection details
    const weak = typeof ping === 'number' && ping > 250;
    status = isP2PConnected
      ? (weak ? { tone: 'wait', text: 'Weak connection' } : { tone: 'ok', text: 'Connected' })
      : { tone: 'wait', text: 'Waiting for friends' };
  } else {
    status = signalStatus?.connected
      ? { tone: 'ok', text: 'Online' }
      : { tone: 'wait', text: signalStatus?.label || 'Connecting…' };
  }

  return (
    <header className="phone-topbar">
      <div className="phone-logo">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4l14 8-14 8z" fill="#e5143d" /></svg>
        3RTC
      </div>
      {roomId && (
        <button
          type="button"
          className="phone-room-pill"
          onClick={() => onCopyRoom?.(String(roomId))}
          aria-label={`Copy room code ${roomId}`}
        >
          {roomId}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V6a2 2 0 0 1 2-2h9" />
          </svg>
        </button>
      )}
      {roomId && playbackLock && (
        <span className="phone-lock-pill" title="Only the host can control playback" aria-label="Host controls on">🔒</span>
      )}
      <button
        type="button"
        className={`phone-status-pill ${status.tone}`}
        onClick={roomId ? onOpenNetworkHud : undefined}
        disabled={!roomId}
        aria-label={`Connection: ${status.text}`}
      >
        <span className="phone-status-dot" />
        {status.text}
      </button>
    </header>
  );
}

const Icon = {
  mic: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  ),
  micOff: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11 5.8M12 18v3" />
    </svg>
  ),
  speaker: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10v4h4l5 4V6L8 10H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  ),
  speakerOff: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10v4h4l5 4V6L8 10H4zM17 9l5 6M22 9l-5 6" />
    </svg>
  ),
  addVideo: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M12 9v6M9 12h6" />
    </svg>
  ),
  more: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  )
};

/** Phone bottom bar: mic (or hold-to-talk), speaker, add video, more. */
export function PhoneActionBar({
  isMicMuted,
  isPttMode,
  isPttActive,
  onToggleMic,
  onPttPressStart,
  onPttPressEnd,
  isAudioBlocked,
  onToggleBlockAudio,
  onOpenAddVideo,
  onOpenMore
}) {
  const micLive = isPttMode ? isPttActive : !isMicMuted;
  const micLabel = isPttMode ? (isPttActive ? 'Talking' : 'Hold to talk') : (isMicMuted ? 'Mic off' : 'Mic on');
  const pttHandlers = isPttMode
    ? {
      onPointerDown: (e) => { e.preventDefault(); onPttPressStart?.(); },
      onPointerUp: () => onPttPressEnd?.(),
      onPointerCancel: () => onPttPressEnd?.(),
      onPointerLeave: () => { if (isPttActive) onPttPressEnd?.(); },
      onContextMenu: (e) => e.preventDefault()
    }
    : { onClick: onToggleMic };

  return (
    <nav className="phone-actionbar" aria-label="Call controls">
      <button
        type="button"
        className={`phone-action ${micLive ? 'is-live' : 'is-off'}`}
        aria-pressed={micLive}
        {...pttHandlers}
      >
        <span className="phone-action-icon">{micLive ? Icon.mic : Icon.micOff}</span>
        {micLabel}
      </button>
      <button
        type="button"
        className={`phone-action ${isAudioBlocked ? 'is-off' : ''}`}
        aria-pressed={!isAudioBlocked}
        onClick={onToggleBlockAudio}
      >
        <span className="phone-action-icon">{isAudioBlocked ? Icon.speakerOff : Icon.speaker}</span>
        {isAudioBlocked ? 'Sound off' : 'Speaker'}
      </button>
      <button type="button" className="phone-action" onClick={onOpenAddVideo}>
        <span className="phone-action-icon">{Icon.addVideo}</span>
        Add video
      </button>
      <button type="button" className="phone-action" onClick={onOpenMore}>
        <span className="phone-action-icon">{Icon.more}</span>
        More
      </button>
    </nav>
  );
}
