import React, { useState, useEffect, useCallback } from 'react';
import { formatFileSize, safeImageDownloadName } from '../utils/p2pImageShare';

export default function ImageLightboxModal({
  isOpen,
  image = null,
  onClose
}) {
  const [zoomLevel, setZoomLevel] = useState(1);
  const [isCopied, setIsCopied] = useState(false);

  // Reset zoom on open/change
  useEffect(() => {
    if (isOpen) {
      setZoomLevel(1);
      setIsCopied(false);
    }
  }, [isOpen, image]);

  // Keyboard navigation: Escape to close, + / - to zoom
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        setZoomLevel((prev) => Math.min(3, +(prev + 0.25).toFixed(2)));
      } else if (e.key === '-' || e.key === '_') {
        setZoomLevel((prev) => Math.max(0.5, +(prev - 0.25).toFixed(2)));
      } else if (e.key === '0') {
        setZoomLevel(1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleZoomIn = () => {
    setZoomLevel((prev) => Math.min(3, +(prev + 0.25).toFixed(2)));
  };

  const handleZoomOut = () => {
    setZoomLevel((prev) => Math.max(0.5, +(prev - 0.25).toFixed(2)));
  };

  const handleResetZoom = () => {
    setZoomLevel(1);
  };

  const handleToggleZoom = () => {
    setZoomLevel((prev) => (prev > 1 ? 1 : 2));
  };

  const handleDownload = () => {
    if (!image?.url) return;
    const a = document.createElement('a');
    a.href = image.url;
    a.download = safeImageDownloadName(image.name, image.mimeType || image.blob?.type);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleCopyImage = async () => {
    if (!image) return;

    try {
      if (image.blob && window.ClipboardItem && navigator.clipboard?.write) {
        // Direct binary blob copying
        const itemType = image.blob.type || 'image/png';
        const clipboardItem = new ClipboardItem({ [itemType]: image.blob });
        await navigator.clipboard.write([clipboardItem]);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
        return;
      }
    } catch (e) {
      // Fallback: copy image URL
    }

    if (image.url && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(image.url);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (err) { }
    }
  };

  if (!isOpen || !image) return null;

  const date = new Date(image.timestamp || Date.now());
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <div
      className="image-lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="High Resolution Image Preview"
      onClick={onClose}
    >
      <div className="image-lightbox-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header Bar */}
        <div className="lightbox-header">
          <div className="lightbox-meta">
            <div className="lightbox-icon-wrap">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
              </svg>
            </div>
            <div className="lightbox-title-group">
              <div className="lightbox-filename" title={image.name || 'Image'}>
                {image.name || 'Shared Image'}
              </div>
              <div className="lightbox-submeta">
                <span className="lightbox-size">{formatFileSize(image.size)}</span>
                <span className="lightbox-dot">•</span>
                <span className="lightbox-sender">
                  Shared by <strong>{image.sender || 'Peer'}</strong>
                </span>
                <span className="lightbox-dot">•</span>
                <span className="lightbox-time">{timeStr}</span>
              </div>
            </div>
          </div>

          {/* Action Toolbar */}
          <div className="lightbox-actions">
            {/* Zoom Controls */}
            <div className="lightbox-zoom-group">
              <button
                type="button"
                className="lightbox-tool-btn"
                onClick={handleZoomOut}
                disabled={zoomLevel <= 0.5}
                title="Zoom Out (-)"
                aria-label="Zoom Out"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M19 13H5v-2h14v2z" />
                </svg>
              </button>
              <button
                type="button"
                className="lightbox-zoom-label-btn"
                onClick={handleResetZoom}
                title="Reset Zoom (0)"
              >
                {Math.round(zoomLevel * 100)}%
              </button>
              <button
                type="button"
                className="lightbox-tool-btn"
                onClick={handleZoomIn}
                disabled={zoomLevel >= 3}
                title="Zoom In (+)"
                aria-label="Zoom In"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                </svg>
              </button>
            </div>

            {/* Copy Button */}
            <button
              type="button"
              className={`lightbox-btn ${isCopied ? 'copied' : ''}`}
              onClick={handleCopyImage}
              title="Copy Image to Clipboard"
            >
              {isCopied ? (
                <>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
                  </svg>
                  <span>Copy</span>
                </>
              )}
            </button>

            {/* Download Button */}
            <button
              type="button"
              className="lightbox-btn primary"
              onClick={handleDownload}
              title="Download image in full resolution"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z" />
              </svg>
              <span>Save</span>
            </button>

            {/* Close Button */}
            <button
              type="button"
              className="lightbox-close-btn"
              onClick={onClose}
              title="Close Preview (Esc)"
              aria-label="Close Preview"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Viewport & Full-resolution Image */}
        <div className="lightbox-viewport" onDoubleClick={handleToggleZoom}>
          <div
            className="lightbox-image-stage"
            style={{ transform: `scale(${zoomLevel})` }}
          >
            <img
              src={image.url}
              alt={image.name || 'High resolution view'}
              className="lightbox-main-img"
              draggable={false}
            />
          </div>
        </div>

        {/* Caption Bar (if present) */}
        {image.caption && (
          <div className="lightbox-caption-bar">
            <span className="caption-tag">Caption:</span>
            <span className="caption-text">{image.caption}</span>
          </div>
        )}
      </div>
    </div>
  );
}
