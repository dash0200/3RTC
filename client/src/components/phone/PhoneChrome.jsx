import React from 'react';

import { Logo } from '../Logo';
import { Icon as LineIcon } from '../icons';
import { getAvatarColor } from '../../utils/sound';
import { getInitials } from '../PeerVoiceRoster';
import { getMobileJoinUrl } from '../../utils/qrCode';

/**
 * Phone top bar (Figma). Before a room: logo + status. In a room: the room code (tap to share the
 * invite link), the connection as a signal icon (tap for details) and who's here (tap for People).
 */
export function PhoneTopBar({ roomId, onCopyRoom, networkStats, isP2PConnected, signalStatus, onOpenNetworkHud, playbackLock = false, people = [], onOpenPeople, username = '' }) {
  const ping = networkStats?.avgPingMs;
  if (!roomId) {
    const online = Boolean(signalStatus?.connected);
    return (
      <header className="phone-topbar is-home">
        <Logo size={28} />
        <span className={`phone-status-pill ${online ? 'ok' : 'wait'}`}>
          <span className="phone-status-dot" />
          {online ? 'Online' : (signalStatus?.label || 'Connecting…')}
        </span>
      </header>
    );
  }
  const weak = typeof ping === 'number' && ping > 250;
  const tone = isP2PConnected ? (weak ? 'weak' : 'ok') : 'wait';
  const toneText = isP2PConnected ? (weak ? 'Weak connection' : 'Connected') : 'Waiting for friends';
  const share = async () => {
    const url = getMobileJoinUrl(roomId, null, username);
    if (navigator.share) {
      try { await navigator.share({ title: '3RTC', text: 'Watch with me on 3RTC', url }); return; } catch { /* cancelled: fall back to copy */ }
    }
    onCopyRoom?.(url);
  };
  const shown = people.slice(0, 2);
  const extra = people.length - shown.length;

  return (
    <header className="phone-topbar">
      <button type="button" className="phone-room-pill" onClick={share} aria-label={`Share room ${roomId}`}>
        <span className="phone-room-code">{roomId}</span>
        <LineIcon name="share" size={16} />
      </button>
      {playbackLock && (
        <span className="phone-lock-pill" title="Only the host can control playback" aria-label="Host controls on"><LineIcon name="lock" size={16} /></span>
      )}
      <span className="phone-topbar-space" />
      <button type="button" className={`phone-signal is-${tone}`} onClick={onOpenNetworkHud} aria-label={`${toneText}. Connection details`} title={toneText}>
        <LineIcon name="signal" size={18} strokeWidth={2.6} />
      </button>
      <button type="button" className="phone-people" onClick={onOpenPeople} aria-label={`${people.length} ${people.length === 1 ? 'person' : 'people'} in the room`}>
        {shown.map((p, i) => (
          <span key={p.key} className="rd-av" style={{ '--av': getAvatarColor(p.name), zIndex: 3 - i }} aria-hidden="true">{getInitials(p.name)}</span>
        ))}
        {extra > 0 && <span className="rd-av phone-people-more" style={{ zIndex: 0 }} aria-hidden="true">+{extra}</span>}
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
