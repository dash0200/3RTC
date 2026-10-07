import React, { useState, useEffect, useRef } from 'react';

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
  for (const cat of PRESET_CATEGORIES) {
    const found = cat.videos.find((v) => v.id === videoId);
    if (found) return found.title;
  }
  return fallbackTitle || `YouTube Video (${videoId})`;
}

export const PRESET_CATEGORIES = [
  {
    id: 'lofi',
    name: '🎵 Lofi Beats',
    videos: [
      { id: 'lTRiuFIWV54', title: '1 A.M. Study Session (Lofi Girl)' },
      { id: 'n61ULEU7CO0', title: 'Best of Lofi Hip Hop' },
      { id: 'a5sdsbGKz8U', title: 'Lofi Hip Hop Mix' },
      { id: '_tV5LEBDs7w', title: 'Cozy Winter Lofi' }
    ]
  },
  {
    id: 'synthwave',
    name: '🌆 Synthwave',
    videos: [
      { id: 'b4N4q-y-L04', title: 'Night Drive (NewRetroWave)' },
      { id: 'B_9H4o4j16Q', title: "After School '89 Chillwave" },
      { id: 'g4H51H-pY6k', title: 'Space Trip Synthwave Mix' },
      { id: 'F3QYt1l_Mog', title: '1991 Interface Never Sleeps' }
    ]
  },
  {
    id: 'bunny',
    name: '🎬 Big Buck Bunny',
    videos: [
      { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny (4K 60fps)' },
      { id: 'R6MlUcmOul8', title: 'Tears of Steel (Blender Sci-Fi)' },
      { id: '41hv2tW5Lc4', title: 'Spring (Blender Open Movie)' }
    ]
  },
  {
    id: 'space',
    name: '🌌 Space Ambient',
    videos: [
      { id: '1ZYbU82GVz4', title: 'Deep Space Cosmic Relaxation' },
      { id: 'yE-n7rC_cT4', title: 'Starfield Space Ambient' },
      { id: 'n5Xv_Jz-1_k', title: 'Stargazing Space Ambient' },
      { id: 'N66f6Q7LpSc', title: 'Stillness Space Ambient' }
    ]
  },
  {
    id: 'cyberpunk',
    name: '⚡ Cyberpunk Radio',
    videos: [
      { id: 'f02mOEt11OQ', title: 'Code-Fi Lofi Beats' },
      { id: 'vV95-9b2sR0', title: 'CircuitsFM Cyberpunk Radio' },
      { id: 'k3A-3g8sZ6M', title: 'NewRetroWave Radio' }
    ]
  }
];

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
  const [isDropOver, setIsDropOver] = useState(false);

  const playerRef = useRef(null);
  const localFileInputRef = useRef(null);
  const isRemoteActionRef = useRef(false);
  const lastStateRef = useRef(-1);
  const lastReportedTimeRef = useRef(0);
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
      return;
    }

    let checkInterval = null;

    const initPlayer = () => {
      if (!window.YT || !window.YT.Player) return false;
      const element = document.getElementById('yt-iframe-placeholder');
      if (!element) return false;

      // If player already exists, load the new video directly
      if (playerRef.current && typeof playerRef.current.loadVideoById === 'function') {
        isRemoteActionRef.current = true;
        playerRef.current.loadVideoById(videoId);
        setSyncStatus('Loaded new video');
        setTimeout(() => {
          isRemoteActionRef.current = false;
        }, 1200);
        return true;
      }

      try {
        playerRef.current = new window.YT.Player('yt-iframe-placeholder', {
          videoId: videoId,
          playerVars: {
            autoplay: 1,
            enablejsapi: 1,
            origin: window.location.origin,
            rel: 0,
            modestbranding: 1
          },
          events: {
            onReady: (e) => {
              setPlayerReady(true);
              setSyncStatus('Synced with peers');
              try {
                e.target.playVideo();
                setIsPlaying(true);
              } catch (err) { }
            },
            onStateChange: handlePlayerStateChange,
            onError: (e) => {
              let msg = 'Video playback error';
              if (e.data === 101 || e.data === 150) {
                msg = 'Embedding disabled by video owner';
              } else if (e.data === 100) {
                msg = 'Video not found or removed';
              }
              setSyncStatus(msg);
            }
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

    // Ignore state changes triggered programmatically by incoming remote actions
    if (isRemoteActionRef.current) {
      return;
    }

    const curTime = typeof playerRef.current.getCurrentTime === 'function'
      ? playerRef.current.getCurrentTime()
      : 0;
    lastReportedTimeRef.current = curTime;
    setCurrentTimeSec(curTime);

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

  // 5. Polling interval to detect manual timeline scrubbing (seeking) inside YouTube player
  useEffect(() => {
    if (!playerReady) return;
    const interval = setInterval(() => {
      if (!playerRef.current || isRemoteActionRef.current) return;
      try {
        if (typeof playerRef.current.getCurrentTime !== 'function') return;
        const curTime = playerRef.current.getCurrentTime();
        const state = playerRef.current.getPlayerState?.();

        setCurrentTimeSec(curTime);
        if (state === 1) setIsPlaying(true);
        else if (state === 2) setIsPlaying(false);

        // If time jumped forward or backward by > 2.0s without remote action
        const delta = Math.abs(curTime - lastReportedTimeRef.current);
        if (lastReportedTimeRef.current > 0 && delta > 2.2 && (state === 1 || state === 2 || state === 3)) {
          if (isP2PConnected) {
            onBroadcastAction('seek', { currentTime: curTime });
          }
          setSyncStatus(`Seeked to ${formatTime(curTime)} (Synced)`);
        }
        lastReportedTimeRef.current = curTime;
      } catch (e) { }
    }, 400);

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
      setSyncStatus('Ready');
      currentVideoIdRef.current = null;
      onVideoChange(null);
      return;
    }

    if (!playerRef.current) return;

    isRemoteActionRef.current = true;

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

  // 7. Load or Queue YouTube URL
  const handleLoadUrl = async (e) => {
    if (e) e.preventDefault();
    const id = extractYouTubeId(urlInput);
    if (!id) {
      setInputError('Please enter a valid YouTube link (e.g., https://www.youtube.com/watch?v=...) or 11-char ID');
      return;
    }
    setInputError('');
    const inputVal = urlInput;
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

  const handleSelectPreset = (category) => {
    setInputError('');
    const pool = category.videos;
    if (!pool || pool.length === 0) return;

    // Filter out the currently active video ID if pool has more than 1 video,
    // so it always chooses a fresh/different track every time!
    const activeId = currentVideoIdRef.current || videoId;
    const available = pool.filter((v) => v.id !== activeId);
    const candidateList = available.length > 0 ? available : pool;
    const randomChoice = candidateList[Math.floor(Math.random() * candidateList.length)];

    onVideoChange(randomChoice.id, randomChoice.title);
    onBroadcastAction('load', { newVideoId: randomChoice.id, title: randomChoice.title });
  };

  // 8. Manual UI Controls
  const handleTogglePlayPause = () => {
    if (!playerRef.current) return;
    const cur = playerRef.current.getCurrentTime?.() || 0;
    const state = playerRef.current.getPlayerState?.();

    if (state === 1) {
      // Pause
      isRemoteActionRef.current = true;
      playerRef.current.pauseVideo?.();
      setIsPlaying(false);
      setTimeout(() => { isRemoteActionRef.current = false; }, 800);
      onBroadcastAction('pause', { currentTime: cur });
      setSyncStatus('Paused (Synced)');
    } else {
      // Play
      isRemoteActionRef.current = true;
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
    setSyncStatus('Ready');
    currentVideoIdRef.current = null;
    onVideoChange(null);
    onBroadcastAction('close', {});
  };

  const totalParticipants = peerCount + 1;
  const requiredVotes = totalParticipants <= 2 ? totalParticipants : Math.ceil(totalParticipants / 2);
  const hasVotedSkip = skipVotes.includes(username);

  if (videoId) {
    return (
      <div className="yt-fullstage-player">
        {/* Compact Top Bar to switch URL or monitor sync */}
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
              Load for All
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
            <div className={`yt-sync-pill ${isPlaying ? 'playing' : 'paused'}`}>
              <span className="yt-sync-dot"></span>
              <span>{syncStatus}</span>
            </div>
            <span className="yt-time-display">{formatTime(currentTimeSec)}</span>

            <div className="yt-controls-toolbar">
              <button
                type="button"
                className="yt-ctrl-btn"
                onClick={handleTogglePlayPause}
                title={isPlaying ? 'Pause for all' : 'Play for all'}
              >
                {isPlaying ? (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
                <span>{isPlaying ? 'Pause' : 'Play'}</span>
              </button>

              <button
                type="button"
                className="yt-ctrl-btn"
                onClick={() => handleSeekDelta(-5)}
                title="Seek back 5 seconds for all"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z" />
                </svg>
                <span>-5s</span>
              </button>

              <button
                type="button"
                className="yt-ctrl-btn"
                onClick={() => handleSeekDelta(5)}
                title="Seek forward 5 seconds for all"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
                </svg>
                <span>+5s</span>
              </button>

              <button
                type="button"
                className="yt-ctrl-btn"
                onClick={handleRestart}
                title="Restart video from 0:00 for all"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                </svg>
                <span>Restart</span>
              </button>

              <button
                type="button"
                className="yt-ctrl-btn sync-btn"
                onClick={handleForceSync}
                title="Force broadcast sync timestamp to all peers"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
                </svg>
                <span>Sync Now</span>
              </button>

              {/* Next in Queue */}
              <button
                type="button"
                className={`yt-ctrl-btn next-queue-btn ${queue.length > 0 ? 'has-items' : ''}`}
                onClick={onPlayNextInQueue}
                disabled={queue.length === 0}
                title={queue.length > 0 ? `Play next queued: "${queue[0].title}"` : 'Queue is empty'}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
                <span>Next ({queue.length})</span>
              </button>

              {/* Vote to Skip */}
              <button
                type="button"
                className={`yt-ctrl-btn vote-skip-btn ${hasVotedSkip ? 'voted' : ''}`}
                onClick={onVoteSkip}
                title={hasVotedSkip ? 'You voted to skip (click to unvote)' : `Vote to skip (${skipVotes.length}/${requiredVotes} votes needed)`}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                  <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
                </svg>
                <span>{hasVotedSkip ? 'Voted' : 'Skip'} ({skipVotes.length}/{requiredVotes})</span>
              </button>

              {/* Open Queue in Sidebar Shortcut */}
              {typeof onOpenQueue === 'function' && (
                <button
                  type="button"
                  className="yt-ctrl-btn queue-drawer-btn"
                  onClick={onOpenQueue}
                  title="View and edit queue in sidebar"
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                    <path d="M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z" />
                  </svg>
                  <span>Queue {queue.length > 0 ? `(${queue.length})` : ''}</span>
                </button>
              )}

              <button
                type="button"
                className="yt-ctrl-btn exit-video-btn"
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
        </div>

        {/* Full Stage Video Viewport occupying the entire stageCanvas */}
        <div className="yt-stage-canvas-viewport">
          <div id="yt-iframe-placeholder"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="yt-sync-wrapper">
      <div className="yt-screen-card">
        {/* Center Hero Card */}
        <div className="yt-hero-center">
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

          {/* Quick Presets Row */}
          <div className="yt-hero-presets-row">
            <span className="yt-hero-presets-tag">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="#f59e0b">
                <path d="M7 2v11h3v9l7-12h-4l4-8z" />
              </svg>
              Quick Watch
            </span>
            {PRESET_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className="yt-hero-preset-btn"
                onClick={() => handleSelectPreset(cat)}
                title={`Play ${cat.name}`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>

        {/* Bottom Scrubber & Controls Bar */}
        <div className="yt-screen-controls-bar">
          <div className="yt-screen-ctrls-left">
            <button type="button" className="yt-screen-ctrl-icon" disabled title="Play">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
            <button type="button" className="yt-screen-ctrl-icon" disabled title="Next">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </button>
            <button type="button" className="yt-screen-ctrl-icon" disabled title="Volume">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
              </svg>
            </button>
          </div>

          <div className="yt-screen-scrubber-track">
            <div className="yt-screen-scrubber-fill" style={{ width: '18%' }} />
            <div className="yt-screen-scrubber-thumb" style={{ left: '18%' }} />
          </div>

          <div className="yt-screen-ctrls-right">
            <span className="yt-screen-time-text">0:00 / 0:00</span>
            <button type="button" className="yt-screen-ctrl-icon" disabled title="Settings">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
            </button>
            <button type="button" className="yt-screen-ctrl-icon" disabled title="Theater Mode">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.89-2-2-2zm0 14H5V6h14v12z" />
              </svg>
            </button>
            <button type="button" className="yt-screen-ctrl-icon" disabled title="Fullscreen">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
