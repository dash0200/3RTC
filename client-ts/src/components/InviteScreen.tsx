import React, { useEffect, useRef, useState } from 'react';
import { nameFieldValue, cleanName } from '../utils/names';
import { getAvatarColor } from '../utils/sound';
import { getInitials } from './PeerVoiceRoster';
import { Logo } from './Logo';

export interface InviteScreenProps {
  pin: string;
  username?: string;
  onJoin?: (pin: string, name: string, options: { micOn: boolean }) => void;
  onDismiss?: () => void;
}

/**
 * Opened from an invite link (?room=12345): the only big button is Join.
 * The mic choice is made here, before anyone can hear you.
 */
export default function InviteScreen({
  pin,
  username = '',
  onJoin,
  onDismiss
}: InviteScreenProps) {
  const [name, setName] = useState<string>(() => nameFieldValue(username));
  const [micOn, setMicOn] = useState<boolean>(false);
  // Who sent the link (?from=Priya, added by 3RTC's invite links)
  const [inviter] = useState<string>(() => {
    try {
      return cleanName(new URLSearchParams(window.location.search).get('from') || '');
    } catch {
      return '';
    }
  });
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Focus the name on desktop only (on phones it would open the keyboard over the Join button)
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) nameRef.current?.focus();
  }, []);

  const join = (e?: React.FormEvent) => {
    e?.preventDefault();
    onJoin?.(pin, name.trim() || username || 'Guest', { micOn });
  };

  return (
    <div className="invite">
      <header className="invite-top"><Logo size={28} /></header>
      <form className="invite-body" onSubmit={join}>
        <div className="invite-hero">
          {inviter ? (
            <span className="rd-av invite-av" style={{ ['--av' as any]: getAvatarColor(inviter) }} aria-hidden="true">{getInitials(inviter)}</span>
          ) : (
            <span className="invite-mark" aria-hidden="true">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="4" /><path d="M2 21c0-4 3-7 7-7s7 3 7 7M19 8v6M16 11h6" /></svg>
            </span>
          )}
          <h1>{inviter ? `${inviter} invited you to watch together` : 'You’re invited to watch together'}</h1>
          <p>Room <span className="invite-code">{pin}</span> · up to 4 people, video, voice and chat</p>
        </div>

        <div className="invite-fields">
          <div className="dh-field">
            <label htmlFor="invite-name">Your name</label>
            <input
              id="invite-name"
              ref={nameRef}
              type="text"
              maxLength={20}
              autoComplete="nickname"
              placeholder="So your friends know it’s you"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className="invite-toggle">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            <span className="invite-toggle-text">
              <span>Turn my mic on when I join</span>
              <small>{micOn ? 'Everyone in the room will hear you' : 'You can turn it on any time'}</small>
            </span>
            <input type="checkbox" role="switch" className="rd-switch" checked={micOn} onChange={(e) => setMicOn(e.target.checked)} />
          </label>
        </div>

        <div className="invite-actions">
          <button type="submit" className="rd-btn rd-btn-primary rd-btn-xl">Join room</button>
          <button type="button" className="rd-btn rd-btn-ghost" onClick={onDismiss}>Start my own room instead</button>
        </div>
      </form>
    </div>
  );
}
