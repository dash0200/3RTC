import React, { useState } from 'react';
import { nameFieldValue } from '../../utils/names';
import { BUILD_LABEL } from '../../version';
import RejoinCard from '../RejoinCard';
import { useRoomCodeInput } from '../../hooks/useRoomCodeInput';

/** Phone home: your name, create a room, or join with a 5-digit code. */
export default function PhoneHome({ username, initialPin = '', onCreate, onJoin, onOpenServerSettings, rejoin = null }) {
  const [name, setName] = useState(() => nameFieldValue(username));
  const displayName = name.trim() || username || 'Guest';
  const { digits, code, isComplete, boxProps } = useRoomCodeInput(initialPin, (c) => onJoin?.(c, displayName));

  return (
    <div className="phone-home">
      <div className="phone-home-main">
        <div className="phone-home-hero">
          <span className="phone-home-mark" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" />
            </svg>
          </span>
          <h1>Watch together</h1>
          <p>Video, voice and chat straight between your devices. Up to 6 people.</p>
        </div>

        <RejoinCard rejoin={rejoin} />

        <div className="phone-field">
          <label htmlFor="phone-name" className="phone-label">YOUR NAME</label>
          <input
            id="phone-name"
            className="phone-input"
            type="text"
            maxLength={20}
            autoComplete="nickname"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <button type="button" className="phone-btn phone-btn-primary phone-btn-lg" onClick={() => onCreate?.(displayName)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Create a room
        </button>

        <div className="phone-divider"><span>or join with a code</span></div>

        <fieldset className="phone-code">
          <legend className="phone-visually-hidden">5-digit room code</legend>
          {digits.map((_, i) => (
            <input key={i} className="phone-code-box" {...boxProps(i)} />
          ))}
        </fieldset>
        <button
          type="button"
          className="phone-btn phone-btn-ghost phone-btn-lg"
          disabled={!isComplete}
          onClick={() => onJoin?.(code, displayName)}
        >
          Join room
        </button>
      </div>

      <footer className="phone-home-foot">
        <p>Video, voice and chat stay peer-to-peer.</p>
        {onOpenServerSettings && (
          <button type="button" className="phone-link-btn" onClick={onOpenServerSettings}>Server settings</button>
        )}
        <nav className="site-links phone-site-links" aria-label="About 3RTC">
          <a href="/about">About</a>
          <a href="/youtube-watch-party">YouTube watch party</a>
          <a href="/watch-movies-together">Movie night</a>
          <a href="/watch-videos-together">Your own videos</a>
          <a href="/watch-links-together">Twitch & Vimeo</a>
          <a href="/play-ludo-online">Play Ludo</a>
          <a href="/privacy">Privacy</a>
        </nav>
        <p className="build-label">{BUILD_LABEL}</p>
      </footer>
    </div>
  );
}
