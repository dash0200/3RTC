//! Whiteboard (`whiteboard/model.ts`): strokes on a fixed 1600 × 1000 board (every screen scales
//! it to fit, so a point means the same spot for everyone).
//!
//! The drawing is split so one new stroke doesn't resend all of it:
//! `act:whiteboard` is the index `{ epoch, chunks, bg, clearedBy }` (clearing starts a new epoch),
//! `act:whiteboard:<epoch>:<n>` a chunk `{ strokes }` of up to [`CHUNK_MAX`] strokes.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ActivityDef, Meta, Reducer, js_slice, js_string, js_truthy};

/// Its menu entry.
pub const DEF: ActivityDef = ActivityDef {
    id: "whiteboard",
    name: "Whiteboard",
    icon: "🖍️",
    description: "Draw and write together, live",
    min_people: 1,
};

/// The index's key.
pub const KEY: &str = "act:whiteboard";
/// Board width (board units).
pub const BOARD_W: f64 = 1600.0;
/// Board height (board units).
pub const BOARD_H: f64 = 1000.0;
/// Strokes per chunk before the next one opens.
pub const CHUNK_MAX: usize = 60;
/// A few over while the next chunk is being opened.
const CHUNK_HARD_MAX: usize = 100;
/// Most chunks per drawing.
pub const MAX_CHUNKS: i64 = 50;
/// Numbers per stroke (x, y pairs).
const MAX_POINTS: usize = 3000;
/// The tools.
pub const TOOLS: [&str; 7] = ["pen", "hl", "line", "rect", "ell", "arrow", "text"];

/// A chunk's key.
#[must_use]
pub fn chunk_key(epoch: i64, n: i64) -> String {
    format!("{KEY}:{epoch}:{n}")
}

/// One stroke.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stroke {
    /// Its id.
    pub id: String,
    /// Who drew it (name).
    pub by: String,
    /// The tool (`pen`, `hl`, `line`, `rect`, `ell`, `arrow`, `text`).
    pub k: String,
    /// Colour, `#rrggbb`.
    pub c: String,
    /// Line width, or font size for text.
    pub w: i64,
    /// pen / highlighter: x,y,x,y…; shapes: x1,y1,x2,y2; text: x,y.
    pub p: Vec<i64>,
    /// The text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t: Option<String>,
}

/// The index (`BoardIndex`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    /// Clearing starts a new one.
    pub epoch: i64,
    /// Chunks in this epoch.
    pub chunks: i64,
    /// `light` or `dark`.
    pub bg: String,
    /// Who cleared it last.
    pub cleared_by: String,
}

impl Index {
    /// From shared state.
    #[must_use]
    pub fn from_value(v: &Value) -> Option<Self> {
        serde_json::from_value(v.clone()).ok()
    }
}

/// A chunk of strokes.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Chunk {
    /// The strokes, oldest first.
    pub strokes: Vec<Stroke>,
}

impl Chunk {
    /// From shared state.
    #[must_use]
    pub fn from_value(v: &Value) -> Option<Self> {
        serde_json::from_value(v.clone()).ok()
    }
}

fn can_manage(meta: &Meta<'_>) -> bool {
    meta.is_host || meta.host_id.is_none_or(|h| !meta.present.iter().any(|p| p == h))
}

/// JS `Number(x)`.
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else if t
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))
            {
                t.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => js_number(&a[0]),
        _ => f64::NAN,
    }
}

#[allow(clippy::cast_possible_truncation)]
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

