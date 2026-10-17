import React, { useState, useEffect } from 'react';

const CLOUD_URL = 'wss://signal.3rtc.me';
const LOCAL_URL = 'ws://localhost:8080';

export default function ServerSettingsModal({ isOpen, onClose, currentUrl, onApply }) {
  const [url, setUrl] = useState(currentUrl);

  useEffect(() => {
    setUrl(currentUrl);
  }, [currentUrl, isOpen]);

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
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal-card">
        <div className="modal-header">
          <div className="modal-title">Signaling Server Connection</div>
          <button className="modal-close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-desc">
            Configure the WebSocket signaling server used to negotiate WebRTC offers, answers, and ICE candidates.
          </p>

          <div className="quick-servers">
            <button
              className={`server-preset-btn ${url === CLOUD_URL ? 'active' : ''}`}
              onClick={() => handlePreset(CLOUD_URL)}
            >
              <span className="preset-name">3RTC Cloud Server</span>
              <span className="preset-url">{CLOUD_URL}</span>
            </button>
            <button
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
