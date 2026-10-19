import React, { useState } from 'react';
import YouTubeSyncPlayer from './YouTubeSyncPlayer';
import LocalVideoSyncPlayer from './LocalVideoSyncPlayer';
import FloatingReactions from './FloatingReactions';
import DesktopDock from './room/DesktopDock';
import VideoPeopleOverlay from './room/VideoPeopleOverlay';
import SyncPill from './room/SyncPill';
import { BUILD, BUILD_LABEL } from '../version';
import { PhoneEmptyMedia, PhoneStreamOffer } from './phone/PhoneMediaOverlays';
import RejoinCard, { type RejoinInfo } from './RejoinCard';
import LinkPlayer from '../features/media/LinkPlayer';
import { mediaKey } from '../features/media/sources';
import type { MediaItem } from '../types';
import AmbientCinemaGlow from './room/AmbientCinemaGlow';
import ScreenShareStage from './room/ScreenShareStage';

import type { ConnectedPeer, SelfInfo, RoomBus } from '../types/room';
import type { PlayerAction } from '../features/media/LinkPlayer';
import type { QueueItem } from '../features/queue/useQueue';
import type { AudioSettings } from '../utils/audioSettings';
import type { SoundboardSettings, SoundboardClip } from '../utils/soundboard';
import type { UseScreenShareReturn } from '../features/screenshare/useScreenShare';
import type { ReactionFeed } from '../features/reactions/reactionFeed';
import type { PlaybackSyncState } from '../features/playback/drift';
import type { RemoteLocalVideoMeta, StreamProgress } from '../features/playback/usePlayback';
import type { UseFileFormatReturn } from '../features/files/useFileFormat';
import type { NetworkStatsSummary } from '../hooks/useNetworkStats';

import type { ActiveSoundboardSfx } from '../features/soundboard/useSoundboard';
import type { ActivityMenuItem } from '../features/activities/useActivities';
import type { ActivityViewKind } from '../features/activities/activityHost';

export interface StageProps {
  rejoin?: RejoinInfo | null;
  roomId?: string | null;
  isHost?: boolean;
  peerCount?: number;
  isP2PConnected?: boolean;
  connectedPeers?: ConnectedPeer[];
  localUser?: SelfInfo | null;
  onSetPeerVolume?: (peerId: string, volume: number) => void;
  onToggleMutePeer?: (peerId: string) => void;
  onOpenCreate?: () => void;
  onOpenJoin?: () => void;
  onLeaveRoom?: () => void;
  onCopyRoom?: () => void;
  activeVideoId?: string | null;
  activeMedia?: MediaItem | null;  // a link source (Vimeo, Twitch, a video file...): features/media
  onPlayLink?: (media: MediaItem) => void;
  onQueueLink?: (media: MediaItem) => void;
  onExitVideo?: () => void;
  onVideoChange?: (id: string | null, title?: string) => void;
  localVideoFile?: File | null;
  remoteLocalVideoMeta?: RemoteLocalVideoMeta | null;
  fileFormat?: UseFileFormatReturn | null;
  onLocalFileSelect?: (file: File) => void;
  onCloseLocalVideo?: () => void;
  onBroadcastAction?: (action: string, payload?: Record<string, unknown>) => void;
  remoteAction?: PlayerAction | null;
  playbackLock?: boolean;
  onTogglePlaybackLock?: () => void;
  onRegisterStateGetter?: (fn: (() => PlaybackSyncState | null | undefined) | null) => void;
  isMicMuted?: boolean;
  isAudioBlocked?: boolean;
  onToggleMic?: () => void;
  onToggleBlockAudio?: () => void;
  queue?: QueueItem[];
  onAddToQueue?: (item: { videoId?: string; media?: MediaItem | null; title?: string }, options?: { autoplay?: boolean }) => void;
  onPlayNextInQueue?: (options?: { auto?: boolean }) => void;
  onVoteSkip?: () => void;
  skipVotes?: string[];
  onOpenQueue?: () => void;
  activeVideoTitle?: string;
  username?: string;
  reactionFeed?: ReactionFeed | null;
  onSendReaction?: (emoji: string, time?: number) => void;
  // Feature 1.4: WebRTC Direct Video Streaming
  streamProgress?: StreamProgress | null;
  streamVideoUrl?: string | null;
  onRequestP2PStream?: () => void;
  onCancelP2PStream?: () => void;
  audioSettings?: AudioSettings | null;
  onOpenAudioSettings?: () => void;
  isPttActive?: boolean;
  onPttPressStart?: () => void;
  onPttPressEnd?: () => void;
  onUpdateAudioSettings?: (patch: Partial<AudioSettings>) => void;
  onSelectOutput?: (deviceId: string) => Promise<boolean>;
  // Feature 2.3: Synchronized Soundboard (Mini SFX Tray)
  soundboardSettings?: SoundboardSettings | null;
  activeSoundboardSfx?: ActiveSoundboardSfx | null;
  activeSfxCooldowns?: Record<string, number>;
  onPlaySoundboardClip?: (clip: string | SoundboardClip) => void;
  onSoundboardVolumeChange?: (volume: number) => void;
  onToggleSoundboardMute?: () => void;
  // Feature 4.1: Real-Time P2P Network HUD
  onOpenNetworkHud?: () => void;
  // Feature 4.3: QR Code for Instant Mobile Join
  onOpenQrCode?: () => void;
  // Phone layout: only the video area (the phone shell has its own bars); overlays for the
  // empty state and for a peer's video offer sit on top of the still-mounted players
  layout?: 'desktop' | 'phone';
  onOpenAddVideo?: () => void;
  // Activities (features/activities): the open one is shown over the stage; the menu starts one
  activitySlot?: React.ReactNode;
  activityView?: ActivityViewKind;
  activityMenu?: ActivityMenuItem[];
  onStartActivity?: (id: string) => void;
  screenShare?: UseScreenShareReturn | null;
  bus?: RoomBus | null;
  onToggleChat?: () => void;
  isChatOpen?: boolean;
  networkStats?: NetworkStatsSummary;
}

