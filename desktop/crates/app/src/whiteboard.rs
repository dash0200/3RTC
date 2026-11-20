//! The whiteboard on screen (`whiteboard/index.tsx`): the drawing (saved strokes as one picture,
//! rebuilt when they change; strokes being drawn, ours and others', painted over it as you move),
//! everyone's pointer, the tools, undo / redo, light or dark board and clearing. Strokes are
//! saved in chunks (`rtc_games::whiteboard`); while you draw, the stroke streams to the others
//! (`wb-live`) and your pointer shows with your name (`wb-cursor`).

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap};
use std::fmt::Write as _;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Bounds, Context, Corners, FontWeight, Hsla, Image, ImageFormat, MouseButton, MouseDownEvent,
    MouseMoveEvent, PathBuilder, Pixels, Point, RenderImage, canvas, div, fill, img, point, px,
};
use rtc_core::ActivityCommand;
use rtc_engine::Snapshot;
use rtc_games::whiteboard::{
    self, BOARD_H, BOARD_W, CHUNK_MAX, Chunk, Index, MAX_CHUNKS, Stroke, clean_stroke, hits, simplify,
};
use rtc_ui::tokens;
use serde_json::{Value, json};

use crate::view::RoomView;

const COLORS: [&str; 8] = [
    "#1f2329", "#ffffff", "#e5484d", "#f97316", "#f2b705", "#2fa84f", "#2f7fe0", "#a855f7",
];
const SIZES: [i64; 3] = [3, 6, 12];
const ERASER_R: f64 = 14.0;
const LIVE_EVERY: Duration = Duration::from_millis(40);
const CURSOR_EVERY: Duration = Duration::from_millis(80);
const PENDING: Duration = Duration::from_secs(10);
/// Pen points further apart than this meet at a sharp corner, not a curve.
const SHARP_RUN: f64 = 24.0;
const SHARP_TURN: f64 = std::f64::consts::PI / 5.0;

const TOOLS: [(&str, &str, &str); 7] = [
    ("pen", "Pen", "M4 20l4-1 11-11-3-3L5 16l-1 4zM14 6l3 3"),
    ("hl", "Highlighter", "M6 19h12M8 15l7-9 3 2-7 9H8v-2z"),
    ("eraser", "Eraser", "M8 20h11M5 15l8-9 6 6-6 7H9l-4-4z"),
    ("line", "Line", "M5 19L19 5"),
    ("arrow", "Arrow", "M5 19L19 5M11 5h8v8"),
    (
        "rect",
        "Box",
        "M5.5 6h13a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-9A1.5 1.5 0 0 1 5.5 6z",
    ),
    ("ell", "Circle", "M3.5 12a8.5 6.5 0 1 0 17 0a8.5 6.5 0 1 0-17 0"),
];

/// One stroke being drawn by someone else.
#[derive(Debug, Clone)]
struct Live {
    stroke: Stroke,
    at: Instant,
    done: bool,
}

/// This device's whiteboard.
#[derive(Default)]
pub(crate) struct BoardUi {
    tool: &'static str,
    color: usize,
    size: usize,
    /// The stroke we're drawing, and how many of its numbers were sent.
    mine: Option<Stroke>,
    sent: usize,
    last_live: Option<Instant>,
    last_cursor: Option<Instant>,
    /// Strokes the eraser went over (removed on letting go).
    erasing: BTreeSet<String>,
    /// Removed here, maybe not yet everywhere.
    gone: BTreeSet<String>,
    eraser_at: Option<(i64, i64)>,
    /// Added here, not saved yet.
    pending: Vec<(Stroke, Instant)>,
    /// Others' strokes being drawn, by `peer:id`.
    live: HashMap<String, Live>,
    /// Others' pointers: x, y, name, when.
    cursors: HashMap<String, (f64, f64, String, Instant)>,
    /// (added, strokes): ours, to undo.
    undo: Vec<(bool, Vec<Stroke>)>,
    redo: Vec<(bool, Vec<Stroke>)>,
    confirm_clear: bool,
    /// The epoch whose chunks are open.
    epoch: Option<i64>,
    opened: BTreeSet<String>,
    picture: RefCell<Option<(String, Arc<Image>)>>,
    /// The last picture that finished decoding: it stays on screen while a newer one decodes,
    /// so the board never goes blank when a stroke is saved.
    drawn: Rc<RefCell<Option<Drawn>>>,
    /// Pictures of a board no longer shown (a Sketch turn ended): freed at the next paint, where
    /// the window is at hand to take them off the GPU.
    retired: Rc<RefCell<Vec<Drawn>>>,
    icons: RefCell<HashMap<(&'static str, bool), Arc<Image>>>,
    /// Where the board is drawn.
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The game area.
    area: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The board's index key: empty for the whiteboard (`act:whiteboard`), a game's board
    /// (`act:sketch:t3`) otherwise.
    pub(crate) base: String,
    /// The board everything above is about (a new one starts clean).
    shown: String,
}

/// A decoded picture of the saved strokes.
struct Drawn {
    /// Its source (for freeing it once a newer one is shown).
    image: Arc<Image>,
    render: Arc<RenderImage>,
    /// The strokes in it.
    ids: BTreeSet<String>,
}

/// How a board is used (`Whiteboard` props): the whiteboard itself, or a game's.
#[derive(Debug, Clone, Default)]
pub(crate) struct Mode {
    /// Look only: no toolbar, no drawing (a game's guessers).
    pub(crate) read_only: bool,
    /// A game's board: no light / dark, no footer; `can_clear` decides clearing.
    pub(crate) game: bool,
    /// With `game`: this person may clear the board.
    pub(crate) can_clear: bool,
    /// What an empty board says.
    pub(crate) empty: Option<String>,
}

/// A chunk's key on the board `base`.
fn chunk_in(base: &str, epoch: i64, n: i64) -> String {
    format!("{base}:{epoch}:{n}")
}

impl std::fmt::Debug for BoardUi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BoardUi").finish_non_exhaustive()
    }
}

