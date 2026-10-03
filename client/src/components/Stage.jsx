import React, { useState, useEffect } from 'react';
import YouTubeSyncPlayer from './YouTubeSyncPlayer';

export default function Stage({
  roomId,
  isHost,
  peerCount,
  isP2PConnected,
  p2pStatusText,
  onOpenCreate,
  onOpenJoin,
  onCopyRoom,
  onLeaveRoom,
  onToggleChat,
  activeVideoId,
  onVideoChange,
  onBroadcastAction,
  remoteAction,
  onRegisterStateGetter
}) {
  const digits = roomId ? String(roomId).padStart(5, '0').split('') : [];
  const [hasEnteredTheater, setHasEnteredTheater] = useState(false);

  useEffect(() => {
    if (!roomId) {
      setHasEnteredTheater(false);
    }
  }, [roomId]);

  useEffect(() => {
    if (isP2PConnected || activeVideoId) {
      setHasEnteredTheater(true);
    }
  }, [isP2PConnected, activeVideoId]);

  // When room is active and (peers are connected OR a video has been selected OR watch party entered)
  const showYouTubeTheater = Boolean(roomId && (isP2PConnected || activeVideoId || hasEnteredTheater));

  const handleExitVideo = () => {
    onVideoChange(null);
    if (typeof onBroadcastAction === 'function') {
      onBroadcastAction('close', {});
    }
  };

  return (
    <section className="stage-section">
      {/* Top Stage Bar when inside a room */}
      {roomId && (
        <div className="stage-room-bar">
          <div className="room-bar-left">
            <span
              className="room-badge"
              onClick={() => onCopyRoom(String(roomId))}
              title="Click to copy Room ID"
              style={{ cursor: 'pointer' }}
            >
              <span className="room-badge-label">ROOM</span>
              <strong className="room-badge-code">{roomId}</strong>
            </span>
            <button className="btn-copy-pill" onClick={() => onCopyRoom(String(roomId))} title="Copy 5-digit Room ID">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
              </svg>
              Copy Code
            </button>
          </div>

          <div className="room-bar-center">
            <div className={`p2p-pill ${isP2PConnected ? 'connected' : ''}`}>
              <span className="p2p-pill-dot"></span>
              <span className="p2p-pill-text">{p2pStatusText}</span>
            </div>
          </div>

          <div className="room-bar-right">
            {activeVideoId && (
              <button
                type="button"
                className="btn-exit-video-pill"
                onClick={handleExitVideo}
                title="Exit video and return to watch party stage"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
                <span>Exit Video</span>
              </button>
            )}
            <button className="btn-leave-pill" onClick={onLeaveRoom} title="Leave room">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
              </svg>
              Leave
            </button>
          </div>
        </div>
      )}

      {/* Main Canvas Area */}
      <div className={`stage-canvas ${activeVideoId ? 'has-video' : ''}`}>
        {!roomId ? (
          /* Case 1: No room joined yet */
          <div className="stage-overlay">
            <div className="stage-card">
              <div className="stage-logo-ring">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="#FF0033">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                </svg>
              </div>

              <h1 className="stage-title">P2P Watch Party & Live Chat</h1>
              <p className="stage-subtitle">
                Create a 5-digit room or enter an existing code to connect directly peer-to-peer (up to 3 users).
                Watch YouTube videos together with real-time synchronized play, pause & seek.
              </p>

              <div className="initial-actions">
                <button className="btn btn-primary" onClick={onOpenCreate}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                  </svg>
                  Create Room
                </button>
                <button className="btn btn-secondary" onClick={onOpenJoin}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
                  </svg>
                  Join with Code
                </button>
              </div>

              <div className="stage-footer-note">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="#888">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                </svg>
                <span>Direct WebRTC P2P mesh data connection. No third-party video storage.</span>
              </div>
            </div>
          </div>
        ) : showYouTubeTheater ? (
          /* Case 2: Room active + connected (or video loaded) -> Show Synchronized YouTube Theater */
          <YouTubeSyncPlayer
            videoId={activeVideoId}
            onVideoChange={onVideoChange}
            onBroadcastAction={onBroadcastAction}
            remoteAction={remoteAction}
            isP2PConnected={isP2PConnected}
            onRegisterStateGetter={onRegisterStateGetter}
          />
        ) : (
          /* Case 3: Room created/joined, waiting for peer to connect */
          <div className="stage-overlay">
            <div className="stage-card">
              <div className="stage-logo-ring">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="#FF0033">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
                </svg>
              </div>

              <h1 className="stage-title">Room {roomId}</h1>
              <p className="stage-subtitle">
                {isHost
                  ? 'Share this 5-digit code with your friends to connect directly (up to 3 peers).'
                  : 'Connected to signaling. Establishing P2P mesh connection with peers...'}
              </p>

              <div className="active-room-display">
                <div className="code-banner">
                  <div className="code-label">{isHost ? 'SHARE THIS 5-DIGIT CODE' : 'ROOM CODE'}</div>
                  <div
                    className="code-digits"
                    onClick={() => onCopyRoom(String(roomId))}
                    title="Click to copy 5-digit Room ID"
                    style={{ cursor: 'pointer' }}
                  >
                    {digits.map((d, i) => (
                      <span key={i} className="digit-box">{d}</span>
                    ))}
                  </div>
                  <button className="btn btn-subtle" onClick={() => onCopyRoom(String(roomId))}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                    </svg>
                    Copy 5-Digit Code
                  </button>
                </div>

                <div className={`p2p-status-card ${isP2PConnected ? 'connected' : ''}`}>
                  <div className="spinner-dot"></div>
                  <span className="p2p-status-text">{p2pStatusText}</span>
                </div>
              </div>

              {/* Allow host/user to open Watch Party stage directly while waiting */}
              <div className="early-video-loader">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setHasEnteredTheater(true)}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="#FF0033">
                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                  </svg>
                  Open YouTube Watch Party Stage
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Stage Controls Bar */}
      <div className="stage-controls">
        <div className="controls-left">
          <div className="peer-counter">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
            <span>{peerCount} / 3 in Room</span>
          </div>
          <div className={`p2p-badge ${isP2PConnected ? 'active' : ''}`}>
            {isP2PConnected ? 'P2P DIRECT MESH' : 'WAITING PEERS'}
          </div>
        </div>

        <div className="controls-center">
          <button className="control-btn disabled" title="Microphone (Reserved for WebRTC Audio)" disabled>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
            </svg>
          </button>
          <button className="control-btn disabled" title="Camera (Reserved for WebRTC Video)" disabled>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
            </svg>
          </button>
          {roomId && (
            <button className="control-btn danger" onClick={onLeaveRoom} title="Leave Room">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z"/>
              </svg>
            </button>
          )}
        </div>

        <div className="controls-right">
          <button className="control-btn" onClick={onToggleChat} title="Toggle Live Chat">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
            </svg>
          </button>
        </div>
      </div>
    </section>
  );
}
