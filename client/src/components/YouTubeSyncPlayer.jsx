import React, { useState, useEffect, useRef } from 'react';
import { findQuickPickTitle, getQuickPicks, isVideoUnavailable, markVideoUnavailable } from '../utils/quickPicks';
import QuickPicksBrowser from './QuickPicksBrowser';
import { resolvePastedLink } from '../features/media/resolveLink';

// (Moved to utils/youtubeId.js so plain modules and tests can use it)
import { extractYouTubeId } from '../utils/youtubeId';
import { useAudioDucking } from '../features/audio/useAudioDucking';
export { extractYouTubeId };

export function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export async function fetchYouTubeTitle(videoId, fallbackTitle = '') {
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
  } catch (e) {
    // Ignore timeout or network errors
  }
  // Fallback to presets if matched
  const presetTitle = findQuickPickTitle(videoId);
  if (presetTitle) return presetTitle;
  return fallbackTitle || `YouTube Video (${videoId})`;
}

export { isVideoUnavailable };

/** The next quick pick after `videoId` in its category that hasn't failed, or null. */
function nextPlayablePreset(videoId) {
  const category = getQuickPicks().find((c) => c.videos.some((v) => v.id === videoId));
  if (!category) return null;
  const start = category.videos.findIndex((v) => v.id === videoId);
  for (let step = 1; step < category.videos.length; step += 1) {
    const candidate = category.videos[(start + step) % category.videos.length];
    if (!isVideoUnavailable(candidate.id)) return candidate;
  }
  return null;
}