fn now() -> Instant {
    Instant::now()
}

fn new_id() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("d{:x}", t % 0xffff_ffff_ffff)
}

fn hex(c: &str) -> Hsla {
    u32::from_str_radix(c.trim_start_matches('#'), 16).map_or_else(|_| tokens::text(), tokens::hex)
}

fn esc(t: &str) -> String {
    t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// One stroke as SVG (`drawStroke`).
#[allow(clippy::cast_precision_loss)]
fn stroke_svg(out: &mut String, s: &Stroke, dim: bool) {
    let p: Vec<f64> = s.p.iter().map(|v| *v as f64).collect();
    let w = s.w as f64;
    let op = if dim { 0.3 } else { 1.0 };
    match s.k.as_str() {
        "pen" | "hl" => {
            let hl = s.k == "hl";
            let (width, op, cap) = if hl {
                (w * 3.0, if dim { 0.12 } else { 0.35 }, "butt")
            } else {
                (w, op, "round")
            };
            if p.len() == 2 {
                let _ = write!(
                    out,
                    r#"<circle cx="{}" cy="{}" r="{}" fill="{}" opacity="{op}"/>"#,
                    p[0],
                    p[1],
                    width / 2.0,
                    s.c
                );
                return;
            }
            let mut d = format!("M{} {}", p[0], p[1]);
            let mut i = 2;
            while i + 3 < p.len() {
                let (mx, my) = ((p[i] + p[i + 2]) / 2.0, (p[i + 1] + p[i + 3]) / 2.0);
                let (ax, ay) = (p[i] - p[i - 2], p[i + 1] - p[i - 1]);
                let (bx, by) = (p[i + 2] - p[i], p[i + 3] - p[i + 1]);
                let (before, after) = (ax.hypot(ay), bx.hypot(by));
                let turn = if before > 0.0 && after > 0.0 {
                    ((ax * bx + ay * by) / (before * after)).clamp(-1.0, 1.0).acos()
                } else {
                    0.0
                };
                if (before > SHARP_RUN || after > SHARP_RUN) && turn > SHARP_TURN {
                    let _ = write!(d, "L{} {}L{mx} {my}", p[i], p[i + 1]);
                } else {
                    let _ = write!(d, "Q{} {} {mx} {my}", p[i], p[i + 1]);
                }
                i += 2;
            }
            let _ = write!(d, "L{} {}", p[p.len() - 2], p[p.len() - 1]);
            let _ = write!(
                out,
                r#"<path d="{d}" fill="none" stroke="{}" stroke-width="{width}" stroke-linecap="{cap}" stroke-linejoin="round" opacity="{op}"/>"#,
                s.c
            );
        }
        "line" | "arrow" if p.len() == 4 => {
            let mut d = format!("M{} {}L{} {}", p[0], p[1], p[2], p[3]);
            if s.k == "arrow" {
                let a = (p[3] - p[1]).atan2(p[2] - p[0]);
                let len = (w * 4.0).max(14.0);
                let _ = write!(
                    d,
                    "M{} {}L{} {}M{} {}L{} {}",
                    p[2],
                    p[3],
                    p[2] - len * (a - 0.45).cos(),
                    p[3] - len * (a - 0.45).sin(),
                    p[2],
                    p[3],
                    p[2] - len * (a + 0.45).cos(),
                    p[3] - len * (a + 0.45).sin()
                );
            }
            let _ = write!(
                out,
                r#"<path d="{d}" fill="none" stroke="{}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round" opacity="{op}"/>"#,
                s.c
            );
        }
        "rect" if p.len() == 4 => {
            let _ = write!(
                out,
                r#"<rect x="{}" y="{}" width="{}" height="{}" fill="none" stroke="{}" stroke-width="{w}" stroke-linejoin="round" opacity="{op}"/>"#,
                p[0].min(p[2]),
                p[1].min(p[3]),
                (p[2] - p[0]).abs(),
                (p[3] - p[1]).abs(),
                s.c
            );
        }
        "ell" if p.len() == 4 => {
            let _ = write!(
                out,
                r#"<ellipse cx="{}" cy="{}" rx="{}" ry="{}" fill="none" stroke="{}" stroke-width="{w}" opacity="{op}"/>"#,
                (p[0] + p[2]) / 2.0,
                (p[1] + p[3]) / 2.0,
                (p[2] - p[0]).abs() / 2.0,
                (p[3] - p[1]).abs() / 2.0,
                s.c
            );
        }
        "text" if p.len() >= 2 => {
            for (i, line) in s.t.as_deref().unwrap_or("").split('\n').enumerate() {
                #[allow(clippy::cast_precision_loss)]
                let y = p[1] + i as f64 * w * 1.25 + w * 0.82;
                let _ = write!(
                    out,
                    r#"<text x="{}" y="{y}" font-size="{w}" font-weight="600" fill="{}" opacity="{op}" font-family="'Figtree Variable', system-ui, sans-serif">{}</text>"#,
                    p[0],
                    s.c,
                    esc(line)
                );
            }
        }
        _ => {}
    }
}

/// A stroke exactly as it will be saved (pen strokes smoothed).
fn finalize(s: &Stroke) -> Option<Stroke> {
    #[allow(clippy::cast_precision_loss)]
    let p: Vec<i64> = if s.k == "pen" || s.k == "hl" {
        simplify(&s.p.iter().map(|v| *v as f64).collect::<Vec<_>>(), 0.8)
    } else {
        s.p.clone()
    };
    clean_stroke(&serde_json::to_value(Stroke { p, ..s.clone() }).ok()?)
}

/// Paints a stroke being drawn (cheap: straight segments) at `scale`.
#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
fn paint_live(window: &mut gpui_kit::Window, origin: Point<Pixels>, scale: f32, s: &Stroke) {
    let at = |x: i64, y: i64| point(origin.x + px(x as f32 * scale), origin.y + px(y as f32 * scale));
    let hl = s.k == "hl";
    let w = (s.w as f32 * if hl { 3.0 } else { 1.0 } * scale).max(1.0);
    let color = if hl { hex(&s.c).opacity(0.35) } else { hex(&s.c) };
    let p = &s.p;
    let mut b = PathBuilder::stroke(px(w));
    match s.k.as_str() {
        "pen" | "hl" if p.len() >= 4 => {
            b.move_to(at(p[0], p[1]));
            for k in (2..p.len() - 1).step_by(2) {
                b.line_to(at(p[k], p[k + 1]));
            }
        }
        "pen" | "hl" if p.len() >= 2 => {
            b.move_to(at(p[0], p[1]));
            b.line_to(at(p[0] + 1, p[1]));
        }
        "line" | "arrow" if p.len() == 4 => {
            b.move_to(at(p[0], p[1]));
            b.line_to(at(p[2], p[3]));
            if s.k == "arrow" {
                let a = ((p[3] - p[1]) as f64).atan2((p[2] - p[0]) as f64);
                let len = (s.w as f64 * 4.0).max(14.0);
                for d in [-0.45, 0.45] {
                    b.move_to(at(p[2], p[3]));
                    b.line_to(at(
                        p[2] - (len * (a + d).cos()) as i64,
                        p[3] - (len * (a + d).sin()) as i64,
                    ));
                }
            }
        }
        "rect" if p.len() == 4 => {
            b.move_to(at(p[0], p[1]));
            b.line_to(at(p[2], p[1]));
            b.line_to(at(p[2], p[3]));
            b.line_to(at(p[0], p[3]));
            b.close();
        }
        "ell" if p.len() == 4 => {
            let (cx, cy) = ((p[0] + p[2]) as f64 / 2.0, (p[1] + p[3]) as f64 / 2.0);
            let (rx, ry) = ((p[2] - p[0]).abs() as f64 / 2.0, (p[3] - p[1]).abs() as f64 / 2.0);
            for i in 0..=48 {
                let a = f64::from(i) / 48.0 * std::f64::consts::TAU;
                let q = at((cx + rx * a.cos()) as i64, (cy + ry * a.sin()) as i64);
                if i == 0 {
                    b.move_to(q);
                } else {
                    b.line_to(q);
                }
            }
        }
        _ => return,
    }
    if let Ok(path) = b.build() {
        window.paint_path(path, color);
    }
}

impl RoomView {
    /// The board's index key.
    pub(crate) fn wb_base(&self) -> String {
        let b = &self.activity.board.base;
        if b.is_empty() {
            whiteboard::KEY.to_owned()
        } else {
            b.clone()
        }
    }

    fn wb_index(&self) -> Option<Index> {
        let r = self.room.as_ref()?;
        let base = self.wb_base();
        let (_, v) = r.stores.iter().find(|(k, _)| *k == base)?;
        Index::from_value(&v.state)
    }

    /// The saved strokes of this epoch, in order, and each chunk's key and size.
    fn wb_strokes(&self, ix: &Index) -> (Vec<Stroke>, Vec<(String, Vec<String>)>) {
        let Some(r) = self.room.as_ref() else {
            return (Vec::new(), Vec::new());
        };
        let mut chunks: Vec<(i64, String, Chunk)> = Vec::new();
        let prefix = format!("{}:{}:", self.wb_base(), ix.epoch);
        for (k, v) in &r.stores {
            if let Some(n) = k.strip_prefix(&prefix).and_then(|n| n.parse::<i64>().ok())
                && let Some(c) = Chunk::from_value(&v.state)
            {
                chunks.push((n, k.clone(), c));
            }
        }
        chunks.sort_by_key(|(n, ..)| *n);
        let ids = chunks
            .iter()
            .map(|(_, k, c)| (k.clone(), c.strokes.iter().map(|s| s.id.clone()).collect()))
            .collect();
        (chunks.into_iter().flat_map(|(_, _, c)| c.strokes).collect(), ids)
    }

    fn wb_dispatch(&mut self, key: String, action: Value, cx: &mut Context<'_, Self>) {
        self.activity_command(ActivityCommand::Dispatch { key, action }, cx);
    }

    fn wb_send(&self, live: bool, body: Value) {
        self.command(rtc_core::Command::Board { live, body });
    }

    /// After every room update: the open epoch's chunks are open, an old epoch's dropped.
    pub(crate) fn whiteboard_after(&mut self, cx: &mut Context<'_, Self>) {
        let base = self.wb_base();
        if self.activity.board.shown != base {
            // another board (a game's next turn): start clean
            let b = &mut self.activity.board;
            b.shown.clone_from(&base);
            b.epoch = None;
            b.opened.clear();
            b.mine = None;
            b.erasing.clear();
            b.gone.clear();
            b.eraser_at = None;
            b.pending.clear();
            b.live.clear();
            b.cursors.clear();
            b.undo.clear();
            b.redo.clear();
            b.confirm_clear = false;
            let old = b.drawn.borrow_mut().take();
            if let Some(d) = old {
                b.retired.borrow_mut().push(d);
            }
            // a picture of the old board still decoding: never shown, only cached
            if let Some((_, image)) = b.picture.borrow_mut().take() {
                image.remove_asset(cx);
            }
        }
        let Some(ix) = self.wb_index() else {
            self.activity.board.epoch = None;
            self.activity.board.opened.clear();
            return;
        };
        if self.activity.board.tool.is_empty() {
            self.activity.board.tool = "pen";
            self.activity.board.size = 1;
        }
        if self.activity.board.epoch != Some(ix.epoch) {
            if let Some(old) = self.activity.board.epoch {
                self.activity_command(ActivityCommand::Release(format!("{base}:{old}:")), cx);
            }
            let b = &mut self.activity.board;
            b.epoch = Some(ix.epoch);
            b.opened.clear();
            b.undo.clear();
            b.redo.clear();
            b.live.clear();
            b.gone.clear();
            b.pending.clear();
        }
        for n in 0..ix.chunks.min(MAX_CHUNKS) {
            let key = chunk_in(&base, ix.epoch, n);
            if self.activity.board.opened.insert(key.clone()) {
                self.activity_command(ActivityCommand::Open(key), cx);
            }
        }
        let t = now();
        let b = &mut self.activity.board;
        b.live
            .retain(|_, l| t.duration_since(l.at) < if l.done { PENDING } else { Duration::from_secs(4) });
        b.pending.retain(|(_, at)| t.duration_since(*at) < PENDING);
        b.cursors
            .retain(|_, c| t.duration_since(c.3) < Duration::from_secs(5));
    }

    /// Someone's `wb-live` or `wb-cursor`.
    pub(crate) fn on_board(&mut self, from: &str, live: bool, body: &Value, cx: &mut Context<'_, Self>) {
        let epoch = self.activity.board.epoch;
        let b = &mut self.activity.board;
        if !live {
            let x = body.get("x").and_then(Value::as_f64);
            let y = body.get("y").and_then(Value::as_f64);
            match (x, y) {
                (Some(x), Some(y)) if body.get("gone").and_then(Value::as_bool) != Some(true) => {
                    let name = body
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .chars()
                        .take(24)
                        .collect();
                    b.cursors.insert(from.to_owned(), (x, y, name, now()));
                }
                _ => {
                    b.cursors.remove(from);
                }
            }
            cx.notify();
            return;
        }
        let Some(id) = body.get("id").and_then(Value::as_str) else {
            return;
        };
        if body.get("e").and_then(Value::as_i64) != epoch {
            return;
        }
        let key = format!("{from}:{id}");
        if body.get("done").and_then(Value::as_bool) == Some(true) {
            if let Some(l) = b.live.get_mut(&key) {
                l.at = now();
                l.done = true;
            }
            cx.notify();
            return;
        }
        let pts: Vec<Value> = body
            .get("pts")
            .and_then(Value::as_array)
            .map(|a| a.iter().take(600).cloned().collect())
            .unwrap_or_default();
        let k = body.get("k").and_then(Value::as_str).unwrap_or("");
        let from_n = body.get("from").and_then(Value::as_f64);
        let prev = b.live.get(&key).map(|l| l.stroke.p.clone());
        let p: Vec<Value> = if k == "pen" || k == "hl" {
            #[allow(clippy::cast_precision_loss)]
            match &prev {
                Some(old) if from_n == Some(old.len() as f64) => {
                    old.iter().map(|v| Value::from(*v)).chain(pts).collect()
                }
                _ if from_n == Some(0.0) => pts,
                Some(old) => old.iter().map(|v| Value::from(*v)).collect(),
                None => pts,
            }
        } else {
            pts
        };
        let raw = json!({ "id": id, "by": body.get("name"), "k": k, "c": body.get("c"), "w": body.get("w"), "p": p });
        if let Some(stroke) = clean_stroke(&raw) {
            b.live.insert(
                key,
                Live {
                    stroke,
                    at: now(),
                    done: false,
                },
            );
        }
        cx.notify();
    }

    fn wb_add(&mut self, list: &[Stroke], cx: &mut Context<'_, Self>) {
        let Some(ix) = self.wb_index() else { return };
        let (_, chunks) = self.wb_strokes(&ix);
        let base = self.wb_base();
        let last_key = chunk_in(&base, ix.epoch, ix.chunks - 1);
        let in_last = chunks
            .iter()
            .find(|(k, _)| *k == last_key)
            .map(|(_, ids)| ids.len());
        let Some(in_last) = in_last else { return };
        if list.is_empty() || (ix.chunks >= MAX_CHUNKS && in_last >= CHUNK_MAX) {
            return;
        }
        let t = now();
        let b = &mut self.activity.board;
        for s in list {
            b.pending.push((s.clone(), t));
            b.gone.remove(&s.id);
        }
        let n = list.len();
        self.wb_dispatch(last_key, json!({ "kind": "add", "strokes": list }), cx);
        if in_last + n >= CHUNK_MAX {
            self.wb_dispatch(base, json!({ "kind": "grow", "from": ix.chunks - 1 }), cx);
        }
    }

    fn wb_remove(&mut self, list: &[Stroke], cx: &mut Context<'_, Self>) {
        let Some(ix) = self.wb_index() else { return };
        let (_, chunks) = self.wb_strokes(&ix);
        let b = &mut self.activity.board;
        for s in list {
            b.pending.retain(|(p, _)| p.id != s.id);
            b.gone.insert(s.id.clone());
        }
        for (key, ids) in chunks {
            let drop: Vec<&str> = list
                .iter()
                .map(|s| s.id.as_str())
                .filter(|id| ids.iter().any(|x| x == id))
                .collect();
            if !drop.is_empty() {
                self.wb_dispatch(key, json!({ "kind": "remove", "ids": drop }), cx);
            }
        }
    }

    fn wb_record(&mut self, added: bool, list: Vec<Stroke>) {
        let b = &mut self.activity.board;
        b.undo.push((added, list));
        if b.undo.len() > 100 {
            b.undo.remove(0);
        }
        b.redo.clear();
    }

    fn wb_undo(&mut self, redo: bool, cx: &mut Context<'_, Self>) {
        let b = &mut self.activity.board;
        let Some((added, list)) = (if redo { b.redo.pop() } else { b.undo.pop() }) else {
            return;
        };
        // undo an add = remove; redo an add = add again
        if added != redo {
            self.wb_remove(&list, cx);
        } else {
            self.wb_add(&list, cx);
        }
        let b = &mut self.activity.board;
        if redo {
            b.undo.push((added, list));
        } else {
            b.redo.push((added, list));
        }
        cx.notify();
    }

    fn wb_point(&self, pos: Point<Pixels>, margin: f64) -> Option<(i64, i64)> {
        let b = self.activity.board.bounds.get()?;
        let scale = f64::from(f32::from(b.size.width)) / BOARD_W;
        if scale <= 0.0 {
            return None;
        }
        let x = f64::from(f32::from(pos.x - b.origin.x)) / scale;
        let y = f64::from(f32::from(pos.y - b.origin.y)) / scale;
        #[allow(clippy::cast_possible_truncation)]
        Some((
            x.clamp(margin, BOARD_W - margin).round() as i64,
            y.clamp(margin, BOARD_H - margin).round() as i64,
        ))
    }

    fn wb_margin(&self) -> f64 {
        let b = &self.activity.board;
        #[allow(clippy::cast_precision_loss)]
        let w = SIZES[b.size] as f64;
        match b.tool {
            "hl" => w * 1.5 + 1.0,
            "pen" | "line" | "arrow" | "rect" | "ell" => w / 2.0 + 1.0,
            _ => 0.0,
        }
    }

    fn wb_ink(&self, ix: &Index) -> String {
        let c = COLORS[self.activity.board.color];
        if ix.bg == "dark" && c == COLORS[0] {
            "#f4f4f6".into()
        } else if ix.bg == "light" && c == COLORS[1] {
            COLORS[0].into()
        } else {
            c.into()
        }
    }

    fn wb_flush(&mut self, done: bool) {
        let Some(ix) = self.wb_index() else { return };
        let name = self.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
        let b = &mut self.activity.board;
        let Some(s) = b.mine.clone() else { return };
        let body = if s.k == "pen" || s.k == "hl" {
            let pts: Vec<i64> = s.p[b.sent.min(s.p.len())..].to_vec();
            let from = b.sent;
            b.sent = s.p.len();
            (!pts.is_empty()).then(|| json!({ "e": ix.epoch, "id": s.id, "k": s.k, "c": s.c, "w": s.w, "from": from, "pts": pts, "name": name }))
        } else {
            Some(
                json!({ "e": ix.epoch, "id": s.id, "k": s.k, "c": s.c, "w": s.w, "from": 0, "pts": s.p, "name": name }),
            )
        };
        b.last_live = Some(now());
        if let Some(body) = body {
            self.wb_send(true, body);
        }
        if done {
            self.wb_send(true, json!({ "e": ix.epoch, "id": s.id, "done": true }));
        }
    }

    fn wb_down(&mut self, e: &MouseDownEvent, cx: &mut Context<'_, Self>) {
        let Some(ix) = self.wb_index() else { return };
        let Some((x, y)) = self.wb_point(e.position, self.wb_margin()) else {
            return;
        };
        let tool = self.activity.board.tool;
        if tool == "eraser" {
            self.activity.board.eraser_at = Some((x, y));
            self.wb_erase_at(x, y, &ix);
            cx.notify();
            return;
        }
        let name = self.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
        let c = self.wb_ink(&ix);
        let b = &mut self.activity.board;
        b.mine = Some(Stroke {
            id: new_id(),
            by: name,
            k: tool.to_owned(),
            c,
            w: SIZES[b.size],
            p: if tool == "pen" || tool == "hl" {
                vec![x, y]
            } else {
                vec![x, y, x, y]
            },
            t: None,
        });
        b.sent = 0;
        b.last_live = Some(now());
        cx.notify();
    }

    #[allow(clippy::cast_precision_loss)]
    fn wb_erase_at(&mut self, x: i64, y: i64, ix: &Index) {
        let (strokes, _) = self.wb_strokes(ix);
        let b = &mut self.activity.board;
        for s in strokes {
            if !b.erasing.contains(&s.id) && !b.gone.contains(&s.id) && hits(&s, x as f64, y as f64, ERASER_R)
            {
                b.erasing.insert(s.id.clone());
            }
        }
    }

    fn wb_move(&mut self, e: &MouseMoveEvent, cx: &mut Context<'_, Self>) {
        let Some(ix) = self.wb_index() else { return };
        let Some((x, y)) = self.wb_point(e.position, self.wb_margin()) else {
            return;
        };
        let t = now();
        if self
            .activity
            .board
            .last_cursor
            .is_none_or(|l| t.duration_since(l) > CURSOR_EVERY)
        {
            self.activity.board.last_cursor = Some(t);
            let name = self.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
            self.wb_send(false, json!({ "x": x, "y": y, "name": name }));
        }
        let pressed = e.pressed_button == Some(MouseButton::Left);
        if self.activity.board.tool == "eraser" {
            self.activity.board.eraser_at = Some((x, y));
            if pressed {
                self.wb_erase_at(x, y, &ix);
            }
            cx.notify();
            return;
        }
        let b = &mut self.activity.board;
        let Some(s) = b.mine.as_mut() else { return };
        if s.k == "pen" || s.k == "hl" {
            let (lx, ly) = (s.p[s.p.len() - 2], s.p[s.p.len() - 1]);
            #[allow(clippy::cast_precision_loss)]
            if ((x - lx) as f64).hypot((y - ly) as f64) >= 1.5 {
                s.p.push(x);
                s.p.push(y);
            }
        } else {
            let (mut x2, mut y2) = (x, y);
            if e.modifiers.shift && (s.k == "rect" || s.k == "ell") {
                let d = (x - s.p[0]).abs().max((y - s.p[1]).abs());
                x2 = s.p[0] + if x - s.p[0] < 0 { -d } else { d };
                y2 = s.p[1] + if y - s.p[1] < 0 { -d } else { d };
            }
            s.p = vec![s.p[0], s.p[1], x2, y2];
        }
        if b.last_live.is_none_or(|l| t.duration_since(l) >= LIVE_EVERY) {
            self.wb_flush(false);
        }
        cx.notify();
    }

    fn wb_up(&mut self, cx: &mut Context<'_, Self>) {
        if self.activity.board.tool == "eraser" {
            let Some(ix) = self.wb_index() else { return };
            let erasing = std::mem::take(&mut self.activity.board.erasing);
            if !erasing.is_empty() {
                let (strokes, _) = self.wb_strokes(&ix);
                let erased: Vec<Stroke> = strokes.into_iter().filter(|s| erasing.contains(&s.id)).collect();
                self.wb_remove(&erased, cx);
                self.wb_record(false, erased);
            }
            cx.notify();
            return;
        }
        if self.activity.board.mine.is_none() {
            return;
        }
        self.wb_flush(true);
        let Some(s) = self.activity.board.mine.take() else {
            return;
        };
        #[allow(clippy::cast_precision_loss)]
        let tiny =
            s.k != "pen" && s.k != "hl" && ((s.p[2] - s.p[0]) as f64).hypot((s.p[3] - s.p[1]) as f64) < 3.0;
        if !tiny && let Some(done) = finalize(&s) {
            self.wb_add(std::slice::from_ref(&done), cx);
            self.wb_record(true, vec![done]);
        }
        cx.notify();
    }

    fn wb_icon(&self, d: &'static str, on: bool) -> Arc<Image> {
        let key = (d, on);
        if let Some(i) = self.activity.board.icons.borrow().get(&key) {
            return Arc::clone(i);
        }
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="{}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="{d}"/></svg>"#,
            if on { "#ffffff" } else { "#a9a9b5" }
        );
        let image = Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()));
        self.activity
            .board
            .icons
            .borrow_mut()
            .insert(key, Arc::clone(&image));
        image
    }
}

