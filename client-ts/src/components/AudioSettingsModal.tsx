import React, { useState, useEffect, useRef } from 'react';
import {
  PTT_PRESET_KEYS,
  getPttKeyLabel,
  type AudioSettings,
  type PttPresetKey
} from '../utils/audioSettings';
import { sound } from '../utils/sound';
import { useSpeakingActivity } from '../utils/speakingActivity';
import AudioDevicePicker from './AudioDevicePicker';

/** Live mic level for the push-to-talk test; only this re-renders as the level changes. */
function PttTestMeter({ isTransmitting }: { isTransmitting: boolean }) {
  const localAudioLevel = useSpeakingActivity().local.level;
  return (
    <div className="ptt-test-vu-wrapper">
      <div className="ptt-test-vu-bar">
        <div
          className="ptt-test-vu-fill"
          style={{ width: `${isTransmitting ? Math.max(12, localAudioLevel) : 0}%` }}
        />
      </div>
      <span className="ptt-test-vu-number">
        {isTransmitting ? `${localAudioLevel}%` : '0%'}
      </span>
    </div>
  );
}

export interface AudioSettingsModalProps {
  isOpen: boolean;
  onClose?: () => void;
  audioSettings: AudioSettings;
  onUpdateAudioSettings: (settings: AudioSettings) => void;
  onSelectOutput?: (id: string, label?: string) => unknown;
  isMicMuted?: boolean;
  isPttActive?: boolean;
  voiceIsolationSupported?: boolean;
  voiceIsolationStatus?: 'active' | 'rnnoise' | 'unavailable' | string | null;
}

