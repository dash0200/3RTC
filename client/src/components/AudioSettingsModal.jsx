import React, { useState, useEffect, useRef } from 'react';
import { PTT_PRESET_KEYS, getPttKeyLabel, matchesPttKey } from '../utils/audioSettings';
import { sound } from '../utils/sound';

export default function AudioSettingsModal({
  isOpen,
  onClose,
  audioSettings,
  onUpdateAudioSettings,
  localAudioLevel = 0,
  isMicMuted = true,
  isPttActive = false
}) {
  const [isRecordingKey, setIsRecordingKey] = useState(false);
  const [isTestPressed, setIsTestPressed] = useState(false);
  const recordBtnRef = useRef(null);

  // Handle recording custom PTT key
  useEffect(() => {
    if (!isRecordingKey) return;

    const handleKeyDown = (e) => {
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

  if (!isOpen) return null;

  const handleToggle = (key) => {
    onUpdateAudioSettings({
      ...audioSettings,
      [key]: !audioSettings[key]
    });
  };

  const handleModeChange = (mode) => {
    onUpdateAudioSettings({
      ...audioSettings,
      inputMode: mode
    });
  };

  const handlePresetKey = (preset) => {
    onUpdateAudioSettings({
      ...audioSettings,
      pttKey: preset.code,
      pttKeyLabel: preset.label
    });
  };

  const handleDelayChange = (e) => {
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
      inputMode: 'open',
      pttKey: 'Space',
      pttKeyLabel: 'Space',
      pttReleaseDelay: 200,
      pttChime: true
    });
  };

  const handleTestChime = () => {
    sound.playPttOn();
    setTimeout(() => {
      sound.playPttOff();
    }, 280);
  };

  const isPttMode = audioSettings.inputMode === 'ptt';

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="audio-settings-title">
      <div className="modal-card audio-settings-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-title-group">
            <div className="modal-title-icon-box">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
              </svg>
            </div>
            <div>
              <div className="modal-title" id="audio-settings-title">Audio & Voice Settings</div>
              <div className="modal-subtitle">Configure browser DSP audio filters and voice input modes</div>
            </div>
          </div>
          <button className="modal-close-btn" onClick={onClose} title="Close settings" aria-label="Close settings">
            &times;
          </button>
        </div>

        {/* Modal Body */}
        <div className="modal-body audio-settings-body">
          {/* Section 1: Audio Processing Toggles */}
          <div className="settings-section">
            <div className="section-header-row">
              <div className="section-title-wrap">
                <span className="section-tag-badge">HARDWARE DSP</span>
                <h4 className="settings-section-title">Browser Audio Processing</h4>
              </div>
              <span className="active-filters-count">
                {[audioSettings.echoCancellation, audioSettings.noiseSuppression, audioSettings.autoGainControl].filter(Boolean).length} of 3 Active
              </span>
            </div>
            <p className="settings-section-desc">
              Native browser WebRTC filters applied directly to your microphone input for crystal clear voice clarity.
            </p>

            <div className="audio-toggles-grid">
              {/* Noise Suppression */}
              <div className={`audio-toggle-card ${audioSettings.noiseSuppression ? 'is-enabled' : ''}`}>
                <div className="toggle-card-left">
                  <div className="toggle-icon-wrap ns">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                      <path d="M3.27 1.44L2 2.72l4.33 4.33C6.12 7.6 6 8.28 6 9v2c0 3.31 2.69 6 6 6 .62 0 1.21-.11 1.77-.28l4.95 4.95 1.27-1.27L3.27 1.44zM12 15c-2.21 0-4-1.79-4-4V9.66l4 4V15zm5-4c0-.34-.04-.67-.11-.99l1.49-1.49c.4.78.62 1.63.62 2.48h-2zm-2-6c0-.55-.45-1-1-1s-1 .45-1 1v.78l2 2V5z" />
                    </svg>
                  </div>
                  <div className="toggle-card-text">
                    <div className="toggle-title-row">
                      <span className="toggle-card-title">Noise Suppression</span>
                      <span className="toggle-dsp-pill">NS</span>
                    </div>
                    <span className="toggle-card-desc">
                      Filters background noise such as mechanical keyboards, laptop fans, and AC hums.
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch-track ${audioSettings.noiseSuppression ? 'checked' : ''}`}
                  onClick={() => handleToggle('noiseSuppression')}
                  role="switch"
                  aria-checked={audioSettings.noiseSuppression}
                  aria-label="Toggle Noise Suppression"
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              {/* Echo Cancellation */}
              <div className={`audio-toggle-card ${audioSettings.echoCancellation ? 'is-enabled' : ''}`}>
                <div className="toggle-card-left">
                  <div className="toggle-icon-wrap aec">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                    </svg>
                  </div>
                  <div className="toggle-card-text">
                    <div className="toggle-title-row">
                      <span className="toggle-card-title">Echo Cancellation</span>
                      <span className="toggle-dsp-pill">AEC</span>
                    </div>
                    <span className="toggle-card-desc">
                      Prevents watch party video sound and peer voices leaking back through your microphone.
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch-track ${audioSettings.echoCancellation ? 'checked' : ''}`}
                  onClick={() => handleToggle('echoCancellation')}
                  role="switch"
                  aria-checked={audioSettings.echoCancellation}
                  aria-label="Toggle Echo Cancellation"
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              {/* Auto Gain Control */}
              <div className={`audio-toggle-card ${audioSettings.autoGainControl ? 'is-enabled' : ''}`}>
                <div className="toggle-card-left">
                  <div className="toggle-icon-wrap agc">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                      <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
                    </svg>
                  </div>
                  <div className="toggle-card-text">
                    <div className="toggle-title-row">
                      <span className="toggle-card-title">Auto Gain Control</span>
                      <span className="toggle-dsp-pill">AGC</span>
                    </div>
                    <span className="toggle-card-desc">
                      Automatically normalizes voice volume so quiet whisperers are boosted and loud speakers aren't clipping.
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className={`switch-track ${audioSettings.autoGainControl ? 'checked' : ''}`}
                  onClick={() => handleToggle('autoGainControl')}
                  role="switch"
                  aria-checked={audioSettings.autoGainControl}
                  aria-label="Toggle Auto Gain Control"
                >
                  <span className="switch-thumb" />
                </button>
              </div>
            </div>
          </div>

          {/* Section 2: Input Mode (Open Mic vs Push-to-Talk) */}
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
                  Microphone stays live until toggled off. Press <strong>M</strong> or click microphone button to mute/unmute.
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
                  Microphone is muted by default. Audio is only transmitted while holding down your designated key.
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
                        title={isRecordingKey ? "Press any key on your keyboard now" : "Click to rebind hotkey"}
                      >
                        {isRecordingKey ? (
                          <span className="recording-text">
                            <span className="pulse-dot" /> Press Any Key...
                          </span>
                        ) : (
                          <span className="active-key-label">
                            <kbd className="ptt-kbd">{audioSettings.pttKeyLabel || getPttKeyLabel(audioSettings.pttKey)}</kbd>
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
                      <span className="ptt-block-sub">Prevents cutting off your last words when releasing key</span>
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
                        onClick={() => onUpdateAudioSettings({ ...audioSettings, pttReleaseDelay: item.val })}
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
                    <div className="ptt-block-sub">Play subtle audio chime when activating and releasing transmission</div>
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
                    <span className={`ptt-test-status-pill ${isPttActive || isTestPressed ? 'transmitting' : 'idle'}`}>
                      {isPttActive || isTestPressed ? '🎙️ TRANSMITTING' : '🔇 MUTED'}
                    </span>
                  </div>

                  <div className="ptt-test-vu-wrapper">
                    <div className="ptt-test-vu-bar">
                      <div
                        className="ptt-test-vu-fill"
                        style={{ width: `${(isPttActive || isTestPressed) ? Math.max(12, localAudioLevel) : 0}%` }}
                      />
                    </div>
                    <span className="ptt-test-vu-number">
                      {(isPttActive || isTestPressed) ? `${localAudioLevel}%` : '0%'}
                    </span>
                  </div>

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
                    <span>{isTestPressed ? '🔴 Transmitting Now (Release to Mute)' : `Hold to Test or Press [${audioSettings.pttKeyLabel || 'Space'}]`}</span>
                  </button>
                </div>
              </div>
            )}
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

          <button
            type="button"
            className="btn btn-primary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
