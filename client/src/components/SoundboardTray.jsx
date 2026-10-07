import React, { useState, useEffect } from 'react';
import { SOUNDBOARD_CLIPS } from '../utils/soundboard';

export default function SoundboardTray({
  onPlayClip,
  volume = 0.75,
  isMuted = false,
  onVolumeChange,
  onToggleMute,
  activeSfx = null,
  activeCooldowns = {},
  variant = 'floating', // 'floating' | 'embedded'
  onClose
}) {
  const [selectedCategory, setSelectedCategory] = useState('All');
  const categories = ['All', ...Array.from(new Set(SOUNDBOARD_CLIPS.map((c) => c.category)))];

  const filteredClips = selectedCategory === 'All'
    ? SOUNDBOARD_CLIPS
    : SOUNDBOARD_CLIPS.filter((c) => c.category === selectedCategory);

  const isFloating = variant === 'floating';

  return (
    <div
      className={`soundboard-container ${isFloating ? 'is-floating' : 'is-embedded'}`}
      role="region"
      aria-label="Synchronized Soundboard"
    >
      {/* Soundboard Header */}
      <div className="soundboard-header">
        <div className="soundboard-title-group">
          <div className="soundboard-icon-box">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
          </div>
          <div>
            <div className="soundboard-title-row">
              <h3 className="soundboard-title">Soundboard</h3>
              <span className="soundboard-sync-badge" title="Sound clips play simultaneously for everyone in the room">
                P2P SYNC
              </span>
            </div>
            <p className="soundboard-subtitle">Instant SFX synchronized across room peers</p>
          </div>
        </div>

        {/* Live Audio Equalizer Wave if SFX is currently playing */}
        {activeSfx && (
          <div className="soundboard-equalizer-live" title={`Playing: ${activeSfx.soundName}`}>
            <span className="eq-bar bar-1" />
            <span className="eq-bar bar-2" />
            <span className="eq-bar bar-3" />
            <span className="eq-bar bar-4" />
          </div>
        )}

        {isFloating && typeof onClose === 'function' && (
          <button
            type="button"
            className="soundboard-close-btn"
            onClick={onClose}
            title="Close Soundboard"
            aria-label="Close Soundboard"
          >
            ✕
          </button>
        )}
      </div>

      {/* Volume & Audio Controls Toolbar */}
      <div className="soundboard-toolbar">
        <div className="soundboard-vol-group">
          <button
            type="button"
            className={`soundboard-mute-btn ${isMuted ? 'muted' : ''}`}
            onClick={onToggleMute}
            title={isMuted ? 'Unmute Soundboard' : 'Mute Soundboard'}
            aria-label={isMuted ? 'Unmute Soundboard' : 'Mute Soundboard'}
          >
            {isMuted ? (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            )}
          </button>

          <div className="soundboard-slider-wrapper">
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                onVolumeChange(val);
                if (isMuted && val > 0) onToggleMute();
              }}
              className="soundboard-volume-slider"
              title={`Soundboard Volume: ${Math.round(volume * 100)}%`}
              aria-label="Soundboard Volume"
            />
          </div>

          <span className="soundboard-vol-percent">
            {isMuted ? 'Muted' : `${Math.round(volume * 100)}%`}
          </span>
        </div>

        {/* Category Filter Pills */}
        <div className="soundboard-category-tabs">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`category-pill ${selectedCategory === cat ? 'active' : ''}`}
              onClick={() => setSelectedCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Grid of Sound Clips */}
      <div className="soundboard-grid">
        {filteredClips.map((clip) => {
          const isPlayingThis = activeSfx?.soundId === clip.id;

          return (
            <button
              key={clip.id}
              type="button"
              className={`sfx-card ${isPlayingThis ? 'is-playing' : ''}`}
              onClick={() => onPlayClip(clip)}
              title={`${clip.name}: ${clip.description}`}
              aria-label={`Play sound effect: ${clip.name}`}
            >
              <div
                className="sfx-icon-badge"
                style={{
                  background: `linear-gradient(135deg, ${clip.color}33, ${clip.color}11)`,
                  borderColor: `${clip.color}55`
                }}
              >
                <span className="sfx-emoji">{clip.emoji}</span>
                {isPlayingThis && <span className="sfx-ping-ring" style={{ borderColor: clip.color }} />}
              </div>

              <div className="sfx-info">
                <span className="sfx-name">{clip.name}</span>
                <span className="sfx-category">{clip.category}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Active Sound HUD Status Bar */}
      {activeSfx && (
        <div className="soundboard-active-banner">
          <span className="banner-pulse">🔊</span>
          <span className="banner-text">
            <strong>{activeSfx.sender || 'You'}</strong> played{' '}
            <span className="banner-name">{activeSfx.soundName}</span>
          </span>
        </div>
      )}

      {/* Footer Hint */}
      <div className="soundboard-footer">
        <span className="footer-hint-text">
          💡 Clicking any clip plays it instantly for all room peers.
        </span>
      </div>
    </div>
  );
}
