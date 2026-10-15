/**
 * "Paste anything": what a pasted link (or text) is, and how it can be played together.
 *
 *   detectLink(text) -> { ok: true, kind: 'youtube', videoId }
 *                     | { ok: true, kind: 'media', media }      a link source (below)
 *                     | { ok: false, message }                  why it can't be played here
 *
 * A link source ("media") is a small plain object that travels in messages:
 *   { provider: 'vimeo',  url, id }
 *   { provider: 'twitch', url, video: 'v123' } | { provider: 'twitch', url, channel: 'name', live: true }
 *   { provider: 'file',   url }          a direct video/audio file (.mp4, .webm, .mov, .mp3...)
 *   { provider: 'hls',    url }          an HLS stream (.m3u8)
 * plus `title` once known. Media from other people is always rebuilt from its url through
 * detectLink (normalizeMedia), never trusted field by field.
 *
 * Adding a provider: a matcher here, an adapter in ./adapters, and its name in PROVIDERS.
 */
import { extractYouTubeId } from '../../utils/youtubeId';

export const PROVIDERS = {
    vimeo: { label: 'Vimeo', canSeek: true },
    twitch: { label: 'Twitch', canSeek: true },
    file: { label: 'Video link', canSeek: true },
    hls: { label: 'Live/HLS stream', canSeek: true }
};

const FILE_EXT = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|mp3|m4a|aac|wav|flac|opus|oga)$/i;
const HLS_EXT = /\.m3u8$/i;
const DASH_EXT = /\.mpd$/i;

// Sites whose videos can't be played inside another site
const PROTECTED = [
    [/(^|\.)netflix\.com$/, 'Netflix'], [/(^|\.)primevideo\.com$/, 'Prime Video'], [/(^|\.)amazon\.[a-z.]+$/, 'Prime Video'],
    [/(^|\.)hotstar\.com$/, 'Disney+ Hotstar'], [/(^|\.)jiocinema\.com$/, 'JioCinema'], [/(^|\.)jiohotstar\.com$/, 'JioHotstar'],
    [/(^|\.)disneyplus\.com$/, 'Disney+'], [/(^|\.)sonyliv\.com$/, 'SonyLIV'], [/(^|\.)zee5\.com$/, 'ZEE5'],
    [/(^|\.)hulu\.com$/, 'Hulu'], [/(^|\.)max\.com$/, 'Max'], [/(^|\.)tv\.apple\.com$/, 'Apple TV+'], [/(^|\.)mxplayer\.in$/, 'MX Player']
];
const NO_EMBED = [
    [/(^|\.)instagram\.com$/, 'Instagram'], [/(^|\.)facebook\.com$/, 'Facebook'], [/(^|\.)fb\.watch$/, 'Facebook'],
    [/(^|\.)tiktok\.com$/, 'TikTok'], [/(^|\.)(x|twitter)\.com$/, 'X'], [/(^|\.)reddit\.com$/, 'Reddit'],
    [/(^|\.)snapchat\.com$/, 'Snapchat'], [/(^|\.)linkedin\.com$/, 'LinkedIn']
];

const fail = (message) => ({ ok: false, message });

function parseUrl(text) {
    let t = String(text || '').trim();
    if (!t) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(t)) t = `https://${t}`; // "vimeo.com/123"
    try {
        const u = new URL(t);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
    } catch {
        return null;
    }
}

function vimeo(u) {
    if (!/(^|\.)vimeo\.com$/.test(u.hostname)) return null;
    // vimeo.com/123, vimeo.com/123/abcdef (unlisted), player.vimeo.com/video/123?h=abc,
    // vimeo.com/channels/x/123, vimeo.com/groups/x/videos/123, vimeo.com/showcase/1/video/123
    const parts = u.pathname.split('/').filter(Boolean);
    const at = parts.findIndex((p) => /^\d{5,12}$/.test(p));
    if (at < 0) return fail('That Vimeo link doesn\'t point to a single video.');
    const id = parts[at];
    const hash = u.searchParams.get('h') || (parts[at + 1] && /^[0-9a-f]{6,}$/i.test(parts[at + 1]) ? parts[at + 1] : '');
    const url = `https://vimeo.com/${id}${hash ? `/${hash}` : ''}`;
    return { ok: true, kind: 'media', media: { provider: 'vimeo', url, id } };
}

