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

export interface ReactionItem {
  emoji: string;
  key: string;
}

export const DEFAULT_REACTIONS: string[] = ['👍', '❤️', '🔥', '👏', '😂', '🎉'];
export const MAX_REACTIONS = 10;
const STORAGE_KEY = '3rtc_quick_reactions';

/** Keyboard key for the reaction at `index` (1-9, then 0 for the tenth). */
export const keyForIndex = (index: number): string => (index === 9 ? '0' : String(index + 1));

function clean(list: unknown): string[] {
  const out: string[] = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (typeof e === 'string' && isSingleEmoji(e) && !out.includes(e.trim())) {
      out.push(e.trim());
    }
    if (out.length >= MAX_REACTIONS) break;
  }
  return out.length ? out : [...DEFAULT_REACTIONS];
}

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return clean(raw ? JSON.parse(raw) : null);
  } catch {
    return [...DEFAULT_REACTIONS];
  }
}

const toItems = (emojis: string[]): ReactionItem[] =>
  emojis.map((emoji, i) => ({ emoji, key: keyForIndex(i) }));

let items: ReactionItem[] = toItems(load());
let editorOpen = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function setReactionSet(emojis: string[]): void {
  const next = clean(emojis);
  items = toItems(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode: kept for this visit */
  }
  notify();
}

export const getReactionSet = (): ReactionItem[] => items;
export const useReactionSet = (): ReactionItem[] =>
  useSyncExternalStore(subscribe, getReactionSet, getReactionSet);

export function openReactionsEditor(): void {
  editorOpen = true;
  notify();
}

export function closeReactionsEditor(): void {
  editorOpen = false;
  notify();
}

export const useReactionsEditorOpen = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => editorOpen,
    () => editorOpen
  );

// Another tab changed them: follow along
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      items = toItems(load());
      notify();
    }
  });
}
