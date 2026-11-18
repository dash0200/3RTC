import { useState } from 'react';
import { nameFieldValue } from '../utils/names';
import { BUILD, BUILD_LABEL } from '../version';
import RejoinCard, { type RejoinInfo } from './RejoinCard';
import { useRoomCodeInput } from '../hooks/useRoomCodeInput';
import { Logo } from './Logo';
import { Icon } from './icons';

export interface DesktopHomeProps {
  /** Why the last join didn't work (shown while the code is still the one that failed) */
  joinError?: { message: string; pin: string } | null;
  username?: string;
  initialPin?: string;
  onCreate?: (displayName: string) => void;
  onJoin?: (code: string, displayName: string) => void;
  onOpenServerSettings?: () => void;
  rejoin?: RejoinInfo | null;
  isOnline?: boolean;
}

/**
 * Desktop home, before a room exists: one screen with your name, Create, and the 5-box code join.
 * (No chat sidebar, mic or video controls yet: there is no room for them to act on.)
 */
export default function DesktopHome({
  username = '',
  initialPin = '',
  joinError = null,
  onCreate,
  onJoin,
  onOpenServerSettings,
  rejoin = null,
  isOnline = true
}: DesktopHomeProps) {
  const [name, setName] = useState<string>(() => nameFieldValue(username));
  const displayName = name.trim() || username || 'Guest';
  const { digits, code, isComplete, boxProps } = useRoomCodeInput(initialPin, (c) => onJoin?.(c, displayName));

  return (
    <div className="dh">
      {/* 1. Above-the-fold main section: preserved with zero layout or visual changes */}
      <div className="dh-above-fold">
        <header className="dh-header">
          <Logo />
          <nav className="dh-nav" aria-label="3RTC">
            <a
              href="/desktop/3RTC-portable.zip"
              download="3RTC-portable.zip"
              className="dh-nav-download"
              title="Download full 3RTC Windows Desktop app (.zip)"
            >
              <Icon name="download" size={16} strokeWidth={2.4} />
              <span>Download Desktop App (.zip)</span>
            </a>
            <a href="#desktop" className="dh-nav-link">Desktop App</a>
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
            <p className="dh-eyebrow">Free · No sign-up</p>
            <h1 className="dh-headline">Watch anything together, in perfect sync.</h1>
            <p className="dh-sub">
              YouTube, any video link, or a movie on your laptop. Talk, chat and react while you watch —
              straight between your devices, up to 4 people.
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
                {joinError && (!joinError.pin || code === joinError.pin) && (
                  <p className="join-error" role="alert">{joinError.message}</p>
                )}
              </form>

              <ul className="dh-points">
                <li><Check />Video, voice and chat stay between your devices</li>
                <li><Check />Works on phone — add it to your home screen</li>
                <li>
                  <Check />
                  <span>
                    Windows desktop app:{' '}
                    <a href="#desktop" className="dh-point-download">
                      Explore native features (.zip)
                    </a>
                  </span>
                </li>
              </ul>
            </div>

            <section className="dh-preview" aria-label="What a room looks like">
              <div className="dh-preview-video">
                <span className="dh-pill"><span className="dh-dot is-live" aria-hidden="true" />In sync · 4 watching</span>
                <div className="dh-people" aria-hidden="true">
                  <span className="dh-av is-speaking" style={{ ['--av']: '#6aa8ff' } as React.CSSProperties}>P</span>
                  <span className="dh-av" style={{ ['--av']: '#f5b544' } as React.CSSProperties}>A</span>
                  <span className="dh-av" style={{ ['--av']: '#c79bff' } as React.CSSProperties}>M</span>
                  <span className="dh-av" style={{ ['--av']: '#f4f4f6' } as React.CSSProperties}>D</span>
                </div>
                <svg className="dh-preview-play" width="56" height="56" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
              </div>
              <div className="dh-preview-chat">
                <span className="dh-av dh-av-sm" style={{ ['--av']: '#f5b544' } as React.CSSProperties} aria-hidden="true">A</span>
                <p><strong>Arjun</strong> wait, rewind 10s — I missed that</p>
              </div>
            </section>
          </div>
        </main>

        {/* Scroll hint to discover the desktop app */}
        <div className="dh-scroll-hint">
          <a href="#desktop" className="dh-scroll-btn" aria-label="Scroll to Desktop App details">
            <span>Compare with Windows Desktop App</span>
            <Icon name="chevronDown" size={14} strokeWidth={2.4} />
          </a>
        </div>
      </div>

      {/* 2. Extended Desktop App Section */}
      <section id="desktop" className="dh-desktop" aria-labelledby="dh-desktop-heading">
        <div className="dh-desktop-wrap">
          <header className="dh-desktop-head">
            <span className="dh-desktop-tag">
              <Icon name="windows" size={14} />
              <span>Free · Portable · Windows 10 &amp; 11</span>
            </span>
            <h2 id="dh-desktop-heading" className="dh-desktop-title">Prefer a native app? Meet 3RTC Desktop.</h2>
            <p className="dh-desktop-desc">
              Everything the web app does, plus what a browser can't: play almost any video file, stream torrents, share your screen with sound, and stay in the call while you game.
            </p>
            <div className="dh-desktop-cta-row">
              <a
                href="/desktop/3RTC-portable.zip"
                download="3RTC-portable.zip"
                className="rd-btn rd-btn-primary rd-btn-xl dh-desktop-btn"
                title="Download full 3RTC Windows Desktop app (.zip)"
              >
                <Icon name="download" size={20} strokeWidth={2.4} />
                <span className="dh-desktop-btn-text">
                  <strong>Download for Windows (.zip)</strong>
                  <small>v{BUILD_LABEL} · Portable</small>
                </span>
              </a>
              <span className="dh-desktop-free-badge">✓ Free · No sign-up · No ads</span>
            </div>
          </header>

          {/* What only the desktop app does */}
          <div className="dh-spotlight-grid">
            <div className="dh-spotlight-card">
              <div className="dh-spotlight-icon-wrap" style={{ ['--icon-tint']: '#6aa8ff' } as React.CSSProperties}>
                <Icon name="tv" size={24} strokeWidth={2} />
              </div>
              <span className="dh-spotlight-pill">Any video · Torrents</span>
              <h3>Plays what browsers can't</h3>
              <p>
                MKV, HEVC, 4K HDR, surround sound and styled subtitles, decoded on your GPU. Paste a magnet link or drop a .torrent, pick the file, and everyone watches it as it downloads.
              </p>
              <ul className="dh-spotlight-list">
                <li><Check /> Switch audio and subtitle tracks</li>
                <li><Check /> Downloads only the file you picked</li>
              </ul>
            </div>

            <div className="dh-spotlight-card">
              <div className="dh-spotlight-icon-wrap" style={{ ['--icon-tint']: '#38bdf8' } as React.CSSProperties}>
                <Icon name="pointer" size={24} strokeWidth={2} />
              </div>
              <span className="dh-spotlight-pill">Screen · Remote control</span>
              <h3>Share your screen with sound</h3>
              <p>
                Share a window or your whole screen with its app sound, hardware-encoded for smooth video. Let a friend take the mouse and keyboard to help or co-play.
              </p>
              <ul className="dh-spotlight-list">
                <li><Check /> NVENC, AMF and Quick Sync encoding</li>
                <li><Check /> Take control back with the mouse or Ctrl+Alt+Shift+X</li>
              </ul>
            </div>

            <div className="dh-spotlight-card">
              <div className="dh-spotlight-icon-wrap" style={{ ['--icon-tint']: '#a78bfa' } as React.CSSProperties}>
                <Icon name="layers" size={24} strokeWidth={2} />
              </div>
              <span className="dh-spotlight-pill">Game nights</span>
              <h3>Stay in the call while you play</h3>
              <p>
                Voice and sync keep going when the app is in the background, and the controls reach you inside your game.
              </p>
              <ul className="dh-spotlight-list">
                <li><Check /> Push-to-talk that works in any game</li>
                <li><Check /> Overlay shows who's talking (F10)</li>
                <li><Check /> Deafen voices, keep the movie playing</li>
              </ul>
            </div>
          </div>

          {/* Web vs desktop at a glance */}
          <div className="dh-compare-section">
            <div className="dh-compare-head">
              <h3>Web or desktop?</h3>
              <p>Same rooms, so web and desktop users watch together. Use the web app to join in seconds from any device; get the desktop app for the extras.</p>
            </div>

            <div className="dh-compare-table-wrap">
              <table className="dh-compare-table">
                <thead>
                  <tr>
                    <th scope="col" className="dh-col-feature">&nbsp;</th>
                    <th scope="col" className="dh-col-web">Web app (3rtc.me)</th>
                    <th scope="col" className="dh-col-desktop">
                      <span className="dh-desk-badge"><Icon name="windows" size={13} /> Desktop app</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="dh-feature-cell"><strong>Runs on</strong></td>
                    <td>Any browser: phone, Mac or PC</td>
                    <td className="dh-highlight-col">Windows 10 &amp; 11, unzip and run</td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell"><strong>Watch together, voice, chat, games</strong></td>
                    <td><span className="dh-tag-ok">✓ Yes</span></td>
                    <td className="dh-highlight-col"><span className="dh-tag-ok">✓ Yes</span></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell"><strong>Your own video files</strong></td>
                    <td>What your browser plays (mostly MP4 and WebM)</td>
                    <td className="dh-highlight-col"><strong className="dh-text-accent">Almost any format</strong></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell"><strong>Torrents &amp; magnet links</strong></td>
                    <td><Icon name="minus" size={16} className="dh-icon-dash" /></td>
                    <td className="dh-highlight-col"><strong className="dh-text-accent">✓ Stream while downloading</strong></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell"><strong>Screen sharing</strong></td>
                    <td>Browser screen share</td>
                    <td className="dh-highlight-col"><strong className="dh-text-accent">✓ With app sound, hardware-encoded</strong></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell"><strong>Remote control</strong></td>
                    <td><Icon name="minus" size={16} className="dh-icon-dash" /></td>
                    <td className="dh-highlight-col"><strong className="dh-text-accent">✓ Mouse &amp; keyboard</strong></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell"><strong>While you game</strong></td>
                    <td>Push-to-talk only in the tab; background tabs can slow down</td>
                    <td className="dh-highlight-col"><strong className="dh-text-accent">✓ Global push-to-talk + overlay</strong></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell"><strong>Big file transfers</strong></td>
                    <td>Everyday files</td>
                    <td className="dh-highlight-col"><strong className="dh-text-accent">✓ Huge files straight to disk, resumable</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Bottom Download Banner */}
          <div className="dh-desktop-banner">
            <div className="dh-banner-copy">
              <span className="dh-banner-eyebrow">READY FOR MOVIE NIGHT?</span>
              <h3>Download 3RTC Portable for Windows</h3>
              <p>Unzip and run 3rtc.exe. No installer and no admin rights needed.</p>
            </div>
            <div className="dh-banner-actions">
              <a
                href="/desktop/3RTC-portable.zip"
                download="3RTC-portable.zip"
                className="rd-btn rd-btn-primary rd-btn-xl dh-banner-btn"
                title="Download 3RTC Portable Zip"
              >
                <Icon name="download" size={18} strokeWidth={2.4} />
                <span>Download .zip</span>
              </a>
              <span className="dh-banner-sub">Windows 10 &amp; 11 (64-bit) · Free</span>
            </div>
          </div>
        </div>
      </section>

      <footer className="dh-footer">
        <nav aria-label="Guides">
          <a href="/youtube-watch-party">YouTube watch party</a>
          <a href="/watch-movies-together">Movie night</a>
          <a href="/watch-videos-together">Your own videos</a>
          <a href="/watch-links-together">Twitch &amp; Vimeo</a>
          <a href="/play-ludo-online">Play Ludo</a>
        </nav>
        <nav aria-label="More">
          <a href="/desktop/3RTC-portable.zip" download="3RTC-portable.zip">Download Windows app (.zip)</a>
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
