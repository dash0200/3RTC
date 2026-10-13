import React, { useEffect, useRef, useState } from 'react';
import SoundboardTray from '../SoundboardTray';
import { extractYouTubeId, fetchYouTubeTitle, PRESET_CATEGORIES } from '../YouTubeSyncPlayer';

/** Bottom sheet frame: backdrop (tap to close), drag handle, title, close button, Escape closes. */
export function BottomSheet({ isOpen, onClose, title, children }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div className="phone-sheet-layer">
      <div className="phone-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <section className="phone-sheet" role="dialog" aria-modal="true" aria-label={title} ref={panelRef} tabIndex={-1}>
        <div className="phone-sheet-handle" aria-hidden="true" />
        <div className="phone-sheet-head">
          <h2>{title}</h2>
          <button type="button" className="phone-icon-btn" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="phone-sheet-body">{children}</div>
      </section>
    </div>
  );
}

const Chevron = (
  <svg className="phone-row-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);

/** Add video: YouTube link, quick picks, or a video file from the phone. */
export function AddVideoSheet({ isOpen, onClose, isMediaActive, onLoadYouTube, onQueueYouTube, onPickFile, onStopVideo }) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [categoryId, setCategoryId] = useState(PRESET_CATEGORIES[0]?.id);
  const fileRef = useRef(null);

  const category = PRESET_CATEGORIES.find((c) => c.id === categoryId) || PRESET_CATEGORIES[0];

  const submitLink = async (mode) => {
    const id = extractYouTubeId(link.trim());
    if (!id) {
      setError('That doesn’t look like a YouTube link.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const title = await fetchYouTubeTitle(id);
      if (mode === 'queue') onQueueYouTube?.(id, title);
      else onLoadYouTube?.(id, title);
      setLink('');
      onClose?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Add video">
      <form
        className="phone-link-form"
        onSubmit={(e) => {
          e.preventDefault();
          submitLink('play');
        }}
      >
        <label htmlFor="phone-yt-link" className="phone-label">YouTube link</label>
        <input
          id="phone-yt-link"
          className="phone-input"
          type="url"
          inputMode="url"
          placeholder="Paste a YouTube link"
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            if (error) setError('');
          }}
        />
        {error && <div className="phone-form-error" role="alert">{error}</div>}
        <div className="phone-link-actions">
          <button type="submit" className="phone-btn phone-btn-primary" disabled={!link.trim() || busy}>
            Play for everyone
          </button>
          {isMediaActive && (
            <button type="button" className="phone-btn phone-btn-ghost" disabled={!link.trim() || busy} onClick={() => submitLink('queue')}>
              Add to queue
            </button>
          )}
        </div>
      </form>

      <div className="phone-section-label">QUICK PICKS</div>
      <div className="phone-chip-row" role="tablist" aria-label="Quick pick categories">
        {PRESET_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === category?.id}
            className={`phone-chip ${c.id === category?.id ? 'active' : ''}`}
            onClick={() => setCategoryId(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="phone-list">
        {category?.videos.map((v) => (
          <button
            key={v.id}
            type="button"
            className="phone-row"
            onClick={() => {
              onLoadYouTube?.(v.id, v.title);
              onClose?.();
            }}
          >
            <span className="phone-row-thumb" aria-hidden="true">
              <img src={`https://i.ytimg.com/vi/${v.id}/default.jpg`} alt="" loading="lazy" />
            </span>
            <span className="phone-row-text">{v.title}</span>
            {Chevron}
          </button>
        ))}
      </div>

      <div className="phone-section-label">FROM YOUR PHONE</div>
      <button type="button" className="phone-btn phone-btn-ghost phone-btn-block" onClick={() => fileRef.current?.click()}>
        Choose a video file
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="video/*,.mkv,.mp4,.webm,.mov,.m4v"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            onPickFile?.(file);
            onClose?.();
          }
          e.target.value = '';
        }}
      />

      {isMediaActive && (
        <button type="button" className="phone-btn phone-btn-danger phone-btn-block" onClick={() => { onStopVideo?.(); onClose?.(); }}>
          Stop the video for everyone
        </button>
      )}
    </BottomSheet>
  );
}

