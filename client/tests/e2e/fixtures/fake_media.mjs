// Serves test media like a CDN would: byte ranges (seeking) and CORS (hls.js fetches with it).
// Usage: node fake_media.mjs <dir> [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 9933);
const types = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment', '.html': 'text/html', '.txt': 'text/plain' };

http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__ping') { res.end('ok'); return; }
    if (url.pathname === '/page') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body>not a video</body></html>'); return; }
    const file = path.join(dir, decodeURIComponent(url.pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(file).size;
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
    }
    res.writeHead(200, { 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`fake media on ${port} serving ${dir}`));
