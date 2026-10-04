import React, { useState } from 'react';

export default function CreateRoomModal({ isOpen, onClose, onConfirm, currentUsername }) {
  const [name, setName] = useState(currentUsername);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirm(name.trim() || 'Host');
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        <div className="mobile-modal-pill" onClick={onClose}></div>
        <div className="modal-header">
          <div className="modal-title">Create New Room</div>
          <button className="modal-close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-desc">
            Generate a secure 5-digit room ID. Anyone with this 5-digit number can connect to your peer-to-peer session.
          </p>

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label" htmlFor="createUsernameInput">Your Display Name</label>
              <input
                id="createUsernameInput"
                type="text"
                className="text-input"
                placeholder="e.g. Host"
                maxLength={20}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>

            <button type="submit" className="btn btn-primary btn-block">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
              </svg>
              Generate 5-Digit Room
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
