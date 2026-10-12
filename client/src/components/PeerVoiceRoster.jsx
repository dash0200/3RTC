import React, { useState, useRef, useEffect } from 'react';
import { getAvatarColor } from '../utils/sound';
import { useLiveVoiceUsers } from '../utils/speakingActivity';

export function getInitials(name) {
  if (!name) return '??';
  const clean = name.trim();
  const parts = clean.split(/[\s_-]+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

/**
 * Single Peer Avatar Badge with animated speaking ring and status indicators
 */
export function PeerVoiceBadge({
  peer,
  isSelected = false,
  onClick,
  showVolumeTag = true
}) {
  const isSelf = Boolean(peer.isSelf);
  const initials = getInitials(peer.username);
  const avatarBg = getAvatarColor(peer.username);
  const isSpeaking = Boolean(peer.isSpeaking);
  const isMuted = Boolean(peer.isMuted);
  const isLocalMuted = Boolean(peer.isLocalMuted);
  const volumePercent = Math.round((peer.volume !== undefined ? peer.volume : 1.0) * 100);

  return (
    <div
      className={`peer-voice-badge ${isSpeaking ? 'is-speaking' : ''} ${isMuted ? 'is-muted' : ''} ${isLocalMuted ? 'is-local-muted' : ''} ${isSelected ? 'is-selected' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      title={
        isSelf
          ? `You (${peer.username})${isSpeaking ? ' • Speaking' : ''}${isMuted ? ' • Mic Muted' : ' • Mic Live'}`
          : `${peer.username}${isSpeaking ? ' • Speaking' : ''}${isLocalMuted ? ' • Muted by you' : ` • Volume: ${volumePercent}%`} (Click to adjust volume)`
      }
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      <div className="peer-avatar-wrapper">
        {/* Animated Speaking Ring */}
        <div className={`peer-speaking-ring ${isSpeaking ? 'active' : ''}`} />

        {/* Avatar Circle */}
        <div className="peer-avatar-circle" style={{ background: avatarBg }}>
          <span>{initials}</span>
        </div>

        {/* Status Mini-Badge */}
        {isLocalMuted ? (
          <span className="peer-mini-badge local-muted" title="Muted by you">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
            </svg>
          </span>
        ) : isMuted ? (
          <span className="peer-mini-badge muted" title="Microphone muted">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
              <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
            </svg>
          </span>
        ) : isSpeaking ? (
          <span className="peer-mini-badge speaking" title="Speaking">
            <span className="speaking-dot" />
          </span>
        ) : null}
      </div>

      <div className="peer-badge-info">
        <span className="peer-badge-name">
          {isSelf ? `${peer.username} (You)` : peer.username}
        </span>
        {showVolumeTag && !isSelf && (
          <span className={`peer-volume-tag ${isLocalMuted ? 'muted' : volumePercent > 100 ? 'boosted' : ''}`}>
            {isLocalMuted ? 'Muted' : `${volumePercent}%`}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Interactive Popover for Adjusting an Individual Peer's Volume (0% - 200%) & Mute
 */
export function PeerAudioPopover({
  peer,
  onClose,
  onSetVolume,
  onToggleMute
}) {
  const popoverRef = useRef(null);
  const volume = peer.volume !== undefined ? peer.volume : 1.0;
  const volumePercent = Math.round(volume * 100);
  const isLocalMuted = Boolean(peer.isLocalMuted);
  const isSpeaking = Boolean(peer.isSpeaking);
  const audioLevel = peer.audioLevel || 0;
  const avatarBg = getAvatarColor(peer.username);
  const initials = getInitials(peer.username);

  // Click outside to dismiss popover
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        onClose?.();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [onClose]);

  const handleSliderChange = (e) => {
    const val = parseFloat(e.target.value);
    onSetVolume?.(peer.peerId, val);
  };

  const handlePreset = (presetVal) => {
    onSetVolume?.(peer.peerId, presetVal);
  };

  return (
    <div className="peer-audio-popover" ref={popoverRef} onClick={(e) => e.stopPropagation()}>
      <div className="popover-header">
        <div className="popover-user-info">
          <div className="popover-avatar" style={{ background: avatarBg }}>
            <span>{initials}</span>
            {isSpeaking && <div className="popover-speaking-glow" />}
          </div>
          <div className="popover-titles">
            <span className="popover-username">{peer.username}</span>
            <span className={`popover-status-text ${isSpeaking ? 'speaking' : isLocalMuted ? 'muted' : ''}`}>
              {isSpeaking ? '🎙️ Speaking now' : isLocalMuted ? '🔇 Muted by you' : peer.isMuted ? '🔇 Muted by them' : '🟢 Active'}
            </span>
          </div>
        </div>
        <button type="button" className="popover-close-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      {/* Real-time Voice Activity VU Meter */}
      <div className="popover-meter-section">
        <div className="meter-label-row">
          <span>Live Audio Level</span>
          <span className="meter-level-val">{isSpeaking ? `${audioLevel}%` : 'Silent'}</span>
        </div>
        <div className="popover-vu-meter-bar">
          <div
            className={`vu-meter-fill ${audioLevel > 60 ? 'high' : audioLevel > 25 ? 'mid' : 'low'}`}
            style={{ width: `${isSpeaking ? Math.max(8, audioLevel) : 0}%` }}
          />
        </div>
      </div>

      {/* Volume Slider Section (0% - 200%) */}
      <div className="popover-slider-section">
        <div className="slider-label-row">
          <span className="slider-label">Individual Volume</span>
          <span className={`slider-percent-badge ${volumePercent > 100 ? 'boosted' : isLocalMuted || volumePercent === 0 ? 'muted' : ''}`}>
            {isLocalMuted ? '0% (Muted)' : `${volumePercent}%${volumePercent > 100 ? ' (Boosted)' : volumePercent === 100 ? ' (Default)' : ''}`}
          </span>
        </div>

        <div className="slider-track-wrapper">
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={isLocalMuted ? 0 : volume}
            onChange={handleSliderChange}
            className={`peer-volume-slider ${volumePercent > 100 ? 'is-boosted' : ''}`}
            aria-label={`Volume for ${peer.username}`}
          />
          <div className="slider-markers">
            <span className="marker-label">0%</span>
            <span className="marker-label center">100%</span>
            <span className="marker-label">200%</span>
          </div>
        </div>

        {/* Quick Presets */}
        <div className="popover-presets">
          {[
            { label: '50%', val: 0.5 },
            { label: '100%', val: 1.0 },
            { label: '150%', val: 1.5 },
            { label: '200%', val: 2.0 }
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              className={`preset-btn ${!isLocalMuted && Math.abs(volume - item.val) < 0.04 ? 'active' : ''}`}
              onClick={() => handlePreset(item.val)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Popover Actions Footer */}
      <div className="popover-footer">
        <button
          type="button"
          className={`popover-mute-btn ${isLocalMuted ? 'is-muted' : ''}`}
          onClick={() => onToggleMute?.(peer.peerId)}
        >
          {isLocalMuted ? (
            <>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
              <span>Unmute for Me</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
              <span>Mute for Me</span>
            </>
          )}
        </button>

        <button
          type="button"
          className="popover-reset-btn"
          onClick={() => handlePreset(1.0)}
          title="Reset to 100% default volume"
        >
          Reset (100%)
        </button>
      </div>
    </div>
  );
}

/**
 * Compact Horizontal Roster Displayed on the Main Stage
 */
export default function PeerVoiceRoster({
  connectedPeers: connectedPeersProp = [],
  localUser: localUserProp = null,
  onSetPeerVolume,
  onToggleMutePeer,
  onToggleMic,
  audioSettings = null,
  onOpenAudioSettings,
  isPttActive = false
}) {
  // Live speaking rings / meters
  const { peers: connectedPeers, localUser } = useLiveVoiceUsers(connectedPeersProp, localUserProp);
  const [selectedPeerId, setSelectedPeerId] = useState(null);

  const selectedPeer = connectedPeers.find((p) => p.peerId === selectedPeerId);
  const isPttMode = audioSettings?.inputMode === 'ptt';

  return (
    <div className="stage-peer-voice-roster">
      {/* Local User Badge */}
      {localUser && (
        <PeerVoiceBadge
          peer={{
            ...localUser,
            isSpeaking: isPttMode ? (isPttActive && localUser.isSpeaking) : localUser.isSpeaking,
            isMuted: isPttMode ? !isPttActive : localUser.isMuted
          }}
          onClick={isPttMode && typeof onOpenAudioSettings === 'function' ? onOpenAudioSettings : onToggleMic}
          showVolumeTag={false}
        />
      )}

      {/* Connected Peers Badges */}
      {connectedPeers.map((peer) => (
        <div key={peer.peerId} className="peer-badge-relative-wrapper">
          <PeerVoiceBadge
            peer={peer}
            isSelected={selectedPeerId === peer.peerId}
            onClick={() => setSelectedPeerId((prev) => (prev === peer.peerId ? null : peer.peerId))}
          />

          {/* Individual Volume Popover */}
          {selectedPeerId === peer.peerId && (
            <PeerAudioPopover
              peer={peer}
              onClose={() => setSelectedPeerId(null)}
              onSetVolume={onSetPeerVolume}
              onToggleMute={onToggleMutePeer}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Full Voice & Participants Panel for the Sidebar Tab
 */
export function PeerVoicePanel({
  connectedPeers: connectedPeersProp = [],
  localUser: localUserProp = null,
  onSetPeerVolume,
  onToggleMutePeer,
  onToggleMic,
  onToggleBlockAudio,
  roomId = '',
  onCopyRoom,
  audioSettings = null,
  onUpdateAudioSettings,
  onOpenAudioSettings,
  isPttActive = false,
  onPttPressStart,
  onPttPressEnd
}) {
  // Live speaking rings / meters
  const { peers: connectedPeers, localUser } = useLiveVoiceUsers(connectedPeersProp, localUserProp);
  const isPttMode = audioSettings?.inputMode === 'ptt';


  const handleToggleMode = () => {
    if (!audioSettings || typeof onUpdateAudioSettings !== 'function') return;
    onUpdateAudioSettings({
      ...audioSettings,
      inputMode: isPttMode ? 'open' : 'ptt'
    });
  };

  return (
    <div className="peer-voice-panel">
      {/* Panel Header */}
      <div className="voice-panel-header">
        <div className="voice-panel-title-row">
          <div className="title-with-icon">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="#3ea6ff">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
            </svg>
            <h3>Voice & Audio Levels</h3>
          </div>
          <div className="voice-panel-actions">
            {typeof onOpenAudioSettings === 'function' && (
              <button
                type="button"
                className="btn-voice-settings-gear"
                onClick={onOpenAudioSettings}
                title="Open Audio Processing & PTT Settings"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                  <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                </svg>
                <span>Settings</span>
              </button>
            )}
            <span className="voice-peers-count-pill">
              {connectedPeers.length + 1} in Room
            </span>
          </div>
        </div>
        <p className="voice-panel-desc">
          Green pulsating rings indicate real-time speech. Individual volume sliders $(0\% - 200\%)$ balance quiet or loud microphones.
        </p>
      </div>

      {/* Your Microphone Card */}
      {localUser && (
        <div className={`voice-user-card self-card ${localUser.isSpeaking ? 'speaking-active' : ''} ${isPttActive ? 'ptt-active' : ''}`}>
          <div className="card-top-row">
            <div className="user-avatar-meta">
              <div className="avatar-ring-container">
                <div className={`peer-speaking-ring ${localUser.isSpeaking ? 'active' : ''}`} />
                <div className="card-avatar" style={{ background: getAvatarColor(localUser.username) }}>
                  <span>{getInitials(localUser.username)}</span>
                </div>
              </div>
              <div className="card-user-titles">
                <div className="user-name-tag">
                  <span className="card-username">{localUser.username}</span>
                  <span className="self-tag">YOU</span>
                  {localUser.isHost && <span className="host-tag">HOST</span>}
                </div>
                <span className={`card-status-pill ${localUser.isSpeaking ? 'speaking' : isPttActive ? 'speaking' : isPttMode ? 'ptt-idle' : localUser.isMuted ? 'muted' : 'ready'}`}>
                  {isPttMode
                    ? isPttActive
                      ? '🎙️ PTT LIVE'
                      : `📻 PTT [${audioSettings?.pttKeyLabel || 'Space'}]`
                    : localUser.isSpeaking
                      ? '🎙️ Speaking'
                      : localUser.isMuted
                        ? '🔇 Mic Muted'
                        : '🟢 Ready / Silent'}
                </span>
              </div>
            </div>

            <div className="card-quick-actions">
              {isPttMode ? (
                <button
                  type="button"
                  className={`card-mic-btn card-ptt-btn ${isPttActive ? 'is-transmitting' : 'is-idle'}`}
                  onMouseDown={onPttPressStart}
                  onMouseUp={onPttPressEnd}
                  onTouchStart={onPttPressStart}
                  onTouchEnd={onPttPressEnd}
                  title={`Hold to transmit voice or press [${audioSettings?.pttKeyLabel || 'Space'}]`}
                >
                  {isPttActive ? 'Transmitting' : `Hold [${audioSettings?.pttKeyLabel || 'Space'}]`}
                </button>
              ) : (
                <button
                  type="button"
                  className={`card-mic-btn ${localUser.isMuted ? 'is-muted' : 'is-live'}`}
                  onClick={onToggleMic}
                  title={localUser.isMuted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  {localUser.isMuted ? 'Unmute Mic' : 'Mute Mic'}
                </button>
              )}
            </div>
          </div>

          {/* Your Live Mic Input VU Meter */}
          <div className="card-mic-meter-row">
            <span className="meter-caption">Your Input Level:</span>
            <div className="card-vu-bar">
              <div
                className={`card-vu-fill ${localUser.audioLevel > 60 ? 'high' : 'normal'}`}
                style={{ width: `${localUser.isSpeaking ? Math.max(10, localUser.audioLevel) : 0}%` }}
              />
            </div>
            <span className="meter-reading">{localUser.isSpeaking ? `${localUser.audioLevel}%` : '0%'}</span>
          </div>
        </div>
      )}

      {/* Connected Peers Voice Cards */}
      <div className="voice-peers-section">
        <h4 className="section-title">Connected Peers ({connectedPeers.length})</h4>

        {connectedPeers.length === 0 ? (
          <div className="voice-empty-state">
            <div className="empty-state-icon">👥</div>
            <h5>No Other Peers Connected</h5>
            <p>Share your 5-digit room code with up to 2 friends to start voice chat and watch together!</p>
            {roomId && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onCopyRoom?.(String(roomId))}
              >
                Copy Room Code ({roomId})
              </button>
            )}
          </div>
        ) : (
          connectedPeers.map((peer) => {
            const volumePercent = Math.round((peer.volume !== undefined ? peer.volume : 1.0) * 100);
            return (
              <div
                key={peer.peerId}
                className={`voice-user-card peer-card ${peer.isSpeaking ? 'speaking-active' : ''} ${peer.isLocalMuted ? 'is-local-muted' : ''}`}
              >
                <div className="card-top-row">
                  <div className="user-avatar-meta">
                    <div className="avatar-ring-container">
                      <div className={`peer-speaking-ring ${peer.isSpeaking ? 'active' : ''}`} />
                      <div className="card-avatar" style={{ background: getAvatarColor(peer.username) }}>
                        <span>{getInitials(peer.username)}</span>
                      </div>
                    </div>
                    <div className="card-user-titles">
                      <div className="user-name-tag">
                        <span className="card-username">{peer.username}</span>
                        {peer.isHost && <span className="host-tag">HOST</span>}
                      </div>
                      <span className={`card-status-pill ${peer.isSpeaking ? 'speaking' : peer.isLocalMuted ? 'muted' : peer.isMuted ? 'muted' : 'ready'}`}>
                        {peer.isSpeaking
                          ? '🎙️ Speaking'
                          : peer.isLocalMuted
                            ? '🔇 Muted by you'
                            : peer.isMuted
                              ? '🔇 Muted by them'
                              : '🟢 Active'}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    className={`card-mute-toggle-btn ${peer.isLocalMuted ? 'muted' : ''}`}
                    onClick={() => onToggleMutePeer?.(peer.peerId)}
                    title={peer.isLocalMuted ? 'Unmute this peer for me' : 'Mute this peer for me'}
                  >
                    {peer.isLocalMuted ? 'Unmute' : 'Mute'}
                  </button>
                </div>

                {/* Real-time Peer Audio Level Meter */}
                <div className="card-mic-meter-row">
                  <span className="meter-caption">Voice Output:</span>
                  <div className="card-vu-bar">
                    <div
                      className={`card-vu-fill ${peer.audioLevel > 60 ? 'high' : 'normal'}`}
                      style={{ width: `${peer.isSpeaking ? Math.max(10, peer.audioLevel) : 0}%` }}
                    />
                  </div>
                  <span className="meter-reading">{peer.isSpeaking ? `${peer.audioLevel}%` : 'Silent'}</span>
                </div>

                {/* Volume Slider 0% - 200% */}
                <div className="card-volume-control">
                  <div className="control-header-row">
                    <span className="vol-title">Volume Level</span>
                    <span className={`vol-val-badge ${volumePercent > 100 ? 'boosted' : peer.isLocalMuted || volumePercent === 0 ? 'muted' : ''}`}>
                      {peer.isLocalMuted ? '0% (Muted)' : `${volumePercent}%`}
                    </span>
                  </div>

                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.05"
                    value={peer.isLocalMuted ? 0 : (peer.volume !== undefined ? peer.volume : 1.0)}
                    onChange={(e) => onSetPeerVolume?.(peer.peerId, parseFloat(e.target.value))}
                    className={`peer-volume-slider ${volumePercent > 100 ? 'is-boosted' : ''}`}
                  />

                  <div className="slider-chips-row">
                    {[
                      { label: '50%', val: 0.5 },
                      { label: '100%', val: 1.0 },
                      { label: '150%', val: 1.5 },
                      { label: '200%', val: 2.0 }
                    ].map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        className={`chip-preset ${!peer.isLocalMuted && Math.abs((peer.volume || 1.0) - chip.val) < 0.04 ? 'active' : ''}`}
                        onClick={() => onSetPeerVolume?.(peer.peerId, chip.val)}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
