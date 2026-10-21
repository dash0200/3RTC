/**
 * Whiteboard data: strokes on a fixed 1600 × 1000 board (every screen scales it to fit, so a
 * point means the same spot for everyone). Pure: no React, no DOM (drawing takes a 2D context).
 *
 * Shared state is split so one new stroke doesn't resend the whole drawing:
 *   act:whiteboard              { epoch, chunks, bg }   (clear = new epoch)
 *   act:whiteboard:<epoch>:<n>  { strokes }             (up to CHUNK_MAX strokes each)
 */

export const BOARD_W = 1600;
export const BOARD_H = 1000;
export const CHUNK_MAX = 60;
const CHUNK_HARD_MAX = 100; // a few over while the next chunk is being opened
export const MAX_CHUNKS = 50;
const MAX_POINTS = 3000; // numbers per stroke (x, y pairs)

export type Tool = 'pen' | 'hl' | 'line' | 'rect' | 'ell' | 'arrow' | 'text';
export const TOOLS: Tool[] = ['pen', 'hl', 'line', 'rect', 'ell', 'arrow', 'text'];

export interface Stroke {
  id: string;
  /** who drew it (name, for "drawn by") */
  by: string;
  k: Tool;
  c: string; // #rrggbb
  w: number; // line width, or font size for text
  /** pen/highlighter: x,y,x,y…; shapes: x1,y1,x2,y2; text: x,y */
  p: number[];
  t?: string;
}

// ---- index store ----------------------------------------------------------------------------

export interface BoardIndex {
  epoch: number;
  chunks: number;
  bg: 'light' | 'dark';
  clearedBy: string;
}
export const INDEX_INITIAL: BoardIndex = { epoch: 0, chunks: 1, bg: 'light', clearedBy: '' };
export type IndexAction = { kind: 'grow'; from: number } | { kind: 'clear'; name?: string } | { kind: 'bg'; bg: 'light' | 'dark' };

interface Meta {
  by: string;
  isHost?: boolean;
  hostId?: string | null;
  present?: string[];
}
export const canManage = (meta: Meta): boolean => Boolean(meta.isHost || !meta.hostId || !meta.present?.includes(meta.hostId));

export function indexReducer(s: BoardIndex, a: IndexAction, meta: Meta): BoardIndex {
  switch (a.kind) {
    case 'grow':
      // only from the chunk that is the last one now (two people filling it at once grow it once)
      return a.from === s.chunks - 1 && s.chunks < MAX_CHUNKS ? { ...s, chunks: s.chunks + 1 } : s;
    case 'clear':
      if (!canManage(meta)) return s;
      return { ...s, epoch: s.epoch + 1, chunks: 1, clearedBy: String(a.name || '').slice(0, 40) };
    case 'bg':
      return a.bg === 'light' || a.bg === 'dark' ? (a.bg === s.bg ? s : { ...s, bg: a.bg }) : s;
    default:
      return s;
  }
}

// ---- chunk stores -----------------------------------------------------------------------------

export interface Chunk {
  strokes: Stroke[];
}
export const CHUNK_INITIAL: Chunk = { strokes: [] };
export type ChunkAction = { kind: 'add'; strokes: Stroke[] } | { kind: 'remove'; ids: string[] };

const HEX = /^#[0-9a-f]{6}$/i;
const inRange = (v: number, lo: number, hi: number): boolean => Number.isFinite(v) && v >= lo && v <= hi;

/** A stroke from the network, checked and tidied, or null */
export function cleanStroke(x: unknown): Stroke | null {
  if (!x || typeof x !== 'object') return null;
  const s = x as Partial<Stroke>;
  if (typeof s.id !== 'string' || !s.id || s.id.length > 40) return null;
  if (!TOOLS.includes(s.k as Tool) || typeof s.c !== 'string' || !HEX.test(s.c)) return null;
  if (!inRange(Number(s.w), 1, 120) || !Array.isArray(s.p)) return null;
  // Points past the edge (a stroke that left the board) are kept at the edge, not refused
  const p = s.p.slice(0, MAX_POINTS).map(Number);
  if (p.length < 2 || p.length % 2 || !p.every(Number.isFinite)) return null;
  for (let i = 0; i < p.length; i++) p[i] = Math.max(0, Math.min(i % 2 ? BOARD_H : BOARD_W, p[i]));
  if (s.k !== 'pen' && s.k !== 'hl' && s.k !== 'text' && p.length !== 4) return null;
  if (s.k === 'text' && (typeof s.t !== 'string' || !s.t.trim())) return null;
  return {
    id: s.id,
    by: String(s.by || '').slice(0, 40),
    k: s.k as Tool,
    c: s.c.toLowerCase(),
    w: Math.round(Number(s.w)),
    p: p.map((v) => Math.round(v)),
    ...(s.k === 'text' ? { t: String(s.t).slice(0, 500) } : {})
  };
}

export function chunkReducer(s: Chunk, a: ChunkAction): Chunk {
  switch (a.kind) {
    case 'add': {
      if (!Array.isArray(a.strokes)) return s;
      const have = new Set(s.strokes.map((x) => x.id));
      const add = a.strokes.map(cleanStroke).filter((x): x is Stroke => Boolean(x && !have.has(x.id)));
      if (!add.length || s.strokes.length + add.length > CHUNK_HARD_MAX) return s;
      return { strokes: [...s.strokes, ...add] };
    }
    case 'remove': {
      if (!Array.isArray(a.ids)) return s;
      const drop = new Set(a.ids.map(String));
      const strokes = s.strokes.filter((x) => !drop.has(x.id));
      return strokes.length === s.strokes.length ? s : { strokes };
    }
    default:
      return s;
  }
}

