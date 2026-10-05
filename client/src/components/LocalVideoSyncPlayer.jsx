import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { parseSubtitleFile, parseSubtitleString, cuesToWebVTT } from '../utils/subtitleParser';
import FloatingReactions from './FloatingReactions';

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
  isHost = false,
  floatingReactions = [],
  onSendReaction,
  roomId = null
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
  const [isScrubbing, setIsScrubbing] = useState(false);
  const isScrubbingRef = useRef(false);

  // Toggle All Panels in Fullscreen (Pure Cinema Mode vs Standard Playback)
  const [panelsHidden, setPanelsHidden] = useState(false);

  // Feature 1.5: Drag & Drop Subtitles (.SRT / .VTT), Timing Offset & Appearance
  const [subtitles, setSubtitles] = useState(null); // { fileName, cues, vttUrl, vttString, rawText }
  const [subtitlesVisible, setSubtitlesVisible] = useState(true); // Local toggle: hide & show for individual peer (NOT synced)
  const [dragOverlayType, setDragOverlayType] = useState('video'); // 'video' | 'subtitle'
  const [subtitleDelay, setSubtitleDelay] = useState(0); // in seconds (+ = delay later, - = earlier)
  const [subtitleFontSize, setSubtitleFontSize] = useState('md'); // 'sm' | 'md' | 'lg' | 'xl'
  const [subtitleColor, setSubtitleColor] = useState('white'); // 'white' | 'yellow' | 'cyan' | 'lime'
  const [subtitleBg, setSubtitleBg] = useState('semi'); // 'semi' | 'solid' | 'none'
  const [showSubtitleSettings, setShowSubtitleSettings] = useState(false);
  const [delayToast, setDelayToast] = useState(null);
  const toastTimeoutRef = useRef(null);
  const subtitleSettingsRef = useRef(null);
  const lastMousePosRef = useRef({ x: 0, y: 0 });

  const videoRef = useRef(null);
  const playerContainerRef = useRef(null);
  const isHoveringTopRef = useRef(false);
  const isHoveringBottomRef = useRef(false);
  const isRemoteActionRef = useRef(false);
  const fileInputRef = useRef(null);
  const subtitleFileInputRef = useRef(null);
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

  // Generate active WebVTT URL with delay offset applied
  const activeVttUrl = useMemo(() => {
    if (!subtitles || !subtitles.cues || subtitles.cues.length === 0) return null;
    const vttString = cuesToWebVTT(subtitles.cues, subtitleDelay);
    const blob = new Blob([vttString], { type: 'text/vtt' });
    return URL.createObjectURL(blob);
  }, [subtitles, subtitleDelay]);

  // Revoke subtitle blob URL on unmount or when activeVttUrl changes
  useEffect(() => {
    return () => {
      if (activeVttUrl) {
        try { URL.revokeObjectURL(activeVttUrl); } catch (e) {}
      }
    };
  }, [activeVttUrl]);

  // Auto-dismiss HUD delay toast after 1.8s
  useEffect(() => {
    if (delayToast) {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = setTimeout(() => {
        setDelayToast(null);
      }, 1800);
    }
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, [delayToast]);

  // Click outside listener for Subtitle Settings popover
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showSubtitleSettings && subtitleSettingsRef.current && !subtitleSettingsRef.current.contains(e.target)) {
        setShowSubtitleSettings(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showSubtitleSettings]);

  // Control browser native textTrack visibility and timing offset
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    const applyTrackMode = () => {
      if (!vid.textTracks || vid.textTracks.length === 0) return;
      const trackEl = vid.querySelector('track');
      const activeTextTrack = trackEl?.track;

      for (let i = 0; i < vid.textTracks.length; i++) {
        const t = vid.textTracks[i];
        if (activeTextTrack && t === activeTextTrack) {
          t.mode = subtitlesVisible ? 'showing' : 'hidden';
        } else if (!activeTextTrack && i === vid.textTracks.length - 1) {
          t.mode = subtitlesVisible ? 'showing' : 'hidden';
        } else {
          t.mode = 'disabled'; // Disable stale or previous tracks
        }
      }

      // In-place real-time cue timestamp adjustment
      if (activeTextTrack?.cues && activeTextTrack.cues.length > 0 && subtitles?.cues) {
        for (let i = 0; i < activeTextTrack.cues.length && i < subtitles.cues.length; i++) {
          const cue = activeTextTrack.cues[i];
          const orig = subtitles.cues[i];
          const newStart = Math.max(0, orig.startSec + subtitleDelay);
          const newEnd = Math.max(newStart + 0.05, orig.endSec + subtitleDelay);
          cue.startTime = newStart;
          cue.endTime = newEnd;
        }
      }
    };

    applyTrackMode();
    const timer = setTimeout(applyTrackMode, 80);

    const trackEl = vid.querySelector('track');
    if (trackEl) {
      trackEl.addEventListener('load', applyTrackMode);
      return () => {
        clearTimeout(timer);
        trackEl.removeEventListener('load', applyTrackMode);
      };
    }
    return () => clearTimeout(timer);
  }, [subtitlesVisible, activeVttUrl, subtitleDelay, subtitles]);

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
          setSyncStatus(`💬 Subtitles loaded: ${parsed.fileName}`);
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
      setSubtitlesVisible(true);
      setSyncStatus(`Subtitles loaded: ${parsed.fileName}`);

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

  const handleToggleSubtitles = () => {
    if (!subtitles) {
      subtitleFileInputRef.current?.click();
      return;
    }
    setSubtitlesVisible((prev) => !prev);
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
    if (isFullscreen) {
      setShowTopBar(true);
      setShowBottomBar(true);
      setIsCursorIdle(false);
    }
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
    isScrubbingRef.current = true;
    setShowBottomBar(true);
    setIsCursorIdle(false);
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
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

  const arePanelsShowing = !panelsHidden && showBottomBar;

  const handleToggleAllPanels = useCallback((e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    // If panels are currently visible on screen, hide them all (enter Cinema View)
    if (!panelsHidden && showBottomBar) {
      setPanelsHidden(true);
      setShowTopBar(false);
      setShowBottomBar(false);
      setShowSubtitleSettings(false);
      setIsCursorIdle(false);
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      setDelayToast('👁️ All Panels Hidden (Cinema View)');
    } else {
      // Panels are currently hidden: show all panels and exit Cinema View
      setPanelsHidden(false);
      setShowTopBar(true);
      setShowBottomBar(true);
      setIsCursorIdle(false);
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      setDelayToast('📌 All Panels Shown');
    }
    setTimeout(() => setDelayToast(''), 2200);
  }, [panelsHidden, showBottomBar]);

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
        setPanelsHidden(false);
        setShowTopBar(true);
        setShowBottomBar(true);
        setIsCursorIdle(false);
        if (idleTimeoutRef.current) {
          clearTimeout(idleTimeoutRef.current);
        }
      } else {
        // When entering fullscreen, show all controls with initial grace period
        setPanelsHidden(false);
        setShowTopBar(true);
        setShowBottomBar(true);
        setIsCursorIdle(false);
        if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = setTimeout(() => {
          const isFs = Boolean(
            document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement
          );
          if (isFs && !isHoveringBottomRef.current && !isHoveringTopRef.current && !isScrubbingRef.current && !showSubtitleSettings) {
            setShowTopBar(false);
            setShowBottomBar(false);
            setIsCursorIdle(true);
          }
        }, 3500);
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
  }, [showSubtitleSettings]);

  // Global pointerup / mouseup to ensure scrubbing state resets safely anywhere
  useEffect(() => {
    const handleGlobalPointerUp = (e) => {
      if (isScrubbingRef.current) {
        isScrubbingRef.current = false;
        setIsScrubbing(false);
        if (isFullscreen) {
          if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
          const y = e?.clientY ?? lastMousePosRef.current.y;
          const windowHeight = window.innerHeight || window.screen.height || 1080;
          const inBottomZone = y >= windowHeight - 140 || isHoveringBottomRef.current;
          const inTopZone = y <= 90 || isHoveringTopRef.current;

          // While cursor is in controls zones or settings are open, keep visible
          if (inBottomZone || inTopZone || showSubtitleSettings) {
            setShowTopBar(true);
            setShowBottomBar(true);
            return;
          }

          idleTimeoutRef.current = setTimeout(() => {
            const isFs = Boolean(
              document.fullscreenElement ||
              document.webkitFullscreenElement ||
              document.mozFullScreenElement ||
              document.msFullscreenElement
            );
            if (isFs && !isHoveringBottomRef.current && !isHoveringTopRef.current && !showSubtitleSettings) {
              setShowTopBar(false);
              setShowBottomBar(false);
              setIsCursorIdle(true);
            }
          }, 3500);
        }
      }
    };

    window.addEventListener('pointerup', handleGlobalPointerUp);
    window.addEventListener('mouseup', handleGlobalPointerUp);
    return () => {
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      window.removeEventListener('mouseup', handleGlobalPointerUp);
    };
  }, [isFullscreen, showSubtitleSettings]);

  // Fullscreen Mouse Movement & Idle Controls Manager
  const handleMouseMove = useCallback((e) => {
    if (e?.clientX !== undefined && e?.clientY !== undefined) {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    }

    if (!isFullscreen) {
      setShowTopBar(true);
      setShowBottomBar(true);
      setIsCursorIdle(false);
      return;
    }

    // In Cinema View (user explicitly toggled all panels hidden):
    if (panelsHidden) {
      // Reveal cursor so user can point and click the [Show Panels] button
      setIsCursorIdle(false);
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = setTimeout(() => {
        setIsCursorIdle(true);
      }, 3000);
      // DO NOT auto-reveal bottom bar or top bar while in Cinema View!
      // The [Show Panels] button remains visible and clickable!
      return;
    }

    // Normal Fullscreen Playback:
    setIsCursorIdle(false);
    setShowTopBar(true);
    setShowBottomBar(true);

    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
    }

    const y = e ? e.clientY : lastMousePosRef.current.y;
    const windowHeight = window.innerHeight || window.screen.height || 1080;

    const inTopZone = y <= 90;
    const inBottomZone = y >= windowHeight - 140;

    isHoveringTopRef.current = inTopZone;
    isHoveringBottomRef.current = inBottomZone;

    // While cursor is over controls, actively scrubbing, or settings popover is open:
    // Keep controls visible permanently! Do NOT auto-hide!
    if (inTopZone || inBottomZone || isScrubbingRef.current || showSubtitleSettings) {
      return;
    }

    // While cursor is in middle video viewing area:
    // Schedule smooth auto-hide after 3.5 seconds of no mouse movement
    idleTimeoutRef.current = setTimeout(() => {
      const isFs = Boolean(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );
      if (isFs) {
        if (!isHoveringBottomRef.current && !isHoveringTopRef.current && !isScrubbingRef.current && !showSubtitleSettings) {
          setShowTopBar(false);
          setShowBottomBar(false);
          setIsCursorIdle(true);
        }
      }
    }, 3500);
  }, [isFullscreen, showSubtitleSettings, panelsHidden]);

  // Window & document level mouse listeners when in fullscreen to ensure bottom-edge moves are never missed
  useEffect(() => {
    if (!isFullscreen) return;
    const onGlobalMouseMove = (e) => handleMouseMove(e);
    document.addEventListener('mousemove', onGlobalMouseMove, { passive: true });
    document.addEventListener('pointermove', onGlobalMouseMove, { passive: true });
    window.addEventListener('mousemove', onGlobalMouseMove, { passive: true });
    return () => {
      document.removeEventListener('mousemove', onGlobalMouseMove);
      document.removeEventListener('pointermove', onGlobalMouseMove);
      window.removeEventListener('mousemove', onGlobalMouseMove);
    };
  }, [isFullscreen, handleMouseMove]);

  // Keyboard shortcuts (Space = play/pause, Left = -5s, Right = +5s, M = mute, F = fullscreen, C = subtitles, H = toggle all panels, [ / ] = delay offset)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't trigger if user is typing in chat or another input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
        return;
      }

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
        handleToggleSubtitles();
      } else if (e.code === 'KeyH' || e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        handleToggleAllPanels();
      } else if (e.code === 'BracketLeft' || e.key === '[' || e.key === '{') {
        e.preventDefault();
        if (!subtitles) {
          setDelayToast('💬 No subtitles loaded. Drop a .srt or .vtt file to adjust delay');
          return;
        }
        const step = e.shiftKey ? 0.5 : 0.1;
        setSubtitleDelay((prev) => {
          const next = Math.round((prev - step) * 10) / 10;
          setDelayToast(`💬 Subtitle Delay: ${next > 0 ? `+${next.toFixed(1)}` : next.toFixed(1)}s`);
          return next;
        });
      } else if (e.code === 'BracketRight' || e.key === ']' || e.key === '}') {
        e.preventDefault();
        if (!subtitles) {
          setDelayToast('💬 No subtitles loaded. Drop a .srt or .vtt file to adjust delay');
          return;
        }
        const step = e.shiftKey ? 0.5 : 0.1;
        setSubtitleDelay((prev) => {
          const next = Math.round((prev + step) * 10) / 10;
          setDelayToast(`💬 Subtitle Delay: ${next > 0 ? `+${next.toFixed(1)}` : next.toFixed(1)}s`);
          return next;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMuted, subtitles, isFullscreen, handleToggleAllPanels]);

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

  // Calculate seekbar percentage for CSS gradient progress fill
  const progressPercent = durationSec > 0 ? Math.min(100, Math.max(0, (currentTimeSec / durationSec) * 100)) : 0;

  // Case B: Video is ready and playing (either local file or P2P stream)
  return (
    <div
      ref={playerContainerRef}
      className={`local-fullstage-player ${isFullscreen ? 'is-fullscreen' : ''} ${isCursorIdle && isFullscreen ? 'hide-cursor' : ''} ${panelsHidden ? 'panels-hidden' : ''} ${(!showBottomBar || panelsHidden) && isFullscreen ? 'controls-hidden' : ''}`}
      onMouseMove={handleMouseMove}
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
            setShowBottomBar(true);
            setIsCursorIdle(false);
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
          }
        }}
        onMouseLeave={(e) => {
          if (e.clientY > 90) {
            isHoveringTopRef.current = false;
          }
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

        {subtitles && (
          <div className="local-file-info-pill local-subtitle-pill" title={subtitles.fileName}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="#00e5ff">
              <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/>
            </svg>
            <span className="local-filename-text">{subtitles.fileName}</span>
            <button
              type="button"
              className="local-replace-btn local-style-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowSubtitleSettings((prev) => !prev);
              }}
              title="Subtitle Appearance (Font Size, Color, Background) & Timing Offset"
            >
              🎨 Style & Timing
            </button>
            <button
              type="button"
              className="local-replace-btn"
              onClick={() => subtitleFileInputRef.current?.click()}
              title="Replace subtitle file"
            >
              Replace
            </button>
            <button
              type="button"
              className="local-replace-btn local-remove-sub-btn"
              onClick={handleRemoveSubtitles}
              title="Remove subtitles"
            >
              ✕
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
          className={`local-video-element cue-size-${subtitleFontSize} cue-color-${subtitleColor} cue-bg-${subtitleBg}`}
          onPlay={handleVideoPlay}
          onPause={handleVideoPause}
          onSeeked={handleVideoSeeked}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
        >
          {activeVttUrl && (
            <track
              key={subtitles?.fileName || 'sub-track'}
              kind="subtitles"
              label={subtitles?.fileName || 'Subtitles'}
              src={activeVttUrl}
              srcLang="en"
              default
            />
          )}
        </video>

        {/* Delay Offset HUD Toast Notification */}
        {delayToast && (
          <div className="local-hud-toast" aria-live="polite">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="#3ea6ff">
              <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
            </svg>
            <span>{delayToast}</span>
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
        className={`local-bottom-controls ${isFullscreen ? (showBottomBar || isScrubbing ? 'visible' : 'hidden') : ''} ${isScrubbing ? 'is-scrubbing' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setShowTopBar(true);
          setShowBottomBar(true);
          setIsCursorIdle(false);
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          setShowTopBar(true);
          setShowBottomBar(true);
          setIsCursorIdle(false);
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          setShowTopBar(true);
          setShowBottomBar(true);
          setIsCursorIdle(false);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseEnter={() => {
          isHoveringBottomRef.current = true;
          if (isFullscreen) {
            setShowTopBar(true);
            setShowBottomBar(true);
            setIsCursorIdle(false);
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
          }
        }}
        onMouseLeave={(e) => {
          const windowHeight = window.innerHeight || window.screen.height || 1080;
          if (e.clientY < windowHeight - 140 && !isScrubbingRef.current) {
            isHoveringBottomRef.current = false;
          }
        }}
      >
        <div
          className="local-scrubber-wrapper"
          onClick={(e) => {
            e.stopPropagation();
            setShowTopBar(true);
            setShowBottomBar(true);
            setIsCursorIdle(false);
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            setShowTopBar(true);
            setShowBottomBar(true);
            setIsCursorIdle(false);
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            setShowTopBar(true);
            setShowBottomBar(true);
            setIsCursorIdle(false);
          }}
        >
          <input
            type="range"
            min="0"
            max={durationSec || 100}
            step="0.1"
            value={currentTimeSec}
            style={{ '--seek-progress': `${progressPercent.toFixed(2)}%` }}
            onChange={handleScrubberChange}
            onPointerDown={(e) => {
              e.stopPropagation();
              isScrubbingRef.current = true;
              setIsScrubbing(true);
              setShowTopBar(true);
              setShowBottomBar(true);
              setIsCursorIdle(false);
              if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
              isScrubbingRef.current = true;
              setIsScrubbing(true);
              setShowTopBar(true);
              setShowBottomBar(true);
              setIsCursorIdle(false);
              if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
            }}
            className="local-scrubber-slider"
            aria-label="Video scrubber timeline"
            aria-valuemin={0}
            aria-valuemax={durationSec || 100}
            aria-valuenow={currentTimeSec}
            aria-valuetext={`${formatTime(currentTimeSec)} of ${formatTime(durationSec)}`}
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

            {/* Feature 1.5: Subtitles Control Group (Independent Toggle + Appearance & Delay Settings) */}
            <div className="local-subtitle-control-group" ref={subtitleSettingsRef}>
              <button
                type="button"
                className={`local-icon-button local-cc-button ${subtitles ? (subtitlesVisible ? 'active' : 'off') : 'no-subtitles'}`}
                onClick={handleToggleSubtitles}
                title={
                  subtitles
                    ? (subtitlesVisible
                        ? `Subtitles: ON (${subtitles.fileName}) • Click to hide (C)`
                        : `Subtitles: OFF (${subtitles.fileName}) • Click to show (C)`)
                    : 'Load Subtitles (.srt / .vtt) by drag & drop or click'
                }
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/>
                </svg>
                {subtitles && (
                  <span className={`local-cc-badge ${subtitlesVisible ? 'badge-on' : 'badge-off'}`}>
                    {subtitlesVisible ? 'ON' : 'OFF'}
                  </span>
                )}
              </button>

              {/* Subtitle Appearance & Timing Settings Button */}
              <button
                type="button"
                className={`local-icon-button local-sub-settings-btn ${showSubtitleSettings ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSubtitleSettings((prev) => !prev);
                }}
                title="Subtitle Appearance (Font Size, Color, Background) & Timing Offset Settings"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" className="sub-settings-gear-icon">
                  <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/>
                </svg>
                <span className="sub-settings-btn-icon">Aa</span>
              </button>

              {/* Glassmorphic Subtitle Appearance & Timing Settings Popover Card */}
              {showSubtitleSettings && (
                <div
                  className="sub-settings-popover"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="sub-settings-header">
                    <div className="sub-settings-title">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="#3ea6ff">
                        <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/>
                      </svg>
                      <span>Subtitle Appearance & Timing</span>
                    </div>
                    <button
                      type="button"
                      className="sub-close-btn"
                      onClick={() => setShowSubtitleSettings(false)}
                      title="Close settings"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Subtitle File Quick Action / Status */}
                  {!subtitles ? (
                    <button
                      type="button"
                      className="sub-action-load-btn"
                      onClick={() => subtitleFileInputRef.current?.click()}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                      </svg>
                      Load Subtitle File (.SRT / .VTT)
                    </button>
                  ) : (
                    <div className="sub-file-meta-row">
                      <span className="sub-file-name" title={subtitles.fileName}>
                        📄 {subtitles.fileName}
                      </span>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          type="button"
                          className="sub-mini-btn"
                          onClick={() => subtitleFileInputRef.current?.click()}
                          title="Replace subtitle file"
                        >
                          Replace
                        </button>
                        <button
                          type="button"
                          className="sub-mini-btn remove"
                          onClick={handleRemoveSubtitles}
                          title="Remove subtitles"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Live Preview of native subtitle styling */}
                  <div className="sub-preview-box">
                    <div className="sub-preview-label">Live Preview</div>
                    <div className={`sub-preview-cue preview-size-${subtitleFontSize} preview-color-${subtitleColor} preview-bg-${subtitleBg}`}>
                      Sample Subtitle (Live Preview)
                    </div>
                  </div>

                  {/* Timing Sync Delay Offset */}
                  <div className="sub-settings-section">
                    <div className="sub-section-header">
                      <span className="sub-section-title">TIMING DELAY OFFSET</span>
                      <span className={`sub-delay-badge ${subtitleDelay === 0 ? 'zero' : subtitleDelay > 0 ? 'positive' : 'negative'}`}>
                        {subtitleDelay === 0 ? '0.0s (In Sync)' : subtitleDelay > 0 ? `+${subtitleDelay.toFixed(1)}s` : `${subtitleDelay.toFixed(1)}s`}
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
                      Hotkeys: <kbd>[</kbd> and <kbd>]</kbd> to adjust delay in ±0.1s steps (Shift for ±0.5s)
                    </div>
                  </div>

                  {/* Font Size Selector */}
                  <div className="sub-settings-section">
                    <div className="sub-setting-row">
                      <span className="sub-setting-name">Font Size</span>
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
                  </div>

                  {/* Text Color Selector */}
                  <div className="sub-settings-section">
                    <div className="sub-setting-row">
                      <span className="sub-setting-name">Text Color</span>
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
                  </div>

                  {/* Background Style Selector */}
                  <div className="sub-settings-section">
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
                  </div>

                  <div className="sub-settings-footer">
                    <span>✓ Default native subtitles • Appearance and delay are local per peer</span>
                  </div>
                </div>
              )}
            </div>

            {/* Toggle All Panels (Cinema View) Button in Toolbar */}
            <button
              type="button"
              className="local-toolbar-panel-btn"
              onClick={handleToggleAllPanels}
              title="Cinema View: Hide all panels (H)"
              aria-label="Hide All Panels"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H5v-4h9v4zm0-6H5V7h9v4zm5 6h-3V7h3v10z"/>
              </svg>
              <span>Hide Panels</span>
            </button>

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

      {/* Floating Restore Panels Button in Cinema View (Stationed at Top-Right) */}
      {panelsHidden && (
        <button
          type="button"
          className="local-cinema-restore-btn"
          onClick={handleToggleAllPanels}
          title="Show All Panels (H)"
          aria-label="Show All Panels"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
          </svg>
          <span>Show Panels</span>
          <span className="local-hotkey-badge">H</span>
        </button>
      )}

      {/* Floating Live Reactions in Fullscreen */}
      {isFullscreen && typeof onSendReaction === 'function' && (
        <FloatingReactions
          reactions={floatingReactions}
          onSendReaction={onSendReaction}
          showDock={Boolean(roomId)}
          hasMedia={true}
        />
      )}
    </div>
  );
}
