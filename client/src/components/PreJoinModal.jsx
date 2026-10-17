import React, { useState, useEffect, useRef } from 'react';
import { Icon } from './icons';
import { getAvatarColor } from '../utils/sound';
import { getInitials } from './PeerVoiceRoster';
import AudioDevicePicker from './AudioDevicePicker';

/**
 * Pre-Join Green Room / Device Check Modal (UX-H01):
 * Lets the user test their microphone, select input/output hardware, confirm their name,
 * and choose initial mute state before connecting to the live WebRTC room mesh.
 */
export default function PreJoinModal({
  isOpen,
  mode = 'create', // 'create' | 'join'
  pin = '',
  initialName = '',
  audioSettings,
  onUpdateAudioSettings,
  onSelectOutput,
  onConfirm,
  onCancel
}) {
  const [name, setName] = useState(initialName);
  const [micOn, setMicOn] = useState(false);
  const modalCardRef = useRef(null);
  const prevActiveElementRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setMicOn(false);
    }
  }, [isOpen, initialName]);

  // Focus trapping and restoring for accessibility (UX-M05 / UX-H01)
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

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const isCreate = mode === 'create';
  const cleanDisplayName = name.trim() || 'Guest';

  const handleSubmit = (e) => {
    e?.preventDefault();
    onConfirm?.({
      name: cleanDisplayName,
      micOn,
      pin
    });
  };

  return (
    <div
      className="leave-dialog-backdrop prejoin-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
      role="presentation"
    >
      <div
        className="modal-card prejoin-modal-card"
        ref={modalCardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prejoin-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prejoin-head">
          <div className="prejoin-icon-ring" aria-hidden="true">
            <Icon name={isCreate ? 'userPlus' : 'link'} size={24} />
          </div>
          <div className="prejoin-head-text">
            <h2 id="prejoin-title">
              {isCreate ? 'Ready to create room?' : `Join room ${pin}`}
            </h2>
            <p>Check your audio and microphone before entering the party.</p>
          </div>
          <button type="button" className="modal-close-btn" onClick={onCancel} aria-label="Cancel">
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="prejoin-body">
          {/* User Name Preview */}
          <div className="prejoin-name-section">
            <span
              className="rd-av prejoin-avatar"
              style={{ '--av': getAvatarColor(cleanDisplayName) }}
              aria-hidden="true"
            >
              {getInitials(cleanDisplayName)}
            </span>
            <div className="prejoin-name-field">
              <label htmlFor="prejoin-name-input">Your name</label>
              <input
                id="prejoin-name-input"
                type="text"
                maxLength={20}
                autoComplete="nickname"
                placeholder="So your friends know it’s you"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          {/* Audio Devices & Mic Check */}
          <div className="prejoin-devices-box">
            <div className="prejoin-section-label">
              <span>AUDIO CHECK</span>
              <small>Choose devices &amp; test your mic</small>
            </div>
            <AudioDevicePicker
              audioSettings={audioSettings}
              onUpdateAudioSettings={onUpdateAudioSettings}
              onSelectOutput={onSelectOutput}
              isMicLive={false}
            />
          </div>

          {/* Initial Mic Mute Choice Toggle */}
          <label className="invite-toggle prejoin-mic-toggle">
            <Icon name={micOn ? 'mic' : 'micOff'} size={22} />
            <span className="invite-toggle-text">
              <span>Turn microphone on when entering</span>
              <small>
                {micOn
                  ? 'Everyone will hear you as soon as you join'
                  : 'You will enter muted for privacy (recommended)'}
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="rd-switch"
              checked={micOn}
              onChange={(e) => setMicOn(e.target.checked)}
            />
          </label>

          <div className="prejoin-actions">
            <button type="submit" className="rd-btn rd-btn-primary rd-btn-lg prejoin-submit-btn">
              {isCreate ? 'Start room' : 'Enter room'}
            </button>
            <button type="button" className="rd-btn rd-btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
