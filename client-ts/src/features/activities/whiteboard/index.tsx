/**
 * Whiteboard: draw together. Pen, highlighter, eraser, lines, arrows, boxes, circles and text,
 * your own undo/redo, a light or dark board, and saving it as a picture.
 *
 * Finished strokes are shared state in chunks (./model.ts), so people joining later see the
 * whole drawing. While you draw, the stroke streams to the others as it grows ('wb-live'), and
 * everyone's pointer shows with their name ('wb-cursor').
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { useRoom, useSharedState, usePeerMessage } from '../../../core/RoomContext';
import { releaseSharedStores } from '../../../core/sharedState';
import {
  BG,
  BOARD_H,
  BOARD_W,
  CHUNK_INITIAL,
  CHUNK_MAX,
  INDEX_INITIAL,
  MAX_CHUNKS,
  canManage as canManageMeta,
  chunkReducer,
  cleanStroke,
  drawStroke,
  hits,
  indexReducer,
  simplify,
  type BoardIndex,
  type Chunk,
  type ChunkAction,
  type IndexAction,
  type Stroke,
  type Tool
} from './model';
import './whiteboard.css';

const COLORS = ['#1f2329', '#ffffff', '#e5484d', '#f97316', '#f2b705', '#2fa84f', '#2f7fe0', '#a855f7'];
const SIZES = [3, 6, 12];
const TEXT_SIZES = [24, 36, 56];
const ERASER_R = 14;
const LIVE_EVERY_MS = 40;
const CURSOR_EVERY_MS = 80;

const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---- one chunk of strokes (each is its own shared store) -------------------------------------

type ChunkReport = (index: number, strokes: Stroke[], dispatch: (a: ChunkAction) => void) => void;

function ChunkSync({ storeKey, index, onState }: { storeKey: string; index: number; onState: ChunkReport }): null {
  const [chunk, dispatch] = useSharedState<Chunk, ChunkAction>(storeKey, { initial: CHUNK_INITIAL, reducer: chunkReducer });
  useEffect(() => {
    onState(index, chunk.strokes, dispatch);
  }, [index, chunk.strokes, dispatch, onState]);
  return null;
}

// ---- icons --------------------------------------------------------------------------------------

const ICONS: Record<Tool | 'eraser' | 'undo' | 'redo' | 'clear' | 'save' | 'bg', JSX.Element> = {
  pen: <path d="M4 20l4-1 11-11-3-3L5 16l-1 4zM14 6l3 3" />,
  hl: <path d="M6 19h12M8 15l7-9 3 2-7 9H8v-2z" />,
  eraser: <path d="M8 20h11M5 15l8-9 6 6-6 7H9l-4-4z" />,
  line: <path d="M5 19L19 5" />,
  arrow: <path d="M5 19L19 5M11 5h8v8" />,
  rect: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
  ell: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  undo: <path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" />,
  redo: <path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h2" />,
  clear: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  save: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  bg: <path d="M12 3a9 9 0 100 18V3z" />
};
const Icon = ({ name }: { name: keyof typeof ICONS }): JSX.Element => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name]}
  </svg>
);
const TOOL_LABELS: Record<Tool | 'eraser', string> = {
  pen: 'Pen',
  hl: 'Highlighter',
  eraser: 'Eraser',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Box',
  ell: 'Circle',
  text: 'Text'
};

interface LiveStroke {
  stroke: Stroke;
  at: number;
}
interface Cursor {
  x: number;
  y: number;
  name: string;
  at: number;
}
type UndoEntry = { type: 'add' | 'erase'; strokes: Stroke[] };

export interface WhiteboardProps {
  activityId: string;
}

export default function Whiteboard({ activityId }: WhiteboardProps): JSX.Element {
  const room = useRoom();
  const baseKey = `act:${activityId}`;
  const [index, dispatchIndex] = useSharedState<BoardIndex, IndexAction>(baseKey, { initial: INDEX_INITIAL, reducer: indexReducer });
  const myName = room.getSelf().username || 'Someone';
  const hostId = room.getHostPeerId();
  const hostHere = Boolean(hostId && room.peers.some((p) => (p.peerId || p.id) === hostId));
  const canManage = canManageMeta({ by: room.getSelfId() || '', isHost: room.getSelf().isHost, hostId, present: hostHere && hostId ? [hostId] : [] });

  // your own undo / redo (cleared when the board is cleared)
  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);

  // ---- strokes from every chunk ----
  const [chunks, setChunks] = useState<Record<number, { strokes: Stroke[]; dispatch: (a: ChunkAction) => void; epoch: number }>>({});
  const epochRef = useRef(index.epoch);
  epochRef.current = index.epoch;
  const onChunk = useCallback<ChunkReport>((i, strokes, dispatch) => {
    setChunks((prev) => ({ ...prev, [i]: { strokes, dispatch, epoch: epochRef.current } }));
  }, []);
  // A clear: forget the old chunks (here, and their stores)
  const lastEpoch = useRef(index.epoch);
  useEffect(() => {
    if (lastEpoch.current === index.epoch) return;
    const old = lastEpoch.current;
    lastEpoch.current = index.epoch;
    // Old chunks aren't wiped here: the new board's chunks have already reported in by now
    // (children's effects run first), and wiping would lose them until they change. Entries
    // from the old board are left out by their epoch, and drop out as the new ones replace them.
    setChunks((prev) => Object.fromEntries(Object.entries(prev).filter(([, c]) => c.epoch === index.epoch)));
    undoRef.current = [];
    redoRef.current = [];
    releaseSharedStores(room.bus, (k) => k.startsWith(`${baseKey}:${old}:`));
  }, [index.epoch, room.bus, baseKey]);
  const live = Object.entries(chunks).filter(([, c]) => c.epoch === index.epoch);
  const strokes = useMemo(() => live.sort((a, b) => Number(a[0]) - Number(b[0])).flatMap(([, c]) => c.strokes), [chunks, index.epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = strokes.length;
  const lastChunk = chunks[index.chunks - 1];
  const full = index.chunks >= MAX_CHUNKS && (lastChunk?.strokes.length ?? 0) >= CHUNK_MAX;

  // ---- tools ----
  const [tool, setTool] = useState<Tool | 'eraser'>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [sizeIx, setSizeIx] = useState(1);
  const ink = index.bg === 'dark' && color === COLORS[0] ? '#f4f4f6' : index.bg === 'light' && color === COLORS[1] ? '#1f2329' : color;
  const width = tool === 'text' ? TEXT_SIZES[sizeIx] : SIZES[sizeIx];

  // ---- layout: fit the board in the space we get ----
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = useState({ w: 800, h: 500, scale: 0.5 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      const scale = Math.max(0.05, Math.min(r.width / BOARD_W, r.height / BOARD_H));
      setFit({ w: Math.floor(BOARD_W * scale), h: Math.floor(BOARD_H * scale), scale });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

  const prepare = (canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null => {
    if (!canvas) return null;
    const pw = Math.round(fit.w * dpr);
    const ph = Math.round(fit.h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    ctx.setTransform(fit.scale * dpr, 0, 0, fit.scale * dpr, 0, 0);
    return ctx;
  };

  // ---- the eraser marks strokes as you drag over them ----
  const [erasing, setErasing] = useState<Set<string>>(new Set());

  // committed strokes
  useEffect(() => {
    const ctx = prepare(baseRef.current);
    if (!ctx) return;
    ctx.fillStyle = BG[index.bg];
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
    for (const s of strokes) drawStroke(ctx, s, { dim: erasing.has(s.id) });
  }, [strokes, erasing, fit, index.bg]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live strokes and cursors from the others ----
  const liveRef = useRef<Map<string, LiveStroke>>(new Map()); // `${peer}:${id}`
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  const mineRef = useRef<Stroke | null>(null);
  const eraserAt = useRef<{ x: number; y: number } | null>(null);
  const [overlayTick, setOverlayTick] = useState(0);
  const redrawOverlay = useCallback(() => setOverlayTick((t) => t + 1), []);

  usePeerMessage<{ e?: number; id?: string; k?: Tool; c?: string; w?: number; from?: number; pts?: number[]; name?: string; done?: boolean }>('wb-live', (msg, from) => {
    if (msg?.e !== epochRef.current || typeof msg.id !== 'string') return;
    const key = `${from}:${msg.id}`;
    if (msg.done) {
      liveRef.current.delete(key);
      redrawOverlay();
      return;
    }
    const prev = liveRef.current.get(key);
    const pts = Array.isArray(msg.pts) ? msg.pts.slice(0, 600).map(Number) : [];
    let p: number[];
    if (msg.k === 'pen' || msg.k === 'hl') p = prev && msg.from === prev.stroke.p.length ? [...prev.stroke.p, ...pts] : msg.from === 0 ? pts : prev?.stroke.p ?? pts;
    else p = pts;
    const stroke = cleanStroke({ id: msg.id, by: msg.name, k: msg.k, c: msg.c, w: msg.w, p });
    if (stroke) liveRef.current.set(key, { stroke, at: Date.now() });
    redrawOverlay();
  });
  usePeerMessage<{ x?: number; y?: number; name?: string; gone?: boolean }>('wb-cursor', (msg, from) => {
    setCursors((prev) => {
      const next = { ...prev };
      if (msg?.gone || typeof msg?.x !== 'number' || typeof msg?.y !== 'number') delete next[from];
      else next[from] = { x: msg.x, y: msg.y, name: String(msg.name || '').slice(0, 24), at: Date.now() };
      return next;
    });
  });
  // drop what went quiet (someone left mid-stroke)
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [k, v] of liveRef.current) {
        if (now - v.at > 4000) {
          liveRef.current.delete(k);
          changed = true;
        }
      }
      if (changed) redrawOverlay();
      setCursors((prev) => {
        const keep = Object.fromEntries(Object.entries(prev).filter(([, c]) => now - c.at < 5000));
        return Object.keys(keep).length === Object.keys(prev).length ? prev : keep;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [redrawOverlay]);

  // overlay: live strokes (theirs and mine) and the eraser
  useEffect(() => {
    const ctx = prepare(overRef.current);
    if (!ctx) return;
    const committed = new Set(strokes.map((s) => s.id));
    for (const [k, v] of liveRef.current) {
      if (committed.has(v.stroke.id)) liveRef.current.delete(k);
      else drawStroke(ctx, v.stroke);
    }
    if (mineRef.current) drawStroke(ctx, mineRef.current);
    if (eraserAt.current) {
      ctx.beginPath();
      ctx.arc(eraserAt.current.x, eraserAt.current.y, ERASER_R, 0, Math.PI * 2);
      ctx.strokeStyle = index.bg === 'dark' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [overlayTick, strokes, fit, index.bg]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- adding and removing (with undo) ----
  const [, setUndoTick] = useState(0);
  const findChunk = (id: string): ((a: ChunkAction) => void) | null => {
    for (const c of Object.values(chunks)) if (c.epoch === index.epoch && c.strokes.some((s) => s.id === id)) return c.dispatch;
    return null;
  };
  const addStrokes = (list: Stroke[]): void => {
    if (!list.length || full) return;
    const last = chunks[index.chunks - 1];
    if (!last || last.epoch !== index.epoch) return;
    last.dispatch({ kind: 'add', strokes: list });
    if (last.strokes.length + list.length >= CHUNK_MAX) dispatchIndex({ kind: 'grow', from: index.chunks - 1 });
  };
  const removeStrokes = (list: Stroke[]): void => {
    const byChunk = new Map<(a: ChunkAction) => void, string[]>();
    for (const s of list) {
      const d = findChunk(s.id);
      if (!d) continue;
      byChunk.set(d, [...(byChunk.get(d) || []), s.id]);
    }
    for (const [d, ids] of byChunk) d({ kind: 'remove', ids });
  };
  const record = (entry: UndoEntry): void => {
    undoRef.current = [...undoRef.current.slice(-99), entry];
    redoRef.current = [];
    setUndoTick((t) => t + 1);
  };
  const undo = (): void => {
    const e = undoRef.current.pop();
    if (!e) return;
    if (e.type === 'add') removeStrokes(e.strokes);
    else addStrokes(e.strokes);
    redoRef.current.push(e);
    setUndoTick((t) => t + 1);
  };
  const redo = (): void => {
    const e = redoRef.current.pop();
    if (!e) return;
    if (e.type === 'add') addStrokes(e.strokes);
    else removeStrokes(e.strokes);
    undoRef.current.push(e);
    setUndoTick((t) => t + 1);
  };

  // ---- pointer ----
  const toBoard = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = overRef.current!.getBoundingClientRect();
    // past the edge counts as the edge: a stroke that leaves the board runs along it, just
    // inside so the whole line shows
    const x = (e.clientX - r.left) / fit.scale;
    const y = (e.clientY - r.top) / fit.scale;
    const m = tool === 'hl' ? width * 1.5 + 1 : tool === 'pen' || tool === 'line' || tool === 'arrow' || tool === 'rect' || tool === 'ell' ? width / 2 + 1 : 0;
    return { x: Math.max(m, Math.min(BOARD_W - m, x)), y: Math.max(m, Math.min(BOARD_H - m, y)) };
  };
  const sent = useRef(0); // numbers of my live stroke already sent
  const liveTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastCursor = useRef(0);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);

  const flushLive = (done = false): void => {
    const s = mineRef.current;
    if (!s) return;
    if (s.k === 'pen' || s.k === 'hl') {
      const pts = s.p.slice(sent.current);
      if (pts.length) room.bus.broadcast('wb-live', { e: index.epoch, id: s.id, k: s.k, c: s.c, w: s.w, from: sent.current, pts, name: myName });
      sent.current = s.p.length;
    } else {
      room.bus.broadcast('wb-live', { e: index.epoch, id: s.id, k: s.k, c: s.c, w: s.w, from: 0, pts: s.p, name: myName });
    }
    if (done) room.bus.broadcast('wb-live', { e: index.epoch, id: s.id, done: true });
  };

  const eraseAt = (x: number, y: number): void => {
    const hit = strokes.filter((s) => !erasing.has(s.id) && hits(s, x, y, ERASER_R)).map((s) => s.id);
    if (hit.length) setErasing((prev) => new Set([...prev, ...hit]));
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (e.button > 0 || full) return;
    const { x, y } = toBoard(e);
    if (tool === 'text') {
      e.preventDefault();
      if (textDraft?.value.trim()) commitText();
      setTextDraft({ x, y, value: '' });
      return;
    }
    overRef.current?.setPointerCapture(e.pointerId);
    if (tool === 'eraser') {
      eraserAt.current = { x, y };
      eraseAt(x, y);
      redrawOverlay();
      return;
    }
    mineRef.current = { id: newId(), by: myName, k: tool, c: ink, w: width, p: tool === 'pen' || tool === 'hl' ? [x, y] : [x, y, x, y] };
    sent.current = 0;
    liveTimer.current = setInterval(() => flushLive(), LIVE_EVERY_MS);
    redrawOverlay();
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = toBoard(e);
    const now = Date.now();
    if (now - lastCursor.current > CURSOR_EVERY_MS) {
      lastCursor.current = now;
      room.bus.broadcast('wb-cursor', { x: Math.round(x), y: Math.round(y), name: myName });
    }
    if (tool === 'eraser') {
      eraserAt.current = { x, y };
      if (e.buttons) eraseAt(x, y);
      redrawOverlay();
      return;
    }
    const s = mineRef.current;
    if (!s) return;
    if (s.k === 'pen' || s.k === 'hl') {
      // coalesced events give smoother lines on fast moves
      const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
      const list = events.length ? events.map((ev) => toBoard(ev)) : [{ x, y }];
      for (const pt of list) {
        const lx = s.p[s.p.length - 2];
        const ly = s.p[s.p.length - 1];
        if (Math.hypot(pt.x - lx, pt.y - ly) >= 1.5) s.p.push(pt.x, pt.y);
      }
    } else {
      let x2 = x;
      let y2 = y;
      if (e.shiftKey && (s.k === 'rect' || s.k === 'ell')) {
        const d = Math.max(Math.abs(x - s.p[0]), Math.abs(y - s.p[1]));
        x2 = s.p[0] + Math.sign(x - s.p[0] || 1) * d;
        y2 = s.p[1] + Math.sign(y - s.p[1] || 1) * d;
      }
      s.p = [s.p[0], s.p[1], x2, y2];
    }
    redrawOverlay();
  };

  const onUp = (): void => {
    if (tool === 'eraser') {
      if (erasing.size) {
        const gone = strokes.filter((s) => erasing.has(s.id));
        removeStrokes(gone);
        record({ type: 'erase', strokes: gone });
        setErasing(new Set());
      }
      return;
    }
    const s = mineRef.current;
    if (!s) return;
    if (liveTimer.current) clearInterval(liveTimer.current);
    liveTimer.current = null;
    flushLive(true);
    mineRef.current = null;
    const tiny = s.k !== 'pen' && s.k !== 'hl' && Math.hypot(s.p[2] - s.p[0], s.p[3] - s.p[1]) < 3;
    if (!tiny) {
      const finished = cleanStroke({ ...s, p: s.k === 'pen' || s.k === 'hl' ? simplify(s.p) : s.p });
      if (finished) {
        addStrokes([finished]);
        record({ type: 'add', strokes: [finished] });
      }
    }
    redrawOverlay();
  };

  const onLeave = (): void => {
    eraserAt.current = null;
    room.bus.broadcast('wb-cursor', { gone: true });
    redrawOverlay();
  };

  useEffect(() => () => {
    if (liveTimer.current) clearInterval(liveTimer.current);
  }, []);

  const commitText = (): void => {
    const d = textDraft;
    setTextDraft(null);
    if (!d || !d.value.trim()) return;
    const s = cleanStroke({ id: newId(), by: myName, k: 'text', c: ink, w: TEXT_SIZES[sizeIx], p: [d.x, d.y], t: d.value.trimEnd() });
    if (s) {
      addStrokes([s]);
      record({ type: 'add', strokes: [s] });
    }
  };

  // ---- save as a picture ----
  const save = (): void => {
    const c = document.createElement('canvas');
    c.width = BOARD_W;
    c.height = BOARD_H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = BG[index.bg];
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
    for (const s of strokes) drawStroke(ctx, s);
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `whiteboard-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  };

  const [confirmClear, setConfirmClear] = useState(false);
  const isShape = tool !== 'pen' && tool !== 'hl' && tool !== 'eraser' && tool !== 'text';

  return (
    <div className={`wb wb-bg-${index.bg}`}>
      {Array.from({ length: index.chunks }, (_, i) => (
        <ChunkSync key={`${index.epoch}:${i}`} storeKey={`${baseKey}:${index.epoch}:${i}`} index={i} onState={onChunk} />
      ))}
      <div className="wb-toolbar" role="toolbar" aria-label="Drawing tools">
        <div className="wb-group">
          {(['pen', 'hl', 'eraser', 'line', 'arrow', 'rect', 'ell', 'text'] as const).map((t) => (
            <button key={t} type="button" className={`wb-btn${tool === t ? ' is-on' : ''}`} onClick={() => setTool(t)} title={TOOL_LABELS[t]} aria-label={TOOL_LABELS[t]} aria-pressed={tool === t}>
              <Icon name={t} />
            </button>
          ))}
        </div>
        <div className="wb-group">
          {COLORS.map((c) => (
            <button key={c} type="button" className={`wb-swatch${color === c ? ' is-on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} aria-pressed={color === c} />
          ))}
        </div>
        <div className="wb-group">
          {SIZES.map((sz, i) => (
            <button key={sz} type="button" className={`wb-btn wb-size${sizeIx === i ? ' is-on' : ''}`} onClick={() => setSizeIx(i)} aria-label={['Thin', 'Medium', 'Thick'][i]} title={['Thin', 'Medium', 'Thick'][i]}>
              <span style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
            </button>
          ))}
        </div>
        <div className="wb-group">
          <button type="button" className="wb-btn" onClick={undo} disabled={!undoRef.current.length} title="Undo (your own)" aria-label="Undo"><Icon name="undo" /></button>
          <button type="button" className="wb-btn" onClick={redo} disabled={!redoRef.current.length} title="Redo" aria-label="Redo"><Icon name="redo" /></button>
          <button type="button" className="wb-btn" onClick={() => dispatchIndex({ kind: 'bg', bg: index.bg === 'light' ? 'dark' : 'light' })} title="Light or dark board" aria-label="Light or dark board"><Icon name="bg" /></button>
          <button type="button" className="wb-btn" onClick={save} title="Save as a picture" aria-label="Save as a picture"><Icon name="save" /></button>
          {confirmClear ? (
            <>
              <button type="button" className="wb-text-btn is-danger" onClick={() => { dispatchIndex({ kind: 'clear', name: myName }); setConfirmClear(false); }}>Clear for everyone</button>
              <button type="button" className="wb-text-btn" onClick={() => setConfirmClear(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="wb-btn" onClick={() => setConfirmClear(true)} disabled={!canManage || !total} title={canManage ? 'Clear the board' : 'The host can clear the board'} aria-label="Clear the board"><Icon name="clear" /></button>
          )}
        </div>
      </div>

      <div className="wb-stage" ref={wrapRef}>
        <div className="wb-board" style={{ width: fit.w, height: fit.h }}>
          <canvas ref={baseRef} className="wb-canvas" style={{ width: fit.w, height: fit.h }} aria-hidden="true" />
          <canvas
            ref={overRef}
            className={`wb-canvas wb-over wb-tool-${tool}`}
            style={{ width: fit.w, height: fit.h }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerLeave={onLeave}
            role="img"
            aria-label={`Whiteboard with ${total} drawing${total === 1 ? '' : 's'}`}
          />
          {Object.entries(cursors).map(([peer, c]) => (
            <div key={peer} className="wb-cursor" style={{ left: c.x * fit.scale, top: c.y * fit.scale }}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1 1l5 14 2-6 6-2z" /></svg>
              <span>{c.name}</span>
            </div>
          ))}
          {textDraft && (
            <textarea
              className="wb-text-input"
              autoFocus
              style={{ left: textDraft.x * fit.scale, top: textDraft.y * fit.scale, fontSize: TEXT_SIZES[sizeIx] * fit.scale, color: ink }}
              value={textDraft.value}
              placeholder="Type…"
              rows={Math.max(1, textDraft.value.split('\n').length)}
              onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation(); // don't let the room's keyboard shortcuts take letters
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitText();
                } else if (e.key === 'Escape') setTextDraft(null);
              }}
              onBlur={commitText}
            />
          )}
          {!total && !textDraft && !mineRef.current && !liveRef.current.size && <div className="wb-empty">Draw anything. Everyone in the room sees it live.</div>}
        </div>
      </div>
      <div className="wb-foot">
        <span>{index.clearedBy && !total ? `Cleared by ${index.clearedBy}. ` : ''}{total} drawing{total === 1 ? '' : 's'}{isShape ? ' · hold Shift for a square or circle' : ''}</span>
        {full && <span className="wb-full">The board is full: save it and clear it to keep drawing.</span>}
      </div>
    </div>
  );
}
