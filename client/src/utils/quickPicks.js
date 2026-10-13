/**
 * YouTube quick picks.
 *
 * The signaling server searches YouTube for each category a few times a day and caches the
 * result (GET /api/quick-picks); every client reads that cache, so YouTube's API quota never
 * depends on how many people use the app. Until the server's list arrives, or if the server has
 * no API key or can't be reached, the app uses the last list it downloaded, then the built-in one.
 */
import { useSyncExternalStore } from 'react';

// Built-in fallback list. Every ID was checked against YouTube's embed lookup (Oct 2026): it exists, is public
// and allows playing on other sites. Mostly official channels (Lofi Girl, Chillhop, Blender, NASA)
// because their videos stay up; fan re-uploads and seasonal live streams disappear.
export const BUILTIN_QUICK_PICKS = [
  {
    id: 'lofi',
    name: '🎵 Lofi Beats',
    videos: [
      { id: 'jfKfPfyJRdk', title: 'lofi hip hop radio – beats to relax/study to (Lofi Girl)' },
      { id: 'lTRiuFIWV54', title: '1 A.M Study Session (Lofi Girl)' },
      { id: '_tV5LEBDs7w', title: 'Cozy Winter (Lofi Girl)' },
      { id: 'n61ULEU7CO0', title: 'Best of lofi hip hop 2021 (Lofi Girl)' },
      { id: '28KRPhVzCus', title: 'lofi hip hop radio – beats to sleep/chill to (Lofi Girl)' }
    ]
  },
  {
    id: 'chill',
    name: '🎷 Jazz & Chill',
    videos: [
      { id: 'HuFYqnbVbzY', title: 'jazz lofi radio (Lofi Girl)' },
      { id: '5yx6BWlEVcY', title: 'Chillhop Radio – jazzy & lofi hip hop beats' },
      { id: 'f02mOEt11OQ', title: 'code-fi / lofi beats to code/relax to' },
      { id: '1ZYbU82GVz4', title: 'Flying – Relaxing Music (Peder B. Helland)' }
    ]
  },
  {
    id: 'synthwave',
    name: '🌆 Synthwave',
    videos: [
      { id: '4xDzrJKXOOY', title: 'synthwave radio – beats to chill/game to (Lofi Girl)' },
      { id: 'MV_3Dpw-BRY', title: 'Kavinsky – Nightcall (Drive soundtrack)' },
      { id: '8GW6sLrK40k', title: 'HOME – Resonance' }
    ]
  },
  {
    id: 'movies',
    name: '🎬 Open Movies',
    videos: [
      { id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny (4K 60fps)' },
      { id: 'eRsGyueVLvQ', title: 'Sintel (Blender Open Movie)' },
      { id: 'R6MlUcmOul8', title: 'Tears of Steel (Blender Open Movie)' },
      { id: 'WhWc3b3KhnY', title: 'Spring (Blender Open Movie)' },
      { id: 'mN0zPOpADL4', title: 'Agent 327: Operation Barbershop' },
      { id: 'Y-rmzh0PI3c', title: 'Cosmos Laundromat (Blender Open Movie)' }
    ]
  },
  {
    id: 'space',
    name: '🌌 Space',
    videos: [
      { id: '21X5lGlDOfg', title: 'NASA Live: Official Stream of NASA TV' },
      { id: '4czjS9h4Fpg', title: 'Perseverance Rover Landing on Mars (NASA)' },
      { id: 'UDVtMYqUAyw', title: 'Interstellar Main Theme – Hans Zimmer (extended)' }
    ]
  }
];

const STORAGE_KEY = '3rtc_quick_picks';
const VIDEO_ID = /^[\w-]{11}$/;

/** Server data is checked before use: a broken or odd response never replaces a working list. */
function sanitize(data) {
  if (!data || !Array.isArray(data.categories)) return null;
  const categories = data.categories.slice(0, 12).map((c) => ({
    id: String(c?.id || '').slice(0, 40),
    name: String(c?.name || '').slice(0, 60),
    videos: (Array.isArray(c?.videos) ? c.videos : [])
      .filter((v) => VIDEO_ID.test(String(v?.id || '')))
      .slice(0, 25)
      .map((v) => ({ id: v.id, title: String(v.title || 'YouTube video').slice(0, 200), channel: String(v.channel || '').slice(0, 100) }))
  })).filter((c) => c.id && c.name && c.videos.length > 0);
  return categories.length > 0 ? categories : null;
}

function readSaved() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    return null;
  }
}

let current = readSaved() || BUILTIN_QUICK_PICKS;
const listeners = new Set();

function setQuickPicks(next) {
  current = next;
  listeners.forEach((fn) => fn());
}

export const getQuickPicks = () => current;

export function useQuickPicks() {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, getQuickPicks);
}

/** wss://host:443 -> https://host:443/api/quick-picks (ws:// -> http:// for a local server) */
export function quickPicksUrl(signalUrl) {
  try {
    const url = new URL(signalUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/api/quick-picks';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Tries each server address in turn (the same server can be reachable under several names). */
export async function loadQuickPicks(signalUrls) {
  for (const signalUrl of [].concat(signalUrls)) {
    if (await loadQuickPicksFrom(signalUrl)) return true;
  }
  return false;
}

async function loadQuickPicksFrom(signalUrl) {
  const url = quickPicksUrl(signalUrl);
  if (!url) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false; // 503: the server has no list (no API key yet)
    const categories = sanitize(await res.json());
    if (!categories) return false;
    setQuickPicks(categories);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ categories }));
    } catch {
      // storage full or blocked: the list still works for this visit
    }
    return true;
  } catch {
    return false; // offline or unreachable: keep what we have
  }
}

/** Title of a quick-pick video, if it is in the current or built-in list. */
export function findQuickPickTitle(videoId) {
  for (const list of [current, BUILTIN_QUICK_PICKS]) {
    for (const category of list) {
      const found = category.videos.find((v) => v.id === videoId);
      if (found) return found.title;
    }
  }
  return null;
}
