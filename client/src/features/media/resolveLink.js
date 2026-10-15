/**
 * The paste box: from pasted text to something the room can play, with a title.
 *   { kind: 'youtube', videoId, title } | { kind: 'media', media } | { error }
 * A link that's only a guess (no known site, no video extension) is opened here first; it's only
 * shared if this browser can actually play it.
 */
import { detectLink, fallbackTitle } from './sources';
import { fetchYouTubeTitle } from '../../components/YouTubeSyncPlayer';

const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

async function vimeoTitle(url) {
    try {
        const res = await withTimeout(fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`), 4000);
        if (!res?.ok) return '';
        const data = await res.json();
        return typeof data?.title === 'string' ? data.title.slice(0, 200) : '';
    } catch {
        return '';
    }
}

export async function resolvePastedLink(text) {
    const res = detectLink(text);
    if (!res.ok) return { error: res.message };
    if (res.kind === 'youtube') return { kind: 'youtube', videoId: res.videoId, title: await fetchYouTubeTitle(res.videoId) };
    const media = { ...res.media };
    if (res.guessed) {
        const { probeVideoUrl } = await import('./adapters/html5');
        if (!(await probeVideoUrl(media.url))) {
            return { error: 'That link isn\'t a video this browser can play. Paste a YouTube, Vimeo or Twitch link, or a direct video link (.mp4, .webm, .m3u8).' };
        }
    }
    if (media.provider === 'vimeo') media.title = await vimeoTitle(media.url);
    if (!media.title) media.title = fallbackTitle(media);
    return { kind: 'media', media };
}

// Short enough for a phone; the explanation is in the error messages
export const PASTE_PLACEHOLDER = 'Paste a link: YouTube, Vimeo, Twitch, .mp4…';
