/**
 * QR codes for room invites.
 *
 * Encoding uses qrcode-generator (MIT, no dependencies, runs entirely in the browser). The
 * previous hand-written encoder produced codes that phone cameras couldn't read.
 * Error correction level H: up to ~30% of the code can be covered (the 3RTC badge in the middle
 * of the invite) and it still scans.
 */
import qrcode from 'qrcode-generator';

/**
 * QR matrix for `text`: matrix[row][col] is true for dark modules.
 * @param {string} text
 * @returns {{ matrix: boolean[][], size: number, version: number }}
 */
export function generateQrMatrix(text) {
  const qr = qrcode(0, 'H'); // 0 = smallest version that fits
  qr.addData(String.fromCharCode(...new TextEncoder().encode(String(text))), 'Byte'); // UTF-8 bytes
  qr.make();
  const size = qr.getModuleCount();
  const matrix = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => qr.isDark(r, c)));
  return { matrix, size, version: (size - 17) / 4 };
}

/**
 * Generates an SVG path data string for all dark modules
 * @param {boolean[][]} matrix 
 * @param {number} cellSize 
 * @param {number} margin 
 * @returns {string} SVG path string
 */
export function generateQrSvgPath(matrix, cellSize = 10, margin = 4) {
  const size = matrix.length;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        const x = (c + margin) * cellSize;
        const y = (r + margin) * cellSize;
        path += `M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z `;
      }
    }
  }
  return path;
}

/**
 * Draws the QR Code directly to an HTML5 canvas element
 * @param {HTMLCanvasElement} canvas 
 * @param {string} text 
 * @param {object} options 
 */
export function drawQrToCanvas(canvas, text, options = {}) {
  const {
    cellSize = 8,
    margin = 4,
    darkColor = '#000000',
    lightColor = '#ffffff'
  } = options;

  const { matrix, size } = generateQrMatrix(text);
  const totalSize = (size + margin * 2) * cellSize;

  canvas.width = totalSize;
  canvas.height = totalSize;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = lightColor;
  ctx.fillRect(0, 0, totalSize, totalSize);

  // Dark modules
  ctx.fillStyle = darkColor;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        ctx.fillRect(
          (c + margin) * cellSize,
          (r + margin) * cellSize,
          cellSize,
          cellSize
        );
      }
    }
  }
}

/**
 * Detect server tag ('orc', 'gcp', 'local') from a signaling WebSocket URL.
 */
export function getServerTag(signalUrl) {
  if (!signalUrl) return '';
  if (signalUrl.includes('orc.3rtc.me')) return 'orc';
  if (signalUrl.includes('gcp.3rtc.me')) return 'gcp';
  if (signalUrl.includes('localhost') || signalUrl.includes('127.0.0.1')) return 'local';
  return '';
}

/**
 * Constructs the clean mobile join URL with optional server affinity (?s=orc | ?s=gcp)
 */
export function getMobileJoinUrl(roomId, customHost = null, fromName = '', serverTag = '') {
  const cleanRoom = String(roomId || '').trim();
  // "Priya invited you": the inviter's name rides along in the link (no server lookup needed)
  const from = String(fromName || '').trim();
  const fromPart = from && !/^User_\d+$/.test(from) ? `&from=${encodeURIComponent(from.slice(0, 24))}` : '';
  const serverPart = serverTag ? `&s=${encodeURIComponent(serverTag)}` : '';
  if (typeof window === 'undefined') {
    return `https://3rtc.me/?room=${cleanRoom}${fromPart}${serverPart}`;
  }

  const origin = customHost ? customHost : window.location.origin;
  const pathname = window.location.pathname.endsWith('/') ? window.location.pathname : `${window.location.pathname}/`;
  return `${origin}${pathname}?room=${cleanRoom}${fromPart}${serverPart}`;
}
