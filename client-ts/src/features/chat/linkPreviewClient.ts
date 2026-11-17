/**
 * Link previews for chat messages, from the signaling server's GET /api/link-preview (it fetches
 * the page: a browser can't read other sites). One request per link per visit (cached here, and
 * by the server); failures are remembered too, so nothing is asked twice.
 */
import { splitLinks } from '../../utils/chatLinks';

export interface LinkPreviewData {
  url: string;
  title: string;
  description: string;
  image: string;
  siteName: string;
}

const CACHE_MAX = 200;
const cache = new Map<string, Promise<LinkPreviewData | null>>();
let servers: string[] = [];

/** The signaling servers (wss://…), set by the app; previews come from the first that answers. */
export function setPreviewServers(signalUrls: string[]): void {
  servers = [...signalUrls];
}

/** wss://host -> https://host/api/link-preview?url=… */
export function previewEndpoint(signalUrl: string, link: string): string | null {
  try {
    const url = new URL(signalUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/api/link-preview';
    url.search = `?url=${encodeURIComponent(link)}`;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** The first web link in a message, if any. */
export function firstLink(text: string | null | undefined): string | null {
  for (const part of splitLinks(text)) if (part.href) return part.href;
  return null;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A preview from the server, kept only if well formed (the image only if https). */
export function cleanPreview(raw: unknown): LinkPreviewData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 200).trim();
  if (!title) return null;
  const image = str(r.image, 1000);
  return {
    url: str(r.url, 2048),
    title,
    description: str(r.description, 300),
    image: /^https:\/\//i.test(image) ? image : '',
    siteName: str(r.siteName, 80)
  };
}

async function load(link: string): Promise<LinkPreviewData | null> {
  for (const server of servers) {
    const endpoint = previewEndpoint(server, link);
    if (!endpoint) continue;
    try {
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
      if (res.status === 404) return null; // no preview for that link
      if (!res.ok) continue; // rate-limited or down: try the next server
      return cleanPreview(await res.json());
    } catch {
      // unreachable: try the next server
    }
  }
  return null;
}

/** The preview of `link` (once per visit). */
export function getLinkPreview(link: string): Promise<LinkPreviewData | null> {
  let hit = cache.get(link);
  if (!hit) {
    hit = load(link);
    cache.set(link, hit);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  return hit;
}
