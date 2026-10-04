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
  onVideoChange,
  onBroadcastAction,
  remoteAction,
  isP2PConnected,
  onRegisterStateGetter,
  onLocalFileSelect
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
        } catch (e) {}
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
              } catch (err) {}
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
        } catch (e) {}
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
      } catch (e) {}
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
        } catch (e) {}
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

  // 7. Load new YouTube URL
  const handleLoadUrl = (e) => {
    if (e) e.preventDefault();
    const id = extractYouTubeId(urlInput);
    if (!id) {
      setInputError('Please enter a valid YouTube link (e.g., https://www.youtube.com/watch?v=...) or 11-char ID');
      return;
    }
    setInputError('');
    setUrlInput('');
    onVideoChange(id);
    onBroadcastAction('load', { newVideoId: id });
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

    onVideoChange(randomChoice.id);
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
      } catch (e) {}
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

  if (videoId) {
    return (
      <div className="yt-fullstage-player">
        {/* Compact Top Bar to switch URL or monitor sync */}
        <div className="yt-stage-topbar">
          <form className="yt-stage-url-form" onSubmit={handleLoadUrl}>
            <div className="yt-input-wrapper compact">
              <svg className="yt-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="#FF0033">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
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
            <button type="submit" className="btn btn-primary yt-load-btn compact">
              Load for All
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
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
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
                  <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/>
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
                  <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/>
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
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
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
                  <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
                </svg>
                <span>Sync Now</span>
              </button>

              <button
                type="button"
                className="yt-ctrl-btn exit-video-btn"
                onClick={handleCloseVideo}
                title="Exit video and return to watch party stage"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
                <span>Exit Video</span>
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
      {/* Top Input Bar: YouTube URL Loader */}
      <div className="yt-url-bar">
        <form className="yt-url-form" onSubmit={handleLoadUrl}>
          <div className="yt-input-wrapper">
            <svg className="yt-input-icon" viewBox="0 0 24 24" width="22" height="22" fill="#FF0033">
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
            </svg>
            <input
              type="text"
              className="yt-url-input"
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
          <button type="submit" className="btn btn-primary yt-load-btn">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Load for All
          </button>
        </form>

        {inputError && <div className="yt-url-error">{inputError}</div>}

        {/* Quick Presets */}
        <div className="yt-presets-bar">
          <span className="yt-presets-label" title="Click any category to play a random track from that genre">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style={{ verticalAlign: 'middle', marginRight: 4 }}>
              <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.42l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.12z"/>
            </svg>
            Quick Watch (Random):
          </span>
          {PRESET_CATEGORIES.map((cat) => {
            const isCategoryActive = cat.videos.some((v) => v.id === videoId);
            return (
              <button
                key={cat.id}
                type="button"
                className={`yt-preset-chip ${isCategoryActive ? 'active' : ''}`}
                onClick={() => handleSelectPreset(cat)}
                title={`Play a random ${cat.name} video`}
              >
                {cat.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="lobby-options-container">
        {/* Local Video Drag & Drop Zone */}
        <div
          className={`local-lobby-dropzone ${isDropOver ? 'active' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setIsDropOver(true); }}
          onDragLeave={() => setIsDropOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDropOver(false);
            const dropped = e.dataTransfer?.files?.[0];
            if (dropped && typeof onLocalFileSelect === 'function') {
              onLocalFileSelect(dropped);
            }
          }}
          onClick={() => localFileInputRef.current?.click()}
        >
          <input
            type="file"
            ref={localFileInputRef}
            style={{ display: 'none' }}
            accept="video/*,.mkv,.mp4,.webm,.mov,.avi,.m4v"
            onChange={(e) => {
              const selected = e.target.files?.[0];
              if (selected && typeof onLocalFileSelect === 'function') {
                onLocalFileSelect(selected);
              }
            }}
          />

          <div className="local-drop-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="#3ea6ff">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
            </svg>
          </div>
          <div className="local-drop-content">
            <h3 className="local-drop-title">Drag & Drop Any Local Video (.mp4, .mkv, .webm)</h3>
            <p className="local-drop-subtitle">
              Play local files with <strong>100% privacy & zero bandwidth</strong>. Synced play, pause & seek between all peers.
            </p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm local-browse-btn">
            Browse File
          </button>
        </div>

        {/* YouTube Watch Party Card */}
        <div className="yt-placeholder-card">
          <div className="yt-placeholder-icon">
            <svg viewBox="0 0 24 24" width="36" height="36" fill="#FF0033">
              <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
            </svg>
          </div>
          <h2 className="yt-placeholder-title">P2P Synchronized YouTube Watch Party</h2>
          <p className="yt-placeholder-subtitle">
            Paste any YouTube video link or select a quick watch preset above.
            The video will immediately load for all peers, and <strong>Play, Pause & Seek</strong> will stay synchronized in real time.
          </p>
        </div>
      </div>
    </div>
  );
}
