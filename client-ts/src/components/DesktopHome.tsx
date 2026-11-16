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
              <span>100% Free · Standalone Portable · Windows 10 &amp; 11</span>
            </span>
            <h2 id="dh-desktop-heading" className="dh-desktop-title">Prefer a native app? Meet 3RTC Desktop.</h2>
            <p className="dh-desktop-desc">
              Engineered in Rust with GPU hardware decoding, direct BitTorrent swarm streaming, and system-wide gaming integrations. Zero browser tabs, zero throttling, zero compromises.
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
                  <small>v{BUILD_LABEL} · ~59 MB · Portable</small>
                </span>
              </a>
              <span className="dh-desktop-free-badge">✓ Always Free · No Sign-Up · No Ads · Open Source</span>
            </div>
          </header>

          {/* 6 Major Desktop-Exclusive Features */}
          <div className="dh-spotlight-grid">
            <div className="dh-spotlight-card">
              <div className="dh-spotlight-icon-wrap" style={{ ['--icon-tint']: '#6aa8ff' } as React.CSSProperties}>
                <Icon name="tv" size={24} strokeWidth={2} />
              </div>
              <span className="dh-spotlight-pill">Native mpv Engine</span>
              <h3>Flawless 4K, HDR &amp; Anime Subtitles</h3>
              <p>
                Browsers fail on HEVC/H.265, 10-bit color, DTS/AC3 surround sound, or styled ASS anime subtitles. 3RTC Desktop embeds the battle-tested <strong>mpv</strong> media engine with Direct3D11 GPU hardware decoding for stutter-free playback and instant seeking.
              </p>
              <ul className="dh-spotlight-list">
                <li><Check /> Plays any MKV, MP4, 4K HDR &amp; anime video</li>
                <li><Check /> Switch audio tracks &amp; ASS styled subtitles on the fly</li>
                <li><Check /> Microsecond sync precision across all peers</li>
              </ul>
            </div>

            <div className="dh-spotlight-card">
              <div className="dh-spotlight-icon-wrap" style={{ ['--icon-tint']: '#ff7849' } as React.CSSProperties}>
                <Icon name="magnet" size={24} strokeWidth={2} />
              </div>
              <span className="dh-spotlight-pill">BitTorrent Swarm</span>
              <h3>Stream Any Magnet or Torrent Link</h3>
              <p>
                Web browsers are trapped within WebTorrent web seeds. 3RTC Desktop connects directly to the real global BitTorrent swarm (DHT, PEX, TCP &amp; uTP) to stream movies instantly in sync as they download.
              </p>
              <ul className="dh-spotlight-list">
                <li><Check /> Paste any magnet URI or drop a .torrent file</li>
                <li><Check /> Streams from millions of standard BitTorrent seeders</li>
                <li><Check /> Full room sync: everyone watches the torrent together</li>
              </ul>
            </div>

            <div className="dh-spotlight-card">
              <div className="dh-spotlight-icon-wrap" style={{ ['--icon-tint']: '#38bdf8' } as React.CSSProperties}>
                <Icon name="pointer" size={24} strokeWidth={2} />
              </div>
              <span className="dh-spotlight-pill">Remote Control &amp; Screen</span>
              <h3>Screen Share &amp; Remote Control</h3>
              <p>
                Share your screen with high FPS and crystal-clear stereo game audio via WASAPI loopback. Hand trusted friends remote mouse and keyboard control to co-play or help navigate, with a 250Hz Game Mode and instant safety take-back.
              </p>
              <ul className="dh-spotlight-list">
                <li><Check /> High-FPS capture with direct stereo app sound</li>
                <li><Check /> Mouse &amp; keyboard control with 250Hz Game Mode</li>
                <li><Check /> Emergency take-back via mouse or Ctrl+Alt+Shift+X</li>
              </ul>
            </div>

            <div className="dh-spotlight-card">
              <div className="dh-spotlight-icon-wrap" style={{ ['--icon-tint']: '#eab308' } as React.CSSProperties}>
                <Icon name="bolt" size={24} strokeWidth={2} />
              </div>
              <span className="dh-spotlight-pill">Hardware Accelerated</span>
              <h3>Zero Background Lag &amp; NVENC Encoding</h3>
              <p>
                Browsers throttle background tabs down to 1Hz when you game, dropping audio and freezing video. 3RTC Desktop runs natively with NVENC/AMF hardware encoding, never dropping frames or stuttering voice when Alt-Tabbed.
              </p>
              <ul className="dh-spotlight-list">
                <li><Check /> NVENC / AMF / QSV hardware video encoding at 60 FPS</li>
                <li><Check /> Zero background throttling: voice &amp; sync stay active in games</li>
                <li><Check /> Ultra-lightweight native Rust footprint (~40MB RAM)</li>
              </ul>
            </div>

            <div className="dh-spotlight-card">
              <div className="dh-spotlight-icon-wrap" style={{ ['--icon-tint']: '#a78bfa' } as React.CSSProperties}>
                <Icon name="layers" size={24} strokeWidth={2} />
              </div>
              <span className="dh-spotlight-pill">Press F10 Anywhere</span>
              <h3>In-Game Floating Overlay</h3>
              <p>
                Play your favorite games while hanging out. The floating overlay stays pinned on top of any game or fullscreen window with speaking indicators, chat, and playback controls.
              </p>
              <ul className="dh-spotlight-list">
                <li><Check /> See who is speaking without Alt-Tabbing</li>
                <li><Check /> Click-through mode never blocks your mouse or crosshair</li>
                <li><Check /> Instant toggle with the F10 hotkey</li>
              </ul>
            </div>

            <div className="dh-spotlight-card">
              <div className="dh-spotlight-icon-wrap" style={{ ['--icon-tint']: '#36d399' } as React.CSSProperties}>
                <Icon name="keyboard" size={24} strokeWidth={2} />
              </div>
              <span className="dh-spotlight-pill">System Integration &amp; P2P</span>
              <h3>Global Push-to-Talk &amp; Massive Files</h3>
              <p>
                Browser shortcuts stop working the moment you click away. 3RTC Desktop provides true global hotkeys so push-to-talk responds from any game, plus direct disk-to-disk transfers for 10GB+ files without browser memory limits.
              </p>
              <ul className="dh-spotlight-list">
                <li><Check /> Global push-to-talk in any game or application</li>
                <li><Check /> Selective deafen: silence voices while keeping movie audio</li>
                <li><Check /> Send 10GB+ files directly between SSDs with auto-resume</li>
              </ul>
            </div>
          </div>

          {/* Side-by-Side Comparison Table */}
          <div className="dh-compare-section">
            <div className="dh-compare-head">
              <h3>Web App vs. Desktop App</h3>
              <p>Choose the experience that fits your setup. Both are 100% free with no sign-up.</p>
            </div>

            <div className="dh-compare-table-wrap">
              <table className="dh-compare-table">
                <thead>
                  <tr>
                    <th scope="col" className="dh-col-feature">Capability</th>
                    <th scope="col" className="dh-col-web">Web App (3rtc.me)</th>
                    <th scope="col" className="dh-col-desktop">
                      <span className="dh-desk-badge"><Icon name="windows" size={13} /> Desktop App</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Price &amp; Accounts</strong>
                      <span>Account requirement or subscriptions</span>
                    </td>
                    <td><span className="dh-tag-ok">100% Free · No Sign-Up</span></td>
                    <td className="dh-highlight-col"><span className="dh-tag-ok">100% Free · No Sign-Up</span></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Installation</strong>
                      <span>How you launch the app</span>
                    </td>
                    <td>Instant in browser (Zero install)</td>
                    <td className="dh-highlight-col"><strong>Portable .zip (Unzip &amp; run, no install)</strong></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Local Video Player</strong>
                      <span>Decoding high-bitrate &amp; MKV files</span>
                    </td>
                    <td>Browser HTML5 (Codec-limited, no HEVC/DTS)</td>
                    <td className="dh-highlight-col">
                      <strong className="dh-text-accent">Native mpv with GPU decoding</strong>
                      <small className="dh-subtext">Plays any 4K/MKV, multi-track audio &amp; ASS subs</small>
                    </td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Torrent &amp; Magnet Streaming</strong>
                      <span>Stream directly from BitTorrent swarms</span>
                    </td>
                    <td>WebTorrent web seeds only (Limited swarm)</td>
                    <td className="dh-highlight-col">
                      <strong className="dh-text-accent">✓ Full BitTorrent swarm (DHT, PEX, TCP &amp; uTP)</strong>
                      <small className="dh-subtext">Paste any magnet link to stream in real-time sync</small>
                    </td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Screen Sharing &amp; Audio</strong>
                      <span>Sharing displays, games &amp; app sound</span>
                    </td>
                    <td>Standard browser screen capture</td>
                    <td className="dh-highlight-col">
                      <strong className="dh-text-accent">✓ High-FPS capture + stereo game audio (WASAPI)</strong>
                      <small className="dh-subtext">Smooth, low-latency desktop &amp; window sharing</small>
                    </td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Interactive Remote Control</strong>
                      <span>Control friends' shared screen to co-play</span>
                    </td>
                    <td><Icon name="minus" size={16} className="dh-icon-dash" /></td>
                    <td className="dh-highlight-col">
                      <strong className="dh-text-accent">✓ Mouse &amp; keyboard control + Game Mode</strong>
                      <small className="dh-subtext">250Hz pointer aim + emergency take-back</small>
                    </td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Background Performance</strong>
                      <span>When gaming or Alt-Tabbed to another window</span>
                    </td>
                    <td>Throttled to 1Hz by browser (Voice/sync lag)</td>
                    <td className="dh-highlight-col">
                      <strong className="dh-text-accent">✓ Zero throttling</strong>
                      <small className="dh-subtext">Persistent background voice &amp; WebRTC while gaming</small>
                    </td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Video Hardware Encoding</strong>
                      <span>GPU-accelerated screen capture pipeline</span>
                    </td>
                    <td>Software canvas capture (CPU heavy)</td>
                    <td className="dh-highlight-col">
                      <strong className="dh-text-accent">✓ NVENC / AMF / QSV GPU hardware encoder</strong>
                      <small className="dh-subtext">Lag-free 60 FPS sharing with near-zero CPU usage</small>
                    </td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>In-Game Floating Overlay</strong>
                      <span>Overlay over games and other windows</span>
                    </td>
                    <td><Icon name="minus" size={16} className="dh-icon-dash" /></td>
                    <td className="dh-highlight-col">
                      <strong className="dh-text-accent">✓ Transparent overlay (F10)</strong>
                      <small className="dh-subtext">Float chat &amp; voice over any game</small>
                    </td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Global Push-to-Talk</strong>
                      <span>Talking while in a game or other app</span>
                    </td>
                    <td>Active browser tab only</td>
                    <td className="dh-highlight-col">
                      <strong className="dh-text-accent">✓ System-wide hotkey</strong>
                      <small className="dh-subtext">Works anywhere in Windows</small>
                    </td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Large File Transfers</strong>
                      <span>Direct peer-to-peer file sharing limits</span>
                    </td>
                    <td>Browser RAM limit (~1–2 GB)</td>
                    <td className="dh-highlight-col">
                      <strong className="dh-text-accent">✓ 10GB+ native resumable transfers</strong>
                      <small className="dh-subtext">Direct disk-to-disk streaming with no RAM limits</small>
                    </td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Player Shortcuts</strong>
                      <span>Customizing play/pause/seek keys</span>
                    </td>
                    <td>Fixed browser shortcuts</td>
                    <td className="dh-highlight-col"><strong>✓ Fully customizable keybindings</strong></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Selective Deafen</strong>
                      <span>Muting voices while watching a movie</span>
                    </td>
                    <td>Mutes all room audio</td>
                    <td className="dh-highlight-col"><strong>✓ Mutes voices only, movie audio keeps playing</strong></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Resource Efficiency</strong>
                      <span>CPU and memory overhead</span>
                    </td>
                    <td>Standard browser tab usage (~500MB–1.5GB)</td>
                    <td className="dh-highlight-col"><strong>Ultra-lightweight native Rust (~40MB RAM)</strong></td>
                  </tr>
                  <tr>
                    <td className="dh-feature-cell">
                      <strong>Voice, Chat &amp; Games</strong>
                      <span>High-definition voice, sync &amp; soundboard</span>
                    </td>
                    <td>✓ Full support</td>
                    <td className="dh-highlight-col">✓ Full support</td>
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
              <p>Extract the zip archive and run 3rtc.exe anywhere. No administrator rights, setup wizard, or installation required.</p>
            </div>
            <div className="dh-banner-actions">
              <a
                href="/desktop/3RTC-portable.zip"
                download="3RTC-portable.zip"
                className="rd-btn rd-btn-primary rd-btn-xl dh-banner-btn"
                title="Download 3RTC Portable Zip"
              >
                <Icon name="download" size={18} strokeWidth={2.4} />
                <span>Download .zip (~59 MB)</span>
              </a>
              <span className="dh-banner-sub">Compatible with Windows 10 &amp; 11 (64-bit) · 100% Free</span>
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
