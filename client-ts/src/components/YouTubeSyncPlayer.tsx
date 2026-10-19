import { useState, useEffect, useRef } from 'react';
import { findQuickPickTitle, getQuickPicks, isVideoUnavailable, markVideoUnavailable, type QuickPickVideo } from '../utils/quickPicks';
import QuickPicksBrowser from './QuickPicksBrowser';
import { resolvePastedLink } from '../features/media/resolveLink';
import { extractYouTubeId } from '../utils/youtubeId';

export { extractYouTubeId, isVideoUnavailable };

export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export async function fetchYouTubeTitle(videoId: string, fallbackTitle = ''): Promise<string> {
  if (!videoId) return fallbackTitle || 'YouTube Video';
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data && data.title) {
        return data.title;
      }
    }
  } catch {
    // Ignore timeout or network errors
  }
  // Fallback to presets if matched
  const presetTitle = findQuickPickTitle(videoId);
  if (presetTitle) return presetTitle;
  return fallbackTitle || `YouTube Video (${videoId})`;
}

/** The next quick pick after `videoId` in its category that hasn't failed, or null. */
function nextPlayablePreset(videoId: string): QuickPickVideo | null {
  const category = getQuickPicks().find((c) => c.videos.some((v) => v.id === videoId));
  if (!category) return null;
  const start = category.videos.findIndex((v) => v.id === videoId);
  for (let step = 1; step < category.videos.length; step += 1) {
    const candidate = category.videos[(start + step) % category.videos.length];
    if (!isVideoUnavailable(candidate.id)) return candidate;
  }
  return null;
}

import type { PlayerAction } from '../features/media/LinkPlayer';
import type { QueueItem } from '../features/queue/useQueue';
import type { MediaItem } from '../types';
import type { PlaybackSyncState } from '../features/playback/drift';

export interface YouTubeSyncPlayerProps {
  videoId?: string | null;
  activeVideoTitle?: string;
  onVideoChange: (videoId: string | null, title?: string) => void;
  onBroadcastAction: (action: string, payload?: Record<string, unknown>) => void;
  remoteAction?: PlayerAction | null;
  isP2PConnected?: boolean;
  onRegisterStateGetter?: (getter: (() => PlaybackSyncState | null | undefined) | null) => void;
  onLocalFileSelect?: (file: File) => void;
  queue?: QueueItem[];
  onAddToQueue?: (item: { videoId?: string; media?: MediaItem | null; title?: string }, options?: { autoplay?: boolean }) => void;
  onPlayNextInQueue?: (options?: { auto?: boolean }) => void;
  onVoteSkip?: () => void;
  skipVotes?: string[];
  peerCount?: number;
  username?: string;
  onOpenQueue?: () => void;
  onPlayLink?: (media: MediaItem) => void;
  onQueueLink?: (media: MediaItem) => void;
  onStartScreenShare?: () => void;
}