function twitch(u) {
    const host = u.hostname.replace(/^(www|m|player)\./, '');
    if (host === 'clips.twitch.tv' || (host === 'twitch.tv' && /\/clip\//.test(u.pathname))) {
        return fail('Twitch clips can\'t be played in sync (Twitch doesn\'t allow it). Paste a Twitch video or channel instead.');
    }
    if (host !== 'twitch.tv') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) {
        return { ok: true, kind: 'media', media: { provider: 'twitch', url: `https://www.twitch.tv/videos/${parts[1]}`, video: `v${parts[1]}` } };
    }
    // player.twitch.tv/?channel=x or ?video=v123
    const qVideo = u.searchParams.get('video');
    if (qVideo && /^v?\d+$/.test(qVideo)) {
        const n = qVideo.replace(/^v/, '');
        return { ok: true, kind: 'media', media: { provider: 'twitch', url: `https://www.twitch.tv/videos/${n}`, video: `v${n}` } };
    }
    const channel = (u.searchParams.get('channel') || parts[0] || '').toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(channel) || ['directory', 'search', 'settings', 'downloads', 'p', 'subscriptions'].includes(channel)) {
        return fail('Paste a Twitch video or channel link.');
    }
    return { ok: true, kind: 'media', media: { provider: 'twitch', url: `https://www.twitch.tv/${channel}`, channel, live: true } };
}

function blockedSite(u) {
    const host = u.hostname.replace(/^www\./, '');
    for (const [re, name] of PROTECTED) {
        if (re.test(host)) return fail(`${name} videos are protected (DRM) and can't be played inside another site.`);
    }
    for (const [re, name] of NO_EMBED) {
        if (re.test(host)) return fail(`${name} doesn't let other sites play its videos. Paste a direct video link (.mp4) or a YouTube, Vimeo or Twitch link.`);
    }
    if (/(^|\.)dailymotion\.com$|(^|\.)dai\.ly$/.test(host)) return fail('Dailymotion isn\'t supported yet.');
    return null;
}

/** What `text` is and whether it can be played together (see the top of this file). */
export function detectLink(text) {
    const raw = String(text || '').trim();
    if (!raw) return fail('Paste a video link.');
    const ytId = extractYouTubeId(raw);
    if (ytId) return { ok: true, kind: 'youtube', videoId: ytId };

    const u = parseUrl(raw);
    if (!u) return fail('That doesn\'t look like a link. Paste a YouTube, Vimeo or Twitch link, or a direct video link (.mp4, .m3u8).');
    if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(u.hostname)) {
        return fail('That YouTube link doesn\'t point to a video.');
    }
    const site = vimeo(u) || twitch(u) || blockedSite(u);
    if (site) return site;

    const path = decodeURIComponent(u.pathname);
    const url = u.href;
    if (HLS_EXT.test(path)) return { ok: true, kind: 'media', media: { provider: 'hls', url } };
    if (DASH_EXT.test(path)) return fail('DASH streams (.mpd) aren\'t supported yet. HLS (.m3u8) and direct video files work.');
    if (FILE_EXT.test(path)) return { ok: true, kind: 'media', media: { provider: 'file', url } };
    // Any other link: maybe a video file without an extension. Checked before anyone loads it.
    return { ok: true, kind: 'media', media: { provider: 'file', url }, guessed: true };
}

/** Media received from someone else: rebuilt from its url (and the title kept), or null. */
export function normalizeMedia(media) {
    if (!media || typeof media.url !== 'string' || media.url.length > 2048) return null;
    const res = detectLink(media.url);
    if (!res.ok || res.kind !== 'media') return null;
    const title = typeof media.title === 'string' ? media.title.slice(0, 200) : '';
    return { ...res.media, ...(title ? { title } : {}) };
}

/** Same video? (for messages about "what is playing") */
export const mediaKey = (media) => (media ? `${media.provider}:${media.url}` : '');

/** A name to show before (or instead of) a real title. */
export function fallbackTitle(media) {
    if (!media) return '';
    if (media.provider === 'twitch') return media.channel ? `${media.channel} on Twitch` : 'Twitch video';
    if (media.provider === 'vimeo') return 'Vimeo video';
    try {
        const u = new URL(media.url);
        const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
        return last && last.length < 120 ? last : u.hostname;
    } catch {
        return 'Video';
    }
}
