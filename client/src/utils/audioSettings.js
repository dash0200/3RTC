/**
 * Audio Settings & Processing Configuration Utilities for 3RTC
 * Handles Echo Cancellation, Noise Suppression, Auto Gain Control & Push-to-Talk (PTT)
 */

export const DEFAULT_AUDIO_SETTINGS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
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
      return {
        ...DEFAULT_AUDIO_SETTINGS,
        ...parsed,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
    }
  } catch {
    // Fall back to default
  }
  return { ...DEFAULT_AUDIO_SETTINGS };
}

/**
 * Save audio settings to localStorage (keeps hardware DSP filters always active)
 */
export function saveAudioSettings(settings) {
  try {
    const enforced = {
      ...settings,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enforced));
  } catch {
    // Ignore storage errors
  }
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
