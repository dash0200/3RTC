/**
 * YouTube quick picks.
 *
 * The signaling server searches YouTube for each category a few times a day and caches the
 * result (GET /api/quick-picks); every client reads that cache, so YouTube's API quota never
 * depends on how many people use the app. Until the server's list arrives, or if the server has
 * no API key or can't be reached, the app uses the last list it downloaded, then the built-in one.
 *
 * Trending: a worldwide mix by default; "Trending in…" switches to one country's charts (the
 * choice is remembered on this device).
 */
import { useSyncExternalStore } from 'react';

export interface QuickPickVideo {
  id: string;
  title: string;
  channel?: string;
  live?: boolean;
  seconds?: number;
}

export interface QuickPickCategory {
  id: string;
  group: string;
  name: string;
  videos: QuickPickVideo[];
}

export interface QuickPickGroup {
  group: string;
  categories: QuickPickCategory[];
}

export interface QuickPickRegionInfo {
  region: string | null;
  regions: string[];
}

// Built-in fallback list. Every ID was checked against YouTube's embed lookup (Oct 2026): it exists, is public
// and allows playing on other sites. Mostly official channels (Lofi Girl, Chillhop, Blender, NASA)
// because their videos stay up; fan re-uploads and seasonal live streams disappear.
export const BUILTIN_QUICK_PICKS: QuickPickCategory[] = [
  {
    id: 'lofi',
    group: 'Music',
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
    group: 'Music',
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
    group: 'Music',
    name: '🌆 Synthwave',
    videos: [
      { id: '4xDzrJKXOOY', title: 'synthwave radio – beats to chill/game to (Lofi Girl)' },
      { id: 'MV_3Dpw-BRY', title: 'Kavinsky – Nightcall (Drive soundtrack)' },
      { id: '8GW6sLrK40k', title: 'HOME – Resonance' }
    ]
  },
  {
    id: 'movies',
    group: 'Watch',
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
    group: 'Relax',
    name: '🌌 Space',
    videos: [
      { id: '21X5lGlDOfg', title: 'NASA Live: Official Stream of NASA TV' },
      { id: '4czjS9h4Fpg', title: 'Perseverance Rover Landing on Mars (NASA)' },
      { id: 'UDVtMYqUAyw', title: 'Interstellar Main Theme – Hans Zimmer (extended)' }
    ]
  }
];

const STORAGE_KEY = '3rtc_quick_picks';
const REGION_KEY = '3rtc_qp_region'; // the country picked by hand, if any

export const GLOBAL_REGION = 'GLOBAL';
export const REGION_NAMES: Record<string, string> = {
  IN: 'India',
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  BR: 'Brazil',
  JP: 'Japan',
  KR: 'South Korea',
  [GLOBAL_REGION]: 'Worldwide'
};
export const regionName = (code: string): string => REGION_NAMES[code] || code;

/** The country picked in "Trending in…", else worldwide. */
function chosenRegion(): string {
  try {
    const picked = localStorage.getItem(REGION_KEY);
    if (picked && REGION_NAMES[picked]) return picked;
  } catch {
    /* storage blocked */
  }
  return GLOBAL_REGION;
}
const VIDEO_ID = /^[\w-]{11}$/;

/** Server data is checked before use: a broken or odd response never replaces a working list. */
function sanitize(data: unknown): QuickPickCategory[] | null {
  if (!data || typeof data !== 'object' || !('categories' in data)) return null;
  const rawCategories = (data as { categories: unknown }).categories;
  if (!Array.isArray(rawCategories)) return null;
  const categories: QuickPickCategory[] = rawCategories
    .slice(0, 40)
    .map((c: unknown) => {
      const cat = (c && typeof c === 'object') ? (c as Record<string, unknown>) : {};
      const rawVideos = Array.isArray(cat.videos) ? cat.videos : [];
      return {
        id: String(cat.id || '').slice(0, 40),
        group: String(cat.group || 'Picks').slice(0, 30),
        name: String(cat.name || '').slice(0, 60),
        videos: rawVideos
          .map((v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {}))
          .filter((v) => VIDEO_ID.test(String(v.id || '')))
          .slice(0, 25)
          .map((v) => ({
            id: String(v.id),
            title: String(v.title || 'YouTube video').slice(0, 200),
            channel: String(v.channel || '').slice(0, 100),
            ...(v.live === true ? { live: true } : {}),
            ...(typeof v.seconds === 'number' && Number.isFinite(v.seconds) && v.seconds > 0 ? { seconds: Math.round(v.seconds) } : {})
          }))
      };
    })
    .filter((c: QuickPickCategory) => c.id && c.name && c.videos.length > 0);
  return categories.length > 0 ? categories : null;
}

