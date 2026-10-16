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
  nowPlaying = ''
}) {
  const [copied, setCopied] = useState(false);
  const ping = networkStats?.avgPingMs;
  const isWeak = isP2PConnected && typeof ping === 'number' && ping > 250;
  const alone = peerCount <= 1;
  const connection = isP2PConnected
    ? (isWeak ? { tone: 'weak', text: 'Weak connection' } : { tone: 'ok', text: 'Connected' })
    : alone ? { tone: 'idle', text: 'Waiting for friends' } : { tone: 'weak', text: 'Connecting…' };

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
      <p className="rh-now" title={nowPlaying || undefined}>{nowPlaying ? `Now playing · ${nowPlaying}` : ''}</p>
      {playbackLock && (
        <span className="rh-lock" title="Only the host can play, pause, seek or change the video">
          <Icon name="lock" size={15} />Host controls
        </span>
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
    </header>
  );
}
