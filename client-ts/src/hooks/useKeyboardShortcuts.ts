/**
 * App-wide keys (ignored while typing in a field):
 * - push-to-talk key held (PTT mode): talk; released or window blurred: mute (with optional delay)
 * - M (open-mic mode): toggle the microphone
 * - Q (in a room): show the join QR code
 * M and Q are skipped while a local video is open (its player uses keys of its own).
 */
import { useEffect, type MutableRefObject } from 'react';
import { sound } from '../utils/sound';
import { matchesPttKey, isTypingInField, type AudioSettings } from '../utils/audioSettings';

const isPlainKey = (e: KeyboardEvent, letter: string): boolean =>
  (e.code === `Key${letter}` || e.key === letter.toLowerCase() || e.key === letter) && !e.ctrlKey && !e.altKey && !e.metaKey;

export interface VoiceShortcutsController {
  isPttActiveRef: MutableRefObject<boolean>;
  pttReleaseTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setIsPttActive: (active: boolean) => void;
  setMicrophoneMuted: (muted: boolean, isPttAction?: boolean) => void;
  toggleMicrophone: () => void;
}

export interface KeyboardShortcutsOptions {
  audioSettings: AudioSettings;
  voice: VoiceShortcutsController;
  inRoom: boolean;
  localVideoOpen?: boolean;
  onShowQr: () => void;
}

export function useKeyboardShortcuts({
  audioSettings,
  voice,
  inRoom,
  localVideoOpen = false,
  onShowQr
}: KeyboardShortcutsOptions): void {
  const { isPttActiveRef, pttReleaseTimerRef, setIsPttActive, setMicrophoneMuted, toggleMicrophone } = voice;

  useEffect(() => {
    const releasePtt = (): void => {
      isPttActiveRef.current = false;
      setIsPttActive(false);
      if (audioSettings.pttChime) sound.playPttOff();
      setMicrophoneMuted(true, true);
    };

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (isTypingInField(e)) return;
      if (audioSettings.inputMode === 'ptt' && matchesPttKey(e, audioSettings.pttKey)) {
        if (e.code === 'Space') e.preventDefault();
        if (e.repeat) return;
        if (pttReleaseTimerRef.current) {
          clearTimeout(pttReleaseTimerRef.current);
          pttReleaseTimerRef.current = null;
        }
        if (!isPttActiveRef.current) {
          isPttActiveRef.current = true;
          setIsPttActive(true);
          if (audioSettings.pttChime) sound.playPttOn();
          setMicrophoneMuted(false, true);
        }
      } else if (audioSettings.inputMode === 'open' && isPlainKey(e, 'M')) {
        if (!localVideoOpen) {
          e.preventDefault();
          toggleMicrophone();
        }
      } else if (inRoom && isPlainKey(e, 'Q')) {
        if (!localVideoOpen) {
          e.preventDefault();
          onShowQr();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (audioSettings.inputMode !== 'ptt' || !matchesPttKey(e, audioSettings.pttKey)) return;
      if (e.code === 'Space') e.preventDefault();
      if (!isPttActiveRef.current) return;
      const delay = Math.max(0, audioSettings.pttReleaseDelay || 0);
      if (delay > 0) {
        if (pttReleaseTimerRef.current) clearTimeout(pttReleaseTimerRef.current);
        pttReleaseTimerRef.current = setTimeout(() => {
          pttReleaseTimerRef.current = null;
          releasePtt();
        }, delay);
      } else {
        releasePtt();
      }
    };

    const handleBlur = (): void => {
      if (!isPttActiveRef.current) return;
      if (pttReleaseTimerRef.current) {
        clearTimeout(pttReleaseTimerRef.current);
        pttReleaseTimerRef.current = null;
      }
      releasePtt();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [audioSettings, inRoom, localVideoOpen, onShowQr, isPttActiveRef, pttReleaseTimerRef, setIsPttActive, setMicrophoneMuted, toggleMicrophone]);
}
