/**
 * What an open activity tells the frame around it (ActivityStage), so the game can be shrunk to a
 * small window or a bubble and still call the person back:
 *   useActivityStatus({ attention, color, label })
 *     attention: it's this person's move (the bubble pulses, the small window glows)
 *     color:     a CSS colour for the bubble's ring (e.g. whose turn it is)
 *     label:     short text shown next to the bubble ("Your turn")
 * Activities that don't call it just get a plain bubble.
 */
import { createContext, createElement, useContext, useEffect } from 'react';

export const ActivityHostContext = createContext(null);

export function ActivityHostProvider({ onStatus, children }) {
    return createElement(ActivityHostContext.Provider, { value: onStatus }, children);
}

export function useActivityStatus({ attention = false, color = '', label = '' } = {}) {
    const report = useContext(ActivityHostContext);
    useEffect(() => {
        report?.({ attention: Boolean(attention), color: String(color || ''), label: String(label || '') });
    }, [report, attention, color, label]);
    // Gone (the activity closed): nothing to call attention to
    useEffect(() => () => report?.({ attention: false, color: '', label: '' }), [report]);
}

/** How the activity is shown on this device: over the stage, in a small window, or as a bubble. */
export const ACTIVITY_VIEWS = ['full', 'window', 'bubble'];

/**
 * Where the game goes when something changes (pure, for tests):
 *   a video starts while a game is open -> small window on computers, bubble on phones
 *   the video ends                       -> back to full
 *   a game opens                         -> full, or (a video already playing) window / bubble
 */
export function nextActivityView({ view, mediaActive, wasMediaActive, isPhone, activityOpen, activityJustOpened }) {
    if (!activityOpen) return 'full';
    const aside = isPhone ? 'bubble' : 'window';
    if (activityJustOpened) return mediaActive ? aside : 'full';
    if (mediaActive && !wasMediaActive) return view === 'full' ? aside : view;
    if (!mediaActive && wasMediaActive) return 'full';
    if (isPhone && view === 'window') return 'bubble'; // (no small window on phones)
    return view;
}
