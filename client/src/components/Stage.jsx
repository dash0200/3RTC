import React, { useState, useEffect, useRef } from 'react';
import YouTubeSyncPlayer from './YouTubeSyncPlayer';
import LocalVideoSyncPlayer from './LocalVideoSyncPlayer';
import FloatingReactions, { LIVE_REACTIONS } from './FloatingReactions';
import { PeerAudioPopover, getInitials } from './PeerVoiceRoster';
import { getAvatarColor } from '../utils/sound';
import SoundboardTray from './SoundboardTray';

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
  onPttPressEnd,
  // Feature 2.3: Synchronized Soundboard (Mini SFX Tray)
  soundboardSettings = null,
  activeSoundboardSfx = null,
  activeSfxCooldowns = {},
  onPlaySoundboardClip,
  onSoundboardVolumeChange,
  onToggleSoundboardMute,
  // Feature 4.1: Real-Time P2P Network HUD
  networkStats = null,
  onOpenNetworkHud,
  // Feature 4.3: QR Code for Instant Mobile Join
  onOpenQrCode
}) {
  const isPttMode = audioSettings?.inputMode === 'ptt';
  const localFileInputRef = useRef(null);

  const [selectedPeerPopover, setSelectedPeerPopover] = useState(null);
  const [isSoundboardOpen, setIsSoundboardOpen] = useState(false);
  const soundboardContainerRef = useRef(null);

  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef(null);

  // Close soundboard popover when clicking outside
  useEffect(() => {
    if (!isSoundboardOpen) return;
    const handleClickOutside = (e) => {
      if (soundboardContainerRef.current && !soundboardContainerRef.current.contains(e.target)) {
        setIsSoundboardOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [isSoundboardOpen]);

  // Close more menu when clicking outside
  useEffect(() => {
    if (!isMoreMenuOpen) return;
    const handleClickOutside = (e) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target)) {
        setIsMoreMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [isMoreMenuOpen]);

  const isMediaActive = Boolean(activeVideoId || localVideoFile || remoteLocalVideoMeta || streamVideoUrl);
  const showTheater = Boolean(roomId);

  const handleSelectReaction = (emoji) => {
    if (typeof onSendReaction === 'function') {
      onSendReaction(emoji);
    }
  };

  const handlePeerChipClick = (peer) => {
    const peerIdentifier = peer?.peerId || peer?.id;
    const currentIdentifier = selectedPeerPopover?.peerId || selectedPeerPopover?.id;
    if (currentIdentifier && currentIdentifier === peerIdentifier) {
      setSelectedPeerPopover(null);
    } else {
      setSelectedPeerPopover(peer);
    }
  };

  // Drag and Drop Local Video Handlers
  const [isStageDragOver, setIsStageDragOver] = useState(false);
  const [isBtnDragOver, setIsBtnDragOver] = useState(false);

  const isVideoFile = (file) => {
    if (!file) return false;
    if (file.type && file.type.startsWith('video/')) return true;
    const name = file.name ? file.name.toLowerCase() : '';
    return /\.(mp4|mkv|webm|avi|mov|m4v|ogv|flv)$/i.test(name);
  };

  const handleStageDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isStageDragOver) setIsStageDragOver(true);
  };

  const handleStageDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsStageDragOver(false);
  };

  const handleStageDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsStageDragOver(false);
    setIsBtnDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        if (isVideoFile(files[i])) {
          onLocalFileSelect?.(files[i]);
          break;
        }
      }
    }
  };

  const handleBtnDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isBtnDragOver) setIsBtnDragOver(true);
  };

  const handleBtnDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsBtnDragOver(false);
  };

  const handleBtnDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsBtnDragOver(false);
    setIsStageDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        if (isVideoFile(files[i])) {
          onLocalFileSelect?.(files[i]);
          break;
        }
      }
    }
  };

  return (
    <section className="stage-section">
      {/* Main Canvas Area (Drag-and-Drop Video Target & Stage Canvas) */}
      <div
        className={`stage-canvas yt-sync-wrapper ${isMediaActive ? 'has-video' : ''} ${isStageDragOver ? 'stage-drag-active' : ''}`}
        onDragOver={handleStageDragOver}
        onDragEnter={handleStageDragOver}
        onDragLeave={handleStageDragLeave}
        onDrop={handleStageDrop}
      >
        {/* Drag & Drop Visual Overlay */}
        {isStageDragOver && (
          <div className="stage-drag-overlay" role="alert">
            <div className="stage-drag-card">
              <div className="stage-drag-cloud-icon">
                <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor">
                  <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
                </svg>
              </div>
              <div className="stage-drag-title">Drop video to play for all peers</div>
              <div className="stage-drag-subtitle">Supports MP4, MKV, WebM • WebRTC direct sync</div>
            </div>
          </div>
        )}
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
        ) : (
          /* Case 2B: YouTube Player / Watch Party Stage */
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
        )}

        {/* Floating Live Reactions Overlay */}
        <FloatingReactions
          reactions={floatingReactions}
          onSendReaction={onSendReaction}
          showDock={false}
          hasMedia={isMediaActive}
        />
      </div>

      {/* Live Synchronized SFX HUD Banner on Stage */}
      {activeSoundboardSfx && (
        <div className="stage-soundboard-hud" role="status" aria-live="polite">
          <div className="sfx-hud-icon-wrap">
            <span className="sfx-hud-emoji">{activeSoundboardSfx.emoji || '🔊'}</span>
            <span className="sfx-hud-pulse-ring" />
          </div>
          <div className="sfx-hud-content">
            <div className="sfx-hud-label-row">
              <span className="sfx-hud-sender">{activeSoundboardSfx.sender || 'Peer'}</span>
              <span className="sfx-hud-action">played</span>
              <span className="sfx-hud-name">{activeSoundboardSfx.soundName}</span>
            </div>
            <div className="sfx-hud-visualizer">
              <span className="hud-eq-bar bar-1" />
              <span className="hud-eq-bar bar-2" />
              <span className="hud-eq-bar bar-3" />
              <span className="hud-eq-bar bar-4" />
              <span className="hud-eq-bar bar-5" />
            </div>
          </div>
        </div>
      )}

      {/* Bottom Stage Controls Bar (Matching Screenshot UI) */}
      <div className="stage-bottom-bar">
        {/* Left: Add Local Video Button & Voice Chips */}
        <div className="stage-bottom-left">
          <button
            type="button"
            className={`btn-add-local-video ${isBtnDragOver ? 'drag-over' : ''}`}
            onClick={() => localFileInputRef.current?.click()}
            onDragOver={handleBtnDragOver}
            onDragEnter={handleBtnDragOver}
            onDragLeave={handleBtnDragLeave}
            onDrop={handleBtnDrop}
            title="Click or drag and drop local video file (mp4, mkv, webm)"
          >
            <div className="local-video-cloud-icon">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
              </svg>
            </div>
            <div className="local-video-text">
              <span className="local-video-title">{isBtnDragOver ? 'Drop Video Here!' : 'Add Local Video'}</span>
              <span className="local-video-types">{isBtnDragOver ? 'Release to play' : '(mp4, mkv, webm • drag & drop)'}</span>
            </div>
          </button>
          <input
            type="file"
            ref={localFileInputRef}
            accept="video/mp4,video/webm,video/ogg,video/x-matroska,.mkv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file && typeof onLocalFileSelect === 'function') {
                onLocalFileSelect(file);
              }
            }}
          />

          <div className="stage-bottom-divider" />

          {/* Voice Chips: Local User and Connected Peers */}
          <div className="stage-bottom-voice-chips">
            {localUser && (
              <div
                className={`stage-voice-chip ${localUser.isSpeaking ? 'speaking' : ''} ${isMicMuted ? 'muted' : 'live'}`}
                onClick={isPttMode ? onOpenAudioSettings : onToggleMic}
                title={
                  isPttMode
                    ? `PTT Mode: Hold [${audioSettings?.pttKeyLabel || 'Space'}] to transmit`
                    : isMicMuted
                      ? "Microphone is muted. Click to speak"
                      : "Microphone is live. Click to mute"
                }
              >
                <div className="voice-chip-avatar" style={{ background: '#f59e0b' }}>
                  {getInitials(localUser.username || 'You')}
                </div>
                <span className="voice-chip-name">{localUser.username || 'You'} (You)</span>
                <span className={`voice-chip-mic-badge ${isMicMuted ? 'muted' : 'live'}`}>
                  {isMicMuted ? (
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
                    </svg>
                  )}
                </span>
              </div>
            )}

            {connectedPeers.map((peer, idx) => {
              const peerKey = peer.peerId || peer.id || `peer-${idx}`;
              const isPeerSpeaking = Boolean(peer.isSpeaking);
              const isPeerMuted = Boolean(peer.isMuted);
              const isSelected = (selectedPeerPopover?.peerId || selectedPeerPopover?.id) === (peer.peerId || peer.id);
              return (
                <div key={peerKey} className="stage-peer-chip-wrapper">
                  <div
                    className={`stage-voice-chip ${isPeerSpeaking ? 'speaking' : ''} ${isPeerMuted ? 'muted' : 'live'} ${isSelected ? 'selected' : ''}`}
                    onClick={() => handlePeerChipClick(peer)}
                    title={`${peer.username}${isPeerSpeaking ? ' • Speaking' : ''}${isPeerMuted ? ' • Muted' : ''} (Click to adjust volume)`}
                  >
                    <div className="voice-chip-avatar" style={{ background: getAvatarColor(peer.username) }}>
                      {getInitials(peer.username)}
                    </div>
                    <span className="voice-chip-name">{peer.username}</span>
                    <span className={`voice-chip-mic-badge ${isPeerMuted ? 'muted' : 'live'}`}>
                      {isPeerMuted ? (
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                          <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
                        </svg>
                      )}
                    </span>
                  </div>

                  {isSelected && (
                    <PeerAudioPopover
                      peer={peer}
                      onClose={() => setSelectedPeerPopover(null)}
                      onSetVolume={onSetPeerVolume}
                      onToggleMute={onToggleMutePeer}
                    />
                  )}
                </div>
              );
            })}

            {/* + Invite Pill */}
            {roomId && (
              <button
                type="button"
                className="stage-invite-btn"
                onClick={typeof onOpenQrCode === 'function' ? onOpenQrCode : () => onCopyRoom(String(roomId))}
                title="Invite peers: Scan QR code or copy 5-digit room code"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                </svg>
                <span>Invite</span>
              </button>
            )}
          </div>
        </div>

        {/* Right: Circular Action Buttons */}
        <div className="stage-bottom-right">
          {/* 1. Mic Button */}
          <button
            type="button"
            className={`circle-action-btn ${isMicMuted ? 'muted' : 'active'}`}
            onClick={roomId ? (isPttMode ? onOpenAudioSettings : onToggleMic) : undefined}
            onMouseDown={roomId && isPttMode ? onPttPressStart : undefined}
            onMouseUp={roomId && isPttMode ? onPttPressEnd : undefined}
            onTouchStart={roomId && isPttMode ? onPttPressStart : undefined}
            onTouchEnd={roomId && isPttMode ? onPttPressEnd : undefined}
            title={
              !roomId
                ? "Join a room to use microphone"
                : isAudioBlocked
                  ? "Audio & mic are blocked. Click to unblock"
                  : isPttMode
                    ? isPttActive
                      ? "🎙️ PTT Live! Release key/mouse to mute"
                      : `📻 Push-to-Talk: Hold [${audioSettings?.pttKeyLabel || 'Space'}] to transmit`
                    : isMicMuted
                      ? "Unmute Microphone"
                      : "Mute Microphone"
            }
            disabled={!roomId}
          >
            {isMicMuted ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
              </svg>
            )}
          </button>

          {/* 2. Audio Block / Deafen Button */}
          <button
            type="button"
            className={`circle-action-btn ${isAudioBlocked ? 'blocked' : ''}`}
            onClick={roomId ? onToggleBlockAudio : undefined}
            title={
              !roomId
                ? "Join a room to manage audio"
                : isAudioBlocked
                  ? "Audio & mic are blocked. Click to unblock"
                  : "Block Audio & Mic (Deafen)"
            }
            disabled={!roomId}
          >
            {isAudioBlocked ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            )}
          </button>

          {/* 3. Leave Room Button (Red Circle) */}
          {roomId && (
            <button
              type="button"
              className="circle-action-btn danger-leave"
              onClick={onLeaveRoom}
              title="Leave Room"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z" />
              </svg>
            </button>
          )}

          {/* 4. Soundboard Button (SFX Tray) */}
          {roomId && (
            <div className="stage-soundboard-wrap" ref={soundboardContainerRef}>
              {isSoundboardOpen && (
                <div className="stage-soundboard-floating-wrapper" role="dialog" aria-label="Soundboard SFX Tray">
                  <SoundboardTray
                    variant="floating"
                    volume={soundboardSettings?.volume ?? 0.75}
                    isMuted={Boolean(soundboardSettings?.muted)}
                    onVolumeChange={onSoundboardVolumeChange}
                    onToggleMute={onToggleSoundboardMute}
                    activeSfx={activeSoundboardSfx}
                    activeCooldowns={activeSfxCooldowns}
                    onPlayClip={onPlaySoundboardClip}
                    onClose={() => setIsSoundboardOpen(false)}
                  />
                </div>
              )}
              <button
                type="button"
                className={`circle-action-btn ${isSoundboardOpen ? 'active' : ''}`}
                onClick={() => setIsSoundboardOpen((prev) => !prev)}
                title="Soundboard SFX (Airhorn, Ba-Dum-Tss, Tada...)"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                </svg>
              </button>
            </div>
          )}

          {/* 5. Live Chat Toggle Button */}
          <button
            type="button"
            className={`circle-action-btn ${isChatOpen ? 'active' : ''}`}
            onClick={onToggleChat}
            title={isChatOpen ? "Close Live Chat" : `Open Live Chat${(unreadChatCount || chatCount) > 0 ? ` (${unreadChatCount || chatCount} new)` : ''}`}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
            </svg>
            {!isChatOpen && (unreadChatCount || chatCount) > 0 && (
              <span className="circle-badge">
                {(unreadChatCount || chatCount) > 99 ? '99+' : (unreadChatCount || chatCount)}
              </span>
            )}
          </button>

          {/* 6. More Options Dropdown Button */}
          <div className="stage-more-wrap" ref={moreMenuRef}>
            <button
              type="button"
              className={`circle-action-btn ${isMoreMenuOpen ? 'active' : ''}`}
              onClick={() => setIsMoreMenuOpen((prev) => !prev)}
              title="More options & reactions"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
              </svg>
            </button>

            {isMoreMenuOpen && (
              <div className="stage-more-dropdown" role="menu">
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setIsMoreMenuOpen(false);
                    onOpenAudioSettings?.();
                  }}
                >
                  <span className="dropdown-item-icon">🎙️</span>
                  <span>Audio & Mic Settings</span>
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setIsMoreMenuOpen(false);
                    onOpenNetworkHud?.();
                  }}
                >
                  <span className="dropdown-item-icon">📊</span>
                  <span>Network HUD Diagnostics</span>
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setIsMoreMenuOpen(false);
                    onOpenQrCode?.();
                  }}
                >
                  <span className="dropdown-item-icon">📱</span>
                  <span>Mobile Join QR Code</span>
                </button>
                <div className="dropdown-divider" />
                <div className="dropdown-label">Quick Reactions (Press 1-6):</div>
                <div className="dropdown-reactions-row">
                  {LIVE_REACTIONS.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="dropdown-react-btn"
                      onClick={() => {
                        handleSelectReaction(r.emoji);
                        setIsMoreMenuOpen(false);
                      }}
                      title={`${r.label} (Press ${r.key})`}
                    >
                      {r.emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}