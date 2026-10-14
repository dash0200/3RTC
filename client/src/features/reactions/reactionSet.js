/**
 * Each person's own quick reactions: up to 10 emojis, saved on this device. Keys 1-9 and 0 send
 * them in order. Others see whatever you send (any single emoji is accepted).
 *
 *   const reactions = useReactionSet();          // [{ emoji, key }]
 *   setReactionSet(['👍', '🔥', ...]);
 *   openReactionsEditor();                       // shows features/reactions/ReactionsEditor.jsx
 */
import { useSyncExternalStore } from 'react';
import { isSingleEmoji } from '../../utils/emoji';

export const DEFAULT_REACTIONS = ['👍', '❤️', '🔥', '👏', '😂', '🎉'];
export const MAX_REACTIONS = 10;
const STORAGE_KEY = '3rtc_quick_reactions';

/** Keyboard key for the reaction at `index` (1-9, then 0 for the tenth). */
export const keyForIndex = (index) => (index === 9 ? '0' : String(index + 1));

function clean(list) {
    const out = [];
    for (const e of Array.isArray(list) ? list : []) {
        if (isSingleEmoji(e) && !out.includes(e.trim())) out.push(e.trim());
        if (out.length >= MAX_REACTIONS) break;
    }
    return out.length ? out : [...DEFAULT_REACTIONS];
}

function load() {
    try {
        return clean(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch {
        return [...DEFAULT_REACTIONS];
    }
}

const toItems = (emojis) => emojis.map((emoji, i) => ({ emoji, key: keyForIndex(i) }));

let items = toItems(load());
let editorOpen = false;
const listeners = new Set();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l) => {
    listeners.add(l);
    return () => listeners.delete(l);
};

export function setReactionSet(emojis) {
    const next = clean(emojis);
    items = toItems(next);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch { /* private mode: kept for this visit */ }
    notify();
}

export const getReactionSet = () => items;
export const useReactionSet = () => useSyncExternalStore(subscribe, getReactionSet, getReactionSet);

export function openReactionsEditor() {
    editorOpen = true;
    notify();
}
export function closeReactionsEditor() {
    editorOpen = false;
    notify();
}
export const useReactionsEditorOpen = () => useSyncExternalStore(subscribe, () => editorOpen, () => editorOpen);

// Another tab changed them: follow along
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
            items = toItems(load());
            notify();
        }
    });
}
