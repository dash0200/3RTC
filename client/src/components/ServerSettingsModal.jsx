import React, { useState, useEffect, useRef } from 'react';

const ORACLE_URL = 'wss://orc.3rtc.me';
const GCP_URL = 'wss://gcp.3rtc.me';
const LOCAL_URL = 'ws://localhost:8080';

export default function ServerSettingsModal({ isOpen, onClose, currentUrl, onApply }) {
  const [url, setUrl] = useState(currentUrl);
  const modalCardRef = useRef(null);
  const prevActiveElementRef = useRef(null);

  useEffect(() => {
    setUrl(currentUrl);
  }, [currentUrl, isOpen]);

  // Focus trapping and restoring for accessibility (UX-M05)
  useEffect(() => {
    if (!isOpen) return;
    prevActiveElementRef.current = document.activeElement;

    const card = modalCardRef.current;
    if (card) {
      const focusables = card.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        card.focus();
      }
    }

    const handleTabKey = (e) => {
      if (e.key !== 'Tab') return;
      const card = modalCardRef.current;
      if (!card) return;
      const focusables = Array.from(card.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ));
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || !card.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !card.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleTabKey);
    return () => {
      window.removeEventListener('keydown', handleTabKey);
      if (prevActiveElementRef.current && typeof prevActiveElementRef.current.focus === 'function') {
        prevActiveElementRef.current.focus();
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePreset = (presetUrl) => {
    setUrl(presetUrl);
  };

  const handleSave = () => {
    const clean = url.trim();
    if (clean) {
      onApply(clean);
      onClose();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="server-settings-title"
    >
      <div className="modal-card" ref={modalCardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title" id="server-settings-title">Signaling Server Connection</div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close settings">&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-desc">
            Configure the WebSocket signaling server used to negotiate WebRTC offers, answers, and ICE candidates.
          </p>

          <div className="quick-servers">
            <button
              type="button"
              className={`server-preset-btn ${url === ORACLE_URL ? 'active' : ''}`}
              onClick={() => handlePreset(ORACLE_URL)}
            >
              <span className="preset-name">Oracle Cloud (Always Free)</span>
              <span className="preset-url">{ORACLE_URL}</span>
            </button>
            <button
              type="button"
              className={`server-preset-btn ${url === GCP_URL ? 'active' : ''}`}
              onClick={() => handlePreset(GCP_URL)}
            >
              <span className="preset-name">Google Cloud (GCP)</span>
              <span className="preset-url">{GCP_URL}</span>
            </button>
            <button
              type="button"
              className={`server-preset-btn ${url === LOCAL_URL ? 'active' : ''}`}
              onClick={() => handlePreset(LOCAL_URL)}
            >
              <span className="preset-name">Localhost Dev Server</span>
              <span className="preset-url">{LOCAL_URL}</span>
            </button>
          </div>

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label className="form-label" htmlFor="customServerInput">Custom WebSocket URL</label>
            <input
              id="customServerInput"
              type="text"
              className="text-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="wss://your-server.com:443"
            />
          </div>

          <button className="btn btn-primary btn-block" onClick={handleSave}>
            Save & Reconnect
          </button>
        </div>
      </div>
    </div>
  );
}