function readSaved(): QuickPickCategory[] | null {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    return null;
  }
}

let current: QuickPickCategory[] = readSaved() || BUILTIN_QUICK_PICKS;
// Which country's trending is shown, and which countries the server offers
let regionInfo: QuickPickRegionInfo = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.region) {
      return {
        region: saved.region,
        regions: Array.isArray(saved.regions) ? saved.regions.filter((r: string) => REGION_NAMES[r]) : []
      };
    }
  } catch {
    /* nothing saved */
  }
  return { region: null, regions: [] };
})();

const listeners = new Set<() => void>();
let lastSignalUrls: string[] = [];

function setQuickPicks(next: QuickPickCategory[]): void {
  current = next;
  listeners.forEach((fn) => fn());
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getQuickPicks = (): QuickPickCategory[] => current;

export function useQuickPicks(): QuickPickCategory[] {
  return useSyncExternalStore(subscribe, getQuickPicks);
}

/** { region, regions }: the country whose trending is shown (null before the server answered). */
export function useQuickPicksRegion(): QuickPickRegionInfo {
  return useSyncExternalStore(subscribe, () => regionInfo);
}

/** Show another country's trending ("Trending in…"); GLOBAL for the worldwide mix. */
export async function setQuickPicksRegion(code: string): Promise<boolean> {
  try {
    localStorage.setItem(REGION_KEY, code);
  } catch {
    /* storage blocked: for this visit only */
  }
  regionInfo = { ...regionInfo, region: code };
  setQuickPicks([...current]);
  return loadQuickPicks(lastSignalUrls);
}

/** wss://host:443 -> https://host:443/api/quick-picks (ws:// -> http:// for a local server) */
export function quickPicksUrl(signalUrl: string, region = ''): string | null {
  try {
    const url = new URL(signalUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/api/quick-picks';
    url.search = region ? `?region=${encodeURIComponent(region)}` : '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Tries each server address in turn (the same server can be reachable under several names). */
export async function loadQuickPicks(signalUrls: string | string[]): Promise<boolean> {
  lastSignalUrls = Array.isArray(signalUrls) ? [...signalUrls] : [signalUrls];
  for (const signalUrl of lastSignalUrls) {
    if (await loadQuickPicksFrom(signalUrl)) return true;
  }
  return false;
}

async function loadQuickPicksFrom(signalUrl: string): Promise<boolean> {
  const url = quickPicksUrl(signalUrl, chosenRegion());
  if (!url) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false; // 503: the server has no list (no API key yet)
    const data = await res.json();
    const categories = sanitize(data);
    if (!categories) return false;
    // Servers from before per-country trending send no region: no "Trending in" choice then
    const regions = Array.isArray(data.regions) ? data.regions.filter((r: string) => REGION_NAMES[r]) : [];
    regionInfo = REGION_NAMES[data.region] ? { region: data.region, regions } : { region: null, regions: [] };
    setQuickPicks(categories);
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ categories, region: regionInfo.region, regions: regionInfo.regions })
      );
    } catch {
      // storage full or blocked: the list still works for this visit
    }
    return true;
  } catch {
    return false; // offline or unreachable: keep what we have
  }
}

/** Title of a quick-pick video, if it is in the current or built-in list. */
export function findQuickPickTitle(videoId: string): string | null {
  for (const list of [current, BUILTIN_QUICK_PICKS]) {
    for (const category of list) {
      const found = category.videos.find((v) => v.id === videoId);
      if (found) return found.title;
    }
  }
  return null;
}

/** Categories grouped for display, groups in first-seen order: [{ group, categories }] */
export function groupQuickPicks(categories: QuickPickCategory[]): QuickPickGroup[] {
  const groups: QuickPickGroup[] = [];
  for (const category of categories) {
    let entry = groups.find((g) => g.group === category.group);
    if (!entry) {
      entry = { group: category.group || 'Picks', categories: [] };
      groups.push(entry);
    }
    entry.categories.push(category);
  }
  return groups;
}

export const youtubeThumb = (id: string): string => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

// Videos YouTube refused this session (removed, private, or blocked from playing on other sites
// or in this region). Quick picks skip them, so a broken one is never offered twice.
const unavailableVideoIds = new Set<string>();
export const isVideoUnavailable = (id: string): boolean => unavailableVideoIds.has(id);
export const markVideoUnavailable = (id: string): void => {
  unavailableVideoIds.add(id);
  setQuickPicks([...current]); // new snapshot, so pickers re-render without the video
};
