import React, { useState, useEffect, useRef, useMemo } from 'react';
import { generateQrMatrix, drawQrToCanvas, getMobileJoinUrl, getServerTag } from '../utils/qrCode';
import { copyToClipboard } from '../utils/clipboard';

export default function QrCodeModal({
  isOpen,
  onClose,
  roomId = '',
  username = '',
  signalUrl = ''
}) {
  const canvasRef = useRef(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [shareSuccess, setShareSuccess] = useState(false);

  // LAN Helper state
  const isLocalhost = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '[::1]'
  );
  const [customHost, setCustomHost] = useState('');
  const [showLanHelper, setShowLanHelper] = useState(isLocalhost);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Compute final join URL
  const joinUrl = useMemo(() => {
    return getMobileJoinUrl(roomId, customHost.trim() || null, username, getServerTag(signalUrl));
  }, [roomId, customHost, username, signalUrl]);

  // Render QR Code onto canvas
  useEffect(() => {
    if (!isOpen || !canvasRef.current || !roomId) return;
    try {
      drawQrToCanvas(canvasRef.current, joinUrl, {
        cellSize: 7,
        margin: 3,
        darkColor: '#0a0d14',
        lightColor: '#ffffff'
      });
    } catch (e) {
      console.error('Failed to draw QR code:', e);
    }
  }, [isOpen, joinUrl, roomId]);

  if (!isOpen || !roomId) return null;

  // Copy full join link to clipboard
  const handleCopyLink = async () => {
    const success = await copyToClipboard(joinUrl);
    if (success) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2200);
    }
  };

  // Download QR code as PNG image
  const handleDownloadQr = () => {
    if (!canvasRef.current) return;
    try {
      const dataUrl = canvasRef.current.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `3RTC-Room-${roomId}-QR.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 2000);
    } catch (e) {
      console.error('Download failed:', e);
    }
  };

  // Web Share API (native mobile/desktop share sheet)
  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Join 3RTC Room ${roomId}`,
          text: `Join my 3RTC Watch Party room (${roomId})! Scan or click to join directly.`,
          url: joinUrl
        });
        setShareSuccess(true);
        setTimeout(() => setShareSuccess(false), 2000);
      } catch (err) {
        if (err.name !== 'AbortError') {
          handleCopyLink();
        }
      }
    } else {
      handleCopyLink();
    }
  };

  return (
    <div
      className="qr-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Instant Mobile Join QR Code"
      onClick={onClose}
    >
      <div className="qr-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="qr-modal-header">
          <div className="qr-header-title-wrap">
            <div className="qr-icon-pill">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M4 4h6v6H4zm2 2v2h2V6zm8-2h6v6h-6zm2 2v2h2V6zM4 14h6v6H4zm2 2v2h2v-2zm10 0h2v2h-2zm-2 2h2v2h-2zm4 0h2v2h-2zm0-4h2v2h-2zm-4-2h2v2h-2zm2 2h2v2h-2z" />
              </svg>
            </div>
            <div>
              <h2 className="qr-modal-title">Instant Mobile Join</h2>
              <p className="qr-modal-subtitle">Scan with smartphone camera to connect to Room {roomId}</p>
            </div>
          </div>

          <button
            type="button"
            className="qr-close-btn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* QR Code Presentation Box */}
        <div className="qr-code-presentation">
          <div className="qr-canvas-frame">
            <div className="qr-corner-bracket top-left" />
            <div className="qr-corner-bracket top-right" />
            <div className="qr-corner-bracket bottom-left" />
            <div className="qr-corner-bracket bottom-right" />

            <div className="qr-canvas-inner">
              <canvas
                ref={canvasRef}
                className="qr-canvas"
                title={`QR Code for 3RTC Room ${roomId}`}
              />
              <div className="qr-center-logo-pill">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="#e5143d">
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                </svg>
                <span>3RTC</span>
              </div>
            </div>
          </div>

          {/* Room PIN Highlight Badge */}
          <div className="qr-room-badge-row">
            <span className="qr-badge-label">ROOM PIN:</span>
            <span className="qr-badge-digits">{roomId}</span>
            <span className="qr-badge-hint">• No app installation required</span>
          </div>
        </div>

        {/* Shareable Link Bar */}
        <div className="qr-link-section">
          <div className="qr-link-box">
            <span className="qr-link-url" title={joinUrl}>{joinUrl}</span>
            <button
              type="button"
              className={`qr-btn-copy ${copiedLink ? 'copied' : ''}`}
              onClick={handleCopyLink}
              title="Copy link to clipboard"
            >
              {copiedLink ? (
                <>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="#00e676">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
                  </svg>
                  <span>Copy Link</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Localhost / LAN IP Accordion for Testing */}
        {isLocalhost && (
          <div className="qr-lan-section">
            <button
              type="button"
              className="qr-lan-toggle"
              onClick={() => setShowLanHelper((prev) => !prev)}
            >
              <span className="lan-info-icon">💡</span>
              <span className="lan-toggle-text">Testing on Wi-Fi / Local Network?</span>
              <span className="lan-toggle-arrow">{showLanHelper ? '▲' : '▼'}</span>
            </button>

            {showLanHelper && (
              <div className="qr-lan-content">
                <p className="qr-lan-desc">
                  Phone cameras cannot open <code>localhost</code>. If you are on the same Wi-Fi, enter your PC's local LAN IP:
                </p>
                <div className="qr-lan-input-row">
                  <input
                    type="text"
                    className="qr-lan-input"
                    placeholder="e.g. http://192.168.1.5:5173"
                    value={customHost}
                    onChange={(e) => setCustomHost(e.target.value)}
                  />
                  {customHost && (
                    <button
                      type="button"
                      className="qr-lan-clear-btn"
                      onClick={() => setCustomHost('')}
                      title="Reset to default origin"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Action Buttons Footer */}
        <div className="qr-modal-actions">
          <button
            type="button"
            className="qr-action-btn secondary"
            onClick={handleDownloadQr}
            title="Download QR code image for printing or sharing"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
            </svg>
            <span>{downloadSuccess ? 'Downloaded!' : 'Download Image'}</span>
          </button>

          {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
            <button
              type="button"
              className="qr-action-btn secondary"
              onClick={handleNativeShare}
              title="Share room invitation using system share menu"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z" />
              </svg>
              <span>{shareSuccess ? 'Shared!' : 'Share Room'}</span>
            </button>
          )}

          <button
            type="button"
            className="qr-action-btn primary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
