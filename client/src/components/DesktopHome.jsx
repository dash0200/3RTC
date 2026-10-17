import React, { useState } from 'react';
import { nameFieldValue } from '../utils/names';
import { BUILD, BUILD_LABEL } from '../version';
import RejoinCard from './RejoinCard';
import { useRoomCodeInput } from '../hooks/useRoomCodeInput';
import { Logo } from './Logo';

/**
 * Desktop home, before a room exists: one screen with your name, Create, and the 5-box code join.
 * (No chat sidebar, mic or video controls yet: there is no room for them to act on.)
 */
export default function DesktopHome({ username, initialPin = '', onCreate, onJoin, onOpenServerSettings, rejoin = null, isOnline = true }) {
  const [name, setName] = useState(() => nameFieldValue(username));
  const displayName = name.trim() || username || 'Guest';
  const { digits, code, isComplete, boxProps } = useRoomCodeInput(initialPin, (c) => onJoin?.(c, displayName));

  return (
    <div className="dh">
      <header className="dh-header">
        <Logo />
        <nav className="dh-nav" aria-label="3RTC">
          <a href="/watch-videos-together">How it works</a>
          <a href="/about">About</a>
          <span className={`dh-status ${isOnline ? 'is-online' : ''}`}>
            <span className="dh-dot" aria-hidden="true" />
            {isOnline ? 'Ready' : 'Connecting…'}
          </span>
        </nav>
      </header>

      <main className="dh-main">
        {/* Top Centered Hero Intro */}
        <section className="dh-hero-intro">
          <p className="dh-eyebrow">Free · No sign-up · Nothing to install</p>
          <h1 className="dh-headline">Watch anything together, in perfect sync.</h1>
          <p className="dh-sub">
            YouTube, any video link, or a movie on your laptop. Talk, chat and react while you watch —
            straight between your devices, up to 6 people.
          </p>
        </section>

        {/* Parallel Side-by-Side Content Grid: Login/Join Card (Left) & Room Preview (Right) */}
        <div className="dh-content-grid">
          <div className="dh-action-column">
            <RejoinCard rejoin={rejoin} />

            <form className="dh-card" onSubmit={(e) => { e.preventDefault(); onCreate?.(displayName); }}>
              <div className="dh-field">
                <label htmlFor="dh-name">Your name</label>
                <input
                  id="dh-name"
                  type="text"
                  maxLength={20}
                  autoComplete="nickname"
                  placeholder="So your friends know it’s you"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <button type="submit" className="rd-btn rd-btn-primary rd-btn-lg">Create a room</button>
              <div className="dh-divider"><span>or join a friend’s room</span></div>
              <div className="dh-join">
                <fieldset className="dh-code">
                  <legend className="rd-visually-hidden">5-digit room code</legend>
                  {digits.map((_, i) => <input key={i} {...boxProps(i)} />)}
                </fieldset>
                <button
                  type="button"
                  className="rd-btn rd-btn-secondary rd-btn-lg"
                  disabled={!isComplete}
                  onClick={() => onJoin?.(code, displayName)}
                >
                  Join
                </button>
              </div>
            </form>

            <ul className="dh-points">
              <li><Check />Video, voice and chat stay between your devices</li>
              <li><Check />Works on phone — add it to your home screen</li>
            </ul>
          </div>

        <section className="dh-preview" aria-label="What a room looks like">
          <div className="dh-preview-video">
            <span className="dh-pill"><span className="dh-dot is-live" aria-hidden="true" />In sync · 4 watching</span>
            <div className="dh-people" aria-hidden="true">
              <span className="dh-av is-speaking" style={{ '--av': '#6aa8ff' }}>P</span>
              <span className="dh-av" style={{ '--av': '#f5b544' }}>A</span>
              <span className="dh-av" style={{ '--av': '#c79bff' }}>M</span>
              <span className="dh-av" style={{ '--av': '#f4f4f6' }}>D</span>
            </div>
            <svg className="dh-preview-play" width="56" height="56" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
          </div>
          <div className="dh-preview-chat">
            <span className="dh-av dh-av-sm" style={{ '--av': '#f5b544' }} aria-hidden="true">A</span>
            <p><strong>Arjun</strong> wait, rewind 10s — I missed that</p>
          </div>
        </section>
        </div>
      </main>

      <footer className="dh-footer">
        <nav aria-label="Guides">
          <a href="/youtube-watch-party">YouTube watch party</a>
          <a href="/watch-movies-together">Movie night</a>
          <a href="/watch-videos-together">Your own videos</a>
          <a href="/watch-links-together">Twitch &amp; Vimeo</a>
          <a href="/play-ludo-online">Play Ludo</a>
        </nav>
        <nav aria-label="More">
          {onOpenServerSettings && <button type="button" className="dh-linkbtn" onClick={onOpenServerSettings}>Server settings</button>}
          <a href="/privacy">Privacy</a>
          <a href="/about">About</a>
          <span className="dh-build" title={BUILD.time ? `Built ${new Date(BUILD.time).toLocaleString()}` : undefined}>{BUILD_LABEL}</span>
        </nav>
      </footer>
    </div>
  );
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}
