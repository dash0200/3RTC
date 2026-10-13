import React, { useState } from 'react';
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
  isPttActive = false,
  peerCount = 1,
  onOpenSettings,
  // Feature 4.1: Real-Time P2P Network HUD
  networkStats = null,
  onOpenNetworkHud,
  // Feature 4.3: QR Code for Instant Mobile Join
  onOpenQrCode
}) {
  const [copied, setCopied] = useState(false);

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
        <div className="brand-logo" title="3RTC Watch Party Studio">
          <div className="yt-icon-box">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#ffffff">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <span className="brand-title">3RTC</span>
          <span className="brand-badge">LIVE</span>
        </div>

        {roomId && (
          <div className="header-room-pill-wrap">
            <div
              className={`header-room-chip ${copied ? 'copied' : ''}`}
              onClick={handleCopyClick}
              title="Click to copy 5-digit Room ID"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleCopyClick(e);
                }
              }}
            >
              <span className="room-green-dot" />
              <span className="room-label-text">Room:</span>
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
              {copied && <span className="room-copied-tag">Copied!</span>}
            </div>
          </div>
        )}
      </div>

      {/* Center Spacer */}
      <div className="header-center" />

      {/* Right: Network, Mic, Leave, Peer Counter, Settings */}
      <div className="header-right">
        {roomId && (
          <>
            {/* Network Latency & Topology Pill */}
            <button
              type="button"
              className={`header-net-chip ${isP2PConnected ? 'connected' : ''}`}
              onClick={typeof onOpenNetworkHud === 'function' ? onOpenNetworkHud : undefined}
              title={
                isP2PConnected
                  ? `WebRTC Direct Mesh (${networkStats?.avgPingMs !== null && networkStats?.avgPingMs !== undefined ? `${networkStats.avgPingMs}ms • ` : ''}${networkStats?.overallConnectionType || 'Direct P2P'}) - Click for Diagnostics HUD`
                  : (p2pStatusText || 'Waiting for peers... Click for Diagnostics')
              }
              aria-label="Open Network Diagnostics HUD"
            >
              <span className="net-status-dot" />
              <span className="net-status-text">
                {isP2PConnected
                  ? (networkStats?.avgPingMs !== null && networkStats?.avgPingMs !== undefined
                    ? `${networkStats.avgPingMs}ms • ${networkStats.overallConnectionType || 'Direct P2P'}`
                    : '1ms • Direct P2P')
                  : (p2pStatusText || 'Direct P2P')}
              </span>
            </button>

            {/* Microphone Toggle Pill */}
            {audioSettings?.inputMode === 'ptt' ? (
              <button
                type="button"
                className={`header-ctrl-pill ${isPttActive ? 'live ptt-live' : 'muted ptt-idle'}`}
                onClick={typeof onOpenAudioSettings === 'function' ? onOpenAudioSettings : onToggleMic}
                title={
                  isAudioBlocked
                    ? "Microphone is blocked"
                    : isPttActive
                      ? "PTT Transmitting Live! Release key to mute"
                      : `Push-to-Talk: Hold [${audioSettings?.pttKeyLabel || 'Space'}] to transmit`
                }
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  {isPttActive ? (
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
                  ) : (
                    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                  )}
                </svg>
                <span>{isAudioBlocked ? 'Mic Blocked' : isPttActive ? 'PTT Live' : `PTT [${audioSettings?.pttKeyLabel || 'Space'}]`}</span>
              </button>
            ) : (
              <button
                type="button"
                className={`header-ctrl-pill ${isMicMuted ? 'muted' : 'live'}`}
                onClick={onToggleMic}
                title={isMicMuted ? "Microphone is muted. Click to speak" : "Microphone is live. Click to mute"}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  {isMicMuted ? (
                    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                  ) : (
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
                  )}
                </svg>
                <span>{isAudioBlocked ? 'Mic Blocked' : isMicMuted ? 'Mic Off' : 'Mic Live'}</span>
              </button>
            )}

            {/* Leave Room Pill */}
            {typeof onLeaveRoom === 'function' && (
              <button
                type="button"
                className="header-leave-btn"
                onClick={onLeaveRoom}
                title="Leave room"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                </svg>
                <span>Leave</span>
              </button>
            )}

            {/* Subtle Divider */}
            <div className="header-v-divider" />

            {/* Peers in Room Counter */}
            <div className="header-peers-chip" title={`${peerCount} connected in room`}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
              </svg>
              <span>{peerCount} / {MAX_ROOM_SIZE}</span>
            </div>
          </>
        )}
      </div>
    </header>
  );
}