function SwitchRow({ icon, title, sub, checked, onChange }) {
  return (
    <div className="phone-row phone-row-static">
      <span className="phone-row-icon" aria-hidden="true">{icon}</span>
      <span className="phone-row-text">
        <span>{title}</span>
        {sub && <span className="phone-row-sub">{sub}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={`phone-switch ${checked ? 'on' : ''}`}
        onClick={onChange}
      >
        <span className="phone-switch-knob" />
      </button>
    </div>
  );
}

const MoreIcon = {
  noise: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h3l3-7 4 14 3-7h5" /></svg>,
  ptt: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>,
  sliders: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></svg>,
  music: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>,
  wifi: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0" /><circle cx="12" cy="19.5" r="1" fill="currentColor" /></svg>,
  qr: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3M21 14v7h-4" /></svg>,
  server: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>
};

/** More: voice options and room actions. */
export function MoreSheet({
  isOpen,
  onClose,
  audioSettings,
  onUpdateAudioSettings,
  onOpenAudioSettings,
  onOpenSoundboard,
  onOpenNetworkHud,
  networkStats,
  onOpenQrCode,
  roomId,
  onOpenServerSettings,
  onLeaveRoom
}) {
  const isolationOn = Boolean(audioSettings?.voiceIsolation);
  const isPtt = audioSettings?.inputMode === 'ptt';
  const ping = networkStats?.avgPingMs;
  const then = (fn) => () => {
    onClose?.();
    fn?.();
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="More">
      <div className="phone-section-label">VOICE</div>
      <div className="phone-group">
        <SwitchRow
          icon={MoreIcon.noise}
          title="Noise removal"
          sub="Removes fans, keyboard and room noise"
          checked={isolationOn}
          onChange={() => onUpdateAudioSettings?.({ ...audioSettings, voiceIsolation: !isolationOn })}
        />
        <SwitchRow
          icon={MoreIcon.ptt}
          title="Push to talk"
          sub="Hold the mic button to speak"
          checked={isPtt}
          onChange={() => onUpdateAudioSettings?.({ ...audioSettings, inputMode: isPtt ? 'open' : 'ptt' })}
        />
        <button type="button" className="phone-row" onClick={then(onOpenAudioSettings)}>
          <span className="phone-row-icon" aria-hidden="true">{MoreIcon.sliders}</span>
          <span className="phone-row-text">Audio settings</span>
          {Chevron}
        </button>
      </div>

      <div className="phone-section-label">ROOM</div>
      <div className="phone-group">
        <button type="button" className="phone-row" onClick={then(onOpenSoundboard)}>
          <span className="phone-row-icon" aria-hidden="true">{MoreIcon.music}</span>
          <span className="phone-row-text">Soundboard</span>
          {Chevron}
        </button>
        <button type="button" className="phone-row" onClick={then(onOpenNetworkHud)}>
          <span className="phone-row-icon" aria-hidden="true">{MoreIcon.wifi}</span>
          <span className="phone-row-text">Network</span>
          {ping !== null && ping !== undefined && <span className="phone-row-value ok">{ping} ms</span>}
          {Chevron}
        </button>
        <button type="button" className="phone-row" onClick={then(onOpenQrCode)}>
          <span className="phone-row-icon" aria-hidden="true">{MoreIcon.qr}</span>
          <span className="phone-row-text">Invite with QR code</span>
          {roomId && <span className="phone-row-value mono">{roomId}</span>}
        </button>
        <button type="button" className="phone-row" onClick={then(onOpenServerSettings)}>
          <span className="phone-row-icon" aria-hidden="true">{MoreIcon.server}</span>
          <span className="phone-row-text">Server settings</span>
          {Chevron}
        </button>
      </div>

      <button type="button" className="phone-btn phone-btn-danger phone-btn-block" onClick={then(onLeaveRoom)}>
        Leave room
      </button>
    </BottomSheet>
  );
}

/** Soundboard in a sheet (same clips and sync as on desktop). */
export function SoundboardSheet({ isOpen, onClose, soundboardSettings, activeSoundboardSfx, activeSfxCooldowns, onPlaySoundboardClip, onSoundboardVolumeChange, onToggleSoundboardMute }) {
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Soundboard">
      <SoundboardTray
        variant="embedded"
        volume={soundboardSettings?.volume ?? 0.75}
        isMuted={Boolean(soundboardSettings?.muted)}
        onVolumeChange={onSoundboardVolumeChange}
        onToggleMute={onToggleSoundboardMute}
        activeSfx={activeSoundboardSfx}
        activeCooldowns={activeSfxCooldowns}
        onPlayClip={onPlaySoundboardClip}
        onClose={onClose}
      />
    </BottomSheet>
  );
}
