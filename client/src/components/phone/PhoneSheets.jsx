import React, { useEffect, useRef, useState } from 'react';
import SoundboardTray from '../SoundboardTray';
import { resolvePastedLink } from '../../features/media/resolveLink';
import { groupQuickPicks, isVideoUnavailable, useQuickPicks, youtubeThumb } from '../../utils/quickPicks';
import TrendingRegionSelect from '../TrendingRegionSelect';

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

const YT_ID = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/))([\w-]{11})/;
const looksLikeLink = (text) => /^https?:\/\/\S+$/i.test((text || '').trim());

/**
 * Add a video (Figma "Add a video" sheet): the link you just copied first, then any link,
 * a video from this device, and quick picks. On desktop the same sheet opens as a dialog.
 */
export function AddVideoSheet({ isOpen, onClose, isMediaActive, onLoadYouTube, onQueueYouTube, onLoadLink, onQueueLink, onQueuePick, queuedIds = [], onPlayQueue, onPickFile, onStopVideo }) {
  const queuedSet = new Set(queuedIds);
  const queuePick = onQueuePick || onQueueYouTube;
  const [link, setLink] = useState('');
  const [clip, setClip] = useState(null); // a link found on the clipboard
  const [clipAllowed, setClipAllowed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const quickPicks = useQuickPicks();
  const groups = groupQuickPicks(quickPicks);
  const [groupName, setGroupName] = useState(null);
  const [categoryId, setCategoryId] = useState(null);
  const fileRef = useRef(null);

  const group = groups.find((g) => g.group === groupName) || groups[0];
  const category = group?.categories.find((c) => c.id === categoryId) || group?.categories[0];
  const picks = (category?.videos || []).filter((v) => !isVideoUnavailable(v.id));

  // The link you just copied: read silently when the browser already allows it, else one tap
  const readClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText())?.trim();
      if (looksLikeLink(text)) { setClip(text); return true; }
    } catch { /* not allowed */ }
    return false;
  };
  useEffect(() => {
    if (!isOpen) return;
    setClip(null);
    let cancelled = false;
    (async () => {
      try {
        const perm = await navigator.permissions?.query({ name: 'clipboard-read' });
        if (cancelled) return;
        setClipAllowed(perm?.state !== 'denied' && Boolean(navigator.clipboard?.readText));
        if (perm?.state === 'granted') await readClipboard();
      } catch {
        setClipAllowed(Boolean(navigator.clipboard?.readText));
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  // Any link: YouTube, Vimeo, Twitch, a video file (features/media)
  const submitLink = async (value, mode) => {
    setError('');
    setBusy(true);
    try {
      const res = await resolvePastedLink(value);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.kind === 'media') {
        if (mode === 'queue') onQueueLink?.(res.media);
        else onLoadLink?.(res.media);
      } else if (mode === 'queue') onQueueYouTube?.(res.videoId, res.title);
      else onLoadYouTube?.(res.videoId, res.title);
      setLink('');
      onClose?.();
    } finally {
      setBusy(false);
    }
  };
  const clipYt = clip && clip.match(YT_ID)?.[1];

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Add a video">
      {clip ? (
        <div className="av-clip">
          <div className="av-clip-row">
            <span className="av-clip-thumb" aria-hidden="true">
              {clipYt && <img src={youtubeThumb(clipYt)} alt="" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />}
            </span>
            <span className="av-clip-text">
              <span className="av-clip-label">From your clipboard</span>
              <span className="av-clip-url">{clip.replace(/^https?:\/\/(www\.)?/, '')}</span>
            </span>
          </div>
          <div className="av-clip-actions">
            <button type="button" className="rd-btn rd-btn-primary" disabled={busy} onClick={() => submitLink(clip, 'play')}>{busy ? 'Checking…' : 'Play now'}</button>
            <button type="button" className="rd-btn rd-btn-secondary" disabled={busy} onClick={() => submitLink(clip, 'queue')}>Add to queue</button>
          </div>
        </div>
      ) : clipAllowed ? (
        <button type="button" className="av-row" onClick={async () => { if (!(await readClipboard())) setError('No link on your clipboard. Paste one below.'); }}>
          <span className="av-row-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>
          </span>
          <span className="av-row-text">
            <span>Paste the link you copied</span>
            <span className="av-row-sub">YouTube, Vimeo, Twitch or a video link</span>
          </span>
        </button>
      ) : null}

      <form
        className="av-link"
        onSubmit={(e) => {
          e.preventDefault();
          if (link.trim()) submitLink(link, 'play');
        }}
      >
        <label htmlFor="av-link-input" className="av-label">Or paste a link</label>
        <input
          id="av-link-input"
          className="av-input"
          type="url"
          inputMode="url"
          placeholder="YouTube, Vimeo, Twitch or .mp4 link"
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            if (error) setError('');
          }}
        />
        {error && <div className="av-error" role="alert">{error}</div>}
        {link.trim() && (
          <div className="av-clip-actions">
            <button type="submit" className="rd-btn rd-btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Play for everyone'}</button>
            {isMediaActive && (
              <button type="button" className="rd-btn rd-btn-secondary" disabled={busy} onClick={() => submitLink(link, 'queue')}>Add to queue</button>
            )}
          </div>
        )}
      </form>

      <button type="button" className="av-row" onClick={() => fileRef.current?.click()}>
        <span className="av-row-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg>
        </span>
        <span className="av-row-text">
          <span>Play a video from this device</span>
          <span className="av-row-sub">MP4, MKV, WebM · streams to everyone</span>
        </span>
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

      {group && (
        <div className="av-picks">
          <div className="av-picks-head">
            <span className="av-label">Quick picks</span>
            {onPlayQueue && queuedIds.length > 0 && (
              <button type="button" className="av-play-queue" onClick={() => { onPlayQueue(); onClose?.(); }}>Play queue ({queuedIds.length})</button>
            )}
          </div>
          {groups.length > 1 && (
            <div className="av-seg" role="tablist" aria-label="Quick pick mood">
              {groups.map((g) => (
                <button key={g.group} type="button" role="tab" aria-selected={g === group} className={g === group ? 'active' : ''} onClick={() => { setGroupName(g.group); setCategoryId(null); }}>
                  {g.group}
                </button>
              ))}
            </div>
          )}
          {group.group === 'Trending' && <TrendingRegionSelect className="is-phone" />}
          {group.categories.length > 1 && (
            <div className="av-cats" role="tablist" aria-label="Quick pick categories">
              {group.categories.map((c) => (
                <button key={c.id} type="button" role="tab" aria-selected={c === category} className={c === category ? 'active' : ''} onClick={() => setCategoryId(c.id)}>
                  {c.name.replace(/^[^\p{L}\p{N}]+/u, '')}
                </button>
              ))}
            </div>
          )}
          <div className="av-pick-row">
            {picks.map((v) => (
              <div key={v.id} className="av-pick">
                <button type="button" className="av-pick-play" onClick={() => { onLoadYouTube?.(v.id, v.title); onClose?.(); }}>
                  <span className="av-pick-thumb" aria-hidden="true">
                    <img src={youtubeThumb(v.id)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                  </span>
                  <span className="av-pick-title">{v.title}</span>
                </button>
                {queuePick && (
                  <button
                    type="button"
                    className={`av-pick-queue ${queuedSet.has(v.id) ? 'is-queued' : ''}`}
                    onClick={() => !queuedSet.has(v.id) && queuePick(v.id, v.title)}
                    disabled={queuedSet.has(v.id)}
                    aria-label={queuedSet.has(v.id) ? `"${v.title}" is in the queue` : `Add "${v.title}" to queue`}
                  >
                    {queuedSet.has(v.id) ? 'Queued' : '+ Queue'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {isMediaActive && (
        <button type="button" className="rd-btn av-stop" onClick={() => { onStopVideo?.(); onClose?.(); }}>
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
  lock: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
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
  onLeaveRoom,
  isHost = false,
  playbackLock = false,
  onTogglePlaybackLock,
  activityMenu = [],
  onStartActivity
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

      {roomId && activityMenu.length > 0 && (
        <>
          <div className="phone-section-label">PLAY TOGETHER</div>
          <div className="phone-group">
            {activityMenu.map((a) => (
              <button
                key={a.id}
                type="button"
                className="phone-row"
                disabled={Boolean(a.disabledReason) || a.isOpen}
                onClick={then(() => onStartActivity?.(a.id))}
              >
                <span className="phone-row-icon" aria-hidden="true">{a.icon}</span>
                <span className="phone-row-text">
                  <span>{a.name}</span>
                  <span className="phone-row-sub">{a.isOpen ? 'Open now' : (a.disabledReason || a.description)}</span>
                </span>
                {Chevron}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="phone-section-label">ROOM</div>
      <div className="phone-group">
        {isHost ? (
          <SwitchRow
            icon={MoreIcon.lock}
            title="Only I control playback"
            sub="Others can't pause, seek or change the video"
            checked={playbackLock}
            onChange={onTogglePlaybackLock}
          />
        ) : playbackLock ? (
          <div className="phone-row phone-row-static">
            <span className="phone-row-icon" aria-hidden="true">{MoreIcon.lock}</span>
            <span className="phone-row-text">
              <span>The host controls playback</span>
              <span className="phone-row-sub">You can still chat, talk and add to the queue</span>
            </span>
          </div>
        ) : null}
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
        {onOpenServerSettings && (
          <button type="button" className="phone-row" onClick={then(onOpenServerSettings)}>
            <span className="phone-row-icon" aria-hidden="true">{MoreIcon.server}</span>
            <span className="phone-row-text">Server settings</span>
            {Chevron}
          </button>
        )}
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
