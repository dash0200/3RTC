import React, { useEffect, useRef, useState } from 'react';
import AudioDevicePicker from './AudioDevicePicker';
import { MAX_ROOM_SIZE } from '../webrtc/config';
import { copyToClipboard } from '../utils/clipboard';

export default function Header({
  isLive,
  roomId,
  onCopyRoom,
  isMicMuted = true,
  isAudioBlocked = false,
  onToggleMic,
  onToggleBlockAudio,
  isP2PConnected = false,
  p2pStatusText = '',
  isMediaActive = false,
  onExitVideo,
  onLeaveRoom,
  isChatOpen = false,
  unreadChatCount = 0,
  onToggleChat,
  audioSettings = null,
  onOpenAudioSettings,
  onUpdateAudioSettings,
  onSelectOutput,
  isPttActive = false,
  peerCount = 1,
  onOpenSettings,
  // Feature 4.1: Real-Time P2P Network HUD
  networkStats = null,
  onOpenNetworkHud,
  // Feature 4.3: QR Code for Instant Mobile Join
  onOpenQrCode,
  playbackLock = false
}) {
  const [copied, setCopied] = useState(false);
  // Plain words for the connection (the numbers live in the connection details)
  const ping = networkStats?.avgPingMs;
  const isWeak = isP2PConnected && typeof ping === 'number' && ping > 250;
  const connectionLabel = isP2PConnected
    ? (isWeak ? 'Weak connection' : 'Connected')
    : peerCount <= 1 ? 'Waiting for friends' : 'Connecting…';
  // Quick device switch (the arrow next to the mic button)
  const [devicesOpen, setDevicesOpen] = useState(false);
  const devicesRef = useRef(null);
  useEffect(() => {
    if (!devicesOpen) return undefined;
    const onDown = (e) => { if (devicesRef.current && !devicesRef.current.contains(e.target)) setDevicesOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setDevicesOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [devicesOpen]);

  const handleCopyClick = async (e) => {
    e.stopPropagation();
    if (!roomId) return;
    const cleanId = String(roomId).trim();
    const success = await copyToClipboard(cleanId);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (typeof onCopyRoom === 'function') {
        onCopyRoom(cleanId);
      }
    }
  };

  return (
    <header className="app-header">
      {/* Left: Brand Logo & Room Chip */}
      <div className="header-left">
        <div className="brand-logo">
          <div className="yt-icon-box">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#ffffff">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <span className="brand-title">3RTC</span>
        </div>

        {roomId && (
          <div className="header-room-pill-wrap">
            <button
              type="button"
              className={`header-room-chip ${copied ? 'copied' : ''}`}
              onClick={handleCopyClick}
              aria-label={`Copy room code ${roomId}`}
              title="Copy room code"
            >
              <span className="room-label-text">Room</span>
              <span className="room-code-digits">{roomId}</span>
              <span className="room-copy-icon">
                {copied ? (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="#00e676">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
                  </svg>
                )}
              </span>
              {copied && <span className="room-copied-tag" role="status">Copied</span>}
            </button>
          </div>
        )}
      </div>

      {/* Center Spacer */}
      <div className="header-center" />

      {/* Right: Network, Mic, Leave, Peer Counter, Settings */}
      <div className="header-right">
        {roomId && (
          <>
            {playbackLock && (
              <span className="header-lock-pill" title="The host turned on host controls: only the host can play, pause, seek or change the video">
                🔒 Host controls
              </span>
            )}
            {/* Network Latency & Topology Pill */}
            <button
              type="button"
              className={`header-net-chip ${isP2PConnected ? (isWeak ? 'weak' : 'connected') : ''}`}
              onClick={typeof onOpenNetworkHud === 'function' ? onOpenNetworkHud : undefined}
              title={
                isP2PConnected
                  ? `WebRTC Direct Mesh (${networkStats?.avgPingMs !== null && networkStats?.avgPingMs !== undefined ? `${networkStats.avgPingMs}ms • ` : ''}${networkStats?.overallConnectionType || 'Direct P2P'}) - Click for Diagnostics HUD`
                  : (p2pStatusText || 'Waiting for peers... Click for Diagnostics')
              }
              aria-label={`${connectionLabel}. Open connection details`}
            >
              <span className="net-status-dot" />
              <span className="net-status-text">{connectionLabel}</span>
            </button>

            {typeof onUpdateAudioSettings === 'function' && (
              <div className="header-devices" ref={devicesRef}>
                <button
                  type="button"
                  className={`header-devices-btn ${devicesOpen ? 'is-open' : ''}`}
                  onClick={() => setDevicesOpen((o) => !o)}
                  title="Microphone and speaker"
                  aria-label="Choose microphone and speaker"
                  aria-expanded={devicesOpen}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 14v-2a9 9 0 0 1 18 0v2" /><rect x="3" y="14" width="5" height="7" rx="2" /><rect x="16" y="14" width="5" height="7" rx="2" /></svg>
                </button>
                {devicesOpen && (
                  <div className="header-devices-menu" role="dialog" aria-label="Audio devices">
                    <AudioDevicePicker
                      compact
                      audioSettings={audioSettings}
                      onUpdateAudioSettings={onUpdateAudioSettings}
                      onSelectOutput={onSelectOutput}
                      isMicLive={!isMicMuted}
                    />
                    {typeof onOpenAudioSettings === 'function' && (
                      <button type="button" className="header-devices-more" onClick={() => { setDevicesOpen(false); onOpenAudioSettings(); }}>
                        Voice settings & mic test…
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              className={`header-invite-btn ${peerCount <= 1 ? 'is-alone' : ''}`}
              onClick={onOpenQrCode}
              title={`${peerCount} of ${MAX_ROOM_SIZE} in the room`}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4" /><path d="M2 21c0-4 3-7 7-7s7 3 7 7M19 8v6M16 11h6" /></svg>
              <span>{peerCount <= 1 ? 'Invite friends' : 'Invite'}</span>
              {peerCount > 1 && <span className="header-invite-count">{peerCount} / {MAX_ROOM_SIZE}</span>}
            </button>
          </>
        )}
      </div>
    </header>
  );
}