export default function YouTubeSyncPlayer({
  videoId,
  activeVideoTitle = '',
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
  onOpenQueue,
  onPlayLink,   // a pasted Vimeo / Twitch / video-file link: play for everyone
  onQueueLink   // ...or add it to the queue
}) {
  const [urlInput, setUrlInput] = useState('');
  const [playerReady, setPlayerReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState('Ready');
  const [inputError, setInputError] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [volume, setVolume] = useState(100);
  const [isMuted, setIsMuted] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hoverPreview, setHoverPreview] = useState(null);
  const [isDropOver, setIsDropOver] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [showTopControls, setShowTopControls] = useState(true);
  const idleTimerRef = useRef(null);

  // Phase 3: Intelligent Dialogue Ducking (reduces volume by ~18 dB when peers speak)
  const duckingFactor = useAudioDucking(Boolean(videoId));
  useEffect(() => {
    if (!playerRef.current || isMuted) return;
    const effectiveVol = Math.round(volume * duckingFactor);
    playerRef.current.setVolume?.(effectiveVol);
  }, [duckingFactor, volume, isMuted]);

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

  const playerRef = useRef(null);
  const fullstageRef = useRef(null);
  const iframeContainerRef = useRef(null);
  const scrubberRef = useRef(null);
  const settingsRef = useRef(null);
  const localFileInputRef = useRef(null);
  const isRemoteActionRef = useRef(false);
  // State changes the player is about to report because of something we told it to do (a peer's
  // command, or our own buttons, which broadcast themselves). Only those are skipped: anything
  // else is a person using the player and is sent to the room. (Skipping every change for a while
  // used to also skip updating lastStateRef, so after a peer's play/pause our own next
  // pause/play looked like "no change" and was never sent.)
  // `final` is where the command ends up (e.g. PLAYING after a play); once it arrives nothing more
  // is skipped, so a person acting right after a peer's command is still sent to the room
  const echoRef = useRef({ states: null, final: null, until: 0 });
  const expectEcho = (states, ms = 1500, final = null) => {
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
  const currentVideoIdRef = useRef(videoId);
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
        } catch (e) { }
        playerRef.current = null;
      }
      setPlayerReady(false);
      setIsPlaying(false);
      setCurrentTimeSec(0);
      setDurationSec(0);
      durationSecRef.current = 0;
      return;
    }

    let checkInterval = null;

    const initPlayer = () => {
      if (!window.YT || !window.YT.Player) return false;
      const container = iframeContainerRef.current || document.querySelector('.yt-stage-canvas-viewport');
      if (!container) return false;

      // Always clean up existing instance to guarantee controls: 0 is strictly applied
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        try {
          playerRef.current.destroy();
        } catch (e) { }
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
        playerRef.current = new window.YT.Player(element, {
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
            onReady: (e) => {
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
              } catch (err) { }
            },
            onStateChange: handlePlayerStateChange,
            onError: (e) => handlePlayerErrorRef.current?.(e.data, playerVideoId)
          }
        });
        return true;
      } catch (err) {
        return false;
      }
    };

    if (!initPlayer()) {
      checkInterval = setInterval(() => {
        if (initPlayer()) {
          clearInterval(checkInterval);
        }
      }, 200);
    }

    return () => {
      if (checkInterval) clearInterval(checkInterval);
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
        } catch (e) { }
        playerRef.current = null;
      }
    };
  }, []);

  // 4. Handle local player state changes and broadcast to peers
  const handlePlayerStateChange = (event) => {
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

    if (state === window.YT.PlayerState.PLAYING && lastStateRef.current !== window.YT.PlayerState.PLAYING) {
      setSyncStatus('Playing (Synced)');
      setIsPlaying(true);
      if (isP2PConnected) {
        onBroadcastAction('play', { currentTime: curTime });
      }
    } else if (state === window.YT.PlayerState.PAUSED && lastStateRef.current !== window.YT.PlayerState.PAUSED) {
      setSyncStatus('Paused (Synced)');
      setIsPlaying(false);
      if (isP2PConnected) {
        onBroadcastAction('pause', { currentTime: curTime });
      }
    } else if (state === window.YT.PlayerState.ENDED) {
      setSyncStatus('Video finished');
      setIsPlaying(false);
      if (typeof onPlayNextInQueue === 'function') {
        onPlayNextInQueue({ auto: true });
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
      } catch (e) { }
    }, 350);

    return () => clearInterval(interval);
  }, [playerReady, isP2PConnected, onBroadcastAction]);

  // 6. Handle incoming remote sync actions from peers
  useEffect(() => {
    if (!remoteAction) return;
    const { action, currentTime, newVideoId, videoId: actionVideoId } = remoteAction;
    const targetVideoId = newVideoId || actionVideoId;

    if (action === 'close' || action === 'unload') {
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        try {
          playerRef.current.destroy();
        } catch (e) { }
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
    } catch (err) {
      // Failed to apply remote action
    } finally {
      setTimeout(() => {
        isRemoteActionRef.current = false;
      }, 1200);
    }
  }, [remoteAction]);

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

  // Click outside listener for Settings Menu
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showSettings && settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSettings]);

  // Keyboard hotkeys (Space to toggle, M to mute, F to fullscreen, Left/Right to seek)
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) {
        return;
      }

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        handleTogglePlayPause();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        toggleMute();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleSeekDelta(-5);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleSeekDelta(5);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, isMuted, volume, durationSec]);

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

  const handleLoadUrl = async (e) => {
    if (e) e.preventDefault();
    const res = await resolveInput();
    if (!res) return;
    if (res.kind === 'media') {
      onPlayLink?.(res.media);
      return;
    }
    onVideoChange(res.videoId, res.title);
    onBroadcastAction('load', { newVideoId: res.videoId, title: res.title });
  };

  const handleQueueUrl = async (e) => {
    if (e) e.preventDefault();
    const res = await resolveInput();
    if (!res) return;
    if (res.kind === 'media') onQueueLink?.(res.media);
    else if (typeof onAddToQueue === 'function') onAddToQueue({ videoId: res.videoId, title: res.title });
  };

  // YouTube refused the video (100: removed or private; 101/150: owner blocks other sites, or it's
  // blocked in this region / age-restricted). Skip to the next queued video, or the next working
  // quick pick in the same category, instead of leaving everyone on "Video unavailable".
  const handlePlayerErrorRef = useRef(null);
  handlePlayerErrorRef.current = (code, failedId) => {
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

  const handleSelectPreset = (category) => {
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

  // 8. Playback & Player Controls
  const handleTogglePlayPause = () => {
    if (!playerRef.current) return;
    const cur = playerRef.current.getCurrentTime?.() || 0;
    const state = playerRef.current.getPlayerState?.();

    if (state === 1) {
      isRemoteActionRef.current = true;
      expectEcho([2], 1500, 2);
      playerRef.current.pauseVideo?.();
      setIsPlaying(false);
      setTimeout(() => { isRemoteActionRef.current = false; }, 800);
      onBroadcastAction('pause', { currentTime: cur });
      setSyncStatus('Paused (Synced)');
    } else {
      isRemoteActionRef.current = true;
      expectEcho([1, 3], 1500, 1);
      playerRef.current.playVideo?.();
      setIsPlaying(true);
      setTimeout(() => { isRemoteActionRef.current = false; }, 800);
      onBroadcastAction('play', { currentTime: cur });
      setSyncStatus('Playing (Synced)');
    }
  };

  const handleSeekDelta = (deltaSec) => {
    if (!playerRef.current || typeof playerRef.current.getCurrentTime !== 'function') return;
    const cur = playerRef.current.getCurrentTime();
    const target = Math.max(0, cur + deltaSec);
    isRemoteActionRef.current = true;
    expectSeekEcho();
    playerRef.current.seekTo(target, true);
    lastReportedTimeRef.current = target;
    setCurrentTimeSec(target);
    setTimeout(() => { isRemoteActionRef.current = false; }, 800);
    onBroadcastAction('seek', { currentTime: target });
    setSyncStatus(`Seeked ${deltaSec > 0 ? `+${deltaSec}s` : `${deltaSec}s`} (Synced)`);
  };

  const handleRestart = () => {
    if (!playerRef.current) return;
    isRemoteActionRef.current = true;
    expectSeekEcho();
    playerRef.current.seekTo(0, true);
    lastReportedTimeRef.current = 0;
    setCurrentTimeSec(0);
    setTimeout(() => { isRemoteActionRef.current = false; }, 800);
    onBroadcastAction('seek', { currentTime: 0 });
    setSyncStatus('Restarted video (Synced)');
  };

  const handleForceSync = () => {
    if (!playerRef.current) return;
    const cur = playerRef.current.getCurrentTime?.() || 0;
    const state = playerRef.current.getPlayerState?.();
    const action = state === 1 ? 'play' : 'pause';
    onBroadcastAction(action, { currentTime: cur });
    setSyncStatus('Sent sync pulse to all peers');
  };

  const handleCloseVideo = () => {
    if (playerRef.current) {
      try {
        if (typeof playerRef.current.stopVideo === 'function') {
          playerRef.current.stopVideo();
        }
        if (typeof playerRef.current.destroy === 'function') {
          playerRef.current.destroy();
        }
      } catch (e) { }
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
    onBroadcastAction('close', {});
  };

  const handleVolumeChange = (e) => {
    const val = Number(e.target.value);
    setVolume(val);
    if (val === 0) {
      setIsMuted(true);
      playerRef.current?.mute?.();
    } else {
      if (isMuted) {
        setIsMuted(false);
        playerRef.current?.unMute?.();
      }
      playerRef.current?.setVolume?.(val);
    }
  };

  const toggleMute = () => {
    if (!playerRef.current) {
      setIsMuted(!isMuted);
      return;
    }
    if (isMuted) {
      playerRef.current.unMute?.();
      setIsMuted(false);
      if (volume === 0) {
        setVolume(80);
        playerRef.current.setVolume?.(80);
      }
    } else {
      playerRef.current.mute?.();
      setIsMuted(true);
    }
  };

  const toggleFullscreen = () => {
    const container = fullstageRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      if (container.requestFullscreen) {
        container.requestFullscreen();
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  const handleSetPlaybackRate = (rate) => {
    setPlaybackRate(rate);
    if (playerRef.current?.setPlaybackRate) {
      playerRef.current.setPlaybackRate(rate);
    }
    setShowSettings(false);
    setSyncStatus(`Speed: ${rate}x`);
  };

  // 9. Interactive Scrubber Seek Logic
  const calculateTimeFromEvent = (e) => {
    if (!scrubberRef.current || !durationSec || durationSec <= 0) return 0;
    const rect = scrubberRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * durationSec;
  };

  const handleScrubberMouseDown = (e) => {
    if (!durationSec || durationSec <= 0) return;
    isScrubbingRef.current = true;
    const targetTime = calculateTimeFromEvent(e);
    setCurrentTimeSec(targetTime);

    if (playerRef.current?.seekTo) {
      isRemoteActionRef.current = true;
      expectSeekEcho(60000); // until mouse up
      playerRef.current.seekTo(targetTime, true);
      lastReportedTimeRef.current = targetTime;
    }

    const handleMouseMove = (moveEvt) => {
      if (!isScrubbingRef.current) return;
      const time = calculateTimeFromEvent(moveEvt);
      setCurrentTimeSec(time);
      if (playerRef.current?.seekTo) {
        playerRef.current.seekTo(time, true);
        lastReportedTimeRef.current = time;
      }
    };

    const handleMouseUp = (upEvt) => {
      if (!isScrubbingRef.current) return;
      isScrubbingRef.current = false;
      const finalTime = calculateTimeFromEvent(upEvt);
      setCurrentTimeSec(finalTime);
      if (playerRef.current?.seekTo) {
        playerRef.current.seekTo(finalTime, true);
        lastReportedTimeRef.current = finalTime;
      }
      setTimeout(() => { isRemoteActionRef.current = false; }, 800);
      expectSeekEcho();
      if (isP2PConnected) {
        onBroadcastAction('seek', { currentTime: finalTime });
      }
      setSyncStatus(`Seeked to ${formatTime(finalTime)} (Synced)`);

      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleMouseMove);
      window.removeEventListener('touchend', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('touchmove', handleMouseMove);
    window.addEventListener('touchend', handleMouseUp);
  };

  const handleScrubberMouseMove = (e) => {
    if (!scrubberRef.current || !durationSec || durationSec <= 0) return;
    const rect = scrubberRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverPreview({ time: ratio * durationSec, percent: ratio * 100 });
  };

  const handleScrubberMouseLeave = () => {
    setHoverPreview(null);
  };

  const progressPercent = durationSec > 0 ? Math.min(100, Math.max(0, (currentTimeSec / durationSec) * 100)) : 0;
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

              {/* Exit video button removed: Header provides global Exit Video button */}
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
  const onDragOver = (e) => {
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
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setIsDropOver(false); }}
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
          queuedIds={queue.map((item) => item.videoId)}
          queueCount={queue.length}
          onPlayQueue={typeof onPlayNextInQueue === 'function' ? onPlayNextInQueue : undefined}
        />
      </div>
    </div>
  );
}
