/**
 * App-wide keys (ignored while typing in a field):
 * - push-to-talk key held (PTT mode): talk; released or window blurred: mute (with optional delay)
 * - M (open-mic mode): toggle the microphone
 * - Q (in a room): show the join QR code
 * M and Q are skipped while a local video is open (its player uses keys of its own).
 */
import { useEffect } from 'react';
import { sound } from '../utils/sound';
import { matchesPttKey, isTypingInField } from '../utils/audioSettings';

const isPlainKey = (e, letter) =>
    (e.code === `Key${letter}` || e.key === letter.toLowerCase() || e.key === letter) && !e.ctrlKey && !e.altKey && !e.metaKey;

export function useKeyboardShortcuts({ audioSettings, voice, inRoom, localVideoOpen, onShowQr }) {
    const { isPttActiveRef, pttReleaseTimerRef, setIsPttActive, setMicrophoneMuted, toggleMicrophone } = voice;

    useEffect(() => {
        const releasePtt = () => {
            isPttActiveRef.current = false;
            setIsPttActive(false);
            if (audioSettings.pttChime) sound.playPttOff();
            setMicrophoneMuted(true, true);
        };

        const handleKeyDown = (e) => {
            if (isTypingInField(e)) return;
            if (audioSettings.inputMode === 'ptt' && matchesPttKey(e, audioSettings.pttKey)) {
                if (e.code === 'Space') e.preventDefault();
                if (e.repeat) return;
                clearTimeout(pttReleaseTimerRef.current);
                pttReleaseTimerRef.current = null;
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

        const handleKeyUp = (e) => {
            if (audioSettings.inputMode !== 'ptt' || !matchesPttKey(e, audioSettings.pttKey)) return;
            if (e.code === 'Space') e.preventDefault();
            if (!isPttActiveRef.current) return;
            const delay = Math.max(0, audioSettings.pttReleaseDelay || 0);
            if (delay > 0) {
                clearTimeout(pttReleaseTimerRef.current);
                pttReleaseTimerRef.current = setTimeout(() => {
                    pttReleaseTimerRef.current = null;
                    releasePtt();
                }, delay);
            } else {
                releasePtt();
            }
        };

        const handleBlur = () => {
            if (!isPttActiveRef.current) return;
            clearTimeout(pttReleaseTimerRef.current);
            pttReleaseTimerRef.current = null;
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
