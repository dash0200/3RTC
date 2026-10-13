/* 3RTC service worker.
 * Template: the build (vite.config.js -> pwaServiceWorker) fills in VERSION and
 * PRECACHE_URLS and writes the result to dist/sw.js. Not used in dev.
 *
 * - App shell (index.html, hashed JS/CSS, icons, sounds) is precached per build -> instant launch.
 * - Navigations are served from the cached shell (single-page app); a new deploy installs a
 *   new worker in the background and takes effect on the next launch.
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
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function serveShell(request) {
  const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
  if (cached) return cached;
  return fetch(request);
}

// Other pages (/about, /privacy…) are plain static pages: network first, cached copy offline
async function servePage(request, url) {
  try {
    return await fetch(request);
  } catch (err) {
    const cached = await caches.match(url.pathname, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw err;
  }
}

const isAppPath = (pathname) => pathname === '/' || pathname === '/index.html';

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE });
  return cached || fetch(request);
}

// Hashed file names never change content, so a cached copy is always valid
async function cacheOnFirstUse(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
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
    if (PRECACHE_URLS.includes(url.pathname)) {
      event.respondWith(cacheFirst(request));
    } else if (url.pathname.startsWith('/assets/')) {
      event.respondWith(cacheOnFirstUse(request));
    }
    return;
  }

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
