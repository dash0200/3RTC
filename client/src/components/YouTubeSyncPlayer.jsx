import React, { useState, useEffect, useRef } from 'react';
import { findQuickPickTitle, getQuickPicks, isVideoUnavailable, markVideoUnavailable } from '../utils/quickPicks';
import QuickPicksBrowser from './QuickPicksBrowser';

// Extract YouTube ID from various URL formats or raw 11-char ID
export function extractYouTubeId(urlOrId) {
  if (!urlOrId) return null;
  const trimmed = urlOrId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/live\/|youtube\.com\/shorts\/)([^"&?\/\s]{11})/i;
  const match = trimmed.match(regex);
  return match ? match[1] : null;
}

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
  onOpenQueue
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
  const [activeSourceTab, setActiveSourceTab] = useState('youtube'); // 'youtube' | 'local'

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
  const echoRef = useRef({ states: null, until: 0 });
  const expectEcho = (states, ms = 1500) => {
    echoRef.current = { states: new Set(states), until: Date.now() + ms };
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
          isPlaying: state === 1
        };
      });
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
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        try {
          playerRef.current.destroy();
        } catch (e) { }
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
        onPlayNextInQueue();
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
    if (action === 'load') expectEcho([YTS.UNSTARTED, YTS.BUFFERING, YTS.PLAYING, YTS.CUED, YTS.PAUSED], 3000);
    else if (action === 'play') expectEcho([YTS.PLAYING, YTS.BUFFERING]);
    else if (action === 'pause') expectEcho([YTS.PAUSED, YTS.BUFFERING]);
    else if (action === 'seek') expectEcho([YTS.PLAYING, YTS.PAUSED, YTS.BUFFERING]);

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

  // 7. Load or Queue YouTube URL
  const handleLoadUrl = async (e) => {
    if (e) e.preventDefault();
    const id = extractYouTubeId(urlInput);
    if (!id) {
      setInputError('Please enter a valid YouTube link (e.g., https://www.youtube.com/watch?v=...) or 11-char ID');
      return;
    }
    setInputError('');
    setUrlInput('');
    const title = await fetchYouTubeTitle(id);
    onVideoChange(id, title);
    onBroadcastAction('load', { newVideoId: id, title });
  };

  const handleQueueUrl = async (e) => {
    if (e) e.preventDefault();
    const id = extractYouTubeId(urlInput);
    if (!id) {
      setInputError('Please enter a valid YouTube link (e.g., https://www.youtube.com/watch?v=...) or 11-char ID');
      return;
    }
    setInputError('');
    setUrlInput('');
    if (typeof onAddToQueue === 'function') {
      const title = await fetchYouTubeTitle(id);
      onAddToQueue({ videoId: id, title });
    }
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
      onPlayNextInQueue();
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
      expectEcho([2]);
      playerRef.current.pauseVideo?.();
      setIsPlaying(false);
      setTimeout(() => { isRemoteActionRef.current = false; }, 800);
      onBroadcastAction('pause', { currentTime: cur });
      setSyncStatus('Paused (Synced)');
    } else {
      isRemoteActionRef.current = true;
      expectEcho([1, 3]);
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
    expectEcho([1, 2, 3]);
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
    expectEcho([1, 2, 3]);
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
      expectEcho([1, 2, 3], 60000); // until mouse up
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
      expectEcho([1, 2, 3]);
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
      >
        {/* Sleek, Clean Top Bar */}
        <div className="yt-stage-topbar">
          <form className="yt-stage-url-form" onSubmit={handleLoadUrl}>
            <div className="yt-input-wrapper compact">
              <svg className="yt-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="#FF0033">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
              </svg>
              <input
                type="text"
                className="yt-url-input"
                placeholder="Paste new YouTube link or ID..."
                value={urlInput}
                onChange={(e) => {
                  setUrlInput(e.target.value);
                  if (inputError) setInputError('');
                }}
              />
              {urlInput && (
                <button
                  type="button"
                  className="yt-clear-btn"
                  onClick={() => setUrlInput('')}
                  title="Clear input"
                >
                  &times;
                </button>
              )}
            </div>
            <button type="submit" className="btn btn-primary yt-load-btn compact" title="Play immediately for all">
              Load
            </button>
            <button
              type="button"
              className="btn btn-secondary yt-queue-add-btn compact"
              onClick={handleQueueUrl}
              title="Add to shared collaborative queue"
            >
              + Queue
            </button>
          </form>

          <div className="yt-stage-top-controls">
            {activeVideoTitle && (
              <span className="yt-active-title" title={activeVideoTitle}>
                {activeVideoTitle}
              </span>
            )}

            <div className={`yt-sync-pill ${isPlaying ? 'playing' : 'paused'}`}>
              <span className="yt-sync-dot"></span>
              <span>{syncStatus}</span>
            </div>

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

            {/* Exit video button */}
            <button
              type="button"
              className="yt-ctrl-btn exit-video-btn compact"
              onClick={handleCloseVideo}
              title="Exit video and return to watch party stage"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
              <span>Exit</span>
            </button>
          </div>
        </div>

        {/* Video Viewport occupying full space */}
        <div className="yt-stage-canvas-viewport" ref={iframeContainerRef}>
          <div id="yt-iframe-placeholder"></div>
        </div>

      </div>
    );
  }

  // CASE 2: Idle Screen (Lobby / Presets)
  return (
    <div className="yt-screen-card" ref={fullstageRef}>
      {/* Center Hero Card */}
      <div className="yt-hero-center">
        {/* Source Selector Tabs: YouTube & Local Video */}
        <div className="stage-source-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeSourceTab === 'youtube'}
            className={`stage-source-tab ${activeSourceTab === 'youtube' ? 'active tab-yt' : ''}`}
            onClick={() => setActiveSourceTab('youtube')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
            <span>YouTube Video</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSourceTab === 'local'}
            className={`stage-source-tab ${activeSourceTab === 'local' ? 'active tab-local' : ''}`}
            onClick={() => setActiveSourceTab('local')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z" />
            </svg>
            <span>Local Video File</span>
          </button>
        </div>

        {activeSourceTab === 'youtube' ? (
          <>
            <div className="yt-hero-icon-box">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="#ffffff">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <h2 className="yt-hero-title">P2P Synchronized YouTube Watch Party</h2>
            <p className="yt-hero-subtitle">
              Paste any YouTube link or select a quick watch preset. The video will immediately load for all peers, and <strong>Play, Pause &amp; Seek</strong> will stay synchronized in real time.
            </p>

            {/* Clean URL Input Bar */}
            <form className="yt-hero-form" onSubmit={handleLoadUrl}>
              <div className="yt-hero-input-wrap">
                <div className="yt-hero-input-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="#FF0033">
                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                  </svg>
                </div>
                <input
                  type="text"
                  className="yt-hero-input"
                  placeholder="Paste YouTube link (e.g. https://www.youtube.com/watch?v=...) or ID"
                  value={urlInput}
                  onChange={(e) => {
                    setUrlInput(e.target.value);
                    if (inputError) setInputError('');
                  }}
                />
                {urlInput && (
                  <button
                    type="button"
                    className="yt-clear-btn"
                    onClick={() => setUrlInput('')}
                    title="Clear input"
                  >
                    &times;
                  </button>
                )}
              </div>
              <button type="submit" className="yt-hero-load-btn" title="Play immediately for all">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Load for All</span>
              </button>
            </form>
            {inputError && <div className="yt-url-error">{inputError}</div>}

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
          </>
        ) : (
          <>
            <div className="yt-hero-icon-box local">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="#ffffff">
                <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z" />
              </svg>
            </div>
            <h2 className="yt-hero-title">P2P Synchronized Local Video Watch Party</h2>
            <p className="yt-hero-subtitle">
              Play your own local <strong>.mp4, .mkv, .webm, or .mov</strong> files with zero server upload. Peers directly sync playback in real time or stream P2P.
            </p>

            {/* Local Video Dropzone & Browse Button */}
            <div
              className={`yt-hero-local-dropzone ${isDropOver ? 'drag-over' : ''}`}
              onClick={() => localFileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDropOver(true); }}
              onDragLeave={() => setIsDropOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDropOver(false);
                const files = e.dataTransfer?.files;
                if (files && files.length > 0) {
                  onLocalFileSelect?.(files[0]);
                }
              }}
            >
              <div className="local-drop-cloud-icon">
                <svg viewBox="0 0 24 24" width="38" height="38" fill="currentColor">
                  <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
                </svg>
              </div>
              <div className="local-drop-text-group">
                <div className="local-drop-main-text">
                  <span>Click to Select Video</span> or Drag &amp; Drop Here
                </div>
                <div className="local-drop-sub-text">
                  Supports MP4, MKV, WebM, MOV • 100% Private Peer-to-Peer
                </div>
              </div>
              <button
                type="button"
                className="btn-browse-file"
                onClick={(e) => {
                  e.stopPropagation();
                  localFileInputRef.current?.click();
                }}
              >
                Browse File
              </button>
            </div>

            <input
              ref={localFileInputRef}
              type="file"
              accept="video/*,.mkv,.mp4,.webm,.mov,.avi,.m4v"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  onLocalFileSelect?.(f);
                }
                e.target.value = '';
              }}
            />

            <div className="yt-hero-presets-row">
              <span className="yt-hero-presets-tag">⚡ Local Direct</span>
              <span className="yt-hero-info-pill">0 Network Upload</span>
              <span className="yt-hero-info-pill">100% Private Playback</span>
              <span className="yt-hero-info-pill">Subtitles Supported</span>
            </div>
          </>
        )}
      </div>

    </div>
  );
}
