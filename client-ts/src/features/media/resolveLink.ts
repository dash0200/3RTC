/**
 * The paste box: from pasted text to something the room can play, with a title.
 *   { kind: 'youtube', videoId, title } | { kind: 'media', media } | { error }
 * A link that's only a guess (no known site, no video extension) is opened here first; it's only
 * shared if this browser can actually play it.
 */
import { detectLink, fallbackTitle } from './sources';
import { findQuickPickTitle } from '../../utils/quickPicks';
import type { MediaItem } from '../../types';

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

export async function fetchYouTubeTitle(videoId: string, fallbackTitle = ''): Promise<string> {
  if (!videoId) return fallbackTitle || 'YouTube Video';
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.title === 'string' && data.title) {
        return data.title;
      }
    }
  } catch {
    // Ignore timeout or network errors
  }
  const presetTitle = findQuickPickTitle(videoId);
  if (presetTitle) return presetTitle;
  return fallbackTitle || `YouTube Video (${videoId})`;
}

async function vimeoTitle(url: string): Promise<string> {
  try {
    const res = await withTimeout(fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`), 4000);
    if (!res?.ok) return '';
    const data = await res.json();
    return typeof data?.title === 'string' ? data.title.slice(0, 200) : '';
  } catch {
    return '';
  }
}

export type ResolvePastedLinkResult =
  | { kind: 'youtube'; videoId: string; title: string; error?: never }
  | { kind: 'media'; media: MediaItem; error?: never }
  | { error: string; kind?: never };

export async function resolvePastedLink(text: string): Promise<ResolvePastedLinkResult> {
  const res = detectLink(text);
  if (!res.ok) return { error: res.message };
  if (res.kind === 'youtube') {
    return { kind: 'youtube', videoId: res.videoId, title: await fetchYouTubeTitle(res.videoId) };
  }
  const media = { ...res.media };
  if (res.guessed) {
    const { probeVideoUrl } = await import('./adapters/html5');
    if (!(await probeVideoUrl(media.url))) {
      return {
        error:
          'That link isn\'t a video this browser can play. Paste a YouTube, Vimeo or Twitch link, or a direct video link (.mp4, .webm, .m3u8).'
      };
    }
  }
  if (media.provider === 'vimeo') media.title = await vimeoTitle(media.url);
  if (!media.title) media.title = fallbackTitle(media);
  return { kind: 'media', media };
}

// Short enough for a phone; the explanation is in the error messages
export const PASTE_PLACEHOLDER = 'Paste a link: YouTube, Vimeo, Twitch, .mp4…';
