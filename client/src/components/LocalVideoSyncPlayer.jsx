import React, { useState, useEffect, useRef } from 'react';

export function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) {
    const remMins = mins % 60;
    return `${hrs}:${remMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatFileSize(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function LocalVideoSyncPlayer({
  initialFile = null,
  remoteMeta = null,
  onFileSelect,
  onClose,
  onBroadcastAction,
  remoteAction,
  isP2PConnected,
  onRegisterStateGetter
}) {
  const [file, setFile] = useState(initialFile);
  const [objectUrl, setObjectUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [syncStatus, setSyncStatus] = useState('Ready');
  const [isDragOver, setIsDragOver] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showTopBar, setShowTopBar] = useState(true);
  const [showBottomBar, setShowBottomBar] = useState(true);
  const [isCursorIdle, setIsCursorIdle] = useState(false);

  const videoRef = useRef(null);
  const playerContainerRef = useRef(null);
  const isHoveringTopRef = useRef(false);
  const isHoveringBottomRef = useRef(false);
  const isRemoteActionRef = useRef(false);
  const fileInputRef = useRef(null);
  const idleTimeoutRef = useRef(null);
  const fileRef = useRef(file);
  fileRef.current = file;

  // 1. Create or revoke object URL when local file changes
  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setObjectUrl(url);
      setSyncStatus('Local video ready');
      return () => {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
      };
    } else {
      setObjectUrl(null);
    }
  }, [file]);

  // If initialFile changes from parent
  useEffect(() => {
    if (initialFile && initialFile !== file) {
      setFile(initialFile);
    }
  }, [initialFile]);

  // 2. Register state getter for late-joiner synchronization
  useEffect(() => {
    if (typeof onRegisterStateGetter === 'function') {
      onRegisterStateGetter(() => {
        const vid = videoRef.current;
        return {
          mediaType: 'local',
          fileName: fileRef.current?.name || remoteMeta?.fileName || '',
          fileSize: fileRef.current?.size || remoteMeta?.fileSize || 0,
          currentTime: vid ? vid.currentTime : 0,
          isPlaying: vid ? !vid.paused : false
        };
      });
    }
  }, [onRegisterStateGetter, remoteMeta]);

  // 3. Handle incoming remote sync actions from peers
  useEffect(() => {
    if (!remoteAction) return;
    const { action, currentTime, sender, fileName } = remoteAction;

    if (action === 'close') {
      onClose();
      return;
    }

    const vid = videoRef.current;
    if (!vid) return;

    isRemoteActionRef.current = true;

    try {
      if (action === 'play') {
        setSyncStatus(`▶️ ${sender || 'Peer'} played`);
        if (currentTime !== undefined && Math.abs(vid.currentTime - currentTime) > 0.8) {
          vid.currentTime = currentTime;
        }
        vid.play().then(() => {
          setIsPlaying(true);
        }).catch(() => {
          // Autoplay may await user interaction
        });
      } else if (action === 'pause') {
        setSyncStatus(`⏸️ ${sender || 'Peer'} paused`);
        if (currentTime !== undefined && Math.abs(vid.currentTime - currentTime) > 0.8) {
          vid.currentTime = currentTime;
        }
        vid.pause();
        setIsPlaying(false);
      } else if (action === 'seek') {
        if (currentTime !== undefined) {
          vid.currentTime = currentTime;
          setCurrentTimeSec(currentTime);
          setSyncStatus(`⏩ ${sender || 'Peer'} seeked to ${formatTime(currentTime)}`);
        }
      }
    } catch (err) {
      // Failed to apply remote action
    } finally {
      setTimeout(() => {
        isRemoteActionRef.current = false;
      }, 600);
    }
  }, [remoteAction, onClose]);

  // 4. File drag and drop handlers
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const droppedFile = e.dataTransfer?.files?.[0];
    if (droppedFile) {
      loadNewLocalFile(droppedFile);
    }
  };

  const handleFileInputChange = (e) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      loadNewLocalFile(selectedFile);
    }
  };

  const loadNewLocalFile = (newFile) => {
    setFile(newFile);
    if (typeof onFileSelect === 'function') {
      onFileSelect(newFile);
    }
    // Broadcast to peers that this video file was loaded
    if (typeof onBroadcastAction === 'function') {
      onBroadcastAction('load', {
        type: 'local-video-action',
        fileName: newFile.name,
        fileSize: newFile.size
      });
    }
  };

  // 5. Video event listeners (play, pause, seeked, timeupdate)
  const handleVideoPlay = () => {
    setIsPlaying(true);
    if (isRemoteActionRef.current) return;
    setSyncStatus('Playing (Synced)');
    if (typeof onBroadcastAction === 'function' && videoRef.current) {
      onBroadcastAction('play', {
        type: 'local-video-action',
        currentTime: videoRef.current.currentTime
      });
    }
  };

  const handleVideoPause = () => {
    setIsPlaying(false);
    if (isRemoteActionRef.current) return;
    setSyncStatus('Paused (Synced)');
    if (typeof onBroadcastAction === 'function' && videoRef.current) {
      onBroadcastAction('pause', {
        type: 'local-video-action',
        currentTime: videoRef.current.currentTime
      });
    }
  };

  const handleVideoSeeked = () => {
    if (isRemoteActionRef.current || !videoRef.current) return;
    const cur = videoRef.current.currentTime;
    setSyncStatus(`Seeked to ${formatTime(cur)} (Synced)`);
    if (typeof onBroadcastAction === 'function') {
      onBroadcastAction('seek', {
        type: 'local-video-action',
        currentTime: cur
      });
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTimeSec(videoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDurationSec(videoRef.current.duration || 0);
      setSyncStatus('Ready to play');
    }
  };

  // 6. Manual UI Controls
  const togglePlayPause = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      vid.play().catch(() => {});
    } else {
      vid.pause();
    }
  };

  const handleSeekDelta = (deltaSec) => {
    const vid = videoRef.current;
    if (!vid) return;
    const target = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + deltaSec));
    vid.currentTime = target;
    setCurrentTimeSec(target);
    setSyncStatus(`Seeked ${deltaSec > 0 ? `+${deltaSec}s` : `${deltaSec}s`} (Synced)`);
    if (typeof onBroadcastAction === 'function') {
      onBroadcastAction('seek', {
        type: 'local-video-action',
        currentTime: target
      });
    }
  };

  const handleRestart = () => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.currentTime = 0;
    setCurrentTimeSec(0);
    setSyncStatus('Restarted video (Synced)');
    if (typeof onBroadcastAction === 'function') {
      onBroadcastAction('seek', {
        type: 'local-video-action',
        currentTime: 0
      });
    }
  };

  const handleScrubberChange = (e) => {
    const vid = videoRef.current;
    if (!vid || !durationSec) return;
    const target = parseFloat(e.target.value);
    vid.currentTime = target;
    setCurrentTimeSec(target);
    setSyncStatus(`Seeked to ${formatTime(target)} (Synced)`);
    if (typeof onBroadcastAction === 'function') {
      onBroadcastAction('seek', {
        type: 'local-video-action',
        currentTime: target
      });
    }
  };

  const handleForceSync = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const action = vid.paused ? 'pause' : 'play';
    if (typeof onBroadcastAction === 'function') {
      onBroadcastAction(action, {
        type: 'local-video-action',
        currentTime: vid.currentTime
      });
    }
    setSyncStatus('Sent sync pulse to all peers');
  };

  const handleExitVideo = () => {
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch (e) {}
    }
    setFile(null);
    setObjectUrl(null);
    if (typeof onBroadcastAction === 'function') {
      onBroadcastAction('close', { type: 'local-video-action' });
    }
    onClose();
  };

  const toggleMute = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const newMuted = !isMuted;
    vid.muted = newMuted;
    setIsMuted(newMuted);
  };

  const handleVolumeChange = (e) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const toggleFullscreen = () => {
    const container = playerContainerRef.current || document.querySelector('.local-fullstage-player');
    if (!container) return;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNowFullscreen = Boolean(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );
      setIsFullscreen(isNowFullscreen);
      if (!isNowFullscreen) {
        setShowTopBar(true);
        setShowBottomBar(true);
        setIsCursorIdle(false);
        if (idleTimeoutRef.current) {
          clearTimeout(idleTimeoutRef.current);
        }
      } else {
        // When entering fullscreen, start with bars hidden
        setShowTopBar(false);
        setShowBottomBar(false);
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
      }
    };
  }, []);

  const handleMouseMove = (e) => {
    if (!isFullscreen) {
      setShowTopBar(true);
      setShowBottomBar(true);
      setIsCursorIdle(false);
      return;
    }

    setIsCursorIdle(false);
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
    }

    const y = e.clientY;
    const windowHeight = window.innerHeight;

    // Show top bar only when cursor is brought to the top (within 85px of top edge or hovering top bar)
    const nearTop = y <= 85 || isHoveringTopRef.current;
    // Show bottom controls only when cursor is brought to the bottom (within 95px of bottom edge or hovering bottom bar)
    const nearBottom = y >= windowHeight - 95 || isHoveringBottomRef.current;

    setShowTopBar(Boolean(nearTop));
    setShowBottomBar(Boolean(nearBottom));

    idleTimeoutRef.current = setTimeout(() => {
      const isFs = Boolean(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );
      if (isFs) {
        if (!isHoveringTopRef.current) setShowTopBar(false);
        if (!isHoveringBottomRef.current) setShowBottomBar(false);
        if (!isHoveringTopRef.current && !isHoveringBottomRef.current) {
          setIsCursorIdle(true);
        }
      }
    }, (nearTop || nearBottom) ? 3500 : 1200);
  };

  // Keyboard shortcuts (Space = play/pause, Left = -5s, Right = +5s, M = mute, F = fullscreen)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't trigger if user is typing in chat or another input
      if (['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        handleSeekDelta(-5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        handleSeekDelta(5);
      } else if (e.code === 'KeyM') {
        toggleMute();
      } else if (e.code === 'KeyF') {
        toggleFullscreen();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMuted]);

  const activeFileName = file?.name || remoteMeta?.fileName || 'Local Video';
  const activeFileSize = file?.size || remoteMeta?.fileSize || 0;

  // Case A: User has not loaded their copy of the video file yet
  if (!objectUrl) {
    return (
      <div
        className={`local-dropzone-wrapper ${isDragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          accept="video/*,.mkv,.mp4,.webm,.mov,.avi,.m4v"
          onChange={handleFileInputChange}
        />

        <div className="local-waiting-card">
          <div className="local-waiting-icon-ring">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="#3ea6ff">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
            </svg>
          </div>

          {remoteMeta ? (
            <>
              <div className="local-remote-banner">
                <span className="local-remote-badge">PEER VIDEO LOADED</span>
                <h2 className="local-remote-filename">"{remoteMeta.fileName}"</h2>
                {remoteMeta.fileSize > 0 && (
                  <span className="local-file-size-tag">({formatFileSize(remoteMeta.fileSize)})</span>
                )}
              </div>
              <p className="local-waiting-subtitle">
                A peer in this room is playing this video. Drag & drop your local copy of this file here to join in synchronized playback!
              </p>
            </>
          ) : (
            <>
              <h2 className="local-waiting-title">Drag & Drop Any Video File</h2>
              <p className="local-waiting-subtitle">
                Play your own local <strong>.mp4, .mkv, .webm, or .mov</strong> files. Video runs 100% locally with <strong>zero server upload</strong>, and playback stays synchronized with all peers.
              </p>
            </>
          )}

          <div className="local-action-buttons">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
              </svg>
              Select Video from Computer
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleExitVideo}
            >
              Back to Stage
            </button>
          </div>

          <div className="local-privacy-pills">
            <span className="local-pill">⚡ 0 Network Bandwidth</span>
            <span className="local-pill">🔒 100% Private Local Playback</span>
            <span className="local-pill">🔄 Real-time P2P Sync</span>
          </div>
        </div>
      </div>
    );
  }

  // Case B: Local video is ready and playing
  return (
    <div
      ref={playerContainerRef}
      className={`local-fullstage-player ${isFullscreen ? 'is-fullscreen' : ''} ${isCursorIdle && isFullscreen ? 'hide-cursor' : ''}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => {
        if (isFullscreen) {
          setShowTopBar(false);
          setShowBottomBar(false);
          setIsCursorIdle(true);
        }
      }}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept="video/*,.mkv,.mp4,.webm,.mov,.avi,.m4v"
        onChange={handleFileInputChange}
      />

      {/* Top Bar for status, file info & sync controls */}
      <div
        className={`yt-stage-topbar local-stage-topbar ${isFullscreen ? (showTopBar ? 'visible' : 'hidden') : ''}`}
        onMouseEnter={() => {
          isHoveringTopRef.current = true;
          if (isFullscreen) {
            setShowTopBar(true);
            setIsCursorIdle(false);
          }
        }}
        onMouseLeave={() => {
          isHoveringTopRef.current = false;
        }}
      >
        <div className="local-file-info-pill" title={activeFileName}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="#3ea6ff">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
          <span className="local-filename-text">{activeFileName}</span>
          {activeFileSize > 0 && (
            <span className="local-filesize-text">({formatFileSize(activeFileSize)})</span>
          )}
          <button
            type="button"
            className="local-replace-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Change local video file"
          >
            Change
          </button>
        </div>

        <div className="yt-stage-top-controls">
          <div className={`yt-sync-pill ${isPlaying ? 'playing' : 'paused'}`}>
            <span className="yt-sync-dot"></span>
            <span>{syncStatus}</span>
          </div>
          <span className="yt-time-display">
            {formatTime(currentTimeSec)} / {formatTime(durationSec)}
          </span>

          <div className="yt-controls-toolbar">
            <button
              type="button"
              className="yt-ctrl-btn"
              onClick={togglePlayPause}
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
              onClick={handleExitVideo}
              title="Exit local video and return to watch party stage"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
              <span>Exit Video</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Video Viewport */}
      <div
        className="local-video-viewport"
        onClick={togglePlayPause}
        onDoubleClick={toggleFullscreen}
      >
        <video
          ref={videoRef}
          src={objectUrl}
          playsInline
          className="local-video-element"
          onPlay={handleVideoPlay}
          onPause={handleVideoPause}
          onSeeked={handleVideoSeeked}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
        />

        {/* Drag-over overlay indicator */}
        {isDragOver && (
          <div className="local-drag-overlay">
            <svg viewBox="0 0 24 24" width="64" height="64" fill="#3ea6ff">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
            </svg>
            <h2>Drop to replace video</h2>
          </div>
        )}
      </div>

      {/* Bottom Timeline Scrubber & Player Controls */}
      <div
        className={`local-bottom-controls ${isFullscreen ? (showBottomBar ? 'visible' : 'hidden') : ''}`}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={() => {
          isHoveringBottomRef.current = true;
          if (isFullscreen) {
            setShowBottomBar(true);
            setIsCursorIdle(false);
          }
        }}
        onMouseLeave={() => {
          isHoveringBottomRef.current = false;
        }}
      >
        <div className="local-scrubber-wrapper">
          <input
            type="range"
            min="0"
            max={durationSec || 100}
            step="0.1"
            value={currentTimeSec}
            onChange={handleScrubberChange}
            className="local-scrubber-slider"
          />
        </div>

        <div className="local-bottom-bar">
          <div className="local-bottom-left">
            <button
              type="button"
              className="local-icon-button"
              onClick={togglePlayPause}
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              {isPlaying ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              )}
            </button>

            <button
              type="button"
              className="local-icon-button"
              onClick={toggleMute}
              title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
            >
              {isMuted || volume === 0 ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                </svg>
              )}
            </button>

            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              className="local-volume-slider"
              title="Volume"
            />

            <span className="local-time-indicator">
              {formatTime(currentTimeSec)} / {formatTime(durationSec)}
            </span>
          </div>

          <div className="local-bottom-right">
            <span className="local-badge-sync">P2P Synced Controls</span>
            <button
              type="button"
              className="local-icon-button"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
            >
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
