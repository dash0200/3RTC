import React, { useState } from 'react';
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
  onToggleChat
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
      <div className="header-left">
        <div className="brand-logo">
          <svg className="yt-icon" viewBox="0 0 24 24" width="28" height="28" fill="#FF0033">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
          </svg>
          <span className="brand-title">3RTC<span className="brand-badge">LIVE</span></span>
        </div>
        <div className={`live-pill ${isLive ? 'active' : ''}`}>
          <span className="live-dot"></span>
          <span>{isLive ? 'LIVE' : 'OFFLINE'}</span>
        </div>
      </div>

      <div className="header-center">
        {roomId && (
          <div className="header-room-group">
            <div
              className={`room-status-chip ${copied ? 'copied' : ''}`}
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
              <span className="chip-label">ROOM:</span>
              <span className="chip-code">{roomId}</span>
              <button
                type="button"
                className="chip-copy-btn"
                title="Copy Room ID"
                tabIndex={-1}
                onClick={handleCopyClick}
              >
                {copied ? (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="#00e676">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
                  </svg>
                )}
              </button>
              {copied && <span className="chip-copied-text">Copied!</span>}
            </div>

            {/* Direct P2P Status Chip */}
            <div
              className={`header-p2p-chip ${isP2PConnected ? 'connected' : ''}`}
              title={p2pStatusText || (isP2PConnected ? 'WebRTC Direct P2P Mesh Connected' : 'Waiting for peers...')}
            >
              <span className="p2p-chip-dot"></span>
              <span className="p2p-chip-text">{p2pStatusText || (isP2PConnected ? 'Direct P2P Active' : 'Waiting for peers...')}</span>
            </div>

            <button
              type="button"
              className={`header-voice-chip ${isMicMuted ? 'muted' : 'live'}`}
              onClick={onToggleMic}
              title={
                isAudioBlocked
                  ? "Microphone is blocked (Audio is blocked. Click to unblock and speak)"
                  : isMicMuted
                    ? "Microphone muted. Click to speak"
                    : "Microphone live. Click to mute"
              }
            >
              <span className={`voice-chip-dot ${isMicMuted ? 'muted' : 'live'}`}></span>
              <span>{isAudioBlocked ? 'Mic Blocked' : isMicMuted ? 'Mic Off' : 'Mic Live'}</span>
            </button>

            {isAudioBlocked && (
              <button
                type="button"
                className="header-voice-chip blocked"
                onClick={onToggleBlockAudio}
                title="Incoming audio & microphone blocked (Text Chat only). Click to unblock."
              >
                <span className="voice-chip-dot blocked"></span>
                <span>Audio Blocked</span>
              </button>
            )}

            {isMediaActive && typeof onExitVideo === 'function' && (
              <button
                type="button"
                className="header-action-btn exit-video"
                onClick={onExitVideo}
                title="Exit video and return to watch party stage"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
                <span>Exit Video</span>
              </button>
            )}

            {typeof onLeaveRoom === 'function' && (
              <button
                type="button"
                className="header-action-btn leave-room"
                onClick={onLeaveRoom}
                title="Leave room"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                  <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                </svg>
                <span>Leave</span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="header-right">
        {typeof onToggleChat === 'function' && (
          <button
            type="button"
            className={`header-sidebar-toggle-btn ${isChatOpen ? 'active' : ''} ${!isChatOpen && unreadChatCount > 0 ? 'has-unread' : ''}`}
            onClick={onToggleChat}
            title={isChatOpen ? "Close sidebar" : `Open sidebar${unreadChatCount > 0 ? ` (${unreadChatCount} new)` : ''}`}
            aria-label={isChatOpen ? "Close sidebar" : "Open sidebar"}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
            <span>{isChatOpen ? 'Close Sidebar' : 'Open Sidebar'}</span>
            {!isChatOpen && unreadChatCount > 0 && (
              <span className="header-sidebar-badge">
                {unreadChatCount > 99 ? '99+' : unreadChatCount}
              </span>
            )}
          </button>
        )}
      </div>
    </header>
  );
}