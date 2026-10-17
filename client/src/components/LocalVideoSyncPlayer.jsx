import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { parseSubtitleFile, parseSubtitleString, cuesToWebVTT } from '../utils/subtitleParser';
import FloatingReactions from './FloatingReactions';
import FileFormatNotice from '../features/files/FileFormatNotice';
import { useAudioDucking } from '../features/audio/useAudioDucking';
import ScrubberReactionHeatmap from './room/ScrubberReactionHeatmap';
import { languageName, subtitleTrackLabel } from '../features/files/formats';
import { canExtract } from '../features/files/extractSubtitles';

// Whole-file download (no on-demand streaming in this browser): rough time left
const wholeFileEta = (p) => {
  const left = (p.totalBytes || 0) - (p.receivedBytes || 0);
  const speed = (p.speedMBs || 0) * 1024 * 1024;
  if (!(left > 0) || !(speed > 0)) return '';
  const min = Math.ceil(left / speed / 60);
  return min >= 60 ? `, ~${Math.floor(min / 60)} h ${min % 60} min left` : `, ~${min} min left`;
};

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

function formatFileSize(bytes) {
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
  reactionFeed,
  onSendReaction,
  roomId = null,
  isPttSpaceActive = false,
  fileFormat = null // what's in the file, can it play here, its subtitle tracks (features/files)
}) {
  const initialUrlRef = useRef(null);
  const [file, setFile] = useState(initialFile);
  const [objectUrl, setObjectUrl] = useState(() => {
    if (initialFile) {
      const url = URL.createObjectURL(initialFile);
      initialUrlRef.current = url;
      return url;
    }
    return null;
  });
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
  const [subtitles, setSubtitles] = useState(null); // { fileName, cues, vttUrl, vttString, rawText, trackNumber }
  const [subtitlesVisible, setSubtitlesVisible] = useState(true); // Local toggle: hide & show for individual peer (NOT synced)
  const [dragOverlayType, setDragOverlayType] = useState('video'); // 'video' | 'subtitle'
  const [subtitleDelay, setSubtitleDelay] = useState(0); // in seconds (+ = delay later, - = earlier)
  const [subtitleFontSize, setSubtitleFontSize] = useState('md'); // 'sm' | 'md' | 'lg' | 'xl'
  const [subtitleColor, setSubtitleColor] = useState('white'); // 'white' | 'yellow' | 'cyan' | 'lime'
  const [subtitleBg, setSubtitleBg] = useState('semi'); // 'semi' | 'solid' | 'none'
  const [showSubtitleSettings, setShowSubtitleSettings] = useState(false);
  const [subtitleTab, setSubtitleTab] = useState('tracks'); // 'tracks' | 'style'
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(420);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState(0);
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const audioSettingsRef = useRef(null);
  const [hoverPreview, setHoverPreview] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [delayToast, setDelayToast] = useState(null);
  const toastTimeoutRef = useRef(null);
  const subtitleSettingsRef = useRef(null);
  const settingsRef = useRef(null);
  const scrubberTrackRef = useRef(null);
  const lastMousePosRef = useRef({ x: 0, y: 0 });

  // Dynamically clamp popover max-height so it never extends above the player or behind the room header
  useLayoutEffect(() => {
    if (!showSubtitleSettings && !showAudioSettings) return;

    const updateMaxHeight = () => {
      const playerEl = playerContainerRef.current;
      const anchorEl = showSubtitleSettings
        ? subtitleSettingsRef.current
        : audioSettingsRef.current;

      if (!playerEl || !anchorEl) return;

      const playerRect = playerEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      // Available space between the top of the player and the anchor button, minus 10px buffer
      const available = anchorRect.top - playerRect.top - 10;
      setPopoverMaxHeight(Math.max(200, Math.floor(available)));
    };

    updateMaxHeight();
    window.addEventListener('resize', updateMaxHeight);
    return () => window.removeEventListener('resize', updateMaxHeight);
  }, [showSubtitleSettings, showAudioSettings, isFullscreen]);

  // Phase 3: Intelligent Dialogue Ducking (reduces volume by ~18 dB when peers speak)
  const duckingFactor = useAudioDucking(Boolean(initialFile || streamVideoUrl));
  useEffect(() => {
    if (!videoRef.current || isMuted) return;
    const effectiveVol = volume * duckingFactor;
    videoRef.current.volume = Math.max(0, Math.min(1, effectiveVol));
  }, [duckingFactor, volume, isMuted]);

  const handleSendReactionWithTime = useCallback((emoji) => {
    if (typeof onSendReaction === 'function') {
      onSendReaction(emoji, currentTimeSec);
    }
  }, [onSendReaction, currentTimeSec]);

  const videoRef = useRef(null);
  const playerContainerRef = useRef(null);
  const isHoveringTopRef = useRef(false);
  const isHoveringBottomRef = useRef(false);
  const isHoveringReactionRef = useRef(false);
  const hidePanelsTimerRef = useRef(null);
  const isRemoteActionRef = useRef(false);
  // Video events caused by applying a peer's command: only those are skipped, so pausing right
  // after someone else pressed play is still sent to the room
  const echoRef = useRef({ play: 0, pause: 0, seeked: 0 });
  const expectEcho = (event, ms = 1500) => { echoRef.current[event] = Date.now() + ms; };
  const isEcho = (event) => {
    if (Date.now() >= echoRef.current[event]) return false;
    echoRef.current[event] = 0; // each expected event is skipped once
    return true;
  };
  const fileInputRef = useRef(null);
  const subtitleFileInputRef = useRef(null);
  const idleTimeoutRef = useRef(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  // What the room was doing before our video could play (joined mid-film), applied once it can
  const pendingRoomStateRef = useRef(null);

  // 1. Create or revoke object URL when local file changes
  useEffect(() => {
    if (file) {
      if (initialUrlRef.current) {
        const url = initialUrlRef.current;
        initialUrlRef.current = null;
        setSyncStatus('Local video ready');
        return () => {
          try {
            URL.revokeObjectURL(url);
          } catch (e) { }
        };
      }
      const url = URL.createObjectURL(file);
      setObjectUrl(url);
      setSyncStatus('Local video ready');
      return () => {
        try {
          URL.revokeObjectURL(url);
        } catch (e) { }
      };
    } else {
      setObjectUrl(null);
    }
  }, [file]);

  const activeVideoKey = file
    ? `local:${file.name}:${file.size}`
    : remoteMeta
      ? `remote:${remoteMeta.fileName}:${remoteMeta.fileSize || 0}`
      : streamVideoUrl
        ? `stream:${streamVideoUrl}`
        : null;

  const lastActiveVideoKeyRef = useRef(activeVideoKey);

  const clearCurrentSubtitlesAndAudio = useCallback(() => {
    setSubtitles((prev) => {
      if (prev?.vttUrl) {
        try { URL.revokeObjectURL(prev.vttUrl); } catch (e) { }
      }
      return null;
    });
    setSubtitlesVisible(true);
    setSubtitleDelay(0);
    setSelectedAudioTrack(0);
    setShowSubtitleSettings(false);
    setShowAudioSettings(false);
  }, []);

  useEffect(() => {
    if (lastActiveVideoKeyRef.current !== activeVideoKey) {
      lastActiveVideoKeyRef.current = activeVideoKey;
      clearCurrentSubtitlesAndAudio();
    }
  }, [activeVideoKey, clearCurrentSubtitlesAndAudio]);

  // If initialFile changes from parent
  useEffect(() => {
    if (initialFile && initialFile !== file) {
      setFile(initialFile);
    }
  }, [initialFile, file]);

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
        try { URL.revokeObjectURL(activeVttUrl); } catch (e) { }
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

  // Click outside listener for Audio Settings popover
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showAudioSettings && audioSettingsRef.current && !audioSettingsRef.current.contains(e.target)) {
        setShowAudioSettings(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showAudioSettings]);

  // Click outside listener for Playback Settings popover
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showSettings && settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showSettings]);

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
          isBuffering: vid ? vid.seeking || vid.readyState < 3 : false,
          subtitleInfo: subtitles ? { fileName: subtitles.fileName, vttString: subtitles.vttString } : null
        };
      });
      return () => onRegisterStateGetter(null);
    }
  }, [onRegisterStateGetter, remoteMeta, subtitles]);

  const playerMountedAtRef = useRef(Date.now());
  const lastProcessedActionRef = useRef(null);

  // 3. Handle incoming remote sync actions from peers
  useEffect(() => {
    if (!remoteAction) return;
    if (remoteAction === lastProcessedActionRef.current) return;
    lastProcessedActionRef.current = remoteAction;

    const { action, currentTime, sender, fileName } = remoteAction;

    if (action === 'close') {
      const actionTime = remoteAction.at || remoteAction.timestamp || 0;
      if (actionTime && actionTime < playerMountedAtRef.current) return;
      if (!actionTime && Date.now() - playerMountedAtRef.current < 1000) return;
      clearCurrentSubtitlesAndAudio();
      onClose();
      return;
    }

    if (action === 'load') {
      clearCurrentSubtitlesAndAudio();
      return;
    }

    // Handle remote subtitle file sharing
    if (action === 'subtitle-share' || remoteAction.subAction === 'share') {
      if (remoteAction.vttString) {
        try {
          const parsed = parseSubtitleString(remoteAction.vttString, remoteAction.fileName || 'synced-subtitles.vtt');
          if (subtitles?.vttUrl) {
            try { URL.revokeObjectURL(subtitles.vttUrl); } catch (e) { }
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
      } catch (e) { }
    }

    const vid = videoRef.current;
    if (!vid || vid.readyState < 1) {
      // No video yet (the stream starts in a moment): do it once it's there
      if (action === 'play' || action === 'pause' || action === 'seek') {
        const prev = pendingRoomStateRef.current;
        pendingRoomStateRef.current = {
          playing: action === 'seek' ? Boolean(prev?.playing) : action === 'play',
          time: typeof currentTime === 'number' ? currentTime : (prev?.time || 0),
          at: Date.now(),
          sender
        };
      }
      if (!vid) return;
    } else {
      pendingRoomStateRef.current = null;
    }

    isRemoteActionRef.current = true;

    try {
      if (action === 'play') {
        setSyncStatus(`▶️ ${sender || 'Peer'} played`);
        if (currentTime !== undefined && Math.abs(vid.currentTime - currentTime) > 0.8) {
          expectEcho('seeked', 8000);
          vid.currentTime = currentTime;
        }
        if (vid.paused) expectEcho('play');
        vid.play().then(() => {
          setIsPlaying(true);
        }).catch(() => {
          // Autoplay may await user interaction
        });
      } else if (action === 'pause') {
        setSyncStatus(`⏸️ ${sender || 'Peer'} paused`);
        if (currentTime !== undefined && Math.abs(vid.currentTime - currentTime) > 0.8) {
          expectEcho('seeked', 8000);
          vid.currentTime = currentTime;
        }
        if (!vid.paused) expectEcho('pause');
        vid.pause();
        setIsPlaying(false);
      } else if (action === 'seek') {
        if (currentTime !== undefined) {
          expectEcho('seeked', 8000); // streamed video: the seek can take a few seconds
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
  }, [remoteAction, onClose, clearCurrentSubtitlesAndAudio, subtitles?.vttUrl]);

  // 4. File drag and drop handlers
  /** Show these subtitles here and send them to the room. */
  const shareSubtitles = (parsed) => {
    setSubtitles((prev) => {
      if (prev?.vttUrl) {
        try { URL.revokeObjectURL(prev.vttUrl); } catch (e) { }
      }
      return parsed;
    });
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
  };

  const handleLoadSubtitleFile = async (subFile) => {
    if (!subFile) return;
    try {
      shareSubtitles(await parseSubtitleFile(subFile));
    } catch (err) {
      console.error('Subtitle file load failed:', err);
      setSyncStatus('Failed to parse subtitle file');
    }
  };

  // Available embedded subtitles and audio tracks from fileFormat
  const availableSubtitles = useMemo(() => {
    return fileFormat?.format?.subtitles || [];
  }, [fileFormat?.format?.subtitles]);

  const handleSelectEmbeddedSubtitle = useCallback((trackNumber) => {
    if (typeof fileFormat?.pickSubtitle === 'function') {
      fileFormat.pickSubtitle(trackNumber);
    }
  }, [fileFormat]);

  const availableAudioTracks = useMemo(() => {
    const formatAudio = fileFormat?.format?.audio;
    if (Array.isArray(formatAudio) && formatAudio.length > 0) {
      return formatAudio;
    }
    const vid = videoRef.current;
    if (vid?.audioTracks && vid.audioTracks.length > 0) {
      return Array.from(vid.audioTracks).map((t, i) => ({
        codec: t.kind || 'audio',
        label: t.label || `Audio Track ${i + 1}`,
        language: t.language || 'und',
        name: t.label || ''
      }));
    }
    return [];
  }, [fileFormat?.format?.audio]);

  const hasMultipleAudio = availableAudioTracks.length > 1;

  const getAudioTrackLabel = useCallback((track, index) => {
    if (!track) return `Audio Track ${index + 1}`;
    const lang = languageName(track.language);
    const name = track.name && track.name !== lang ? track.name : '';
    const parts = [lang, name].filter(Boolean);
    const desc = parts.length > 0 ? parts.join(' – ') : `Track ${index + 1}`;
    const codec = track.label || track.codec;
    return codec ? `${desc} (${codec})` : desc;
  }, []);

  const handleSelectAudioTrack = useCallback((index) => {
    setSelectedAudioTrack(index);
    const vid = videoRef.current;
    if (vid?.audioTracks && vid.audioTracks.length > 0) {
      for (let i = 0; i < vid.audioTracks.length; i++) {
        vid.audioTracks[i].enabled = (i === index);
      }
    }
    const track = availableAudioTracks[index];
    const trackName = track ? getAudioTrackLabel(track, index) : `Track ${index + 1}`;
    setDelayToast(`🎧 Audio: ${trackName}`);
  }, [availableAudioTracks, getAudioTrackLabel]);

  // Sync native audioTracks on loadedmetadata
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    const handleAudioTracks = () => {
      if (vid.audioTracks && vid.audioTracks.length > 0) {
        for (let i = 0; i < vid.audioTracks.length; i++) {
          vid.audioTracks[i].enabled = (i === selectedAudioTrack);
        }
      }
    };

    vid.addEventListener('loadedmetadata', handleAudioTracks);
    return () => {
      vid.removeEventListener('loadedmetadata', handleAudioTracks);
    };
  }, [selectedAudioTrack, objectUrl, streamVideoUrl]);

  // Subtitles read out of the video file (picked here or by someone in the room): use and share them
  const pendingSubtitle = fileFormat?.pendingSubtitle;
  useEffect(() => {
    if (!pendingSubtitle?.vttString) return;
    try {
      const parsed = parseSubtitleString(pendingSubtitle.vttString, pendingSubtitle.fileName);
      if (pendingSubtitle.trackNumber !== undefined) {
        parsed.trackNumber = pendingSubtitle.trackNumber;
      }
      shareSubtitles(parsed);
    } catch (err) {
      setSyncStatus('Failed to load the subtitles from the file');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSubtitle?.id]);

  const handleToggleSubtitles = () => {
    if (!subtitles) {
      if (availableSubtitles.length > 0) {
        setShowAudioSettings(false);
        setShowSettings(false);
        setSubtitleTab('tracks');
        setShowSubtitleSettings((prev) => !prev);
        return;
      }
      subtitleFileInputRef.current?.click();
      return;
    }
    setSubtitlesVisible((prev) => !prev);
  };

  const handleRemoveSubtitles = () => {
    if (subtitles?.vttUrl) {
      try { URL.revokeObjectURL(subtitles.vttUrl); } catch (e) { }
    }
    setSubtitles(null);
    setSyncStatus('Subtitles turned off');
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
    clearCurrentSubtitlesAndAudio();
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
    if (isEcho('play')) return;
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
    if (isEcho('pause')) return;
    setSyncStatus('Paused (Synced)');
    if (typeof onBroadcastAction === 'function' && videoRef.current) {
      onBroadcastAction('pause', {
        type: 'local-video-action',
        currentTime: videoRef.current.currentTime
      });
    }
  };

  const handleVideoSeeked = () => {
    if (!videoRef.current || isEcho('seeked')) return;
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
    const vid = videoRef.current;
    if (!vid) return;
    setDurationSec(vid.duration || 0);
    setSyncStatus('Ready to play');
    // Joined while the room was watching: start from where the room is now
    const pending = pendingRoomStateRef.current;
    pendingRoomStateRef.current = null;
    if (!pending) return;
    const target = pending.playing ? pending.time + (Date.now() - pending.at) / 1000 : pending.time;
    if (target > 0.5 && Math.abs(vid.currentTime - target) > 0.8) {
      expectEcho('seeked', 8000);
      vid.currentTime = Math.min(target, Math.max(0, (vid.duration || target) - 0.5));
    }
    if (pending.playing) {
      expectEcho('play');
      vid.play().then(() => setIsPlaying(true)).catch(() => { });
      setSyncStatus(`▶️ Playing with ${pending.sender || 'the room'}`);
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
      vid.play().catch(() => { });
    } else {
      vid.pause();
    }
  };

  const handleSeekDelta = (deltaSec) => {
    const vid = videoRef.current;
    if (!vid) return;
    const target = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + deltaSec));
    expectEcho('seeked', 8000); // broadcast below, not again from the seeked event
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
    expectEcho('seeked', 8000); // broadcast below, not again from the seeked event
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

  const handleSetPlaybackRate = (rate) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
    setShowSettings(false);
    setSyncStatus(`Speed: ${rate}x`);
  };

  const calculateLocalSeekTime = (e) => {
    if (!scrubberTrackRef.current || !durationSec || durationSec <= 0) return 0;
    const rect = scrubberTrackRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * durationSec;
  };

  const handleScrubberMouseDown = (e) => {
    const vid = videoRef.current;
    if (!vid || !durationSec || durationSec <= 0) return;
    isScrubbingRef.current = true;
    setIsScrubbing(true);
    setShowBottomBar(true);
    setIsCursorIdle(false);
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);

    const targetTime = calculateLocalSeekTime(e);
    expectEcho('seeked', 8000); // broadcast below, not again from the seeked event
    vid.currentTime = targetTime;
    setCurrentTimeSec(targetTime);

    const onMouseMove = (moveEvt) => {
      if (!isScrubbingRef.current) return;
      const time = calculateLocalSeekTime(moveEvt);
      expectEcho('seeked', 8000); // broadcast below, not again from the seeked event
      vid.currentTime = time;
      setCurrentTimeSec(time);
    };

    const onMouseUp = (upEvt) => {
      if (!isScrubbingRef.current) return;
      isScrubbingRef.current = false;
      setIsScrubbing(false);
      const finalTime = calculateLocalSeekTime(upEvt);
      expectEcho('seeked', 8000); // broadcast below, not again from the seeked event
      vid.currentTime = finalTime;
      setCurrentTimeSec(finalTime);
      setSyncStatus(`Seeked to ${formatTime(finalTime)} (Synced)`);
      if (typeof onBroadcastAction === 'function') {
        onBroadcastAction('seek', {
          type: 'local-video-action',
          currentTime: finalTime
        });
      }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onMouseMove);
      window.removeEventListener('touchend', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onMouseMove);
    window.addEventListener('touchend', onMouseUp);
  };

  const handleScrubberMouseMove = (e) => {
    if (!scrubberTrackRef.current || !durationSec || durationSec <= 0) return;
    const rect = scrubberTrackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverPreview({ time: ratio * durationSec, percent: ratio * 100 });
  };

  const handleScrubberMouseLeave = () => {
    setHoverPreview(null);
  };

  const handleScrubberChange = (e) => {
    const vid = videoRef.current;
    if (!vid || !durationSec) return;
    const target = parseFloat(e.target.value);
    isScrubbingRef.current = true;
    setShowBottomBar(true);
    setIsCursorIdle(false);
    if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
    expectEcho('seeked', 8000); // broadcast below, not again from the seeked event
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
      try { URL.revokeObjectURL(objectUrl); } catch (e) { }
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
        container.requestFullscreen().catch(() => { });
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => { });
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
        // When entering fullscreen, start clean: hide panels unless cursor is at top/bottom edge
        setPanelsHidden(false);
        const y = lastMousePosRef.current.y;
        const windowHeight = window.innerHeight || window.screen.height || 1080;
        setShowTopBar(y <= 75);
        setShowBottomBar(y >= windowHeight - 90);
        setIsCursorIdle(false);
        if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
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
          const inBottomZone = y >= windowHeight - 90 || isHoveringBottomRef.current;
          const inTopZone = y <= 75 || isHoveringTopRef.current;

          if (inBottomZone) {
            setShowBottomBar(true);
            setShowTopBar(false);
          } else if (inTopZone) {
            setShowTopBar(true);
            setShowBottomBar(false);
          } else if (!showSubtitleSettings && !showSettings && !showAudioSettings) {
            setShowTopBar(false);
            setShowBottomBar(false);
          }
        }
      }
    };

    window.addEventListener('pointerup', handleGlobalPointerUp);
    window.addEventListener('mouseup', handleGlobalPointerUp);
    return () => {
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      window.removeEventListener('mouseup', handleGlobalPointerUp);
    };
  }, [isFullscreen, showSubtitleSettings, showAudioSettings, showSettings]);

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

    // Fullscreen Playback:
    const x = e ? e.clientX : lastMousePosRef.current.x;
    const y = e ? e.clientY : lastMousePosRef.current.y;
    const windowHeight = window.innerHeight || window.screen.height || 1080;
    const windowWidth = window.innerWidth || window.screen.width || 1920;

    const inTopZone = y <= 75;
    // Bottom zone includes bottom bar (90px) OR the reaction emojis dock area
    // (floating dock is at bottom: 86px, height ~42px, right: 20px, width ~380px)
    const inReactionArea = (y >= windowHeight - 165) && (x >= windowWidth - 480);
    const inBottomZone = y >= windowHeight - 90 || inReactionArea || isHoveringReactionRef.current;

    isHoveringTopRef.current = inTopZone;
    isHoveringBottomRef.current = inBottomZone;

    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
    }

    if (inTopZone) {
      if (hidePanelsTimerRef.current) {
        clearTimeout(hidePanelsTimerRef.current);
        hidePanelsTimerRef.current = null;
      }
      setIsCursorIdle(false);
      setShowTopBar(true);
      setShowBottomBar(false);
    } else if (inBottomZone || isScrubbingRef.current || showSubtitleSettings || showSettings || showAudioSettings) {
      if (hidePanelsTimerRef.current) {
        clearTimeout(hidePanelsTimerRef.current);
        hidePanelsTimerRef.current = null;
      }
      setIsCursorIdle(false);
      setShowBottomBar(true);
      setShowTopBar(false);
    } else {
      // Cursor is in video viewing area (out of the panel zones):
      // Don't close immediately in 0ms! Give a gentle grace window (800ms) so moving towards emojis or
      // minor mouse-out does not abruptly close controls under the user!
      setIsCursorIdle(false);
      if (!hidePanelsTimerRef.current) {
        hidePanelsTimerRef.current = setTimeout(() => {
          if (!isHoveringTopRef.current && !isHoveringBottomRef.current && !isHoveringReactionRef.current && !isScrubbingRef.current && !showSubtitleSettings && !showSettings && !showAudioSettings) {
            setShowTopBar(false);
            setShowBottomBar(false);
          }
          hidePanelsTimerRef.current = null;
        }, 800);
      }
      idleTimeoutRef.current = setTimeout(() => {
        setIsCursorIdle(true);
      }, 1800);
    }
  }, [isFullscreen, showSubtitleSettings, showSettings, showAudioSettings, panelsHidden]);

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
      if (hidePanelsTimerRef.current) {
        clearTimeout(hidePanelsTimerRef.current);
        hidePanelsTimerRef.current = null;
      }
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
        if (isPttSpaceActive) {
          // Space is reserved for Push-to-Talk voice transmission
          return;
        }
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
  }, [isMuted, subtitles, isFullscreen, handleToggleAllPanels, isPttSpaceActive, handleToggleSubtitles]);

  const activeVideoSrc = streamVideoUrl || objectUrl;
  const isStreamed = Boolean(streamVideoUrl && !objectUrl);
  const activeFileName = file?.name || remoteMeta?.fileName || streamProgress?.fileName || 'Local Video';

  // Lock screen, notification and headphone controls (Media Session API). The actions go through
  // the normal video events, so they are synced to the room and respect the host controls lock.
  const mediaSessionRef = useRef({});
  mediaSessionRef.current = { seekDelta: handleSeekDelta };
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
    const vid = videoRef.current;
    if (!ms || !vid || !activeVideoSrc) return undefined;
    try {
      ms.metadata = new MediaMetadata({
        title: activeFileName.replace(/\.[a-z0-9]{2,4}$/i, ''),
        artist: '3RTC · watching together',
        artwork: [
          { src: '/icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/pwa-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
    } catch { }
    const actions = {
      play: () => { vid.play().catch(() => { }); },
      pause: () => vid.pause(),
      seekbackward: (d) => mediaSessionRef.current.seekDelta?.(-(d?.seekOffset || 10)),
      seekforward: (d) => mediaSessionRef.current.seekDelta?.(d?.seekOffset || 10),
      // the 'seeked' event that follows broadcasts the new position
      seekto: (d) => {
        if (typeof d?.seekTime === 'number') vid.currentTime = d.seekTime;
      }
    };
    for (const [name, handler] of Object.entries(actions)) {
      try { ms.setActionHandler(name, handler); } catch { }
    }
    let lastPosition = 0;
    const updatePosition = () => {
      const now = Date.now();
      if (now - lastPosition < 1000 || !Number.isFinite(vid.duration) || vid.duration <= 0) return;
      lastPosition = now;
      try {
        ms.setPositionState({ duration: vid.duration, position: Math.min(vid.currentTime, vid.duration), playbackRate: vid.playbackRate || 1 });
      } catch { }
    };
    const onPlayState = () => {
      try { ms.playbackState = vid.paused ? 'paused' : 'playing'; } catch { }
      lastPosition = 0;
      updatePosition();
    };
    vid.addEventListener('timeupdate', updatePosition);
    vid.addEventListener('play', onPlayState);
    vid.addEventListener('pause', onPlayState);
    vid.addEventListener('seeked', onPlayState);
    return () => {
      vid.removeEventListener('timeupdate', updatePosition);
      vid.removeEventListener('play', onPlayState);
      vid.removeEventListener('pause', onPlayState);
      vid.removeEventListener('seeked', onPlayState);
      for (const name of Object.keys(actions)) {
        try { ms.setActionHandler(name, null); } catch { }
      }
      try { ms.metadata = null; ms.playbackState = 'none'; } catch { }
    };
  }, [activeVideoSrc, activeFileName]);
  const activeFileSize = file?.size || remoteMeta?.fileSize || streamProgress?.totalBytes || 0;

  // Case A: User has not loaded their copy of the video file yet AND no active stream URL
  if (!activeVideoSrc) {
    const sender = remoteMeta?.sender || 'A friend';
    return (
      <div
        className={`yt-screen-card local-screen-card rd-offer-wrap ${isDragOver ? 'drag-over' : ''}`}
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

        {remoteMeta ? (
          <div className="rd-offer">
            <div className="rd-offer-file">
              <span className="rd-offer-icon" aria-hidden="true">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" /></svg>
              </span>
              <div className="rd-offer-text">
                <p className="rd-offer-who">{sender} is playing</p>
                <h2 className="rd-offer-name" title={remoteMeta.fileName}>{remoteMeta.fileName}</h2>
                {remoteMeta.fileSize > 0 && <p className="rd-offer-size">{formatFileSize(remoteMeta.fileSize)}</p>}
              </div>
            </div>

            {fileFormat && <FileFormatNotice info={fileFormat} hasSubtitles compact />}

            {!streamProgress ? (
              <div className="rd-offer-actions">
                <button type="button" className="rd-btn rd-btn-primary rd-btn-xl" onClick={onRequestP2PStream}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" /></svg>
                  Stream from {sender}
                </button>
                <button type="button" className="rd-btn rd-btn-secondary rd-btn-xl" onClick={() => fileInputRef.current?.click()}>
                  I have this file
                </button>
                <p className="rd-offer-hint">Streaming sends the video from {sender}’s device to yours. Have the same file? Pick it and nothing needs to be sent.</p>
              </div>
            ) : (
              <div className="rd-offer-progress" role="status" aria-live="polite">
                <div className="rd-offer-progress-row">
                  <span>
                    {streamProgress.isCompleted
                      ? 'Ready to play'
                      : streamProgress.wholeFile
                        ? `Downloading — plays when done${wholeFileEta(streamProgress)}`
                        : streamProgress.isReady
                          ? 'Starting…'
                          : `Getting the video from ${sender}…`}
                  </span>
                  <span className="rd-offer-percent">{streamProgress.percent || 0}%</span>
                </div>
                <div className="rd-offer-track"><div className="rd-offer-fill" style={{ width: `${Math.max(3, streamProgress.percent || 0)}%` }} /></div>
                <p className="rd-offer-metrics">
                  {formatFileSize(streamProgress.receivedBytes || 0)} of {formatFileSize(remoteMeta.fileSize || streamProgress.totalBytes || 0)} · {(streamProgress.speedMBs || 0).toFixed(1)} MB/s
                </p>
                <button type="button" className="rd-btn rd-btn-ghost" onClick={onCancelP2PStream}>Cancel</button>
              </div>
            )}

            <button type="button" className="rd-btn rd-btn-ghost rd-offer-back" onClick={handleExitVideo}>Not now</button>
          </div>
        ) : (
          <div className="rd-offer">
            <div className="rd-offer-file">
              <span className="rd-offer-icon" aria-hidden="true">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
              </span>
              <div className="rd-offer-text">
                <h2 className="rd-offer-name">Play a video from this computer</h2>
                <p className="rd-offer-size">MP4, MKV, WebM · drop it here or choose it</p>
              </div>
            </div>
            <div className="rd-offer-actions">
              <button type="button" className="rd-btn rd-btn-primary rd-btn-xl" onClick={() => fileInputRef.current?.click()}>Choose a video file</button>
            </div>
            <button type="button" className="rd-btn rd-btn-ghost rd-offer-back" onClick={handleExitVideo}>Not now</button>
          </div>
        )}
      </div>
    );
  }

  // Calculate seekbar percentage for CSS gradient progress fill
  const progressPercent = durationSec > 0 ? Math.min(100, Math.max(0, (currentTimeSec / durationSec) * 100)) : 0;

  // Case B: Video is ready and playing (either local file or P2P stream)
  return (
    <div
      ref={playerContainerRef}
      className={`local-fullstage-player ${isPlaying ? 'is-playing' : 'is-paused'} ${isFullscreen ? 'is-fullscreen' : ''} ${isCursorIdle && isFullscreen ? 'hide-cursor' : ''} ${panelsHidden ? 'panels-hidden' : ''} ${(!showBottomBar || panelsHidden) && isFullscreen ? 'controls-hidden' : ''}`}
      style={{ '--rd-progress': `${progressPercent}%` }}
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
            setShowBottomBar(false);
            setIsCursorIdle(false);
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
          }
        }}
        onMouseLeave={() => {
          isHoveringTopRef.current = false;
          if (isFullscreen) {
            setShowTopBar(false);
          }
        }}
      >
        {isStreamed ? (
          <div
            className="local-file-info-pill is-streamed"
            title={`${activeFileName}${streamProgress ? ` · ${(streamProgress.speedMBs || 0).toFixed(1)} MB/s${streamProgress.fromPeersPercent > 0 ? ` · ${streamProgress.fromPeersPercent}% from viewers` : ''}` : ''}`}
          >
            <span className="rd-stream-label">
              {!streamProgress || streamProgress.isCompleted
                ? 'Streamed to you'
                : streamProgress.wholeFile
                  ? `Downloading · ${streamProgress.percent || 0}%${wholeFileEta(streamProgress)}`
                  : `Streaming · ${streamProgress.percent || 0}%`}
            </span>
            <button
              type="button"
              className="local-replace-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Have the same file? Play your own copy (nothing needs to be sent)"
            >
              Use my copy
            </button>
          </div>
        ) : (
          <div className="local-file-info-pill" title={activeFileName}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="#3ea6ff">
              <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
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
              <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z" />
            </svg>
            <span className="local-filename-text">{subtitles.fileName}</span>
            <button
              type="button"
              className="local-replace-btn local-style-btn"
              onClick={(e) => {
                e.stopPropagation();
                setSubtitleTab('style');
                setShowSubtitleSettings(true);
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
        className={`local-video-viewport ${isPlaying ? 'is-playing' : 'is-paused'}`}
        onClick={togglePlayPause}
        onDoubleClick={toggleFullscreen}
      >
        {fileFormat && (
          <div className="file-notice-anchor" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <FileFormatNotice info={fileFormat} hasSubtitles={Boolean(subtitles)} />
          </div>
        )}
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
              <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
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
                    <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="56" height="56" fill="#3ea6ff">
                    <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
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

      {/* Sleek Modern yt-screen-controls-bar (Identical to YouTube Player) */}
      <div
        className={`yt-screen-controls-bar local-screen-controls-bar ${isFullscreen ? (showBottomBar || isScrubbing ? 'visible' : 'hidden') : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setShowTopBar(true);
          setShowBottomBar(true);
          setIsCursorIdle(false);
        }}
        onMouseEnter={() => {
          isHoveringBottomRef.current = true;
          if (isFullscreen) {
            setShowBottomBar(true);
            setShowTopBar(false);
            setIsCursorIdle(false);
            if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
          }
        }}
        onMouseLeave={() => {
          isHoveringBottomRef.current = false;
          if (isFullscreen && !isScrubbingRef.current && !showSubtitleSettings && !showSettings) {
            setShowBottomBar(false);
          }
        }}
      >
        <div className="yt-screen-ctrls-left">
          <button
            type="button"
            className="yt-screen-ctrl-icon yt-play-btn"
            onClick={togglePlayPause}
            aria-label={isPlaying ? 'Pause for everyone' : 'Play for everyone'}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            className="yt-screen-ctrl-icon rd-skip-btn"
            onClick={() => handleSeekDelta(-10)}
            aria-label="Back 10 seconds"
            title="Back 10 seconds (←)"
          >
            −10
          </button>
          <span className="yt-screen-time-text rd-time-now">{formatTime(currentTimeSec)}</span>
        </div>

        {/* Center: Interactive Scrubber Timeline */}
        <div
          ref={scrubberTrackRef}
          className="yt-screen-scrubber-track interactive"
          onMouseDown={handleScrubberMouseDown}
          onTouchStart={handleScrubberMouseDown}
          onMouseMove={handleScrubberMouseMove}
          onMouseLeave={handleScrubberMouseLeave}
        >
          <div
            className="yt-screen-scrubber-fill"
            style={{ width: `${progressPercent}%` }}
          />
          <ScrubberReactionHeatmap
            durationSec={durationSec}
            currentTimeSec={currentTimeSec}
            feed={reactionFeed}
          />
          {hoverPreview && (
            <div
              className="yt-scrubber-hover-preview"
              style={{ left: `${hoverPreview.percent}%` }}
            >
              {formatTime(hoverPreview.time)}
            </div>
          )}
        </div>

        <div className="yt-screen-ctrls-right">
          <span className="yt-screen-time-text rd-time-total">{formatTime(durationSec)}</span>
          {/* Volume Control Group */}
          <div className="yt-volume-control-group rd-volume">
            <button
              type="button"
              className="yt-screen-ctrl-icon yt-vol-btn"
              onClick={toggleMute}
              aria-label={isMuted ? 'Unmute video' : 'Mute video'}
              title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
            >
              {isMuted || volume === 0 ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                </svg>
              ) : volume < 0.5 ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                </svg>
              )}
            </button>
            <div className="yt-volume-slider-wrapper visible">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="yt-volume-slider"
                style={{
                  background: `linear-gradient(to right, #e5143d 0%, #e5143d ${(isMuted ? 0 : volume) * 100}%, rgba(255, 255, 255, 0.25) ${(isMuted ? 0 : volume) * 100}%, rgba(255, 255, 255, 0.25) 100%)`
                }}
                title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
              />
            </div>
          </div>



          {/* Feature 1.5: Subtitles Control Group (Independent Toggle + Available Video Subtitles + Appearance & Delay Settings) */}
          <div className="local-subtitle-control-group" ref={subtitleSettingsRef}>
            <button
              type="button"
              className={`local-icon-button local-cc-button ${subtitles ? (subtitlesVisible ? 'active' : 'off') : (availableSubtitles.length > 0 ? 'has-tracks' : 'no-subtitles')}`}
              onClick={handleToggleSubtitles}
              aria-label={subtitles ? (subtitlesVisible ? 'Hide subtitles' : 'Show subtitles') : 'Subtitles'}
              title={
                subtitles
                  ? (subtitlesVisible
                    ? `Subtitles: ON (${subtitles.fileName}) • Click to hide (C)`
                    : `Subtitles: OFF (${subtitles.fileName}) • Click to show (C)`)
                  : availableSubtitles.length > 0
                    ? `Subtitles available from video (${availableSubtitles.length} tracks) • Click to open`
                    : 'Load Subtitles (.srt / .vtt) by drag & drop or click'
              }
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z" />
              </svg>
              {subtitles ? (
                <span className={`local-cc-badge ${subtitlesVisible ? 'badge-on' : 'badge-off'}`}>
                  {subtitlesVisible ? 'ON' : 'OFF'}
                </span>
              ) : availableSubtitles.length > 0 ? (
                <span className="local-cc-badge badge-available">
                  {availableSubtitles.filter(canExtract).length || availableSubtitles.length}
                </span>
              ) : null}
            </button>

            {/* Subtitle Appearance & Timing Settings Button (visible if subtitles loaded OR video has available subtitles) */}
            {(subtitles || availableSubtitles.length > 0) && (
              <button
                type="button"
                className={`local-icon-button local-sub-settings-btn ${showSubtitleSettings ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAudioSettings(false);
                  setShowSettings(false);
                  setShowSubtitleSettings((prev) => {
                    const next = !prev;
                    if (next && !subtitles) {
                      setSubtitleTab('tracks');
                    }
                    return next;
                  });
                }}
                title="Subtitle Tracks & Appearance Settings"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" className="sub-settings-gear-icon">
                  <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
                </svg>
                <span className="sub-settings-btn-icon">Aa</span>
              </button>
            )}

            {/* Glassmorphic Subtitle Appearance & Timing Settings Popover Card */}
            {showSubtitleSettings && (
              <div
                className="sub-settings-popover"
                style={{ maxHeight: `${popoverMaxHeight}px` }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {/* Fixed Sticky Header */}
                <div className="sub-settings-header">
                  <div className="sub-settings-title">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="#3ea6ff">
                      <path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z" />
                    </svg>
                    <span>Subtitles & Captions</span>
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

                {/* Tab Navigation Switcher */}
                <div className="sub-settings-tabs">
                  <button
                    type="button"
                    className={`sub-tab-btn ${subtitleTab === 'tracks' ? 'active' : ''}`}
                    onClick={() => setSubtitleTab('tracks')}
                  >
                    <span>Tracks</span>
                    {availableSubtitles.length > 0 && (
                      <span className="sub-tab-count">{availableSubtitles.length}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`sub-tab-btn ${subtitleTab === 'style' ? 'active' : ''}`}
                    onClick={() => setSubtitleTab('style')}
                  >
                    <span>Style & Timing</span>
                    {subtitleDelay !== 0 && (
                      <span className="sub-tab-badge">
                        {subtitleDelay > 0 ? `+${subtitleDelay.toFixed(1)}s` : `${subtitleDelay.toFixed(1)}s`}
                      </span>
                    )}
                  </button>
                </div>

                {/* Scrollable Body */}
                <div className="sub-settings-body">
                  {subtitleTab === 'tracks' ? (
                    <>
                      {/* Subtitle Tracks Section */}
                      <div className="sub-settings-section">
                        <div className="sub-section-header">
                          <span className="sub-section-title">CHOOSE TRACK</span>
                        </div>

                        <div className="sub-track-list">
                          {/* Option: Off */}
                          <button
                            type="button"
                            className={`sub-track-item ${(!subtitles || !subtitlesVisible) ? 'active' : ''}`}
                            onClick={() => {
                              if (subtitles) handleRemoveSubtitles();
                              else setSubtitlesVisible(false);
                            }}
                          >
                            <span className="sub-track-radio">{(!subtitles || !subtitlesVisible) ? '●' : '○'}</span>
                            <div className="sub-track-info">
                              <span className="sub-track-name">Off (No Subtitles)</span>
                            </div>
                            {(!subtitles || !subtitlesVisible) && <span className="sub-track-check">✓</span>}
                          </button>

                          {/* Available Subtitle Tracks from Video */}
                          {availableSubtitles.map((t) => {
                            const extractable = canExtract(t);
                            const isExtracting = fileFormat?.job?.track === t.number;
                            const isTrackActive = subtitles && subtitlesVisible && (
                              subtitles.trackNumber === t.number ||
                              (subtitles.fileName && subtitles.fileName.startsWith(subtitleTrackLabel(t).replace(/ · .*$/, '')))
                            );

                            return (
                              <button
                                key={t.number}
                                type="button"
                                className={`sub-track-item ${isTrackActive ? 'active' : ''} ${isExtracting ? 'is-extracting' : ''}`}
                                disabled={!extractable || Boolean(isExtracting && !fileFormat?.job?.error)}
                                onClick={() => handleSelectEmbeddedSubtitle(t.number)}
                                title={extractable ? subtitleTrackLabel(t) : `${subtitleTrackLabel(t)} (Image subtitles not supported in browser)`}
                              >
                                <span className="sub-track-radio">{isTrackActive ? '●' : '○'}</span>
                                <div className="sub-track-info">
                                  <span className="sub-track-name">{subtitleTrackLabel(t)}</span>
                                  {isExtracting ? (
                                    <span className="sub-track-extracting">
                                      {fileFormat.job.asked && !fileFormat.job.progress
                                        ? 'Requesting subtitles…'
                                        : `Extracting ${Math.round((fileFormat.job.progress || 0) * 100)}%`}
                                    </span>
                                  ) : !extractable ? (
                                    <span className="sub-track-codec">Picture subtitle (not supported)</span>
                                  ) : null}
                                </div>
                                {isTrackActive && <span className="sub-track-check">✓</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Custom Subtitle File Section */}
                      <div className="sub-settings-section">
                        <div className="sub-section-header">
                          <span className="sub-section-title">EXTERNAL FILE (.SRT / .VTT)</span>
                        </div>
                        {subtitles && subtitles.trackNumber === undefined ? (
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
                        ) : (
                          <button
                            type="button"
                            className="sub-action-load-btn"
                            onClick={() => subtitleFileInputRef.current?.click()}
                          >
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                            </svg>
                            Load Custom Subtitle File (.SRT / .VTT)
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Subtitle Appearance & Timing Settings */}
                      {(!subtitles || !subtitlesVisible) && (
                        <div className="sub-hint" style={{ padding: '6px 10px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px', color: '#94a3b8', fontSize: '0.72rem' }}>
                          💡 Subtitles are currently Off. Appearance and timing apply when a track is active.
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
                    </>
                  )}
                </div>

                <div className="sub-settings-footer">
                  <span>✓ Subtitle selection is shared • Styling and delay are local</span>
                </div>
              </div>
            )}
          </div>

          {/* Audio Tracks Control Group (if video has more than 1 audio track) */}
          {hasMultipleAudio && (
            <div className="local-audio-control-group" ref={audioSettingsRef}>
              <button
                type="button"
                className={`local-icon-button local-audio-btn ${showAudioSettings ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowSubtitleSettings(false);
                  setShowSettings(false);
                  setShowAudioSettings((prev) => !prev);
                }}
                title={`Audio Tracks (${availableAudioTracks.length} available) • Current: ${getAudioTrackLabel(availableAudioTracks[selectedAudioTrack], selectedAudioTrack)}`}
                aria-label="Audio Tracks"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z" />
                </svg>
                <span className="local-audio-badge">
                  {availableAudioTracks[selectedAudioTrack]?.language ? availableAudioTracks[selectedAudioTrack].language.slice(0, 3).toUpperCase() : (selectedAudioTrack + 1)}
                </span>
              </button>

              {showAudioSettings && (
                <div
                  className="sub-settings-popover audio-settings-popover"
                  style={{ maxHeight: `${popoverMaxHeight}px` }}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="sub-settings-header">
                    <div className="sub-settings-title">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="#3ea6ff">
                        <path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z" />
                      </svg>
                      <span>Audio Tracks ({availableAudioTracks.length})</span>
                    </div>
                    <button
                      type="button"
                      className="sub-close-btn"
                      onClick={() => setShowAudioSettings(false)}
                      title="Close audio settings"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="sub-settings-body">
                    <div className="sub-settings-section">
                      <div className="sub-section-header">
                        <span className="sub-section-title">SELECT AUDIO STREAM</span>
                      </div>
                      <div className="audio-track-list">
                        {availableAudioTracks.map((track, idx) => {
                          const isSelected = selectedAudioTrack === idx;
                          return (
                            <button
                              key={idx}
                              type="button"
                              className={`audio-track-item ${isSelected ? 'active' : ''}`}
                              onClick={() => handleSelectAudioTrack(idx)}
                            >
                              <span className="audio-track-radio">{isSelected ? '●' : '○'}</span>
                              <div className="audio-track-info">
                                <span className="audio-track-name">{getAudioTrackLabel(track, idx)}</span>
                                {track.codec && (
                                  <span className="audio-track-codec">{track.codec.toUpperCase()}</span>
                                )}
                              </div>
                              {isSelected && <span className="audio-track-check">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="sub-settings-footer">
                    <span>
                      {videoRef.current?.audioTracks && videoRef.current.audioTracks.length > 0
                        ? '✓ Native audio switching enabled'
                        : '🎧 Multi-track audio stream selector'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Playback Settings Menu (Identical to YouTube Player) */}
          <div className="yt-settings-container" ref={settingsRef}>
            <button
              type="button"
              className={`yt-screen-ctrl-icon yt-settings-btn ${showSettings ? 'active' : ''}`}
              onClick={() => {
                setShowSubtitleSettings(false);
                setShowAudioSettings(false);
                setShowSettings(!showSettings);
              }}
              title="Playback Settings & Sync"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
            </button>

            {showSettings && (
              <div className="yt-settings-menu">
                <div className="yt-settings-header">Playback Settings</div>

                <div className="yt-settings-section">
                  <div className="yt-settings-label">Playback Speed</div>
                  <div className="yt-speed-options">
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        className={`yt-speed-btn ${playbackRate === rate ? 'active' : ''}`}
                        onClick={() => handleSetPlaybackRate(rate)}
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>
                </div>

                {hasMultipleAudio && (
                  <>
                    <div className="yt-settings-divider" />
                    <div className="yt-settings-section">
                      <div className="yt-settings-label">Audio Track</div>
                      <div className="audio-track-list">
                        {availableAudioTracks.map((track, idx) => {
                          const isSelected = selectedAudioTrack === idx;
                          return (
                            <button
                              key={idx}
                              type="button"
                              className={`audio-track-item ${isSelected ? 'active' : ''}`}
                              onClick={() => handleSelectAudioTrack(idx)}
                            >
                              <span className="audio-track-radio">{isSelected ? '●' : '○'}</span>
                              <div className="audio-track-info">
                                <span className="audio-track-name">{getAudioTrackLabel(track, idx)}</span>
                              </div>
                              {isSelected && <span className="audio-track-check">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}

                <div className="yt-settings-divider" />

                <div className="yt-settings-actions">
                  <button
                    type="button"
                    className="yt-menu-action-btn"
                    onClick={() => {
                      if (videoRef.current) {
                        videoRef.current.currentTime = 0;
                        setCurrentTimeSec(0);
                        if (isP2PConnected) onBroadcastAction('seek', { currentTime: 0 });
                      }
                      setShowSettings(false);
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                      <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                    </svg>
                    <span>Restart (0:00)</span>
                  </button>
                  {isP2PConnected && (
                    <button
                      type="button"
                      className="yt-menu-action-btn"
                      onClick={() => {
                        const cur = videoRef.current?.currentTime || 0;
                        onBroadcastAction('syncPulse', { currentTime: cur, isPlaying });
                        setShowSettings(false);
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="#00e676">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                      </svg>
                      <span>Sync Pulse with Peers</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="yt-menu-action-btn"
                    onClick={() => { setShowSettings(false); handleToggleAllPanels(); }}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                      <path d="M19 4H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H5V6h14v12z" />
                    </svg>
                    <span>Cinema view (H)</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Fullscreen Button */}
          <button
            type="button"
            className="yt-screen-ctrl-icon"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
            title={isFullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
          >
            {isFullscreen ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            )}
          </button>
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
            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
          </svg>
          <span>Show Panels</span>
          <span className="local-hotkey-badge">H</span>
        </button>
      )}

      {/* Floating Live Reactions in Fullscreen */}
      {isFullscreen && typeof onSendReaction === 'function' && (
        <div
          className="fullscreen-reaction-wrapper"
          onMouseEnter={() => {
            isHoveringReactionRef.current = true;
            if (hidePanelsTimerRef.current) {
              clearTimeout(hidePanelsTimerRef.current);
              hidePanelsTimerRef.current = null;
            }
            setShowBottomBar(true);
            setIsCursorIdle(false);
          }}
          onMouseLeave={() => {
            isHoveringReactionRef.current = false;
            if (!hidePanelsTimerRef.current) {
              hidePanelsTimerRef.current = setTimeout(() => {
                if (!isHoveringTopRef.current && !isHoveringBottomRef.current && !isHoveringReactionRef.current && !isScrubbingRef.current && !showSubtitleSettings && !showSettings) {
                  setShowTopBar(false);
                  setShowBottomBar(false);
                }
                hidePanelsTimerRef.current = null;
              }, 800);
            }
          }}
        >
          <FloatingReactions
            feed={reactionFeed}
            onSendReaction={handleSendReactionWithTime}
            showDock={Boolean(roomId)}
            hasMedia={true}
          />
        </div>
      )}
    </div>
  );
}
