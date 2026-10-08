/* 3RTC service worker.
 * Template: the build (vite.config.js -> pwaServiceWorker) fills in VERSION and
 * PRECACHE_URLS and writes the result to dist/sw.js. Not used in dev.
 *
 * - App shell (index.html, hashed JS/CSS, icons, sounds) is precached per build -> instant launch.
 * - Navigations are served from the cached shell (single-page app); a new deploy installs a
 *   new worker in the background and takes effect on the next launch.
 * - Other hashed /assets/ files (on-demand, e.g. the voice isolation model) are cached on first use.
 * - Google Fonts are cached stale-while-revalidate.
 * - Everything else (signaling WebSocket, YouTube, P2P media, blobs) is never intercepted.
 */

const VERSION = '__SW_VERSION__';
const PRECACHE_URLS = __PRECACHE_URLS__;
const SHELL_CACHE = `3rtc-shell-${VERSION}`;
const FONT_CACHE = '3rtc-fonts';
const ASSET_CACHE = '3rtc-assets';
const SHELL_URL = '/index.html';
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(serveShell(request));
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