/// Frees a board picture that's no longer shown: out of gpui's asset cache, and its texture off
/// the GPU (`remove_asset` alone left every one there: each saved stroke kept a 1600×1000
/// picture, gigabytes after an hour of Sketch).
fn free_drawn(old: Drawn, window: &mut gpui_kit::Window, cx: &mut gpui_kit::App) {
    old.image.remove_asset(cx);
    cx.drop_image(old.render, Some(window));
}

fn tool_btn(id: impl Into<gpui_kit::ElementId>, on: bool) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .size(px(34.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(8.))
        .cursor_pointer()
        .when(on, |el| el.bg(tokens::accent()))
        .when(!on, |el| el.hover(|s| s.bg(tokens::raised())))
}

fn text_btn(
    id: impl Into<gpui_kit::ElementId>,
    label: &str,
    danger: bool,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .h(px(32.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(8.))
        .border_1()
        .border_color(if danger {
            tokens::danger_line()
        } else {
            tokens::line_strong()
        })
        .when(danger, |el| {
            el.bg(tokens::danger_bg()).text_color(tokens::danger_text())
        })
        .text_size(px(12.5))
        .cursor_pointer()
        .hover(|s| s.bg(tokens::raised()))
        .child(label.to_owned())
}

/// The whiteboard.
pub(crate) fn view(
    view: &RoomView,
    room: &Snapshot,
    store: &Value,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    board(view, room, store, &Mode::default(), cx)
}

/// A board (the whiteboard's, or a game's: [`Mode`]).
#[allow(clippy::too_many_lines)]
pub(crate) fn board(
    view: &RoomView,
    room: &Snapshot,
    store: &Value,
    mode: &Mode,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let Some(ix) = Index::from_value(store) else {
        return div().into_any_element();
    };
    let ui = &view.activity.board;
    let base = view.wb_base();
    let read_only = mode.read_only;
    let present: Vec<String> = room
        .stores
        .iter()
        .find(|(k, _)| *k == base)
        .map(|(_, v)| v.presence.members.iter().map(|p| p.as_str().to_owned()).collect())
        .unwrap_or_default();
    let host_here = room
        .host
        .as_ref()
        .is_some_and(|h| *h == room.me || present.iter().any(|p| p == h.as_str()));
    let can_manage = if mode.game {
        mode.can_clear
    } else {
        room.host.as_ref() == Some(&room.me) || !host_here
    };
    let (strokes, chunks) = view.wb_strokes(&ix);
    let total = strokes.len();
    let last_full = chunks
        .iter()
        .find(|(k, _)| *k == chunk_in(&base, ix.epoch, ix.chunks - 1))
        .is_some_and(|(_, ids)| ids.len() >= CHUNK_MAX);
    let full = ix.chunks >= MAX_CHUNKS && last_full;
    let bg = if ix.bg == "dark" { "#15161b" } else { "#fbfbf8" };

    // the saved strokes, one picture
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {BOARD_W} {BOARD_H}"><rect width="{BOARD_W}" height="{BOARD_H}" fill="{bg}"/>"#
    );
    for s in &strokes {
        if !ui.gone.contains(&s.id) {
            stroke_svg(&mut svg, s, ui.erasing.contains(&s.id));
        }
    }
    svg.push_str("</svg>");
    let cached = ui
        .picture
        .borrow()
        .as_ref()
        .filter(|(old, _)| *old == svg)
        .map(|(_, i)| Arc::clone(i));
    let picture = cached.unwrap_or_else(|| {
        let image = Arc::new(Image::from_bytes(ImageFormat::Svg, svg.clone().into_bytes()));
        let superseded = ui.picture.borrow_mut().replace((svg, Arc::clone(&image)));
        // one that never made it to the screen (a newer stroke came first) is only in gpui's
        // cache: free it now (the one on screen is freed once its successor shows)
        if let Some((_, old)) = superseded {
            let on_screen = ui.drawn.borrow().as_ref().is_some_and(|d| d.image.id == old.id);
            if !on_screen {
                old.remove_asset(cx);
            }
        }
        image
    });
    // While a new picture decodes, the last decoded one stays up with the strokes it lacks
    // painted over it (`img` would show nothing for those frames: the board blinked).
    let decoding = ui
        .drawn
        .borrow()
        .as_ref()
        .is_none_or(|d| d.image.id != picture.id);
    let (new_ids, missing): (Option<BTreeSet<String>>, Vec<Stroke>) = if decoding {
        let visible = || strokes.iter().filter(|s| !ui.gone.contains(&s.id));
        let have = ui
            .drawn
            .borrow()
            .as_ref()
            .map(|d| d.ids.clone())
            .unwrap_or_default();
        (
            Some(visible().map(|s| s.id.clone()).collect()),
            visible().filter(|s| !have.contains(&s.id)).cloned().collect(),
        )
    } else {
        (None, Vec::new())
    };
    let drawn = Rc::clone(&ui.drawn);
    let retired = Rc::clone(&ui.retired);
    let board_bg = if ix.bg == "dark" {
        tokens::hex(0x15_161b)
    } else {
        tokens::hex(0xfb_fbf8)
    };

    // what's being drawn: others', ours, not-yet-saved ones, the eraser
    let saved: BTreeSet<&str> = strokes.iter().map(|s| s.id.as_str()).collect();
    let mut over: Vec<Stroke> = ui
        .live
        .values()
        .filter(|l| !saved.contains(l.stroke.id.as_str()))
        .map(|l| finalize(&l.stroke).unwrap_or_else(|| l.stroke.clone()))
        .collect();
    over.extend(
        ui.pending
            .iter()
            .filter(|(s, _)| !saved.contains(s.id.as_str()))
            .map(|(s, _)| s.clone()),
    );
    if let Some(m) = &ui.mine {
        over.push(m.clone());
    }
    let eraser = ui.eraser_at.filter(|_| ui.tool == "eraser");
    let eraser_color = if ix.bg == "dark" {
        tokens::white().opacity(0.7)
    } else {
        tokens::black(0.5)
    };

    let area = ui.area.get();
    let avail_w = area.map_or(900.0, |a| f32::from(a.size.width) - 32.0);
    let chrome = if read_only {
        28.0
    } else if mode.game {
        80.0
    } else {
        120.0
    };
    let avail_h = area.map_or(560.0, |a| f32::from(a.size.height) - chrome);
    #[allow(clippy::cast_possible_truncation)]
    let scale = (avail_w / BOARD_W as f32).min(avail_h / BOARD_H as f32).max(0.05);
    #[allow(clippy::cast_possible_truncation)]
    let (bw, bh) = (BOARD_W as f32 * scale, BOARD_H as f32 * scale);
    let bounds_cell = Rc::clone(&ui.bounds);
    let cursors: Vec<(f64, f64, String)> = ui.cursors.values().map(|c| (c.0, c.1, c.2.clone())).collect();
    let empty = total == 0 && ui.mine.is_none() && ui.live.is_empty();
    let empty_text = mode
        .empty
        .clone()
        .unwrap_or_else(|| "Draw anything. Everyone in the room sees it live.".to_owned());
    #[allow(clippy::cast_possible_truncation)]
    let board = div()
        .id("wb-board")
        .relative()
        .flex_none()
        .w(px(bw))
        .h(px(bh))
        .rounded(px(10.))
        .overflow_hidden()
        .when(!read_only, gpui_kit::Styled::cursor_crosshair)
        .child(
            canvas(
                move |b, _, _| bounds_cell.set(Some(b)),
                move |b, (), window, cx| {
                    // an old board's pictures: off the GPU and out of the cache
                    for old in retired.borrow_mut().drain(..) {
                        free_drawn(old, window, cx);
                    }
                    // the saved strokes: the new picture once decoded, the last one until then
                    let fresh = Arc::clone(&picture).use_render_image(window, cx);
                    let mut last = drawn.borrow_mut();
                    let lagging = match (fresh, new_ids) {
                        (Some(render), Some(ids)) => {
                            let old = last.replace(Drawn {
                                image: Arc::clone(&picture),
                                render,
                                ids,
                            });
                            if let Some(old) = old
                                && old.image.id != picture.id
                            {
                                free_drawn(old, window, cx);
                            }
                            false
                        }
                        (Some(_), None) => false,
                        (None, _) => true,
                    };
                    let corners = Corners::all(px(10.));
                    match last.as_ref() {
                        Some(d) => {
                            let _ = window.paint_image(b, b, corners, Arc::clone(&d.render), 0, false);
                        }
                        None => window.paint_quad(fill(b, board_bg).corner_radii(corners)),
                    }
                    drop(last);
                    if lagging {
                        for s in &missing {
                            paint_live(window, b.origin, scale, s);
                        }
                    }
                    for s in &over {
                        paint_live(window, b.origin, scale, s);
                    }
                    if let Some((x, y)) = eraser {
                        let r = (ERASER_R as f32) * scale;
                        let c = point(
                            b.origin.x + px(x as f32 * scale),
                            b.origin.y + px(y as f32 * scale),
                        );
                        let mut pb = PathBuilder::stroke(px(1.5));
                        for i in 0..=32 {
                            let a = i as f32 / 32.0 * std::f32::consts::TAU;
                            let q = point(c.x + px(r * a.cos()), c.y + px(r * a.sin()));
                            if i == 0 {
                                pb.move_to(q);
                            } else {
                                pb.line_to(q);
                            }
                        }
                        if let Ok(path) = pb.build() {
                            window.paint_path(path, eraser_color);
                        }
                    }
                },
            )
            .absolute()
            .size_full(),
        )
        .children(cursors.into_iter().map(|(x, y, name)| {
            div()
                .absolute()
                .left(px(x as f32 * scale))
                .top(px(y as f32 * scale))
                .flex()
                .items_start()
                .child(
                    div()
                        .size(px(10.))
                        .rounded_full()
                        .bg(tokens::accent())
                        .border_1()
                        .border_color(tokens::white()),
                )
                .child(
                    div()
                        .ml(px(2.))
                        .mt(px(8.))
                        .px(px(5.))
                        .rounded(px(5.))
                        .bg(tokens::accent())
                        .text_color(tokens::white())
                        .text_size(px(11.))
                        .child(name),
                )
        }))
        .when(empty, |el| {
            el.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(15.))
                    .text_color(if ix.bg == "dark" {
                        tokens::text_2()
                    } else {
                        tokens::hex(0x6b_6e78)
                    })
                    .child(empty_text),
            )
        })
        .when(!read_only, |el| {
            el.on_mouse_down(
                MouseButton::Left,
                cx.listener(move |v, e: &MouseDownEvent, _, cx| {
                    if !full {
                        v.wb_down(e, cx);
                    }
                }),
            )
            .on_mouse_move(cx.listener(|v, e: &MouseMoveEvent, _, cx| v.wb_move(e, cx)))
            .on_mouse_up(MouseButton::Left, cx.listener(|v, _, _, cx| v.wb_up(cx)))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|v, _, _, cx| v.wb_up(cx)))
            .on_hover(cx.listener(|v, hovered: &bool, _, cx| {
                if !*hovered {
                    v.activity.board.eraser_at = None;
                    v.wb_send(false, json!({ "gone": true }));
                    cx.notify();
                }
            }))
        });

    // the toolbar
    let mut tools = div()
        .flex()
        .items_center()
        .gap(px(2.))
        .p(px(3.))
        .rounded(px(10.))
        .bg(tokens::surface());
    for (n, (t, _label, d)) in TOOLS.iter().enumerate() {
        let on = ui.tool == *t;
        let t = *t;
        tools = tools.child(
            tool_btn(("wb-tool", n), on)
                .child(img(view.wb_icon(d, on)).size(px(20.)))
                .on_click(cx.listener(move |v, _, _, cx| {
                    v.activity.board.tool = t;
                    cx.notify();
                })),
        );
    }
    let mut colors = div()
        .flex()
        .items_center()
        .gap(px(4.))
        .p(px(5.))
        .rounded(px(10.))
        .bg(tokens::surface());
    for (n, c) in COLORS.iter().enumerate() {
        let on = ui.color == n;
        colors = colors.child(
            div()
                .id(("wb-color", n))
                .size(px(22.))
                .rounded_full()
                .bg(hex(c))
                .border_2()
                .border_color(if on {
                    tokens::accent()
                } else {
                    tokens::line_strong()
                })
                .cursor_pointer()
                .on_click(cx.listener(move |v, _, _, cx| {
                    v.activity.board.color = n;
                    cx.notify();
                })),
        );
    }
    let mut sizes = div()
        .flex()
        .items_center()
        .gap(px(2.))
        .p(px(3.))
        .rounded(px(10.))
        .bg(tokens::surface());
    for n in 0..SIZES.len() {
        let on = ui.size == n;
        #[allow(clippy::cast_precision_loss)]
        let dot = 4.0 + n as f32 * 4.0;
        sizes = sizes.child(
            tool_btn(("wb-size", n), on)
                .child(div().size(px(dot)).rounded_full().bg(tokens::text()))
                .on_click(cx.listener(move |v, _, _, cx| {
                    v.activity.board.size = n;
                    cx.notify();
                })),
        );
    }
    let mut actions = div().flex().items_center().gap(px(6.));
    let bg_key = base.clone();
    actions = actions
        .child(
            text_btn("wb-undo", "Undo", false)
                .when(ui.undo.is_empty(), |el| el.opacity(0.4))
                .on_click(cx.listener(|v, _, _, cx| v.wb_undo(false, cx))),
        )
        .child(
            text_btn("wb-redo", "Redo", false)
                .when(ui.redo.is_empty(), |el| el.opacity(0.4))
                .on_click(cx.listener(|v, _, _, cx| v.wb_undo(true, cx))),
        )
        .when(!mode.game, |el| {
            el.child(
                text_btn(
                    "wb-bg",
                    if ix.bg == "light" {
                        "Dark board"
                    } else {
                        "Light board"
                    },
                    false,
                )
                .on_click(cx.listener(move |v, _, _, cx| {
                    let bg = if v.wb_index().is_some_and(|i| i.bg == "light") {
                        "dark"
                    } else {
                        "light"
                    };
                    v.wb_dispatch(bg_key.clone(), json!({ "kind": "bg", "bg": bg }), cx);
                })),
            )
        });
    if ui.confirm_clear && can_manage {
        let clear_key = base.clone();
        actions = actions
            .child(
                text_btn("wb-clear-yes", "Clear for everyone", true).on_click(cx.listener(
                    move |v, _, _, cx| {
                        let name = v.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
                        v.activity.board.confirm_clear = false;
                        v.wb_dispatch(clear_key.clone(), json!({ "kind": "clear", "name": name }), cx);
                    },
                )),
            )
            .child(
                text_btn("wb-clear-no", "Cancel", false).on_click(cx.listener(|v, _, _, cx| {
                    v.activity.board.confirm_clear = false;
                    cx.notify();
                })),
            );
    } else if can_manage && total > 0 {
        actions = actions.child(
            text_btn("wb-clear", "Clear", false).on_click(cx.listener(|v, _, _, cx| {
                v.activity.board.confirm_clear = true;
                cx.notify();
            })),
        );
    }
    let is_shape = matches!(ui.tool, "line" | "arrow" | "rect" | "ell");
    let foot = format!(
        "{}{total} drawing{}{}",
        if !ix.cleared_by.is_empty() && total == 0 {
            format!("Cleared by {}. ", ix.cleared_by)
        } else {
            String::new()
        },
        if total == 1 { "" } else { "s" },
        if is_shape {
            " · hold Shift for a square or circle"
        } else {
            ""
        }
    );

    let area_cell = Rc::clone(&ui.area);
    div()
        .size_full()
        .relative()
        .child(
            canvas(move |b, _, _| area_cell.set(Some(b)), |_, (), _, _| {})
                .absolute()
                .size_full(),
        )
        .child(
            div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(10.))
                .p(px(14.))
                .when(!read_only, |el| {
                    el.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_center()
                            .gap(px(8.))
                            .child(tools)
                            .child(colors)
                            .child(sizes)
                            .child(actions),
                    )
                })
                .child(board)
                .when(!mode.game, |el| {
                    el.child(
                        div()
                            .flex()
                            .gap(px(10.))
                            .text_size(px(12.5))
                            .text_color(tokens::text_3())
                            .child(foot)
                            .when(full, |el| {
                                el.child(
                                    div()
                                        .text_color(tokens::warn())
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child("The board is full: save it and clear it to keep drawing."),
                                )
                            }),
                    )
                }),
        )
        .into_any_element()
}