// ---- geometry -----------------------------------------------------------------------------------

/** Ramer–Douglas–Peucker on a flat x,y list: drops points that don't change the shape */
export function simplify(p: number[], epsilon = 0.8): number[] {
  const n = p.length / 2;
  if (n <= 2) return p.map(Math.round);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(p[i * 2], p[i * 2 + 1], p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > epsilon && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(Math.round(p[i * 2]), Math.round(p[i * 2 + 1]));
  return out;
}

export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Rough size of a text stroke */
export const textBox = (s: Stroke): { x: number; y: number; w: number; h: number } => {
  const lines = (s.t || '').split('\n');
  const w = Math.max(...lines.map((l) => l.length)) * s.w * 0.56;
  return { x: s.p[0], y: s.p[1], w, h: lines.length * s.w * 1.25 };
};

/** Does a circle of radius r at (x, y) touch the stroke? (the eraser) */
export function hits(s: Stroke, x: number, y: number, r: number): boolean {
  const reach = r + s.w / 2;
  const p = s.p;
  switch (s.k) {
    case 'pen':
    case 'hl': {
      const widen = s.k === 'hl' ? s.w : 0;
      if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach + widen;
      for (let i = 0; i + 3 < p.length; i += 2) {
        if (segmentDistance(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach + widen) return true;
      }
      return false;
    }
    case 'line':
    case 'arrow':
      return segmentDistance(x, y, p[0], p[1], p[2], p[3]) <= reach;
    case 'rect': {
      const [x1, y1, x2, y2] = p;
      return (
        segmentDistance(x, y, x1, y1, x2, y1) <= reach ||
        segmentDistance(x, y, x2, y1, x2, y2) <= reach ||
        segmentDistance(x, y, x2, y2, x1, y2) <= reach ||
        segmentDistance(x, y, x1, y2, x1, y1) <= reach
      );
    }
    case 'ell': {
      const cx = (p[0] + p[2]) / 2;
      const cy = (p[1] + p[3]) / 2;
      const rx = Math.abs(p[2] - p[0]) / 2;
      const ry = Math.abs(p[3] - p[1]) / 2;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        if (Math.hypot(x - (cx + rx * Math.cos(a)), y - (cy + ry * Math.sin(a))) <= reach + 4) return true;
      }
      return false;
    }
    case 'text': {
      const b = textBox(s);
      return x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r;
    }
    default:
      return false;
  }
}

// ---- drawing ----------------------------------------------------------------------------------

export const FONT = "'Figtree Variable', system-ui, sans-serif";

/** Draw one stroke on a context already scaled to board units */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, opts: { dim?: boolean } = {}): void {
  const p = s.p;
  ctx.save();
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  ctx.lineWidth = s.w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (opts.dim) ctx.globalAlpha = 0.3;
  switch (s.k) {
    case 'pen':
    case 'hl': {
      if (s.k === 'hl') {
        ctx.globalAlpha = opts.dim ? 0.12 : 0.35;
        ctx.lineWidth = s.w * 3;
        ctx.lineCap = 'butt';
      }
      ctx.beginPath();
      if (p.length === 2) {
        ctx.arc(p[0], p[1], ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      ctx.moveTo(p[0], p[1]);
      // smooth: curves through the midpoints
      for (let i = 2; i + 3 < p.length; i += 2) {
        const mx = (p[i] + p[i + 2]) / 2;
        const my = (p[i + 1] + p[i + 3]) / 2;
        ctx.quadraticCurveTo(p[i], p[i + 1], mx, my);
      }
      ctx.lineTo(p[p.length - 2], p[p.length - 1]);
      ctx.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[2], p[3]);
      ctx.stroke();
      if (s.k === 'arrow') {
        const a = Math.atan2(p[3] - p[1], p[2] - p[0]);
        const len = Math.max(14, s.w * 4);
        ctx.beginPath();
        ctx.moveTo(p[2], p[3]);
        ctx.lineTo(p[2] - len * Math.cos(a - 0.45), p[3] - len * Math.sin(a - 0.45));
        ctx.moveTo(p[2], p[3]);
        ctx.lineTo(p[2] - len * Math.cos(a + 0.45), p[3] - len * Math.sin(a + 0.45));
        ctx.stroke();
      }
      break;
    }
    case 'rect': {
      ctx.beginPath();
      ctx.rect(Math.min(p[0], p[2]), Math.min(p[1], p[3]), Math.abs(p[2] - p[0]), Math.abs(p[3] - p[1]));
      ctx.stroke();
      break;
    }
    case 'ell': {
      ctx.beginPath();
      ctx.ellipse((p[0] + p[2]) / 2, (p[1] + p[3]) / 2, Math.abs(p[2] - p[0]) / 2, Math.abs(p[3] - p[1]) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.font = `600 ${s.w}px ${FONT}`;
      ctx.textBaseline = 'top';
      (s.t || '').split('\n').forEach((line, i) => ctx.fillText(line, p[0], p[1] + i * s.w * 1.25));
      break;
    }
  }
  ctx.restore();
}

export const BG = { light: '#fbfbf8', dark: '#15161b' };
