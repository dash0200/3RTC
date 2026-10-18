/**
 * 3RTC signaling server: WebSocket signaling (signaling.js), the YouTube quick picks endpoint
 * (quickPicks.js), and in development the built web app. In production (NODE_ENV=production)
 * page visits are redirected to the app at APP_URL.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSignaling, MAX_ROOM_USERS } from './signaling.js';
import { startQuickPicks, serveQuickPicks } from './quickPicks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Development only: serve the built app (npm run build in client/) next to signaling
const candidateDirs = [
  path.resolve(__dirname, '../client/dist'),
  path.resolve(__dirname, 'client/dist')
];
const clientDir = candidateDirs.find(d => fs.existsSync(d) && fs.existsSync(path.join(d, 'index.html'))) || candidateDirs[0];

const PORT = process.env.PORT || 8080;
// Production: 127.0.0.1, so only Caddy (TLS, on the same VM) can reach it. Default: every interface
// (local development, phones on the same Wi-Fi)
const HOST = process.env.HOST || undefined;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()'
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/api/quick-picks') return serveQuickPicks(req, res);

  // In production the website is 3rtc.me (Vercel); this server only does signaling. Browser visits
  // (signal.3rtc.me, the sslip.io address, old invite links) go to the app, keeping ?room=…
  if (process.env.NODE_ENV === 'production') {
    const appUrl = (process.env.APP_URL || 'https://3rtc.me').replace(/\/$/, '');
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.writeHead(302, {
      ...SECURITY_HEADERS,
      Location: `${appUrl}/${query}`,
      'Cache-Control': 'no-cache',
      'X-Robots-Tag': 'noindex'
    });
    return res.end();
  }
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  let safePath = path.normalize(path.join(clientDir, reqPath));
  if (!safePath.startsWith(clientDir) || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    // SPA fallback to index.html
    const indexPath = path.join(clientDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      safePath = indexPath;
    } else {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
  }

  const ext = path.extname(safePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(safePath).pipe(res);
});

attachSignaling(server);
startQuickPicks();

server.listen(PORT, HOST, () => {
  console.log(`===============================================`);
  console.log(` WebRTC Signaling & Web Server on port ${PORT}`);
  console.log(` Web Client UI: http://localhost:${PORT}`);
  console.log(` WebSocket URL: ws://localhost:${PORT}`);
  console.log(` Rooms: up to ${MAX_ROOM_USERS} people`);
  console.log(`===============================================`);
});
