import React, { useState } from 'react';
import { MAX_ROOM_SIZE } from '../webrtc/config';
import { copyToClipboard } from '../utils/clipboard';
import { Logo } from './Logo';
import { Icon } from './icons';

/**
 * Desktop room header (Figma): logo, room code (click to copy), what's playing,
 * the connection in plain words, and Invite (the main button while you're alone).
 */
export default function Header({
  roomId,
  onCopyRoom,
  isP2PConnected = false,
  networkStats = null,
  peerCount = 1,
  onOpenNetworkHud,
  onOpenQrCode,
  playbackLock = false,
  nowPlaying = '',
  isChatOpen = true,
  onToggleChat,
  unreadCount = 0,
  isMediaActive = false,
  onExitVideo = null,
  onVoteSkip = null,
  skipVotes = [],
  connectedPeers = [],
  isHost = false,
  username = '',
  activityStatus = null
}) {
  const [copied, setCopied] = useState(false);
  const ping = networkStats?.avgPingMs;
  const isWeak = isP2PConnected && typeof ping === 'number' && ping > 250;
  const alone = peerCount <= 1;
  const connection = isP2PConnected
    ? (isWeak ? { tone: 'weak', text: 'Weak connection' } : { tone: 'ok', text: 'Connected' })
    : alone ? { tone: 'idle', text: 'Waiting for friends' } : { tone: 'weak', text: 'Connecting…' };

  const hostPeer = isHost ? null : connectedPeers.find((p) => p.isHost);
  const totalParticipants = connectedPeers.length + 1;
  const requiredVotes = totalParticipants <= 2 ? totalParticipants : Math.ceil(totalParticipants / 2);
  const hasVotedSkip = skipVotes.includes(username);

  const copy = async () => {
    if (!roomId) return;
    const code = String(roomId).trim();
    if (await copyToClipboard(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onCopyRoom?.(code);
    }
  };

  return (
    <header className="rh">
      <Logo size={30} />
      {roomId && (
        <button type="button" className={`rh-room ${copied ? 'is-copied' : ''}`} onClick={copy} aria-label={`Copy room code ${roomId}`} title="Copy room code">
          <span className="rh-room-label">{copied ? 'Copied' : 'Room'}</span>
          <span className="rh-room-code">{roomId}</span>
          <Icon name={copied ? 'check' : 'copy'} size={15} />
        </button>
      )}

      {/* When media is active, show clean sync pill in header */}
      {isMediaActive && (
        <span className="rh-sync-pill" role="status" title="Sync status with peers">
          <span className="rh-sync-dot" aria-hidden="true" />
          <span>{isHost ? 'In sync · You are host' : hostPeer ? `In sync · ${hostPeer.username}` : 'In sync'}</span>
        </span>
      )}

      <p className="rh-now" title={nowPlaying || undefined}>{nowPlaying ? `Now playing · ${nowPlaying}` : ''}</p>

      {playbackLock && (
        <span className="rh-lock" title="Only the host can play, pause, seek or change the video">
          <Icon name="lock" size={15} />Host controls
        </span>
      )}

      {/* Dedicated video action buttons in Header - keeps video canvas 100% clean */}
      {isMediaActive && (
        <div className="rh-video-actions">
          {typeof onVoteSkip === 'function' && totalParticipants > 1 && (
            <button
              type="button"
              className={`rh-action-btn rh-skip-btn ${hasVotedSkip ? 'is-voted' : ''}`}
              onClick={onVoteSkip}
              title={hasVotedSkip ? 'You voted to skip (click to unvote)' : `Vote to skip (${skipVotes.length}/${requiredVotes} needed)`}
            >
              <Icon name="skipForward" size={14} />
              <span>Skip ({skipVotes.length}/{requiredVotes})</span>
            </button>
          )}

          {typeof onExitVideo === 'function' && (
            <button
              type="button"
              className="rh-action-btn rh-exit-btn"
              onClick={onExitVideo}
              title="Exit video and return to watch party stage"
              aria-label="Exit video"
            >
              <Icon name="close" size={14} strokeWidth={2.4} />
              <span>Exit</span>
            </button>
          )}
        </div>
      )}
      <button type="button" className={`rh-conn is-${connection.tone}`} onClick={onOpenNetworkHud} aria-label={`${connection.text}. Open connection details`}>
        <Icon name="signal" size={16} strokeWidth={2.4} />
        {connection.text}
      </button>
      <button type="button" className={`rh-invite ${alone ? 'is-primary' : ''}`} onClick={onOpenQrCode}>
        {alone && <Icon name="userPlus" size={17} strokeWidth={2.2} />}
        {alone ? 'Invite friends' : 'Invite'}
        {!alone && <span className="rh-count">{peerCount} / {MAX_ROOM_SIZE}</span>}
      </button>
      {onToggleChat && (
        <button
          type="button"
          className={`rh-chat-toggle ${isChatOpen ? 'is-open' : ''} ${!isChatOpen && activityStatus?.attention ? 'needs-you' : ''}`}
          onClick={onToggleChat}
          aria-label={isChatOpen ? 'Hide side panel' : 'Open chat and queue panel'}
          title={isChatOpen ? 'Hide side panel' : 'Open chat and queue panel'}
        >
          <Icon name="chat" size={16} strokeWidth={2.2} />
          <span className="rh-chat-toggle-text">{isChatOpen ? 'Hide Panel' : 'Panel'}</span>
          {!isChatOpen && (activityStatus?.attention || unreadCount > 0) && (
            <span className={`rh-chat-badge ${activityStatus?.attention ? 'is-activity' : ''}`} style={activityStatus?.color ? { backgroundColor: activityStatus.color } : undefined}>
              {activityStatus?.attention ? (activityStatus.label || '🎲') : unreadCount}
            </span>
          )}
        </button>
      )}
    </header>
  );
}
