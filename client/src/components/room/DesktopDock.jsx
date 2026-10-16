import React from 'react';
import { Icon } from '../icons';
import { usePopover } from '../../hooks/usePopover';
import { useReactionSet, openReactionsEditor } from '../../features/reactions/reactionSet';
import { useLiveVoiceUsers } from '../../utils/speakingActivity';
import { getAvatarColor } from '../../utils/sound';
import { getInitials } from '../PeerVoiceRoster';
import AudioDevicePicker from '../AudioDevicePicker';
import SoundboardTray from '../SoundboardTray';

/**
 * Desktop room controls (Figma "Dock"): you on the left, the call controls in the middle,
 * Leave on its own at the far right.
 */
export default function DesktopDock({
  localUser, connectedPeers, isHost,
  isMicMuted, isAudioBlocked, onToggleMic, onToggleBlockAudio,
  audioSettings, onUpdateAudioSettings, onSelectOutput, onOpenAudioSettings,
  isPttActive, onPttPressStart, onPttPressEnd,
  onSendReaction,
  soundboardSettings, activeSoundboardSfx, activeSfxCooldowns, onPlaySoundboardClip, onSoundboardVolumeChange, onToggleSoundboardMute,
  isMediaActive, onOpenAddVideo,
  activityMenu = [], onStartActivity,
  playbackLock, onTogglePlaybackLock,
  onOpenNetworkHud, onOpenQrCode, onLeaveRoom
}) {
  const isPtt = audioSettings?.inputMode === 'ptt';
  const { localUser: me } = useLiveVoiceUsers(connectedPeers, localUser);
  const quickReactions = useReactionSet();
  const devices = usePopover();
  const reactions = usePopover();
  const sounds = usePopover();
  const games = usePopover();
  const more = usePopover();

  const name = me?.username || 'You';
  const speaking = Boolean(me?.isSpeaking) && !isMicMuted;
  const status = isAudioBlocked ? 'Sound off' : isPtt ? (isPttActive ? 'Talking' : `Hold ${audioSettings?.pttKeyLabel || 'Space'} to talk`) : isMicMuted ? 'Mic off' : speaking ? 'Speaking' : 'Mic on';
  const micLabel = isAudioBlocked ? 'Mic blocked' : isPtt ? (isPttActive ? 'Talking' : `Hold ${audioSettings?.pttKeyLabel || 'Space'}`) : isMicMuted ? 'Mic off' : 'Mic on';
  const micOff = isMicMuted || isAudioBlocked;
  const showGames = !isMediaActive && activityMenu.length > 0;

  return (
    <div className="dock">
      <div className="dock-you">
        <span className={`rd-av ${speaking ? 'is-speaking' : ''} ${micOff ? 'is-quiet' : ''}`} style={{ '--av': getAvatarColor(name) }} aria-hidden="true">
          {getInitials(name)}
        </span>
        <div className="dock-you-text">
          <span className="dock-you-name">{name} <span>(you{isHost ? ' · host' : ''})</span></span>
          <span className={`dock-you-status ${micOff ? 'is-off' : speaking ? 'is-live' : ''}`}>{status}</span>
        </div>
      </div>

      <div className="dock-controls" role="toolbar" aria-label="Call controls">
        <div className={`dock-mic ${micOff ? 'is-off' : 'is-on'}`} ref={devices.ref}>
          <button
            type="button"
            className="dock-mic-toggle"
            aria-pressed={!micOff}
            aria-label={isPtt ? 'Push to talk' : isMicMuted ? 'Turn microphone on' : 'Turn microphone off'}
            onClick={isPtt ? onOpenAudioSettings : onToggleMic}
            onMouseDown={isPtt ? onPttPressStart : undefined}
            onMouseUp={isPtt ? onPttPressEnd : undefined}
          >
            <Icon name={micOff ? 'micOff' : 'mic'} />
            <span>{micLabel}</span>
          </button>
          <button type="button" className="dock-mic-caret" aria-label="Choose microphone and speaker" aria-expanded={devices.open} onClick={devices.toggle}>
            <Icon name="chevronUp" size={14} strokeWidth={2.4} />
          </button>
          {devices.open && (
            <div className="dock-pop dock-pop-devices" role="dialog" aria-label="Microphone and speaker">
              <AudioDevicePicker compact audioSettings={audioSettings} onUpdateAudioSettings={onUpdateAudioSettings} onSelectOutput={onSelectOutput} isMicLive={!isMicMuted} />
              <button type="button" className="dock-pop-link" onClick={() => { devices.close(); onOpenAudioSettings?.(); }}>Voice settings &amp; mic test…</button>
            </div>
          )}
        </div>

        <button
          type="button"
          className={`dock-btn ${isAudioBlocked ? 'is-off' : ''}`}
          aria-pressed={isAudioBlocked}
          aria-label={isAudioBlocked ? 'Hear everyone again' : 'Deafen: stop hearing everyone'}
          title={isAudioBlocked ? 'Hear everyone again' : 'Deafen'}
          onClick={onToggleBlockAudio}
        >
          <Icon name={isAudioBlocked ? 'headphonesOff' : 'headphones'} />
        </button>

        <div className="dock-anchor" ref={reactions.ref}>
          <button type="button" className={`dock-btn ${reactions.open ? 'is-active' : ''}`} aria-label="Reactions" title="Reactions" aria-expanded={reactions.open} onClick={reactions.toggle}>
            <Icon name="smile" />
          </button>
          {reactions.open && (
            <div className="dock-pop dock-pop-reactions" role="dialog" aria-label="Reactions">
              <div className="dock-react-row">
                {quickReactions.map((r) => (
                  <button key={r.emoji} type="button" className="dock-react" title={`${r.emoji} (key ${r.key})`} onClick={() => onSendReaction?.(r.emoji)}>{r.emoji}</button>
                ))}
              </div>
              <button type="button" className="dock-pop-link" onClick={() => { reactions.close(); openReactionsEditor(); }}>Choose your reactions…</button>
            </div>
          )}
        </div>

        <div className="dock-anchor" ref={sounds.ref}>
          <button type="button" className={`dock-btn ${sounds.open ? 'is-active' : ''}`} aria-label="Soundboard" title="Soundboard" aria-expanded={sounds.open} onClick={sounds.toggle}>
            <Icon name="music" />
          </button>
          {sounds.open && (
            <div className="dock-pop dock-pop-sounds" role="dialog" aria-label="Soundboard">
              <SoundboardTray
                variant="floating"
                volume={soundboardSettings?.volume ?? 0.75}
                isMuted={Boolean(soundboardSettings?.muted)}
                onVolumeChange={onSoundboardVolumeChange}
                onToggleMute={onToggleSoundboardMute}
                activeSfx={activeSoundboardSfx}
                activeCooldowns={activeSfxCooldowns}
                onPlayClip={onPlaySoundboardClip}
                onClose={sounds.close}
              />
            </div>
          )}
        </div>

        {showGames ? (
          <div className="dock-anchor" ref={games.ref}>
            <button type="button" className={`dock-btn ${games.open ? 'is-active' : ''}`} aria-label="Games" title="Play together" aria-expanded={games.open} onClick={games.toggle}>
              <Icon name="games" />
            </button>
            {games.open && (
              <div className="dock-pop dock-menu" role="menu" aria-label="Play together">
                <p className="dock-menu-label">Play together</p>
                {activityMenu.map((a) => (
                  <button key={a.id} type="button" role="menuitem" className="dock-menu-item" disabled={Boolean(a.disabledReason) || a.isOpen} title={a.disabledReason || a.description}
                    onClick={() => { games.close(); onStartActivity?.(a.id); }}>
                    <span className="dock-menu-emoji" aria-hidden="true">{a.icon}</span>{a.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button type="button" className="dock-btn" aria-label="Add a video" title="Add a video" onClick={onOpenAddVideo}>
            <Icon name="videoAdd" />
          </button>
        )}

        <div className="dock-anchor" ref={more.ref}>
          <button type="button" className={`dock-btn ${more.open ? 'is-active' : ''}`} aria-label="More options" title="More" aria-haspopup="menu" aria-expanded={more.open} onClick={more.toggle}>
            <Icon name="more" />
          </button>
          {more.open && (
            <div className="dock-pop dock-menu" role="menu" aria-label="More">
              <button type="button" role="menuitem" className="dock-menu-item" onClick={() => { more.close(); onOpenAudioSettings?.(); }}><Icon name="settings" size={18} />Voice settings</button>
              <button type="button" role="menuitem" className="dock-menu-item" onClick={() => { more.close(); onOpenNetworkHud?.(); }}><Icon name="signal" size={18} />Connection details</button>
              <button type="button" role="menuitem" className="dock-menu-item" onClick={() => { more.close(); onOpenQrCode?.(); }}><Icon name="qr" size={18} />Invite with QR code</button>
              {isHost ? (
                <button type="button" role="menuitemcheckbox" aria-checked={playbackLock} className="dock-menu-item" onClick={() => { more.close(); onTogglePlaybackLock?.(); }}
                  title="When on, others can't play, pause, seek or change the video">
                  <Icon name="lock" size={18} />Only I control playback
                  <span className={`dock-switch ${playbackLock ? 'is-on' : ''}`} aria-hidden="true" />
                </button>
              ) : playbackLock ? (
                <p className="dock-menu-note"><Icon name="lock" size={18} />The host controls playback</p>
              ) : null}
              {!showGames && activityMenu.length > 0 && (
                <>
                  <p className="dock-menu-label">Play together</p>
                  {activityMenu.map((a) => (
                    <button key={a.id} type="button" role="menuitem" className="dock-menu-item" disabled={Boolean(a.disabledReason) || a.isOpen} title={a.disabledReason || a.description}
                      onClick={() => { more.close(); onStartActivity?.(a.id); }}>
                      <span className="dock-menu-emoji" aria-hidden="true">{a.icon}</span>{a.name}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="dock-end">
        <button type="button" className="dock-leave" onClick={onLeaveRoom}>Leave</button>
      </div>
    </div>
  );
}
