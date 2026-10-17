/**
 * Toasts (short pop-up notes) and the room log shown in the Logs tab. Every feature reports
 * through these two, so they live in one place.
 */
import { useState, useCallback, useRef } from 'react';

export const MAX_SYSTEM_LOGS = 15;
const TOAST_MS = 2800;

export function useNotices() {
    const [toastMessage, setToastMessage] = useState('');
    const [systemLogs, setSystemLogs] = useState([]);
    const toastTimerRef = useRef(null);

    const showToast = useCallback((msg) => {
        setToastMessage(msg);
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToastMessage(''), TOAST_MS);
    }, []);

    // Keep only the most recent entries so the Logs tab doesn't grow for the whole session
    const addSystemMessage = useCallback((text, category = 'system') => {
        setSystemLogs((prev) => [
            ...prev.slice(-(MAX_SYSTEM_LOGS - 1)),
            { id: crypto.randomUUID(), text, category, timestamp: Date.now() }
        ]);
    }, []);

    const clearLogs = useCallback(() => setSystemLogs([]), []);

    return { toastMessage, showToast, systemLogs, addSystemMessage, clearLogs };
}
