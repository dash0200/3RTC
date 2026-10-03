import React from 'react';

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
  onToggleChat
}) {
  const digits = roomId ? String(roomId).padStart(5, '0').split('') : [];

  return (
    <section className="stage-section">
      <div className="stage-canvas">
        <div className="stage-overlay">
          <div className="stage-card">
            <div className="stage-logo-ring">
              <svg viewBox="0 0 24 24" width="48" height="48" fill="#FF0033">
                <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
              </svg>
            </div>

            <h1 className="stage-title">
              {roomId ? `Room ${roomId}` : 'P2P Video & Live Chat'}
            </h1>
            <p className="stage-subtitle">
              {roomId
                ? isHost
                  ? 'Share this 5-digit code with your peer to establish direct P2P connection.'
                  : 'Joined room. Synchronizing with room host...'
                : 'Create a 5-digit room or enter an existing code to connect peer-to-peer.'}
            </p>

            {!roomId ? (
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
            ) : (
              <div className="active-room-display">
                <div className="code-banner">
                  <div className="code-label">SHARE THIS 5-DIGIT CODE</div>
                  <div className="code-digits">
                    {digits.map((d, i) => (
                      <span key={i} className="digit-box">{d}</span>
                    ))}
                  </div>
                  <button className="btn btn-subtle" onClick={onCopyRoom}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                    </svg>
                    Copy Invitation Link
                  </button>
                </div>

                <div className={`p2p-status-card ${isP2PConnected ? 'connected' : ''}`}>
                  <div className="spinner-dot"></div>
                  <span className="p2p-status-text">{p2pStatusText}</span>
                </div>
              </div>
            )}

            <div className="stage-footer-note">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="#888">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
              </svg>
              <span>Live WebRTC P2P DataChannel active. Video stream integration ready for next phase.</span>
            </div>
          </div>
        </div>
      </div>

      <div className="stage-controls">
        <div className="controls-left">
          <div className="peer-counter">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
            <span>{peerCount} Connected</span>
          </div>
          <div className={`p2p-badge ${isP2PConnected ? 'active' : ''}`}>
            {isP2PConnected ? 'P2P DIRECT LIVE' : 'P2P IDLE'}
          </div>
        </div>

        <div className="controls-center">
          <button className="control-btn disabled" title="Microphone (Ready for Audio)" disabled>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
            </svg>
          </button>
          <button className="control-btn disabled" title="Camera (Ready for Video)" disabled>
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
