import React, { useState, useEffect } from 'react';
import YouTubeSyncPlayer from './YouTubeSyncPlayer';
import LocalVideoSyncPlayer from './LocalVideoSyncPlayer';
import FloatingReactions from './FloatingReactions';
import PeerVoiceRoster from './PeerVoiceRoster';

export default function Stage({
  roomId,
  isHost,
  peerCount,
  isP2PConnected,
  p2pStatusText,
  connectedPeers = [],
  localUser = null,
  onSetPeerVolume,
  onToggleMutePeer,
  onOpenCreate,
  onOpenJoin,
  onCopyRoom,
  onLeaveRoom,
  onToggleChat,
  isChatOpen = false,
  chatCount = 0,
  unreadChatCount = 0,
  activeVideoId,
  onVideoChange,
  localVideoFile,
  remoteLocalVideoMeta,
  onLocalFileSelect,
  onCloseLocalVideo,
  onBroadcastAction,
  remoteAction,
  onRegisterStateGetter,
  isMicMuted = true,
  isAudioBlocked = false,
  onToggleMic,
  onToggleBlockAudio,
  peerVoiceStates = {},
  queue = [],
  onAddToQueue,
  onPlayNextInQueue,
  onVoteSkip,
  skipVotes = [],
  onOpenQueue,
  activeVideoTitle = '',
  username = '',
  floatingReactions = [],
  onSendReaction,
  // Feature 1.4: WebRTC Direct Video Streaming
  streamProgress = null,
  streamVideoUrl = null,
  onRequestP2PStream,
  onCancelP2PStream,
  audioSettings = null,
  onOpenAudioSettings,
  isPttActive = false,
  onPttPressStart,
  onPttPressEnd
}) {
  const isPttMode = audioSettings?.inputMode === 'ptt';
  const digits = roomId ? String(roomId).padStart(5, '0').split('') : [];
  const [hasEnteredTheater, setHasEnteredTheater] = useState(false);

  useEffect(() => {
    if (!roomId) {
      setHasEnteredTheater(false);
    }
  }, [roomId]);

  const isMediaActive = Boolean(activeVideoId || localVideoFile || remoteLocalVideoMeta || streamVideoUrl);

  useEffect(() => {
    if (isP2PConnected || isMediaActive) {
      setHasEnteredTheater(true);
    }
  }, [isP2PConnected, isMediaActive]);

  // When room is active and (peers are connected OR media active OR watch party entered)
  const showTheater = Boolean(roomId && (isP2PConnected || isMediaActive || hasEnteredTheater));

  return (
    <section className="stage-section">
      {/* Main Canvas Area */}
      <div className={`stage-canvas ${isMediaActive ? 'has-video' : ''}`}>
        {!roomId ? (
          /* Case 1: No room joined yet */
          <div className="stage-overlay">
            <div className="stage-card">
              <div className="stage-logo-ring">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="#FF0033">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                </svg>
              </div>

              <h1 className="stage-title">3RTC Watch Party</h1>
              <p className="stage-subtitle">
                Create a room or enter an existing room with code to connect directly peer-to-peer (up to 3 peers).
                Watch YouTube videos together.
              </p>

              <div className="initial-actions">
                <button className="btn btn-primary" onClick={onOpenCreate}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                  </svg>
                  Create Room
                </button>
                <button className="btn btn-secondary" onClick={onOpenJoin}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
                  </svg>
                  Join with Code
                </button>
              </div>

              <div className="stage-footer-note">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="#888">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
                </svg>
                <span>Direct WebRTC P2P mesh data connection. No third-party video storage.</span>
              </div>
            </div>
          </div>
        ) : (localVideoFile || remoteLocalVideoMeta || streamVideoUrl) ? (
          /* Case 2A: Local Video Drag-and-Drop Sync Player or P2P Streamed Video */
          <LocalVideoSyncPlayer
            initialFile={localVideoFile}
            remoteMeta={remoteLocalVideoMeta}
            onFileSelect={onLocalFileSelect}
            onClose={onCloseLocalVideo}
            onBroadcastAction={onBroadcastAction}
            remoteAction={remoteAction}
            isP2PConnected={isP2PConnected}
            onRegisterStateGetter={onRegisterStateGetter}
            streamProgress={streamProgress}
            streamVideoUrl={streamVideoUrl}
            onRequestP2PStream={onRequestP2PStream}
            onCancelP2PStream={onCancelP2PStream}
            isHost={isHost}
            floatingReactions={floatingReactions}
            onSendReaction={onSendReaction}
            roomId={roomId}
            isPttSpaceActive={isPttMode && (audioSettings?.pttKey === 'Space' || audioSettings?.pttKey === ' ')}
          />
        ) : showTheater ? (
          /* Case 2B: YouTube Player / Watch Party Lobby */
          <YouTubeSyncPlayer
            videoId={activeVideoId}
            activeVideoTitle={activeVideoTitle}
            onVideoChange={onVideoChange}
            onBroadcastAction={onBroadcastAction}
            remoteAction={remoteAction}
            isP2PConnected={isP2PConnected}
            onRegisterStateGetter={onRegisterStateGetter}
            onLocalFileSelect={onLocalFileSelect}
            queue={queue}
            onAddToQueue={onAddToQueue}
            onPlayNextInQueue={onPlayNextInQueue}
            onVoteSkip={onVoteSkip}
            skipVotes={skipVotes}
            peerCount={peerCount}
            username={username}
            onOpenQueue={onOpenQueue}
          />
        ) : (
          /* Case 3: Room created/joined, waiting for peer to connect */
          <div className="stage-overlay">
            <div className="stage-card">
              <div className="stage-logo-ring">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="#FF0033">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
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
                      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
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
                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                  </svg>
                  Open YouTube Watch Party Stage
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Floating Live Reactions Overlay & Reaction Dock */}
        <FloatingReactions
          reactions={floatingReactions}
          onSendReaction={onSendReaction}
          showDock={Boolean(roomId)}
          hasMedia={isMediaActive}
        />
      </div>

      {/* Bottom Stage Controls Bar */}
      <div className="stage-controls">
        <div className="controls-left">
          <div className="peer-counter">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
            </svg>
            <span>{peerCount} / 3 in Room</span>
          </div>
          <div className={`p2p-badge ${isP2PConnected ? 'active' : ''}`}>
            {isP2PConnected ? 'P2P DIRECT MESH' : 'WAITING PEERS'}
          </div>

          {/* Voice Chat Avatars, Speaking Rings & Per-Peer Volume */}
          {roomId && (
            <PeerVoiceRoster
              connectedPeers={connectedPeers}
              localUser={localUser}
              onSetPeerVolume={onSetPeerVolume}
              onToggleMutePeer={onToggleMutePeer}
              onToggleMic={onToggleMic}
              audioSettings={audioSettings}
              onOpenAudioSettings={onOpenAudioSettings}
              isPttActive={isPttActive}
            />
          )}
        </div>

        <div className="controls-center">
          {/* Microphone Mute/Unmute Button (with PTT mode support) */}
          <button
            type="button"
            className={`control-btn ${!roomId ? 'disabled' : isPttMode ? (isPttActive ? 'mic-live ptt-transmitting' : 'mic-muted ptt-ready') : isMicMuted ? 'mic-muted' : 'mic-live'}`}
            onClick={roomId ? (!isPttMode ? onToggleMic : onOpenAudioSettings) : undefined}
            onMouseDown={roomId && isPttMode ? onPttPressStart : undefined}
            onMouseUp={roomId && isPttMode ? onPttPressEnd : undefined}
            onTouchStart={roomId && isPttMode ? onPttPressStart : undefined}
            onTouchEnd={roomId && isPttMode ? onPttPressEnd : undefined}
            title={
              !roomId
                ? "Join a room to use microphone"
                : isAudioBlocked
                  ? "Microphone blocked (Audio is blocked. Click to unblock and speak)"
                  : isPttMode
                    ? isPttActive
                      ? "🎙️ PTT Transmitting Live! Release key/mouse to mute"
                      : `📻 Push-to-Talk Mode: Hold [${audioSettings?.pttKeyLabel || 'Space'}] or hold this button to transmit`
                    : isMicMuted
                      ? "Unmute Microphone (Click to speak)"
                      : "Mute Microphone (Microphone is live)"
            }
            disabled={!roomId}
          >
            {isPttMode ? (
              isPttActive ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                </svg>
              )
            ) : isMicMuted ? (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
              </svg>
            )}
            {((!isPttMode && !isMicMuted) || (isPttMode && isPttActive)) && <span className="mic-pulse-wave"></span>}
            {isPttMode && <span className="stage-ptt-tag">{isPttActive ? 'LIVE' : (audioSettings?.pttKeyLabel || 'PTT')}</span>}
          </button>

          {/* Block Incoming Audio / Deafen Button */}
          <button
            type="button"
            className={`control-btn ${!roomId ? 'disabled' : isAudioBlocked ? 'audio-blocked' : 'audio-allowed'}`}
            onClick={roomId ? onToggleBlockAudio : undefined}
            title={
              !roomId
                ? "Join a room to manage audio"
                : isAudioBlocked
                  ? "Audio & mic are blocked. Click to unblock"
                  : "Block Audio & Mic (Text Chat only / Deafen)"
            }
            disabled={!roomId}
          >
            {isAudioBlocked ? (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            )}
          </button>

          {/* Audio Processing & Voice Settings Button */}
          {roomId && typeof onOpenAudioSettings === 'function' && (
            <button
              type="button"
              className="control-btn audio-settings-btn"
              onClick={onOpenAudioSettings}
              title="Audio Processing & PTT Settings (Echo Cancellation, Noise Suppression, Auto Gain)"
              aria-label="Audio & Voice Settings"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
              <span className="audio-dsp-active-dot" title="Hardware Audio DSP Active" />
            </button>
          )}

          {roomId && (
            <button className="control-btn danger" onClick={onLeaveRoom} title="Leave Room">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z" />
              </svg>
            </button>
          )}
        </div>

        <div className="controls-right">
          <button
            type="button"
            className={`control-btn chat-toggle-btn ${isChatOpen ? 'chat-active' : ''} ${!isChatOpen && (unreadChatCount || chatCount) > 0 ? 'has-unread' : ''}`}
            onClick={onToggleChat}
            title={isChatOpen ? "Close Live Chat" : `Open Live Chat${(unreadChatCount || chatCount) > 0 ? ` (${unreadChatCount || chatCount} new)` : ''}`}
            aria-label={isChatOpen ? "Close Live Chat" : "Open Live Chat"}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
            </svg>
            {!isChatOpen && (unreadChatCount || chatCount) > 0 && (
              <span className="control-badge unread-badge">
                {(unreadChatCount || chatCount) > 99 ? '99+' : (unreadChatCount || chatCount)}
              </span>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}