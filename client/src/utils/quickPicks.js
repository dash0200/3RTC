/**
 * YouTube quick picks.
 *
 * The signaling server searches YouTube for each category a few times a day and caches the
 * result (GET /api/quick-picks); every client reads that cache, so YouTube's API quota never
 * depends on how many people use the app. Until the server's list arrives, or if the server has
 * no API key or can't be reached, the app uses the last list it downloaded, then the built-in one.
 *
 * Trending is per country: the app asks for the country it works out from the device's time zone
 * (then its language), or the one the person picked ("Trending in…"); the server answers with that
 * country's charts, or a worldwide mix for countries it doesn't track.
 */
import { useSyncExternalStore } from 'react';

// Built-in fallback list. Every ID was checked against YouTube's embed lookup (Oct 2026): it exists, is public
// and allows playing on other sites. Mostly official channels (Lofi Girl, Chillhop, Blender, NASA)
// because their videos stay up; fan re-uploads and seasonal live streams disappear.
export const BUILTIN_QUICK_PICKS = [
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
export const REGION_NAMES = {
  IN: 'India', US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia', DE: 'Germany',
  FR: 'France', BR: 'Brazil', JP: 'Japan', KR: 'South Korea', [GLOBAL_REGION]: 'Worldwide'
};
export const regionName = (code) => REGION_NAMES[code] || code;

// Time zones that belong to one country (the common ones; others fall back to the language)
const ZONE_COUNTRY = [
  [/^Asia\/(Kolkata|Calcutta)$/, 'IN'],
  [/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+|Menominee|Juneau|Sitka|Nome|Adak)$|^Pacific\/Honolulu$|^US\//, 'US'],
  [/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Montreal|Moncton|Whitehorse|Yellowknife|Iqaluit|Glace_Bay|Goose_Bay|Swift_Current|Dawson_Creek)$|^Canada\//, 'CA'],
  [/^Europe\/(London|Belfast)$|^GB$/, 'GB'],
  [/^Australia\//, 'AU'],
  [/^Europe\/(Berlin|Busingen)$/, 'DE'],
  [/^Europe\/Paris$/, 'FR'],
  [/^America\/(Sao_Paulo|Fortaleza|Recife|Bahia|Belem|Manaus|Cuiaba|Campo_Grande|Porto_Velho|Boa_Vista|Rio_Branco|Maceio|Araguaina|Santarem|Noronha|Eirunepe)$|^Brazil\//, 'BR'],
  [/^Asia\/Tokyo$|^Japan$/, 'JP'],
  [/^Asia\/Seoul$|^ROK$/, 'KR']
];

/**
 * The country for this device's trending list: from the time zone, else the language
 * (en-GB -> GB), else '' (the server then sends its worldwide mix). (pure, for tests)
 */
export function detectRegion(timeZone = '', languages = []) {
  for (const [re, code] of ZONE_COUNTRY) if (re.test(timeZone)) return code;
  for (const lang of languages) {
    const m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(String(lang));
    if (m && REGION_NAMES[m[1].toUpperCase()]) return m[1].toUpperCase();
  }
  return '';
}

function deviceRegion() {
  let timeZone = '';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser */ }
  const languages = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language || '']) : [];
  return detectRegion(timeZone, languages);
}

function chosenRegion() {
  try {
    const picked = localStorage.getItem(REGION_KEY);
    if (picked && REGION_NAMES[picked]) return picked;
  } catch { /* storage blocked */ }
  return deviceRegion();
}
const VIDEO_ID = /^[\w-]{11}$/;

/** Server data is checked before use: a broken or odd response never replaces a working list. */
function sanitize(data) {
  if (!data || !Array.isArray(data.categories)) return null;
  const categories = data.categories.slice(0, 40).map((c) => ({
    id: String(c?.id || '').slice(0, 40),
    group: String(c?.group || 'Picks').slice(0, 30),
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
// Which country's trending is shown, and which countries the server offers
let regionInfo = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.region) return { region: saved.region, regions: Array.isArray(saved.regions) ? saved.regions.filter((r) => REGION_NAMES[r]) : [] };
  } catch { /* nothing saved */ }
  return { region: null, regions: [] };
})();
const listeners = new Set();
let lastSignalUrls = [];

function setQuickPicks(next) {
  current = next;
  listeners.forEach((fn) => fn());
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getQuickPicks = () => current;

export function useQuickPicks() {
  return useSyncExternalStore(subscribe, getQuickPicks);
}

/** { region, regions }: the country whose trending is shown (null before the server answered). */
export function useQuickPicksRegion() {
  return useSyncExternalStore(subscribe, () => regionInfo);
}

/** Show another country's trending ("Trending in…"); GLOBAL for the worldwide mix. */
export async function setQuickPicksRegion(code) {
  try { localStorage.setItem(REGION_KEY, code); } catch { /* storage blocked: for this visit only */ }
  regionInfo = { ...regionInfo, region: code };
  setQuickPicks([...current]);
  return loadQuickPicks(lastSignalUrls);
}

/** wss://host:443 -> https://host:443/api/quick-picks (ws:// -> http:// for a local server) */
export function quickPicksUrl(signalUrl, region = '') {
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
export async function loadQuickPicks(signalUrls) {
  lastSignalUrls = [].concat(signalUrls);
  for (const signalUrl of lastSignalUrls) {
    if (await loadQuickPicksFrom(signalUrl)) return true;
  }
  return false;
}

async function loadQuickPicksFrom(signalUrl) {
  const url = quickPicksUrl(signalUrl, chosenRegion());
  if (!url) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false; // 503: the server has no list (no API key yet)
    const data = await res.json();
    const categories = sanitize(data);
    if (!categories) return false;
    // Servers from before per-country trending send no region: no "Trending in" choice then
    const regions = Array.isArray(data.regions) ? data.regions.filter((r) => REGION_NAMES[r]) : [];
    regionInfo = REGION_NAMES[data.region] ? { region: data.region, regions } : { region: null, regions: [] };
    setQuickPicks(categories);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ categories, region: regionInfo.region, regions: regionInfo.regions }));
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

/** Categories grouped for display, groups in first-seen order: [{ group, categories }] */
export function groupQuickPicks(categories) {
  const groups = [];
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

export const youtubeThumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

// Videos YouTube refused this session (removed, private, or blocked from playing on other sites
// or in this region). Quick picks skip them, so a broken one is never offered twice.
const unavailableVideoIds = new Set();
export const isVideoUnavailable = (id) => unavailableVideoIds.has(id);
export const markVideoUnavailable = (id) => {
  unavailableVideoIds.add(id);
  setQuickPicks([...current]); // new snapshot, so pickers re-render without the video
};
