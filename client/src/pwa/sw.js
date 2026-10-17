/* 3RTC service worker.
 * Template: the build (vite.config.js -> pwaServiceWorker) fills in VERSION and
 * PRECACHE_URLS and writes the result to dist/sw.js. Not used in dev.
 *
 * - App shell (index.html, hashed JS/CSS, icons, sounds) is precached per build -> instant launch.
 * - The app page is fetched from the network first (falling back to the cached copy offline or
 *   after a few seconds), so an online visit always gets the current page with matching assets.
 *   Hashed files of replaced versions are kept in the asset cache, so a page that is already open
 *   keeps working while a new version takes over (otherwise its CSS/JS could 404 mid-deploy).
 * - Other hashed /assets/ files (on-demand, e.g. the voice isolation model) are cached on first use.
 * - Google Fonts are cached stale-while-revalidate.
 * - /__p2p-stream/... is a peer's video streamed on demand: each byte range the <video> element
 *   asks for is read from the page, which fetches it from the peer over WebRTC (p2pStreamer.js).
 * - Everything else (signaling WebSocket, YouTube, blobs) is never intercepted.
 */

const VERSION = '__SW_VERSION__';
const PRECACHE_URLS = __PRECACHE_URLS__;
const SHELL_CACHE = `3rtc-shell-${VERSION}`;
const FONT_CACHE = '3rtc-fonts';
const ASSET_CACHE = '3rtc-assets';
const SHELL_URL = '/';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('3rtc-shell-') && key !== SHELL_CACHE)
          .map((key) => retireShellCache(key))
      ))
      .then(() => self.clients.claim())
  );
});

const SHELL_NETWORK_TIMEOUT_MS = 3000;
const ASSET_CACHE_MAX = 80;

// Network first so a new deploy is picked up on the next visit; the cached shell when offline
// or when the network is too slow to answer
async function serveShell(request) {
  const cached = caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
  try {
    const network = fetch(request).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), SHELL_NETWORK_TIMEOUT_MS));
    return await Promise.race([network, timeout]);
  } catch (err) {
    const fallback = await cached;
    if (fallback) return fallback;
    return fetch(request);
  }
}

// An old version's shell cache is going away: keep its hashed assets (their names never clash),
// trimmed to the most recent ASSET_CACHE_MAX, for pages of that version that are still open
async function retireShellCache(key) {
  try {
    const [oldCache, assets] = await Promise.all([caches.open(key), caches.open(ASSET_CACHE)]);
    for (const request of await oldCache.keys()) {
      if (new URL(request.url).pathname.startsWith('/assets/')) {
        const response = await oldCache.match(request);
        if (response) await assets.put(request, response);
      }
    }
    const keys = await assets.keys();
    for (const stale of keys.slice(0, Math.max(0, keys.length - ASSET_CACHE_MAX))) await assets.delete(stale);
  } catch (err) {
    // best effort
  }
  return caches.delete(key);
}

// Other pages (/about, /privacy…) are plain static pages: network first, cached copy offline
async function servePage(request, url) {
  try {
    return await fetch(request);
  } catch (err) {
    const cached = await caches.match(url.pathname, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

const isAppPath = (pathname) => pathname === '/' || pathname === '/index.html';

async function cacheFirst(request) {
  try {
    const cached = await caches.match(request, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    return await fetch(request);
  } catch (err) {
    const anyCached = await caches.match(request);
    if (anyCached) return anyCached;
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

// Hashed asset: current shell cache, then assets kept from earlier versions, then the network
async function serveAsset(request) {
  const current = await caches.match(request, { cacheName: SHELL_CACHE });
  if (current) return current;
  return cacheOnFirstUse(request);
}

// Hashed file names never change content, so a cached copy is always valid
async function cacheOnFirstUse(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const anyCached = await caches.match(request);
    if (anyCached) return anyCached;
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

// ---- On-demand P2P video stream ----
const P2P_STREAM_PREFIX = '/__p2p-stream/';
const P2P_READ_SIZE = 256 * 1024;

// The page checks that this worker (not an older cached one) can serve P2P streams
self.addEventListener('message', (event) => {
  if (event.data?.type === 'p2p-stream-ping' && event.ports[0]) {
    event.ports[0].postMessage({ p2pStreaming: true });
  }
  // A page this worker doesn't control yet (hard refresh, or opened before the worker started)
  // asks to be taken over, so it can stream on demand
  if (event.data?.type === 'p2p-claim') {
    event.waitUntil(self.clients.claim());
  }
});

/** Ask a page for the stream; resolves with { port, meta } from the page that has it. */
async function openP2PStream(event, streamNo, start, end) {
  const candidates = [];
  const own = event.clientId ? await self.clients.get(event.clientId) : null;
  if (own) candidates.push(own);
  for (const client of await self.clients.matchAll({ type: 'window' })) {
    if (!own || client.id !== own.id) candidates.push(client);
  }
  for (const client of candidates) {
    const { port1, port2 } = new MessageChannel();
    const meta = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      port1.onmessage = (e) => {
        clearTimeout(timer);
        resolve(e.data);
      };
      client.postMessage({ type: 'p2p-range-open', streamNo, start, end }, [port2]);
    });
    if (meta?.ok) return { port: port1, meta };
    port1.close();
  }
  return null;
}

async function serveP2PStream(event, url) {
  const streamNo = url.pathname.slice(P2P_STREAM_PREFIX.length).split('/')[0];
  const rangeHeader = event.request.headers.get('range');
  const match = rangeHeader && /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  const start = match ? Number(match[1]) : 0;
  const requestedEnd = match && match[2] ? Number(match[2]) : null;

  const opened = await openP2PStream(event, streamNo, start, requestedEnd);
  if (!opened) {
    return new Response('Stream not available', { status: 404 });
  }
  const { port, meta } = opened;
  const size = meta.size;
  if (start >= size) {
    port.close();
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const end = requestedEnd === null ? size - 1 : Math.min(requestedEnd, size - 1);

  // Pull-based: the player's own buffering decides how fast data is requested from the peer
  const body = new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        port.onmessage = (e) => {
          const msg = e.data || {};
          if (msg.data) controller.enqueue(new Uint8Array(msg.data));
          if (msg.done) {
            controller.close();
            port.close();
          }
          if (msg.error) controller.error(new Error('P2P stream read failed'));
          resolve();
        };
        port.postMessage({ type: 'read', want: P2P_READ_SIZE });
      });
    },
    cancel() {
      try { port.postMessage({ type: 'cancel' }); } catch { }
      port.close();
    }
  });

  const headers = {
    'Content-Type': meta.mimeType || 'video/mp4',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  };
  if (match) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: match ? 206 : 200, headers });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(P2P_STREAM_PREFIX)) {
    event.respondWith(serveP2PStream(event, url));
    return;
  }
  if (request.headers.has('range')) return;

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(isAppPath(url.pathname) ? serveShell(request) : servePage(request, url));
      return;
    }
    if (url.pathname.startsWith('/assets/')) {
      event.respondWith(serveAsset(request));
    } else if (PRECACHE_URLS.includes(url.pathname)) {
      event.respondWith(cacheFirst(request));
    }
    return;
  }

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
