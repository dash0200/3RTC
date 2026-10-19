import { useRef, useEffect, useState, useCallback } from 'react';
import { Icon } from '../icons';
import ScreenPointerOverlay from './ScreenPointerOverlay';

export interface ScreenShareStageProps {
  stream?: MediaStream | null;
  isLocal?: boolean;
  presenterName?: string;
  hasAudio?: boolean;
  onStopSharing?: () => void;
  onExit?: () => void;
  roomId?: string | null;
  bus?: any;
  localUser?: any;
}

/**
 * ScreenShareStage: Ultra-clean, hardware-accelerated WebRTC Screen Sharing stage.
 * Features:
 * - Completely obstacle-free viewing with auto-hiding top-right controls
 * - Prevents infinite loop on presenter's screen via clean Presenter Slate (Google Meet style)
 * - Ultra-low-latency 60FPS video viewport with aspect ratio preservation
 * - Live collaborative colored cursors & small droplet ripple pings
 * - Picture-in-Picture (PiP) and Fullscreen support
 * - Instant "Stop Sharing" and "Exit" actions
 */
export default function ScreenShareStage({
  stream,
  isLocal = false,
  presenterName = 'Peer',
  hasAudio = false,
  onStopSharing,
  onExit,
  roomId: _roomId,
  bus,
  localUser
}: ScreenShareStageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPipActive, setIsPipActive] = useState(false);
  const [isLaserActive, setIsLaserActive] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const hideTimeoutRef = useRef<any>(null);

  // Attach stream to HTML5 video element (only if viewer or presenter enabled preview)
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    if (stream && (!isLocal || showPreview)) {
      vid.srcObject = stream;
      vid.play().catch(() => {});
    } else {
      vid.srcObject = null;
    }

    return () => {
      if (vid) vid.srcObject = null;
    };
  }, [stream, isLocal, showPreview]);

  // Handle Picture-in-Picture mode
  const togglePip = useCallback(async () => {
    const vid = videoRef.current;
    if (!vid) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPipActive(false);
      } else if (document.pictureInPictureEnabled) {
        await vid.requestPictureInPicture();
        setIsPipActive(true);
      }
    } catch (err) {
      console.error('[ScreenShare] PiP error:', err);
    }
  }, []);

  // Handle Fullscreen mode (supports desktop, Android, and iPhone Safari)
  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    const vid = videoRef.current;
    if (!container) return;

    const isCurrentlyFullscreen = Boolean(
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement ||
      (vid as any)?.webkitDisplayingFullscreen
    );

    if (!isCurrentlyFullscreen) {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      } else if ((container as any).webkitRequestFullscreen) {
        (container as any).webkitRequestFullscreen().catch(() => {});
      } else if (vid && (vid as any).webkitEnterFullscreen) {
        // iPhone Safari full-screen video fallback
        (vid as any).webkitEnterFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen().catch(() => {});
      } else if (vid && (vid as any).webkitExitFullscreen) {
        (vid as any).webkitExitFullscreen();
      }
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const vid = videoRef.current;
      setIsFullscreen(Boolean(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (vid as any)?.webkitDisplayingFullscreen
      ));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Auto-hide controls when mouse is idle (leaves screen completely unobstructed)
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
    }, 2200);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    setShowControls(false);
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  // Presenter mode: show sleek Presenter Slate to prevent infinite mirror loop
  if (isLocal && !showPreview) {
    return (
      <div ref={containerRef} className="screen-share-stage is-presenter-mode">
        <div className="screen-presenter-slate">
          <div className="screen-presenter-card">
            <div className="screen-presenter-icon-wrap">
              <svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span className="screen-presenter-beam" />
            </div>

            <h2 className="screen-presenter-title">You are sharing your screen</h2>
            <p className="screen-presenter-desc">
              Peers in this room can see your live display in HD.<br />
              Switch to any window, tab, or app to present.
            </p>

            <div className="screen-presenter-actions">
              <button
                type="button"
                className="screen-presenter-stop-btn"
                onClick={onStopSharing}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
                <span>Stop Sharing</span>
              </button>

              <button
                type="button"
                className="screen-presenter-preview-btn"
                onClick={() => setShowPreview(true)}
                title="View stream preview"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span>View Stream</span>
              </button>
            </div>

            <div className="screen-presenter-tip">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
              </svg>
              <span>Live preview is hidden here to avoid the infinite loop mirror effect.</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`screen-share-stage ${isFullscreen ? 'is-fullscreen' : ''}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Auto-Hiding Top-Right Action Controls (leaves screen completely unobstructed) */}
      <div className={`screen-share-actions-bar ${showControls ? 'visible' : 'hidden'}`}>
        {hasAudio && (
          <span className="screen-share-audio-badge" title="Sharing system/tab audio">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
            </svg>
            Audio
          </span>
        )}

        {isLocal && showPreview && (
          <button
            type="button"
            className="screen-share-btn screen-share-hide-preview-btn"
            onClick={() => setShowPreview(false)}
            title="Hide preview to prevent infinite mirror"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
            <span>Hide Preview</span>
          </button>
        )}

        <button
          type="button"
          className={`screen-share-btn ${isLaserActive ? 'laser-btn-active' : ''}`}
          onClick={() => setIsLaserActive((prev) => !prev)}
          title={isLaserActive ? 'Turn off Remote Pointer' : 'Turn on Remote Pointer (Click to ping)'}
          aria-label="Toggle Remote Pointer"
        >
          <Icon name="laserPointer" size={17} />
        </button>

        {typeof document !== 'undefined' && Boolean(document.pictureInPictureEnabled) && (
          <button
            type="button"
            className={`screen-share-btn ${isPipActive ? 'active' : ''}`}
            onClick={togglePip}
            title="Picture in Picture (Floating window)"
            aria-label="Picture in picture"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.99h18v14.02z" />
            </svg>
          </button>
        )}

        <button
          type="button"
          className="screen-share-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          aria-label="Toggle Fullscreen"
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

        {isLocal ? (
          <button
            type="button"
            className="screen-share-stop-btn"
            onClick={onStopSharing}
            title="Stop sharing your screen"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="button"
            className="screen-share-exit-btn"
            onClick={onExit}
            title="Exit screen share view"
            aria-label="Exit screen share view"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            <span>Exit</span>
          </button>
        )}
      </div>

      {/* Video Viewport (100% unobstructed) */}
      <div className="screen-share-viewport" ref={viewportRef}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className="screen-share-video-el"
        />

        {!stream && !isLocal && (
          <div className="screen-share-connecting-state">
            <span className="rd-spinner" />
            <span>Connecting to {presenterName}&apos;s screen…</span>
          </div>
        )}

        {/* Collaborative Laser Pointer & Click Ping Overlay */}
        <ScreenPointerOverlay
          videoRef={videoRef}
          containerRef={viewportRef}
          bus={bus}
          localUser={localUser}
          isLaserActive={isLaserActive}
        />
      </div>
    </div>
  );
}