fn is_hex(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// A stroke from the network, checked and tidied (`cleanStroke`), or `None`.
#[must_use]
pub fn clean_stroke(x: &Value) -> Option<Stroke> {
    let o = x.as_object()?;
    let id = o.get("id")?.as_str()?;
    if id.is_empty() || id.encode_utf16().count() > 40 {
        return None;
    }
    let k = o.get("k").and_then(Value::as_str).filter(|k| TOOLS.contains(k))?;
    let c = o.get("c").and_then(Value::as_str).filter(|c| is_hex(c))?;
    let w = o.get("w").map_or(f64::NAN, js_number);
    if !(w.is_finite() && (1.0..=120.0).contains(&w)) {
        return None;
    }
    let list = o.get("p")?.as_array()?;
    let mut p: Vec<f64> = list.iter().take(MAX_POINTS).map(js_number).collect();
    if p.len() < 2 || !p.len().is_multiple_of(2) || !p.iter().all(|v| v.is_finite()) {
        return None;
    }
    for (i, v) in p.iter_mut().enumerate() {
        let hi = if i % 2 == 1 { BOARD_H } else { BOARD_W };
        *v = v.min(hi).max(0.0);
    }
    if k != "pen" && k != "hl" && k != "text" && p.len() != 4 {
        return None;
    }
    let t = if k == "text" {
        let t = o
            .get("t")
            .and_then(Value::as_str)
            .filter(|t| !t.trim().is_empty())?;
        Some(js_slice(t, 500))
    } else {
        None
    };
    let by = o
        .get("by")
        .filter(|b| js_truthy(b))
        .map(js_string)
        .unwrap_or_default();
    Some(Stroke {
        id: id.to_owned(),
        by: js_slice(&by, 40),
        k: k.to_owned(),
        c: c.to_ascii_lowercase(),
        w: js_round(w),
        p: p.into_iter().map(js_round).collect(),
        t,
    })
}

/// The index's rules.
pub struct IndexRules;

impl Reducer for IndexRules {
    fn initial(&self) -> Value {
        serde_json::json!({ "epoch": 0, "chunks": 1, "bg": "light", "clearedBy": "" })
    }

    fn reduce(&self, state: &Value, a: &Value, meta: &mut Meta<'_>) -> Option<Value> {
        let mut s = Index::from_value(state)?;
        match a.get("kind").and_then(Value::as_str)? {
            "grow" => {
                #[allow(clippy::cast_precision_loss)]
                let from_last = a.get("from").and_then(Value::as_f64) == Some((s.chunks - 1) as f64);
                if !from_last || s.chunks >= MAX_CHUNKS {
                    return None;
                }
                s.chunks += 1;
            }
            "clear" => {
                if !can_manage(meta) {
                    return None;
                }
                let name = a
                    .get("name")
                    .filter(|n| js_truthy(n))
                    .map(js_string)
                    .unwrap_or_default();
                s.epoch += 1;
                s.chunks = 1;
                s.cleared_by = js_slice(&name, 40);
            }
            "bg" => {
                let bg = a
                    .get("bg")
                    .and_then(Value::as_str)
                    .filter(|b| *b == "light" || *b == "dark")?;
                if bg == s.bg {
                    return None;
                }
                bg.clone_into(&mut s.bg);
            }
            _ => return None,
        }
        serde_json::to_value(s).ok()
    }
}

/// A chunk's rules.
pub struct ChunkRules;

impl Reducer for ChunkRules {
    fn initial(&self) -> Value {
        serde_json::json!({ "strokes": [] })
    }

    fn reduce(&self, state: &Value, a: &Value, _meta: &mut Meta<'_>) -> Option<Value> {
        let mut s = Chunk::from_value(state)?;
        match a.get("kind").and_then(Value::as_str)? {
            "add" => {
                let list = a.get("strokes")?.as_array()?;
                let have: BTreeSet<String> = s.strokes.iter().map(|x| x.id.clone()).collect();
                let add: Vec<Stroke> = list
                    .iter()
                    .filter_map(clean_stroke)
                    .filter(|x| !have.contains(&x.id))
                    .collect();
                if add.is_empty() || s.strokes.len() + add.len() > CHUNK_HARD_MAX {
                    return None;
                }
                s.strokes.extend(add);
            }
            "remove" => {
                let ids = a.get("ids")?.as_array()?;
                let drop: BTreeSet<String> = ids.iter().map(js_string).collect();
                let before = s.strokes.len();
                s.strokes.retain(|x| !drop.contains(&x.id));
                if s.strokes.len() == before {
                    return None;
                }
            }
            _ => return None,
        }
        serde_json::to_value(s).ok()
    }
}

// ---- geometry --------------------------------------------------------------------------------

/// Distance from (px, py) to the segment a–b.
#[must_use]
pub fn segment_distance(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let len = dx * dx + dy * dy;
    let t = if len > 0.0 {
        (((px - ax) * dx + (py - ay) * dy) / len).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (px - (ax + t * dx)).hypot(py - (ay + t * dy))
}

/// Ramer–Douglas–Peucker on a flat x,y list: drops points that don't change the shape.
#[must_use]
pub fn simplify(p: &[f64], epsilon: f64) -> Vec<i64> {
    let n = p.len() / 2;
    if n <= 2 {
        return p.iter().map(|v| js_round(*v)).collect();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let mut worst = -1.0;
        let mut at = 0;
        for i in a + 1..b {
            let d = segment_distance(
                p[i * 2],
                p[i * 2 + 1],
                p[a * 2],
                p[a * 2 + 1],
                p[b * 2],
                p[b * 2 + 1],
            );
            if d > worst {
                worst = d;
                at = i;
            }
        }
        if worst > epsilon && at > 0 {
            keep[at] = true;
            stack.push((a, at));
            stack.push((at, b));
        }
    }
    (0..n)
        .filter(|&i| keep[i])
        .flat_map(|i| [js_round(p[i * 2]), js_round(p[i * 2 + 1])])
        .collect()
}

/// The rough box of a text stroke: x, y, w, h.
#[must_use]
#[allow(clippy::cast_precision_loss)]
pub fn text_box(s: &Stroke) -> (f64, f64, f64, f64) {
    let t = s.t.as_deref().unwrap_or("");
    let lines: Vec<&str> = t.split('\n').collect();
    let longest = lines.iter().map(|l| l.encode_utf16().count()).max().unwrap_or(0);
    let w = longest as f64 * s.w as f64 * 0.56;
    (
        s.p.first().copied().unwrap_or(0) as f64,
        s.p.get(1).copied().unwrap_or(0) as f64,
        w,
        lines.len() as f64 * s.w as f64 * 1.25,
    )
}

/// Does a circle of radius `r` at (x, y) touch the stroke? (the eraser)
#[must_use]
#[allow(clippy::cast_precision_loss)]
pub fn hits(s: &Stroke, x: f64, y: f64, r: f64) -> bool {
    let reach = r + s.w as f64 / 2.0;
    let p: Vec<f64> = s.p.iter().map(|v| *v as f64).collect();
    let seg = |a: usize, b: usize| segment_distance(x, y, p[a], p[a + 1], p[b], p[b + 1]);
    match s.k.as_str() {
        "pen" | "hl" => {
            let widen = if s.k == "hl" { s.w as f64 } else { 0.0 };
            if p.len() == 2 {
                return (x - p[0]).hypot(y - p[1]) <= reach + widen;
            }
            (0..p.len().saturating_sub(3))
                .step_by(2)
                .any(|i| seg(i, i + 2) <= reach + widen)
        }
        "line" | "arrow" if p.len() == 4 => seg(0, 2) <= reach,
        "rect" if p.len() == 4 => {
            let (x1, y1, x2, y2) = (p[0], p[1], p[2], p[3]);
            segment_distance(x, y, x1, y1, x2, y1) <= reach
                || segment_distance(x, y, x2, y1, x2, y2) <= reach
                || segment_distance(x, y, x2, y2, x1, y2) <= reach
                || segment_distance(x, y, x1, y2, x1, y1) <= reach
        }
        "ell" if p.len() == 4 => {
            let (cx, cy) = ((p[0] + p[2]) / 2.0, (p[1] + p[3]) / 2.0);
            let (rx, ry) = ((p[2] - p[0]).abs() / 2.0, (p[3] - p[1]).abs() / 2.0);
            (0..48).any(|i| {
                let a = f64::from(i) / 48.0 * std::f64::consts::TAU;
                (x - (cx + rx * a.cos())).hypot(y - (cy + ry * a.sin())) <= reach + 4.0
            })
        }
        "text" => {
            let (bx, by, bw, bh) = text_box(s);
            x >= bx - r && x <= bx + bw + r && y >= by - r && y <= by + bh + r
        }
        _ => false,
    }
}