export default function AudioSettingsModal({
  isOpen,
  onClose,
  audioSettings,
  onUpdateAudioSettings,
  onSelectOutput,
  isMicMuted = true,
  isPttActive = false,
  voiceIsolationSupported = false,
  voiceIsolationStatus = null
}: AudioSettingsModalProps) {
  const [isRecordingKey, setIsRecordingKey] = useState(false);
  const [isTestPressed, setIsTestPressed] = useState(false);
  const recordBtnRef = useRef<HTMLButtonElement | null>(null);
  const modalCardRef = useRef<HTMLDivElement | null>(null);
  const prevActiveElementRef = useRef<Element | null>(null);

  // Focus trapping and restoring for accessibility (UX-M05)
  useEffect(() => {
    if (!isOpen) return;
    prevActiveElementRef.current = document.activeElement;

    // Focus first focusable element or modal card
    const card = modalCardRef.current;
    if (card) {
      const focusables = card.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        card.focus();
      }
    }

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const cardEl = modalCardRef.current;
      if (!cardEl) return;
      const focusables = Array.from(
        cardEl.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || !cardEl.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !cardEl.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleTabKey);
    return () => {
      window.removeEventListener('keydown', handleTabKey);
      if (
        prevActiveElementRef.current &&
        typeof (prevActiveElementRef.current as HTMLElement).focus === 'function'
      ) {
        (prevActiveElementRef.current as HTMLElement).focus();
      }
    };
  }, [isOpen]);

  // Handle recording custom PTT key
  useEffect(() => {
    if (!isRecordingKey) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Don't bind Escape as PTT (use it to cancel recording)
      if (e.key === 'Escape') {
        setIsRecordingKey(false);
        return;
      }

      let code = e.code;
      if (e.key === 'Control') code = 'Control';
      else if (e.key === 'Alt') code = 'Alt';
      else if (e.key === 'Shift') code = 'Shift';

      const label = getPttKeyLabel(code);
      onUpdateAudioSettings({
        ...audioSettings,
        pttKey: code,
        pttKeyLabel: label
      });
      setIsRecordingKey(false);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isRecordingKey, audioSettings, onUpdateAudioSettings]);

  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isRecordingKey) {
          setIsRecordingKey(false);
        } else {
          onClose?.();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isRecordingKey, onClose]);

  if (!isOpen) return null;

  const handleToggle = (key: keyof AudioSettings) => {
    onUpdateAudioSettings({
      ...audioSettings,
      [key]: !audioSettings[key]
    });
  };

  const handleModeChange = (mode: 'open' | 'ptt') => {
    onUpdateAudioSettings({
      ...audioSettings,
      inputMode: mode
    });
  };

  const handlePresetKey = (preset: PttPresetKey) => {
    onUpdateAudioSettings({
      ...audioSettings,
      pttKey: preset.code,
      pttKeyLabel: preset.label
    });
  };

  const handleDelayChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    onUpdateAudioSettings({
      ...audioSettings,
      pttReleaseDelay: val
    });
  };

  const handleResetDefaults = () => {
    onUpdateAudioSettings({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
      settingsVersion: 2,
      inputMode: 'open',
      pttKey: 'Space',
      pttKeyLabel: 'Space',
      pttReleaseDelay: 200,
      pttChime: true,
      // the devices stay as chosen
      inputDeviceId: audioSettings.inputDeviceId || '',
      inputDeviceLabel: audioSettings.inputDeviceLabel || '',
      outputDeviceId: audioSettings.outputDeviceId || '',
      outputDeviceLabel: audioSettings.outputDeviceLabel || ''
    });
  };

  const handleTestChime = () => {
    sound.playPttOn();
    setTimeout(() => {
      sound.playPttOff();
    }, 280);
  };

  const isPttMode = audioSettings.inputMode === 'ptt';

  let voiceIsolationNote: { tone: string; text: string } | null = null;
  if (!voiceIsolationSupported) {
    voiceIsolationNote = { tone: 'muted', text: 'Not supported in this browser.' };
  } else if (audioSettings.voiceIsolation) {
    if (voiceIsolationStatus === 'active') {
      voiceIsolationNote = { tone: 'ok', text: '✓ Active (built into your device)' };
    } else if (voiceIsolationStatus === 'rnnoise') {
      voiceIsolationNote = {
        tone: 'ok',
        text: '✓ Active (AI noise removal running on this device)'
      };
    } else if (voiceIsolationStatus === 'unavailable') {
      voiceIsolationNote = {
        tone: 'warn',
        text: "Couldn't start voice isolation. Standard noise suppression is still on."
      };
    } else {
      voiceIsolationNote = { tone: 'muted', text: 'Takes effect when your microphone is on.' };
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="audio-settings-title"
    >
      <div
        className="modal-card audio-settings-modal-card"
        ref={modalCardRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            <div className="modal-title-icon-box">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
              </svg>
            </div>
            <div>
              <div className="modal-title" id="audio-settings-title">
                Audio & Voice Settings
              </div>
              <div className="modal-subtitle">
                Configure voice transmission modes, push-to-talk hotkeys, and mic levels
              </div>
            </div>
          </div>
          <button
            className="modal-close-btn"
            onClick={onClose}
            title="Close settings"
            aria-label="Close settings"
          >
            &times;
          </button>
        </div>

        {/* Modal Body */}
        <div className="modal-body audio-settings-body">
          {/* Input / output devices */}
          <div className="settings-section">
            <div className="section-header-row">
              <div className="section-title-wrap">
                <span className="section-tag-badge">DEVICES</span>
                <h4 className="settings-section-title">Microphone & Speaker</h4>
              </div>
            </div>
            <AudioDevicePicker
              audioSettings={audioSettings}
              onUpdateAudioSettings={onUpdateAudioSettings}
              onSelectOutput={onSelectOutput}
              isMicLive={!isMicMuted}
            />
          </div>

          {/* Voice Transmission Mode (Open Mic vs Push-to-Talk) */}
          <div className="settings-section">
            <div className="section-header-row">
              <div className="section-title-wrap">
                <span className="section-tag-badge mode">INPUT MODE</span>
                <h4 className="settings-section-title">Voice Transmission Mode</h4>
              </div>
            </div>

            <div className="input-mode-selector">
              <button
                type="button"
                className={`mode-option-btn ${!isPttMode ? 'active' : ''}`}
                onClick={() => handleModeChange('open')}
              >
                <div className="mode-option-header">
                  <span className="mode-option-icon">🎙️</span>
                  <span className="mode-option-title">Open Mic / Toggle</span>
                </div>
                <p className="mode-option-desc">
                  Microphone stays live until toggled off. Press <strong>M</strong> or click
                  microphone button to mute/unmute.
                </p>
              </button>

              <button
                type="button"
                className={`mode-option-btn ${isPttMode ? 'active' : ''}`}
                onClick={() => handleModeChange('ptt')}
              >
                <div className="mode-option-header">
                  <span className="mode-option-icon">📻</span>
                  <span className="mode-option-title">Push-to-Talk (PTT)</span>
                </div>
                <p className="mode-option-desc">
                  Microphone is muted by default. Audio is only transmitted while holding down your
                  designated key.
                </p>
              </button>
            </div>

            {/* PTT Configuration Subpanel */}
            {isPttMode && (
              <div className="ptt-config-subpanel">
                {/* Hotkey Binder */}
                <div className="ptt-setting-block">
                  <div className="ptt-block-header">
                    <div>
                      <span className="ptt-block-title">Push-to-Talk Hotkey</span>
                      <span className="ptt-block-sub">Hold this key to broadcast voice</span>
                    </div>

                    <div className="ptt-key-recorder-wrap">
                      <button
                        ref={recordBtnRef}
                        type="button"
                        className={`ptt-record-key-btn ${isRecordingKey ? 'recording' : ''}`}
                        onClick={() => setIsRecordingKey((prev) => !prev)}
                        title={
                          isRecordingKey
                            ? 'Press any key on your keyboard now'
                            : 'Click to rebind hotkey'
                        }
                      >
                        {isRecordingKey ? (
                          <span className="recording-text">
                            <span className="pulse-dot" /> Press Any Key...
                          </span>
                        ) : (
                          <span className="active-key-label">
                            <kbd className="ptt-kbd">
                              {audioSettings.pttKeyLabel || getPttKeyLabel(audioSettings.pttKey)}
                            </kbd>
                            <span className="edit-hint">Change</span>
                          </span>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Preset Pills */}
                  <div className="ptt-presets-row">
                    <span className="presets-label">Popular Presets:</span>
                    {PTT_PRESET_KEYS.map((preset) => (
                      <button
                        key={preset.code}
                        type="button"
                        className={`ptt-preset-chip ${audioSettings.pttKey === preset.code ? 'selected' : ''}`}
                        onClick={() => handlePresetKey(preset)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Release Delay Stepper / Slider */}
                <div className="ptt-setting-block">
                  <div className="ptt-slider-header">
                    <div>
                      <span className="ptt-block-title">Release Delay (Grace Period)</span>
                      <span className="ptt-block-sub">
                        Prevents cutting off your last words when releasing key
                      </span>
                    </div>
                    <span className="ptt-val-badge">{audioSettings.pttReleaseDelay} ms</span>
                  </div>

                  <input
                    type="range"
                    min="0"
                    max="600"
                    step="50"
                    value={audioSettings.pttReleaseDelay}
                    onChange={handleDelayChange}
                    className="ptt-range-slider"
                    aria-label="PTT Release Delay in milliseconds"
                  />

                  <div className="ptt-delay-presets">
                    {[
                      { label: '0ms (Instant)', val: 0 },
                      { label: '150ms', val: 150 },
                      { label: '200ms (Default)', val: 200 },
                      { label: '350ms', val: 350 },
                      { label: '500ms', val: 500 }
                    ].map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className={`chip-preset-small ${audioSettings.pttReleaseDelay === item.val ? 'active' : ''}`}
                        onClick={() =>
                          onUpdateAudioSettings({ ...audioSettings, pttReleaseDelay: item.val })
                        }
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* PTT Sound Effects (Chirps) */}
                <div className="ptt-setting-block ptt-sound-block">
                  <div className="ptt-sound-left">
                    <div className="ptt-block-title">PTT Radio Chirp Sounds</div>
                    <div className="ptt-block-sub">
                      Play subtle audio chime when activating and releasing transmission
                    </div>
                  </div>

                  <div className="ptt-sound-actions">
                    <button
                      type="button"
                      className="btn-preview-chime"
                      onClick={handleTestChime}
                      title="Preview PTT audio chime"
                    >
                      🔊 Preview Sound
                    </button>
                    <button
                      type="button"
                      className={`switch-track ${audioSettings.pttChime ? 'checked' : ''}`}
                      onClick={() => handleToggle('pttChime')}
                      role="switch"
                      aria-checked={audioSettings.pttChime}
                      aria-label="Toggle PTT Chirp Sound"
                    >
                      <span className="switch-thumb" />
                    </button>
                  </div>
                </div>

                {/* Interactive PTT Test Bar */}
                <div className="ptt-test-card">
                  <div className="ptt-test-header">
                    <span>Live Transmission Tester</span>
                    <span
                      className={`ptt-test-status-pill ${isPttActive || isTestPressed ? 'transmitting' : 'idle'}`}
                    >
                      {isPttActive || isTestPressed ? '🎙️ TRANSMITTING' : '🔇 MUTED'}
                    </span>
                  </div>

                  <PttTestMeter isTransmitting={isPttActive || isTestPressed} />

                  <button
                    type="button"
                    className={`ptt-test-hold-btn ${isTestPressed ? 'holding' : ''}`}
                    onMouseDown={() => {
                      setIsTestPressed(true);
                      if (audioSettings.pttChime) sound.playPttOn();
                    }}
                    onMouseUp={() => {
                      setIsTestPressed(false);
                      if (audioSettings.pttChime) sound.playPttOff();
                    }}
                    onMouseLeave={() => {
                      if (isTestPressed) {
                        setIsTestPressed(false);
                        if (audioSettings.pttChime) sound.playPttOff();
                      }
                    }}
                    onTouchStart={() => {
                      setIsTestPressed(true);
                      if (audioSettings.pttChime) sound.playPttOn();
                    }}
                    onTouchEnd={() => {
                      setIsTestPressed(false);
                      if (audioSettings.pttChime) sound.playPttOff();
                    }}
                  >
                    <span>
                      {isTestPressed
                        ? '🔴 Transmitting Now (Release to Mute)'
                        : `Hold to Test or Press [${audioSettings.pttKeyLabel || 'Space'}]`}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Voice Processing: optional voice isolation (echo cancellation, noise suppression & AGC are always on) */}
          <div className="settings-section">
            <div className="section-header-row">
              <div className="section-title-wrap">
                <span className="section-tag-badge">PROCESSING</span>
                <h4 className="settings-section-title">Voice Processing</h4>
              </div>
            </div>

            <div className="ptt-setting-block ptt-sound-block">
              <div className="ptt-sound-left">
                <div className="ptt-block-title">Voice Isolation</div>
                <div className="ptt-block-sub">
                  Filters out everything except your voice: fans, keyboard, people talking nearby.
                  Stronger than standard noise suppression.
                </div>
                {voiceIsolationNote && (
                  <div className={`voice-iso-status ${voiceIsolationNote.tone}`}>
                    {voiceIsolationNote.text}
                  </div>
                )}
              </div>

              <button
                type="button"
                className={`switch-track ${audioSettings.voiceIsolation ? 'checked' : ''}`}
                onClick={() => handleToggle('voiceIsolation')}
                role="switch"
                aria-checked={Boolean(audioSettings.voiceIsolation)}
                aria-label="Toggle Voice Isolation"
                disabled={!voiceIsolationSupported}
              >
                <span className="switch-thumb" />
              </button>
            </div>

            <div className="ptt-block-sub voice-processing-always-on">
              Always on: Echo cancellation · Noise suppression · Automatic gain control
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="modal-footer audio-settings-footer">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleResetDefaults}
            title="Reset audio settings to factory defaults"
          >
            Reset to Defaults
          </button>

          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
