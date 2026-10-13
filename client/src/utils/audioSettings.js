/**
 * Audio Settings & Processing Configuration Utilities for 3RTC
 * Handles Echo Cancellation, Noise Suppression, Auto Gain Control & Push-to-Talk (PTT)
 */

/**
 * Browser's built-in WebRTC mic processing (same as a plain getUserMedia({ audio: true })).
 * Set all three to false for a completely raw mic (only sensible if everyone wears headphones,
 * otherwise speakers echo back into the call).
 */
export const MIC_PROCESSING = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};

export const DEFAULT_AUDIO_SETTINGS = {
  ...MIC_PROCESSING,
  // Noise removal on your voice: the browser/OS voice isolation where available, otherwise in-app
  // RNNoise. On by default: open mic sends continuously, so background noise must be removed.
  voiceIsolation: true,
  settingsVersion: 2,
  inputMode: 'open', // 'open' (Open Mic / Toggle) | 'ptt' (Push-to-Talk)
  pttKey: 'Space',   // KeyboardEvent code or key identifier
  pttKeyLabel: 'Space',
  pttReleaseDelay: 200, // Milliseconds to hold open after releasing PTT key
  pttChime: true        // Sweet tactile audio chirps on push and release
};

export const PTT_PRESET_KEYS = [
  { code: 'Space', label: 'Space' },
  { code: 'Control', label: 'Ctrl' },
  { code: 'Alt', label: 'Alt' },
  { code: 'KeyV', label: 'V' },
  { code: 'KeyT', label: 'T' },
  { code: 'Backquote', label: '~ (Tilde)' }
];

export const STORAGE_KEY = '3rtc_audio_settings';

/**
 * Load audio settings from localStorage with fallback defaults
 */
export function loadAudioSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // v2: voice isolation became the default. Settings saved before that carry the old default
      // (off), which the user most likely never chose, so turn it on once
      if ((parsed.settingsVersion || 1) < 2) {
        parsed.voiceIsolation = true;
        parsed.settingsVersion = 2;
      }
      return {
        ...DEFAULT_AUDIO_SETTINGS,
        ...parsed,
        ...MIC_PROCESSING
      };
    }
  } catch {
    // Fall back to default
  }
  return { ...DEFAULT_AUDIO_SETTINGS };
}

/**
 * Save audio settings to localStorage (mic processing always follows MIC_PROCESSING)
 */
export function saveAudioSettings(settings) {
  try {
    const enforced = {
      ...settings,
      ...MIC_PROCESSING,
      settingsVersion: DEFAULT_AUDIO_SETTINGS.settingsVersion
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enforced));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Whether this browser understands the `voiceIsolation` constraint at all. Even when it does,
 * the OS/mic may not provide it; check the track's settings after capture.
 */
export function isVoiceIsolationSupported() {
  try {
    return navigator.mediaDevices?.getSupportedConstraints?.().voiceIsolation === true;
  } catch {
    return false;
  }
}

/** Extra constraints on top of MIC_PROCESSING for the user's optional processing toggles. */
export function getOptionalMicConstraints() {
  // The browser's own `voiceIsolation` is deliberately not requested: Chrome reports it as applied
  // even where no isolation effect exists (e.g. Windows/Linux), which would silently replace the
  // real noise removal. Voice Isolation always uses in-app RNNoise instead (utils/micPipeline.js).
  return {};
}

/**
 * getUserMedia constraints for voice chat: just the mic, with the browser's standard processing
 * plus voice isolation when the user turned it on.
 */
export function buildMicConstraints(deviceId, options = {}) {
  return {
    audio: {
      ...MIC_PROCESSING,
      ...getOptionalMicConstraints(options),
      ...(deviceId ? { deviceId: { ideal: deviceId } } : {})
    }
  };
}

/**
 * Confirm the browser actually applied MIC_PROCESSING to the mic (constraints are only a
 * request). Re-applies it once if it came back different.
 * Returns { echoCancellation, noiseSuppression, autoGainControl, voiceIsolation, ok }; a value of
 * undefined means the browser doesn't report it.
 */
export async function ensureMicProcessing(track, optionalConstraints = {}) {
  const read = () => (track?.getSettings ? track.getSettings() : {});
  const mismatched = (settings) => Object.keys(MIC_PROCESSING)
    .some((key) => settings[key] !== undefined && settings[key] !== MIC_PROCESSING[key]);
  let settings = read();

  if (track && mismatched(settings)) {
    try {
      // applyConstraints replaces all constraints, so keep the optional ones (voice isolation)
      await track.applyConstraints({ ...MIC_PROCESSING, ...optionalConstraints });
    } catch {
      // Device/browser refused; report what we have
    }
    settings = read();
  }

  return {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    voiceIsolation: settings.voiceIsolation,
    ok: !mismatched(settings)
  };
}

/**
 * Normalize and format human-friendly display label for any key code
 */
export function getPttKeyLabel(code) {
  if (!code) return 'Space';
  if (code === 'Space') return 'Space';
  if (code === 'Control' || code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
  if (code === 'Alt' || code === 'AltLeft' || code === 'AltRight') return 'Alt';
  if (code === 'Shift' || code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'Backquote') return '~ (Tilde)';
  if (code === 'CapsLock') return 'Caps';
  if (code.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/**
 * Check if a KeyboardEvent matches the configured PTT key
 */
export function matchesPttKey(e, pttKey) {
  if (!pttKey) return false;
  if (pttKey === 'Control') {
    return e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight';
  }
  if (pttKey === 'Alt') {
    return e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight';
  }
  if (pttKey === 'Shift') {
    return e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight';
  }
  return e.code === pttKey || e.key === pttKey;
}

/**
 * Check if the active element is an interactive input or textarea where typing hotkeys should not trigger PTT
 */
export function isTypingInField(e) {
  const target = e?.target || document.activeElement;
  if (!target) return false;
  const tag = (target.tagName || '').toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    Boolean(target.isContentEditable) ||
    target.getAttribute('contenteditable') === 'true'
  );
}