export default function YouTubeSyncPlayer({
  videoId,
  onVideoChange,
  onBroadcastAction,
  remoteAction,
  isP2PConnected,
  onRegisterStateGetter,
  onLocalFileSelect,
  queue = [],
  onAddToQueue,
  onPlayNextInQueue,
  onVoteSkip,
  skipVotes = [],
  peerCount = 0,
  username = '',
  onPlayLink,   // a pasted Vimeo / Twitch / video-file link: play for everyone
  onStartScreenShare
}: YouTubeSyncPlayerProps) {
  const [urlInput, setUrlInput] = useState('');
  const [playerReady, setPlayerReady] = useState(false);
  const [, setSyncStatus] = useState('Ready');
  const [inputError, setInputError] = useState('');
  const [, setIsPlaying] = useState(false);
  const [, setCurrentTimeSec] = useState(0);
  const [, setDurationSec] = useState(0);
  const [, setVolume] = useState(100);
  const [, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDropOver, setIsDropOver] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [showTopControls, setShowTopControls] = useState(true);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleStageActivity = () => {
    setShowTopControls(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setShowTopControls(false);
    }, 3500);
  };

  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  const playerRef = useRef<YTPlayerTarget | null>(null);
  const fullstageRef = useRef<HTMLDivElement | null>(null);
  const iframeContainerRef = useRef<HTMLDivElement | null>(null);
  const localFileInputRef = useRef<HTMLInputElement | null>(null);
  const isRemoteActionRef = useRef(false);
  // State changes the player is about to report because of something we told it to do (a peer's
  // command, or our own buttons, which broadcast themselves). Only those are skipped: anything
  // else is a person using the player and is sent to the room.
  const echoRef = useRef<{ states: Set<number> | null; final: number | null; until: number }>({ states: null, final: null, until: 0 });
  const expectEcho = (states: number[], ms = 1500, final: number | null = null) => {
    echoRef.current = { states: new Set(states), final, until: Date.now() + ms };
  };
  // A seek keeps the player's state (after buffering): playing stays playing, paused stays paused
  const expectSeekEcho = (ms = 1500) => {
    const playing = playerRef.current?.getPlayerState?.() === 1;
    expectEcho(playing ? [3, 1] : [3, 2], ms, playing ? 1 : 2);
  };
  const isScrubbingRef = useRef(false);
  const lastStateRef = useRef(-1);
  const lastReportedTimeRef = useRef(0);
  const durationSecRef = useRef(0);
  const currentVideoIdRef = useRef<string | null | undefined>(videoId);
  currentVideoIdRef.current = videoId;

  // 1. Load YouTube Iframe API script if not present
  useEffect(() => {
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      if (firstScriptTag && firstScriptTag.parentNode) {
        firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
      } else {
        document.head.appendChild(tag);
      }
    }
  }, []);

  // 2. Register state getter for late-joiner synchronization
  useEffect(() => {
    if (typeof onRegisterStateGetter === 'function') {
      onRegisterStateGetter(() => {
        const curTime = playerRef.current?.getCurrentTime?.() || 0;
        const state = playerRef.current?.getPlayerState?.();
        return {
          mediaType: 'youtube' as const,
          videoId: currentVideoIdRef.current,
          currentTime: curTime,
          isPlaying: state === 1,
          isBuffering: state === 3
        };
      });
      return () => onRegisterStateGetter(null);
    }
  }, [onRegisterStateGetter]);

  // 3. Initialize or update YT.Player when videoId changes
  useEffect(() => {
    if (!videoId) {
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        try {
          playerRef.current.destroy();
        } catch { }
        playerRef.current = null;
      }
      setPlayerReady(false);
      setIsPlaying(false);
      setCurrentTimeSec(0);
      setDurationSec(0);
      durationSecRef.current = 0;
      return;
    }

    let checkInterval: ReturnType<typeof setInterval> | undefined;

    const initPlayer = () => {
      const YT = window.YT;
      if (!YT || !YT.Player) return false;
      const container = iframeContainerRef.current || document.querySelector('.yt-stage-canvas-viewport');
      if (!container) return false;

      // Always clean up existing instance to guarantee controls: 0 is strictly applied
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        try {
          playerRef.current.destroy();
        } catch { }
        playerRef.current = null;
      }

      // Ensure fresh placeholder DOM element exists inside container
      let element = document.getElementById('yt-iframe-placeholder');
      if (!element) {
        element = document.createElement('div');
        element.id = 'yt-iframe-placeholder';
        container.appendChild(element);
      }

      try {
        const playerVideoId = videoId; // errors are about this video, even if the room moved on
        playerRef.current = new YT.Player(element, {
          videoId: videoId,
          playerVars: {
            autoplay: 1,
            controls: 1, // Enable YouTube native controls so video quality settings, captions, and more videos cards are accessible
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            enablejsapi: 1,
            origin: window.location.origin
          },
          events: {
            onReady: (e: { target: YTPlayerTarget }) => {
              setPlayerReady(true);
              setSyncStatus('Synced with peers');
              try {
                const dur = e.target.getDuration?.() || 0;
                if (dur > 0) {
                  setDurationSec(dur);
                  durationSecRef.current = dur;
                }
                const vol = e.target.getVolume?.();
                if (typeof vol === 'number') setVolume(vol);
                const muted = e.target.isMuted?.();
                if (typeof muted === 'boolean') setIsMuted(muted);
                e.target.playVideo();
                setIsPlaying(true);
              } catch { }
            },
            onStateChange: handlePlayerStateChange,
            onError: (e: { data: number }) => handlePlayerErrorRef.current?.(e.data, playerVideoId)
          }
        });
        return true;
      } catch {
        return false;
      }
    };

    if (!initPlayer()) {
      checkInterval = setInterval(() => {
        if (initPlayer() && checkInterval !== undefined) {
          clearInterval(checkInterval);
        }
      }, 200);
    }

    return () => {
      if (checkInterval !== undefined) clearInterval(checkInterval);
    };
  }, [videoId]);

  // Cleanup player on unmount
  useEffect(() => {
    return () => {
      if (playerRef.current) {
        try {
          if (typeof playerRef.current.stopVideo === 'function') {
            playerRef.current.stopVideo();
          }
          if (typeof playerRef.current.destroy === 'function') {
            playerRef.current.destroy();
          }
        } catch { }
        playerRef.current = null;
      }
    };
  }, []);

  // 4. Handle local player state changes and broadcast to peers
  const handlePlayerStateChange = (event: { data: number }) => {
    if (!playerRef.current) return;
    const state = event.data;

    const dur = typeof playerRef.current.getDuration === 'function' ? playerRef.current.getDuration() : 0;
    if (dur > 0 && Math.abs(dur - durationSecRef.current) > 0.5) {
      durationSecRef.current = dur;
      setDurationSec(dur);
    }

    // Caused by a command we gave the player: remember the state, don't broadcast it
    const echo = echoRef.current;
    if (echo.states && Date.now() < echo.until && echo.states.has(state)) {
      lastStateRef.current = state;
      if (echo.final !== null && state === echo.final) echoRef.current = { states: null, final: null, until: 0 };
      return;
    }

    const curTime = typeof playerRef.current.getCurrentTime === 'function'
      ? playerRef.current.getCurrentTime()
      : 0;
    lastReportedTimeRef.current = curTime;
    if (!isScrubbingRef.current) {
      setCurrentTimeSec(curTime);
    }

    const YT = window.YT;
    if (YT) {
      if (state === YT.PlayerState.PLAYING && lastStateRef.current !== YT.PlayerState.PLAYING) {
        setSyncStatus('Playing (Synced)');
        setIsPlaying(true);
        if (isP2PConnected) {
          onBroadcastAction('play', { currentTime: curTime });
        }
      } else if (state === YT.PlayerState.PAUSED && lastStateRef.current !== YT.PlayerState.PAUSED) {
        setSyncStatus('Paused (Synced)');
        setIsPlaying(false);
        if (isP2PConnected) {
          onBroadcastAction('pause', { currentTime: curTime });
        }
      } else if (state === YT.PlayerState.ENDED) {
        setSyncStatus('Video finished');
        setIsPlaying(false);
        if (typeof onPlayNextInQueue === 'function') {
          onPlayNextInQueue({ auto: true });
        }
      }
    }

    lastStateRef.current = state;
  };

  // 5. Polling interval to track time and detect timeline scrubbing
  useEffect(() => {
    if (!playerReady) return;
    const interval = setInterval(() => {
      if (!playerRef.current || isRemoteActionRef.current) return;
      try {
        if (typeof playerRef.current.getCurrentTime !== 'function') return;
        const curTime = playerRef.current.getCurrentTime();
        const state = playerRef.current.getPlayerState?.();
        const dur = playerRef.current.getDuration?.() || 0;
        if (dur > 0 && Math.abs(dur - durationSecRef.current) > 0.5) {
          durationSecRef.current = dur;
          setDurationSec(dur);
        }

        if (!isScrubbingRef.current) {
          setCurrentTimeSec(curTime);
        }
        if (state === 1) setIsPlaying(true);
        else if (state === 2) setIsPlaying(false);

        // If time jumped forward or backward by > 2.2s without remote action
        const delta = Math.abs(curTime - lastReportedTimeRef.current);
        if (lastReportedTimeRef.current > 0 && delta > 2.2 && (state === 1 || state === 2 || state === 3)) {
          if (isP2PConnected) {
            onBroadcastAction('seek', { currentTime: curTime });
          }
          setSyncStatus(`Seeked to ${formatTime(curTime)} (Synced)`);
        }
        lastReportedTimeRef.current = curTime;
      } catch { }
    }, 350);

    return () => clearInterval(interval);
  }, [playerReady, isP2PConnected, onBroadcastAction]);

  // 6. Handle incoming remote sync actions from peers
  useEffect(() => {
    if (!remoteAction) return;
    const { action, currentTime, newVideoId, videoId: actionVideoId } = remoteAction;
    const targetVideoId: string | undefined =
      typeof newVideoId === 'string' ? newVideoId :
      typeof actionVideoId === 'string' ? actionVideoId : undefined;

    if (action === 'close' || action === 'unload') {
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        try {
          playerRef.current.destroy();
        } catch { }
        playerRef.current = null;
      }
      setPlayerReady(false);
      setIsPlaying(false);
      setCurrentTimeSec(0);
      setDurationSec(0);
      durationSecRef.current = 0;
      setSyncStatus('Ready');
      currentVideoIdRef.current = null;
      onVideoChange(null);
      return;
    }

    if (!playerRef.current) return;

    isRemoteActionRef.current = true;
    const YTS = window.YT?.PlayerState || { UNSTARTED: -1, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
    if (action === 'load') expectEcho([YTS.UNSTARTED, YTS.BUFFERING, YTS.PLAYING, YTS.CUED, YTS.PAUSED], 3000, YTS.PLAYING);
    else if (action === 'play') expectEcho([YTS.PLAYING, YTS.BUFFERING], 1500, YTS.PLAYING);
    else if (action === 'pause') expectEcho([YTS.PAUSED, YTS.BUFFERING], 1500, YTS.PAUSED);
    else if (action === 'seek') expectSeekEcho();

    try {
      if (action === 'load' && targetVideoId && targetVideoId !== currentVideoIdRef.current) {
        setSyncStatus(`Peer loaded new video`);
        currentVideoIdRef.current = targetVideoId;
        if (typeof playerRef.current.loadVideoById === 'function') {
          playerRef.current.loadVideoById(targetVideoId);
        }
      } else if (action === 'play') {
        setSyncStatus(`Peer played video`);
        setIsPlaying(true);
        if (typeof playerRef.current.getCurrentTime === 'function') {
          const cur = playerRef.current.getCurrentTime();
          if (currentTime !== undefined && Math.abs(cur - currentTime) > 1.2) {
            playerRef.current.seekTo(currentTime, true);
            lastReportedTimeRef.current = currentTime;
          }
        }
        if (typeof playerRef.current.playVideo === 'function') {
          playerRef.current.playVideo();
        }
      } else if (action === 'pause') {
        setSyncStatus(`Peer paused video`);
        setIsPlaying(false);
        if (currentTime !== undefined && typeof playerRef.current.seekTo === 'function') {
          playerRef.current.seekTo(currentTime, true);
          lastReportedTimeRef.current = currentTime;
        }
        if (typeof playerRef.current.pauseVideo === 'function') {
          playerRef.current.pauseVideo();
        }
      } else if (action === 'seek') {
        setSyncStatus(`Peer seeked to ${formatTime(currentTime || 0)}`);
        if (currentTime !== undefined && typeof playerRef.current.seekTo === 'function') {
          playerRef.current.seekTo(currentTime, true);
          lastReportedTimeRef.current = currentTime;
          setCurrentTimeSec(currentTime);
        }
      }
    } catch {
      // Failed to apply remote action
    } finally {
      setTimeout(() => {
        isRemoteActionRef.current = false;
      }, 1200);
    }
  }, [remoteAction, onVideoChange]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
    };
  }, []);

  // 7. Load or queue a pasted link (YouTube, or any link source: features/media)
  const resolveInput = async () => {
    if (isResolving) return null;
    setIsResolving(true);
    try {
      const res = await resolvePastedLink(urlInput);
      if (res.error) {
        setInputError(res.error);
        return null;
      }
      setInputError('');
      setUrlInput('');
      return res;
    } finally {
      setIsResolving(false);
    }
  };

  const handleLoadUrl = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const res = await resolveInput();
    if (!res) return;
    if (res.kind === 'media') {
      onPlayLink?.(res.media);
      return;
    }
    if (res.kind === 'youtube' && res.videoId) {
      onVideoChange(res.videoId, res.title);
      onBroadcastAction('load', { newVideoId: res.videoId, title: res.title });
    }
  };

  // YouTube refused the video (100: removed or private; 101/150: owner blocks other sites, or it's
  // blocked in this region / age-restricted). Skip to the next queued video, or the next working
  // quick pick in the same category, instead of leaving everyone on "Video unavailable".
  const handlePlayerErrorRef = useRef<((code: number, failedId: string) => void) | null>(null);
  handlePlayerErrorRef.current = (code: number, failedId: string) => {
    const currentId = currentVideoIdRef.current || videoId;
    if (code !== 100 && code !== 101 && code !== 150) {
      if (failedId === currentId) setSyncStatus('Video playback error');
      return;
    }
    if (failedId) markVideoUnavailable(failedId);
    // Late error for a video the room already left (another peer skipped it first): nothing to do
    if (failedId !== currentId) return;
    const reason = code === 100 ? 'removed or private' : 'blocked outside YouTube';

    if (queue.length > 0 && typeof onPlayNextInQueue === 'function') {
      setSyncStatus(`Unavailable (${reason}), playing next`);
      onPlayNextInQueue({ auto: true });
      return;
    }
    const replacement = failedId ? nextPlayablePreset(failedId) : null;
    if (replacement) {
      setSyncStatus(`Unavailable (${reason}), trying another`);
      onVideoChange(replacement.id, replacement.title);
      onBroadcastAction('load', { newVideoId: replacement.id, title: replacement.title });
      return;
    }
    setSyncStatus(`Video unavailable (${reason})`);
  };

  const handleSelectPreset = (category: { videos: QuickPickVideo[] }) => {
    setInputError('');
    const pool = category.videos.filter((v) => !isVideoUnavailable(v.id));
    if (!pool || pool.length === 0) return;

    const activeId = currentVideoIdRef.current || videoId;
    const available = pool.filter((v) => v.id !== activeId);
    const candidateList = available.length > 0 ? available : pool;
    const randomChoice = candidateList[Math.floor(Math.random() * candidateList.length)];

    onVideoChange(randomChoice.id, randomChoice.title);
    onBroadcastAction('load', { newVideoId: randomChoice.id, title: randomChoice.title });
  };

  const totalParticipants = peerCount + 1;
  const requiredVotes = totalParticipants <= 2 ? totalParticipants : Math.ceil(totalParticipants / 2);
  const hasVotedSkip = skipVotes.includes(username);

  // CASE 1: Video is Active and Playing
  if (videoId) {
    return (
      <div
        className={`yt-fullstage-player ${isFullscreen ? 'is-fullscreen' : ''}`}
        ref={fullstageRef}
        onMouseMove={handleStageActivity}
        onMouseEnter={handleStageActivity}
        onMouseLeave={() => setShowTopControls(false)}
      >
        {/* Fullscreen Overlay: auto-hiding top controls when browser chrome/Header is hidden */}
        {isFullscreen && (
          <div className={`yt-stage-topbar ${showTopControls ? 'is-active' : 'is-idle'}`}>
            <div className="yt-stage-top-controls">
              {/* Vote to Skip (shown if peers are present) */}
              {totalParticipants > 1 && (
                <button
                  type="button"
                  className={`yt-ctrl-btn vote-skip-btn compact ${hasVotedSkip ? 'voted' : ''}`}
                  onClick={onVoteSkip}
                  title={hasVotedSkip ? 'You voted to skip (click to unvote)' : `Vote to skip (${skipVotes.length}/${requiredVotes} needed)`}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
                  </svg>
                  <span>Skip ({skipVotes.length}/{requiredVotes})</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Video Viewport occupying full space */}
        <div className="yt-stage-canvas-viewport" ref={iframeContainerRef}>
          <div id="yt-iframe-placeholder"></div>
        </div>
      </div>
    );
  }

  // CASE 2: Idle Screen: one box for a link or a file (drop it anywhere here), then quick picks
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    setIsDropOver(true);
  };
  return (
    <div
      className={`yt-screen-card ${isDropOver ? 'is-drop-over' : ''}`}
      ref={fullstageRef}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDropOver(false); }}
      onDrop={(e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        setIsDropOver(false);
        onLocalFileSelect?.(e.dataTransfer.files[0]);
      }}
    >
      <div className="yt-hero-center">
        <div className="rd-pick">
        <h2 className="rd-pick-title">What are we watching?</h2>

        <div className={`rd-dropzone ${isDropOver ? 'is-over' : ''}`}>
          <form className="yt-hero-form" onSubmit={handleLoadUrl}>
            <div className="yt-hero-input-wrap">
              <label htmlFor="stage-link" className="rd-visually-hidden">Video link</label>
              <input
                id="stage-link"
                type="text"
                className="yt-hero-input"
                placeholder="Paste a YouTube, Vimeo, Twitch or video link"
                value={urlInput}
                onChange={(e) => {
                  setUrlInput(e.target.value);
                  if (inputError) setInputError('');
                }}
              />
              {urlInput && (
                <button type="button" className="yt-clear-btn" onClick={() => setUrlInput('')} aria-label="Clear link">
                  &times;
                </button>
              )}
            </div>
            <button type="submit" className="yt-hero-load-btn" title="Starts for everyone in the room">
              <span>{isResolving ? 'Checking…' : 'Play for everyone'}</span>
            </button>
          </form>
          {inputError && <div className="yt-url-error">{inputError}</div>}
          <p className="rd-drop-hint">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
            {isDropOver ? 'Drop to play it for everyone' : 'or drop a video file anywhere here ·'}
            {!isDropOver && (
              <>
                <button type="button" className="rd-inline-link" onClick={() => localFileInputRef.current?.click()}>browse files</button>
                <span className="rd-drop-types">MP4, MKV, WebM</span>
                {typeof onStartScreenShare === 'function' && (
                  <>
                    <span>·</span>
                    <button type="button" className="rd-inline-link" onClick={onStartScreenShare}>share screen</button>
                  </>
                )}
              </>
            )}
          </p>
          <input
            ref={localFileInputRef}
            type="file"
            accept="video/*,.mkv,.mp4,.webm,.mov,.avi,.m4v"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onLocalFileSelect?.(f);
              e.target.value = '';
            }}
          />
        </div>
        </div>

        {/* Quick picks: groups, categories and a thumbnail grid */}
        <QuickPicksBrowser
          onPlay={(v) => {
            setInputError('');
            onVideoChange(v.id, v.title);
            onBroadcastAction('load', { newVideoId: v.id, title: v.title });
          }}
          onShuffle={handleSelectPreset}
          onQueue={typeof onAddToQueue === 'function' ? (v) => onAddToQueue({ videoId: v.id, title: v.title }, { autoplay: false }) : undefined}
          queuedIds={queue.map((item) => item.videoId).filter((id): id is string => Boolean(id))}
          queueCount={queue.length}
          onPlayQueue={typeof onPlayNextInQueue === 'function' ? onPlayNextInQueue : undefined}
        />
      </div>
    </div>
  );
}