export default function Stage({
  rejoin = null,
  roomId = null,
  isHost = false,
  peerCount = 1,
  isP2PConnected = false,
  connectedPeers = [],
  localUser = null,
  onSetPeerVolume,
  onToggleMutePeer,
  onOpenCreate,
  onOpenJoin,
  onLeaveRoom,
  activeVideoId = null,
  activeMedia = null,
  onPlayLink,
  onQueueLink,
  onExitVideo = () => {},
  onVideoChange = () => {},
  localVideoFile = null,
  remoteLocalVideoMeta = null,
  fileFormat = null,
  onLocalFileSelect,
  onCloseLocalVideo = () => {},
  onBroadcastAction = () => {},
  remoteAction = null,
  playbackLock = false,
  onTogglePlaybackLock,
  onRegisterStateGetter,
  isMicMuted = true,
  isAudioBlocked = false,
  onToggleMic,
  onToggleBlockAudio,
  queue = [],
  onAddToQueue,
  onPlayNextInQueue,
  onVoteSkip,
  skipVotes = [],
  onOpenQueue,
  activeVideoTitle = '',
  username = '',
  reactionFeed,
  onSendReaction,
  streamProgress = null,
  streamVideoUrl = null,
  onRequestP2PStream,
  onCancelP2PStream,
  audioSettings = null,
  onOpenAudioSettings,
  isPttActive = false,
  onPttPressStart,
  onPttPressEnd,
  onUpdateAudioSettings,
  onSelectOutput,
  soundboardSettings = null,
  activeSoundboardSfx = null,
  activeSfxCooldowns = {},
  onPlaySoundboardClip,
  onSoundboardVolumeChange,
  onToggleSoundboardMute,
  onOpenNetworkHud,
  onOpenQrCode,
  layout = 'desktop',
  onOpenAddVideo,
  activitySlot = null,
  activityView = 'full',
  activityMenu = [],
  onStartActivity,
  screenShare = null,
  bus = null
}: StageProps) {
  const isPhone = layout === 'phone';
  const isPttMode = audioSettings?.inputMode === 'ptt';
  const isScreenSharing = Boolean(screenShare?.isScreenShareActive);
  const isMediaActive = Boolean(activeVideoId || localVideoFile || remoteLocalVideoMeta || streamVideoUrl || activeMedia || isScreenSharing);

  const handleSelectReaction = (emoji: string) => {
    if (typeof onSendReaction === 'function') {
      onSendReaction(emoji);
    }
  };

  // Drag and Drop Local Video Handlers
  const [isStageDragOver, setIsStageDragOver] = useState(false);

  const isVideoFile = (file: File) => {
    if (!file) return false;
    if (file.type && file.type.startsWith('video/')) return true;
    const name = file.name ? file.name.toLowerCase() : '';
    return /\.(mp4|mkv|webm|avi|mov|m4v|ogv|flv)$/i.test(name);
  };

  const handleStageDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isStageDragOver) setIsStageDragOver(true);
  };

  const handleStageDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsStageDragOver(false);
  };

  const handleStageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsStageDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        if (isVideoFile(files[i])) {
          onLocalFileSelect?.(files[i]);
          break;
        }
      }
    }
  };

  const phoneOverlay = !isPhone ? null
    : (remoteLocalVideoMeta && !localVideoFile && !streamVideoUrl) ? 'offer'
      : !isMediaActive ? 'empty'
        : null;

  return (
    <section className={`stage-section ${isPhone ? 'stage-phone' : ''} ${isMediaActive ? 'is-watching' : 'is-idle'}`}>
      <AmbientCinemaGlow activeVideoId={activeVideoId} isMediaActive={isMediaActive} localVideoFile={localVideoFile} streamVideoUrl={streamVideoUrl} />
      {/* Main Canvas Area (Drag-and-Drop Video Target & Stage Canvas) */}
      <div
        className={`stage-canvas yt-sync-wrapper ${isMediaActive ? 'has-video' : ''} ${isStageDragOver ? 'stage-drag-active' : ''} ${phoneOverlay ? 'phone-overlay-active' : ''}`}
        onDragOver={handleStageDragOver}
        onDragEnter={handleStageDragOver}
        onDragLeave={handleStageDragLeave}
        onDrop={handleStageDrop}
      >
        {/* Drag & Drop Visual Overlay */}
        {isStageDragOver && (
          <div className="stage-drag-overlay" role="alert">
            <div className="stage-drag-card">
              <div className="stage-drag-cloud-icon">
                <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor">
                  <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
                </svg>
              </div>
              <div className="stage-drag-title">Drop video to play for all peers</div>
              <div className="stage-drag-subtitle">Supports MP4, MKV, WebM • WebRTC direct sync</div>
            </div>
          </div>
        )}
        {!roomId ? (
          /* Case 1: No room joined yet */
          <div className="stage-overlay">
            <div className="stage-card">
              <div className="stage-logo-ring">
                <svg viewBox="0 0 24 24" width="48" height="48" fill="#e5143d">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                </svg>
              </div>

              <h1 className="stage-title">3RTC Watch Party</h1>
              <p className="stage-subtitle">
                Watch together online: create a room or enter a code to connect directly peer-to-peer (up to 4 people).
                Watch YouTube videos together.
              </p>

              <RejoinCard rejoin={rejoin} />
              <div className="initial-actions">
                <button className="btn btn-primary" onClick={onOpenCreate}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                  </svg>
                  Create Room
                </button>
                <button className="btn btn-secondary" onClick={onOpenJoin}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
                  </svg>
                  Join with Code
                </button>
              </div>

              <div className="stage-footer-note">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="#888">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
                </svg>
                <span>Direct WebRTC P2P mesh data connection. No third-party video storage.</span>
              </div>
              <nav className="site-links" aria-label="About 3RTC">
                <a href="/about">About</a>
                <a href="/youtube-watch-party">YouTube watch party</a>
                <a href="/watch-movies-together">Movie night</a>
                <a href="/watch-videos-together">Your own videos</a>
                <a href="/watch-links-together">Twitch &amp; Vimeo</a>
                <a href="/play-ludo-online">Play Ludo</a>
                <a href="/privacy">Privacy</a>
              </nav>
              <p className="build-label" title={BUILD.time ? `Built ${new Date(BUILD.time).toLocaleString()}${BUILD.branch ? ` from ${BUILD.branch}` : ''}` : undefined}>{BUILD_LABEL}</p>
            </div>
          </div>
        ) : screenShare?.isScreenShareActive ? (
          /* Case 2S: Live WebRTC Screen Share */
          <ScreenShareStage
            stream={screenShare.activeStream}
            isLocal={screenShare.isSharingScreen}
            presenterName={screenShare.screenSharer?.username || (screenShare.isSharingScreen ? (localUser?.username || username) : 'Peer')}
            hasAudio={screenShare.hasAudio}
            onStopSharing={screenShare.stopScreenShare}
            onExit={screenShare.dismissScreenShare}
            roomId={roomId}
            bus={bus}
            localUser={localUser}
          />
        ) : activeMedia ? (
          /* Case 2C: a link source, in sync through features/media */
          <LinkPlayer
            key={mediaKey(activeMedia)}
            media={activeMedia}
            remoteAction={remoteAction}
            onBroadcastAction={(action, payload = {}) => onBroadcastAction(action, { ...payload, type: 'media-action' })}
            onRegisterStateGetter={onRegisterStateGetter}
            onExit={onExitVideo}
            onEnded={onPlayNextInQueue ? () => onPlayNextInQueue({ auto: true }) : undefined}
            onVoteSkip={onVoteSkip}
            skipVotes={skipVotes}
            peerCount={peerCount}
            username={username}
            paste={isPhone ? null : {
              onPlayLink,
              onQueueLink,
              onPlayYouTube: (id: string, title?: string) => {
                onVideoChange(id, title);
                onBroadcastAction('load', { newVideoId: id, title });
              },
              onQueueYouTube: onAddToQueue ? (id: string, title?: string) => onAddToQueue({ videoId: id, title }) : undefined
            }}
          />
        ) : (localVideoFile || remoteLocalVideoMeta || streamVideoUrl) ? (
          /* Case 2A: Local Video Drag-and-Drop Sync Player or P2P Streamed Video */
          <LocalVideoSyncPlayer
            initialFile={localVideoFile}
            remoteMeta={remoteLocalVideoMeta}
            onFileSelect={onLocalFileSelect}
            onClose={onCloseLocalVideo}
            onBroadcastAction={onBroadcastAction}
            remoteAction={remoteAction}
            isP2PConnected={isP2PConnected}
            onRegisterStateGetter={onRegisterStateGetter}
            streamProgress={streamProgress}
            streamVideoUrl={streamVideoUrl}
            fileFormat={fileFormat}
            onRequestP2PStream={onRequestP2PStream}
            onCancelP2PStream={onCancelP2PStream}
            isHost={isHost}
            reactionFeed={reactionFeed}
            onSendReaction={onSendReaction}
            roomId={roomId}
            isPttSpaceActive={isPttMode && (audioSettings?.pttKey === 'Space' || audioSettings?.pttKey === ' ')}
          />
        ) : (
          /* Case 2B: YouTube Player / Watch Party Stage */
          <YouTubeSyncPlayer
            videoId={activeVideoId}
            activeVideoTitle={activeVideoTitle}
            onVideoChange={onVideoChange}
            onBroadcastAction={onBroadcastAction}
            remoteAction={remoteAction}
            isP2PConnected={isP2PConnected}
            onRegisterStateGetter={onRegisterStateGetter}
            onLocalFileSelect={onLocalFileSelect}
            queue={queue}
            onAddToQueue={onAddToQueue}
            onPlayNextInQueue={onPlayNextInQueue}
            onVoteSkip={onVoteSkip}
            skipVotes={skipVotes}
            peerCount={peerCount}
            username={username}
            onOpenQueue={onOpenQueue}
            onPlayLink={onPlayLink}
            onQueueLink={onQueueLink}
            onStartScreenShare={screenShare?.startScreenShare}
          />
        )}

        {phoneOverlay === 'empty' && <PhoneEmptyMedia onAddVideo={onOpenAddVideo} />}
        {phoneOverlay === 'offer' && (
          <PhoneStreamOffer
            meta={remoteLocalVideoMeta}
            fileFormat={fileFormat}
            streamProgress={streamProgress}
            onRequestStream={onRequestP2PStream}
            onCancelStream={onCancelP2PStream}
            onPickFile={onLocalFileSelect}
          />
        )}

        {roomId && activitySlot}

        {roomId && !isMediaActive && (!activitySlot || activityView !== 'full') && !phoneOverlay && !(remoteLocalVideoMeta && !localVideoFile && !streamVideoUrl) && (
          <SyncPill connectedPeers={connectedPeers} isHost={isHost} isPhone={isPhone} />
        )}
        {isPhone && roomId && (!activitySlot || activityView !== 'full') && !phoneOverlay && !(remoteLocalVideoMeta && !localVideoFile && !streamVideoUrl) && (
          <VideoPeopleOverlay
            connectedPeers={connectedPeers}
            localUser={localUser}
            isPhone={isPhone}
            onSetPeerVolume={onSetPeerVolume}
            onToggleMutePeer={onToggleMutePeer}
          />
        )}

        {/* Floating Live Reactions Overlay */}
        <FloatingReactions
          feed={reactionFeed}
          onSendReaction={onSendReaction}
          showDock={false}
          hasMedia={isMediaActive}
        />
      </div>

      {/* Live Synchronized SFX HUD Banner on Stage */}
      {activeSoundboardSfx && (
        <div className="stage-soundboard-hud" role="status" aria-live="polite">
          <div className="sfx-hud-icon-wrap">
            <span className="sfx-hud-emoji">{activeSoundboardSfx.emoji || '🔊'}</span>
            <span className="sfx-hud-pulse-ring" />
          </div>
          <div className="sfx-hud-content">
            <div className="sfx-hud-label-row">
              <span className="sfx-hud-sender">{activeSoundboardSfx.sender || 'Peer'}</span>
              <span className="sfx-hud-action">played</span>
              <span className="sfx-hud-name">{activeSoundboardSfx.soundName}</span>
            </div>
            <div className="sfx-hud-visualizer">
              <span className="hud-eq-bar bar-1" />
              <span className="hud-eq-bar bar-2" />
              <span className="hud-eq-bar bar-3" />
              <span className="hud-eq-bar bar-4" />
              <span className="hud-eq-bar bar-5" />
            </div>
          </div>
        </div>
      )}

      {!isPhone && roomId && (
        <DesktopDock
          localUser={localUser}
          connectedPeers={connectedPeers}
          isHost={isHost}
          isMicMuted={isMicMuted}
          isAudioBlocked={isAudioBlocked}
          onToggleMic={onToggleMic}
          onToggleBlockAudio={onToggleBlockAudio}
          onSetPeerVolume={onSetPeerVolume}
          onToggleMutePeer={onToggleMutePeer}
          audioSettings={audioSettings}
          onUpdateAudioSettings={onUpdateAudioSettings}
          onSelectOutput={onSelectOutput}
          onOpenAudioSettings={onOpenAudioSettings}
          isPttActive={isPttActive}
          onPttPressStart={onPttPressStart}
          onPttPressEnd={onPttPressEnd}
          onSendReaction={handleSelectReaction}
          soundboardSettings={soundboardSettings}
          activeSoundboardSfx={activeSoundboardSfx}
          activeSfxCooldowns={activeSfxCooldowns}
          onPlaySoundboardClip={onPlaySoundboardClip}
          onSoundboardVolumeChange={onSoundboardVolumeChange}
          onToggleSoundboardMute={onToggleSoundboardMute}
          isMediaActive={isMediaActive}
          onOpenAddVideo={onOpenAddVideo}
          isScreenSharing={screenShare?.isSharingScreen}
          screenSharer={screenShare?.screenSharer}
          isScreenShareDismissed={screenShare?.isDismissed}
          onToggleScreenShare={screenShare?.toggleScreenShare}
          activityMenu={activityMenu}
          onStartActivity={onStartActivity}
          playbackLock={playbackLock}
          onTogglePlaybackLock={onTogglePlaybackLock}
          onOpenNetworkHud={onOpenNetworkHud}
          onOpenQrCode={onOpenQrCode}
          onLeaveRoom={onLeaveRoom}
        />
      )}
    </section>
  );
}
