import React, { useState, useEffect, useRef, useMemo } from 'react';
import { parseSubtitleFile, parseSubtitleString, getActiveCues } from '../utils/subtitleParser';

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
  onRegisterStateGetter,
  // Feature 1.4: WebRTC Direct Video Streaming
  streamProgress = null,
  streamVideoUrl = null,
  onRequestP2PStream,
  onCancelP2PStream,
  isHost = false
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

  // Feature 1.5: Drag & Drop Subtitles (.SRT / .VTT)
  const [subtitles, setSubtitles] = useState(null); // { fileName, cues, vttUrl, vttString, rawText }
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [subtitleDelay, setSubtitleDelay] = useState(0.0);
  const [subtitleFontSize, setSubtitleFontSize] = useState('md'); // sm, md, lg, xl
  const [subtitleBg, setSubtitleBg] = useState('semi'); // semi, solid, none
  const [subtitleColor, setSubtitleColor] = useState('white'); // white, yellow, cyan, lime
  const [subtitlePosition, setSubtitlePosition] = useState('bottom'); // bottom, elevated, top
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [dragOverlayType, setDragOverlayType] = useState('video'); // 'video' | 'subtitle'

  const videoRef = useRef(null);
  const playerContainerRef = useRef(null);
  const isHoveringTopRef = useRef(false);
  const isHoveringBottomRef = useRef(false);
  const isRemoteActionRef = useRef(false);
  const fileInputRef = useRef(null);
  const subtitleFileInputRef = useRef(null);
  const subtitleMenuRef = useRef(null);
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

  // Revoke subtitle blob URL on unmount or change
  useEffect(() => {
    return () => {
      if (subtitles?.vttUrl) {
        try { URL.revokeObjectURL(subtitles.vttUrl); } catch (e) {}
      }
    };
  }, [subtitles]);

  // Close subtitle menu when clicking outside
  useEffect(() => {
    if (!showSubtitleMenu) return;
    const handleClickOutside = (e) => {
      if (subtitleMenuRef.current && !subtitleMenuRef.current.contains(e.target)) {
        setShowSubtitleMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSubtitleMenu]);

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
          isPlaying: vid ? !vid.paused : false,
          subtitleInfo: subtitles ? { fileName: subtitles.fileName, vttString: subtitles.vttString } : null
        };
      });
    }
  }, [onRegisterStateGetter, remoteMeta, subtitles]);

  // 3. Handle incoming remote sync actions from peers
  useEffect(() => {
    if (!remoteAction) return;
    const { action, currentTime, sender, fileName } = remoteAction;

    if (action === 'close') {
      onClose();
      return;
    }

    // Handle remote subtitle file sharing
    if (action === 'subtitle-share' || remoteAction.subAction === 'share') {
      if (remoteAction.vttString) {
        try {
          const parsed = parseSubtitleString(remoteAction.vttString, remoteAction.fileName || 'synced-subtitles.vtt');
          if (subtitles?.vttUrl) {
            try { URL.revokeObjectURL(subtitles.vttUrl); } catch (e) {}
          }
          setSubtitles(parsed);
          setSubtitlesEnabled(true);
          setSyncStatus(`💬 Synced subtitles from ${sender || 'Peer'}: ${parsed.fileName}`);
        } catch (e) {
          console.error('Failed to parse remote subtitles:', e);
        }
      }
      return;
    }

    // If initial sync state carried subtitle info
    if (remoteAction.subtitleInfo?.vttString && !subtitles) {
      try {
        const parsed = parseSubtitleString(remoteAction.subtitleInfo.vttString, remoteAction.subtitleInfo.fileName || 'synced-subtitles.vtt');
        setSubtitles(parsed);
        setSubtitlesEnabled(true);
      } catch (e) {}
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
  const handleLoadSubtitleFile = async (subFile) => {
    if (!subFile) return;
    try {
      const parsed = await parseSubtitleFile(subFile);
      if (subtitles?.vttUrl) {
        try { URL.revokeObjectURL(subtitles.vttUrl); } catch (e) {}
      }
      setSubtitles(parsed);
      setSubtitlesEnabled(true);
      setSyncStatus(`Subtitles loaded: ${parsed.fileName} (${parsed.cues.length} cues)`);

      // Broadcast subtitle to room peers via WebRTC DataChannel
      if (typeof onBroadcastAction === 'function') {
        onBroadcastAction('subtitle-share', {
          type: 'local-video-action',
          subAction: 'share',
          fileName: parsed.fileName,
          vttString: parsed.vttString
        });
      }
    } catch (err) {
      console.error('Subtitle file load failed:', err);
      setSyncStatus('Failed to parse subtitle file');
    }
  };

  const handleRemoveSubtitles = () => {
    if (subtitles?.vttUrl) {
      try { URL.revokeObjectURL(subtitles.vttUrl); } catch (e) {}
    }
    setSubtitles(null);
    setSyncStatus('Subtitles removed');
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    setDragOverlayType('video');
    const droppedFile = e.dataTransfer?.files?.[0];
    if (droppedFile) {
      const name = (droppedFile.name || '').toLowerCase();
      if (name.endsWith('.srt') || name.endsWith('.vtt')) {
        handleLoadSubtitleFile(droppedFile);
      } else {
        loadNewLocalFile(droppedFile);
      }
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
    const items = e.dataTransfer?.items;
    if (items && items[0]) {
      const item = items[0];
      if (item.type?.includes('text') || item.type?.includes('vtt') || item.type?.includes('subrip')) {
        setDragOverlayType('subtitle');
      } else {
        setDragOverlayType('video');
      }
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
    if (typeof onCancelP2PStream === 'function') {
      onCancelP2PStream();
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

  // Keyboard shortcuts (Space = play/pause, Left = -5s, Right = +5s, M = mute, F = fullscreen, C = subtitles, [ / ] = delay offset)
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
      } else if (e.code === 'KeyC') {
        e.preventDefault();
        if (subtitles) {
          setSubtitlesEnabled((prev) => !prev);
        } else {
          setShowSubtitleMenu((prev) => !prev);
        }
      } else if (e.key === '[') {
        e.preventDefault();
        setSubtitleDelay((prev) => {
          const next = Math.round((prev - 0.1) * 10) / 10;
          setSyncStatus(`Subtitle offset: ${next > 0 ? `+${next.toFixed(1)}s` : `${next.toFixed(1)}s`}`);
          return next;
        });
      } else if (e.key === ']') {
        e.preventDefault();
        setSubtitleDelay((prev) => {
          const next = Math.round((prev + 0.1) * 10) / 10;
          setSyncStatus(`Subtitle offset: ${next > 0 ? `+${next.toFixed(1)}s` : `${next.toFixed(1)}s`}`);
          return next;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMuted, subtitles, subtitlesEnabled]);

  // Active subtitles matched to current timestamp and timing offset
  const activeCues = useMemo(() => {
    if (!subtitlesEnabled || !subtitles || !subtitles.cues) return [];
    return getActiveCues(subtitles.cues, currentTimeSec, subtitleDelay);
  }, [subtitlesEnabled, subtitles, currentTimeSec, subtitleDelay]);

  const activeVideoSrc = streamVideoUrl || objectUrl;
  const isStreamed = Boolean(streamVideoUrl && !objectUrl);
  const activeFileName = file?.name || remoteMeta?.fileName || streamProgress?.fileName || 'Local Video';
  const activeFileSize = file?.size || remoteMeta?.fileSize || streamProgress?.totalBytes || 0;

  // Case A: User has not loaded their copy of the video file yet AND no active stream URL
  if (!activeVideoSrc) {
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
            <div className="local-dual-choice-container">
              <div className="local-remote-banner">
                <span className="local-remote-badge">PEER VIDEO LOADED</span>
                <h2 className="local-remote-filename">"{remoteMeta.fileName}"</h2>
                {remoteMeta.fileSize > 0 && (
                  <span className="local-file-size-tag">({formatFileSize(remoteMeta.fileSize)})</span>
                )}
                <p className="local-waiting-subtitle">
                  {remoteMeta.sender || 'A peer'} loaded this video file. Choose how you want to join the watch party:
                </p>
              </div>

              <div className="p2p-stream-options-grid">
                {/* Option 1: 1.4 WebRTC Direct Video Stream (MSE Chunk Sharing) */}
                <div className={`stream-option-card card-streaming ${streamProgress ? 'is-streaming' : ''}`}>
                  <div className="stream-card-badge">OPTION 1 • WEBRTC DIRECT STREAM</div>
                  <div className="stream-card-icon">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="#00e676">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                    </svg>
                  </div>
                  <h3 className="stream-card-title">Stream from Peer (P2P)</h3>
                  <p className="stream-card-desc">
                    Don't have this video on your computer? Stream it directly peer-to-peer from <strong>{remoteMeta.sender || 'Peer'}</strong> with zero server upload.
                  </p>

                  {!streamProgress ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-stream-action"
                      onClick={onRequestP2PStream}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
                      </svg>
                      Stream from Peer (P2P)
                    </button>
                  ) : (
                    <div className="p2p-stream-progress-card">
                      <div className="p2p-stream-prog-header">
                        <span className="p2p-stream-prog-status">
                          <span className="p2p-pulse-dot"></span>
                          {streamProgress.isCompleted
                            ? '✅ Ready to play!'
                            : streamProgress.isReady
                            ? '▶️ Buffered initial chunks!'
                            : '📡 Receiving chunks...'}
                        </span>
                        <span className="p2p-stream-prog-percent">{streamProgress.percent || 0}%</span>
                      </div>
                      <div className="p2p-stream-track">
                        <div
                          className="p2p-stream-fill"
                          style={{ width: `${Math.max(4, streamProgress.percent || 0)}%` }}
                        ></div>
                      </div>
                      <div className="p2p-stream-metrics">
                        <span>
                          {formatFileSize(streamProgress.receivedBytes || 0)} / {formatFileSize(remoteMeta.fileSize || streamProgress.totalBytes || 0)}
                        </span>
                        <span>⚡ {(streamProgress.speedMBs || 0).toFixed(1)} MB/s</span>
                        {streamProgress.totalChunks > 0 && (
                          <span>{streamProgress.receivedChunksCount || 0}/{streamProgress.totalChunks} chunks</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm p2p-cancel-btn"
                        onClick={onCancelP2PStream}
                      >
                        ✕ Cancel Stream
                      </button>
                    </div>
                  )}

                  <div className="stream-card-tags">
                    <span className="stream-mini-tag">⚡ Direct SCTP DataChannel</span>
                    <span className="stream-mini-tag">🔒 End-to-End P2P</span>
                  </div>
                </div>

                {/* Option 2: Current Behavior - Local Video File (0 Bandwidth) */}
                <div className="stream-option-card card-local-file">
                  <div className="stream-card-badge">OPTION 2 • ZERO NETWORK BANDWIDTH</div>
                  <div className="stream-card-icon">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="#3ea6ff">
                      <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                    </svg>
                  </div>
                  <h3 className="stream-card-title">Select Local File (Current)</h3>
                  <p className="stream-card-desc">
                    Already have this identical file on your disk? Select or drag & drop it here for instant playback with <strong>0 MB/s network usage</strong>.
                  </p>

                  <button
                    type="button"
                    className="btn btn-secondary btn-file-action"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                    </svg>
                    Select File from Computer
                  </button>

                  <div className="stream-card-tags">
                    <span className="stream-mini-tag">⚡ 0 Network Bandwidth</span>
                    <span className="stream-mini-tag">📁 Drag & Drop Supported</span>
                  </div>
                </div>
              </div>

              <div className="local-action-buttons">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleExitVideo}
                >
                  Back to Stage
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2 className="local-waiting-title">Drag & Drop Any Video File</h2>
              <p className="local-waiting-subtitle">
                Play your own local <strong>.mp4, .mkv, .webm, or .mov</strong> files. Video runs 100% locally with <strong>zero server upload</strong>, and peers can either stream it from you peer-to-peer or sync their local copies.
              </p>

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
            </>
          )}

          <div className="local-privacy-pills">
            <span className="local-pill">⚡ 0 Network Bandwidth</span>
            <span className="local-pill">🔒 100% Private Local Playback</span>
            <span className="local-pill">🔄 Real-time P2P Sync</span>
          </div>
        </div>
      </div>
    );
  }

  // Case B: Video is ready and playing (either local file or P2P stream)
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
        {isStreamed ? (
          <div className="local-file-info-pill is-streamed" title={activeFileName}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="#00e676">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
            </svg>
            <span className="local-stream-badge">📡 P2P STREAM</span>
            <span className="local-filename-text">{activeFileName}</span>
            {streamProgress && (
              <span className="local-filesize-text">
                ({streamProgress.percent}% {streamProgress.isCompleted ? 'buffered' : `• ${(streamProgress.speedMBs || 0).toFixed(1)} MB/s`})
              </span>
            )}
            <button
              type="button"
              className="local-replace-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Switch to playing local copy (0 network bandwidth)"
            >
              Use Local File
            </button>
          </div>
        ) : (
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
        )}

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

      {/* Hidden file input for subtitles (.srt / .vtt) */}
      <input
        type="file"
        ref={subtitleFileInputRef}
        style={{ display: 'none' }}
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        onChange={(e) => {
          const sel = e.target.files?.[0];
          if (sel) handleLoadSubtitleFile(sel);
          e.target.value = '';
        }}
      />

      {/* Main Video Viewport */}
      <div
        className="local-video-viewport"
        onClick={togglePlayPause}
        onDoubleClick={toggleFullscreen}
      >
        <video
          ref={videoRef}
          src={activeVideoSrc}
          playsInline
          className="local-video-element"
          onPlay={handleVideoPlay}
          onPause={handleVideoPause}
          onSeeked={handleVideoSeeked}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
        >
          {subtitles?.vttUrl && (
            <track
              kind="subtitles"
              label={subtitles.fileName}
              src={subtitles.vttUrl}
              default
            />
          )}
        </video>

        {/* Feature 1.5: Synchronized Subtitle Overlay */}
        {subtitlesEnabled && activeCues.length > 0 && (
          <div
            className={`local-subtitle-overlay pos-${subtitlePosition} ${isFullscreen && showBottomBar ? 'bars-active' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`local-subtitle-cue font-${subtitleFontSize} color-${subtitleColor} bg-${subtitleBg}`}>
              {activeCues.map((cue, idx) => (
                <div key={cue.id || idx} className="local-cue-line">
                  {cue.text}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Drag-over overlay indicator */}
        {isDragOver && (
          <div className={`local-drag-overlay ${dragOverlayType === 'subtitle' ? 'drop-subtitle' : 'drop-video'}`}>
            <div className="local-drag-card">
              <div className="local-drag-icon">
                {dragOverlayType === 'subtitle' ? (
                  <svg viewBox="0 0 24 24" width="56" height="56" fill="#00e5ff">
                    <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="56" height="56" fill="#3ea6ff">
                    <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
                  </svg>
                )}
              </div>
              <h3>{dragOverlayType === 'subtitle' ? 'Drop Subtitles (.SRT / .VTT)' : 'Drop Video or Subtitles'}</h3>
              <p>
                {dragOverlayType === 'subtitle'
                  ? 'Release to load subtitles and sync with all room peers'
                  : 'Drop .mp4, .mkv, .webm to replace video, or .srt, .vtt for subtitles'}
              </p>
            </div>
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

            {/* Feature 1.5: Subtitles / CC Popover Menu */}
            <div className="local-subtitle-popover-wrapper" ref={subtitleMenuRef}>
              <button
                type="button"
                className={`local-icon-button local-cc-button ${subtitles ? (subtitlesEnabled ? 'active' : 'loaded-off') : ''} ${showSubtitleMenu ? 'menu-open' : ''}`}
                onClick={() => setShowSubtitleMenu((prev) => !prev)}
                title={`Subtitles / Closed Captions (C)${subtitles ? ` - ${subtitles.fileName}` : ''}`}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/>
                </svg>
                {subtitles && (
                  <span className={`local-cc-status-dot ${subtitlesEnabled ? 'dot-active' : 'dot-off'}`}></span>
                )}
              </button>

              {/* Subtitle Glassmorphic Settings Card */}
              {showSubtitleMenu && (
                <div className="local-subtitle-menu-card" onClick={(e) => e.stopPropagation()}>
                  <div className="sub-menu-header">
                    <div className="sub-menu-title-row">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="#3ea6ff">
                        <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/>
                      </svg>
                      <h4>Subtitles & Captions</h4>
                    </div>
                    <div className="sub-menu-header-actions">
                      {subtitles && (
                        <button
                          type="button"
                          className={`sub-toggle-pill ${subtitlesEnabled ? 'is-on' : 'is-off'}`}
                          onClick={() => setSubtitlesEnabled((prev) => !prev)}
                        >
                          {subtitlesEnabled ? 'ON' : 'OFF'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="sub-close-btn"
                        onClick={() => setShowSubtitleMenu(false)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Subtitle File Source */}
                  <div className="sub-menu-section">
                    <div className="sub-section-label">Subtitle File</div>
                    {subtitles ? (
                      <div className="sub-active-file-card">
                        <div className="sub-active-meta">
                          <span className="sub-file-icon">📄</span>
                          <div className="sub-file-details">
                            <span className="sub-file-name" title={subtitles.fileName}>{subtitles.fileName}</span>
                            <span className="sub-cue-count">{subtitles.cues?.length || 0} subtitle cues • WebRTC synced</span>
                          </div>
                        </div>
                        <div className="sub-file-actions">
                          <button
                            type="button"
                            className="sub-btn-mini"
                            onClick={() => subtitleFileInputRef.current?.click()}
                            title="Replace subtitle file"
                          >
                            Replace
                          </button>
                          <button
                            type="button"
                            className="sub-btn-mini sub-btn-danger"
                            onClick={handleRemoveSubtitles}
                            title="Remove subtitles"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="sub-empty-prompt">
                        <p>Drag & drop any <strong>.srt</strong> or <strong>.vtt</strong> file onto the video, or browse your device:</p>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm sub-upload-btn"
                          onClick={() => subtitleFileInputRef.current?.click()}
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/>
                          </svg>
                          Select .SRT or .VTT File
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Timing Sync Delay Offset */}
                  <div className="sub-menu-section">
                    <div className="sub-section-header">
                      <span className="sub-section-label">Timing Sync Offset</span>
                      <span className={`sub-delay-badge ${subtitleDelay === 0 ? 'zero' : subtitleDelay > 0 ? 'positive' : 'negative'}`}>
                        {subtitleDelay > 0 ? `+${subtitleDelay.toFixed(1)}s` : `${subtitleDelay.toFixed(1)}s`}
                      </span>
                    </div>
                    <div className="sub-offset-steppers">
                      <button
                        type="button"
                        className="sub-step-btn"
                        onClick={() => setSubtitleDelay((prev) => Math.round((prev - 1.0) * 10) / 10)}
                        title="Subtitles 1.0s earlier"
                      >
                        -1.0s
                      </button>
                      <button
                        type="button"
                        className="sub-step-btn"
                        onClick={() => setSubtitleDelay((prev) => Math.round((prev - 0.5) * 10) / 10)}
                        title="Subtitles 0.5s earlier"
                      >
                        -0.5s
                      </button>
                      <button
                        type="button"
                        className="sub-step-btn"
                        onClick={() => setSubtitleDelay((prev) => Math.round((prev - 0.1) * 10) / 10)}
                        title="Subtitles 0.1s earlier"
                      >
                        -0.1s
                      </button>
                      <button
                        type="button"
                        className="sub-step-btn sub-step-reset"
                        onClick={() => setSubtitleDelay(0)}
                        title="Reset delay to 0.0s"
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        className="sub-step-btn"
                        onClick={() => setSubtitleDelay((prev) => Math.round((prev + 0.1) * 10) / 10)}
                        title="Subtitles 0.1s later"
                      >
                        +0.1s
                      </button>
                      <button
                        type="button"
                        className="sub-step-btn"
                        onClick={() => setSubtitleDelay((prev) => Math.round((prev + 0.5) * 10) / 10)}
                        title="Subtitles 0.5s later"
                      >
                        +0.5s
                      </button>
                      <button
                        type="button"
                        className="sub-step-btn"
                        onClick={() => setSubtitleDelay((prev) => Math.round((prev + 1.0) * 10) / 10)}
                        title="Subtitles 1.0s later"
                      >
                        +1.0s
                      </button>
                    </div>
                    <div className="sub-hint">
                      Hotkeys: <kbd>[</kbd> and <kbd>]</kbd> to adjust delay in $\pm 0.1$s steps
                    </div>
                  </div>

                  {/* Appearance Options */}
                  <div className="sub-menu-section">
                    <div className="sub-section-label">Appearance & Styling</div>

                    {/* Font Size */}
                    <div className="sub-setting-row">
                      <span className="sub-setting-name">Size</span>
                      <div className="sub-option-group">
                        {[
                          { id: 'sm', label: 'S' },
                          { id: 'md', label: 'M' },
                          { id: 'lg', label: 'L' },
                          { id: 'xl', label: 'XL' }
                        ].map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            className={`sub-opt-btn ${subtitleFontSize === opt.id ? 'active' : ''}`}
                            onClick={() => setSubtitleFontSize(opt.id)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Text Color */}
                    <div className="sub-setting-row">
                      <span className="sub-setting-name">Color</span>
                      <div className="sub-option-group">
                        {[
                          { id: 'white', label: 'White', color: '#ffffff' },
                          { id: 'yellow', label: 'Yellow', color: '#ffeb3b' },
                          { id: 'cyan', label: 'Cyan', color: '#00e5ff' },
                          { id: 'lime', label: 'Lime', color: '#a6e22e' }
                        ].map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            className={`sub-opt-btn color-chip ${subtitleColor === opt.id ? 'active' : ''}`}
                            onClick={() => setSubtitleColor(opt.id)}
                          >
                            <span className="chip-circle" style={{ backgroundColor: opt.color }}></span>
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Background Box */}
                    <div className="sub-setting-row">
                      <span className="sub-setting-name">Background</span>
                      <div className="sub-option-group">
                        {[
                          { id: 'semi', label: 'Semi-Dark' },
                          { id: 'solid', label: 'Solid' },
                          { id: 'none', label: 'Shadow' }
                        ].map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            className={`sub-opt-btn ${subtitleBg === opt.id ? 'active' : ''}`}
                            onClick={() => setSubtitleBg(opt.id)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Vertical Position */}
                    <div className="sub-setting-row">
                      <span className="sub-setting-name">Position</span>
                      <div className="sub-option-group">
                        {[
                          { id: 'bottom', label: 'Bottom' },
                          { id: 'elevated', label: 'Elevated' },
                          { id: 'top', label: 'Top' }
                        ].map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            className={`sub-opt-btn ${subtitlePosition === opt.id ? 'active' : ''}`}
                            onClick={() => setSubtitlePosition(opt.id)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="sub-menu-footer">
                    <span className="sub-footer-sync-tag">⚡ Subtitles automatically synchronized to room peers via WebRTC</span>
                  </div>
                </div>
              )}
            </div>

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
