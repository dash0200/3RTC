//! The rules of everything a room shares: which activity is open, and each game
//! (`features/activities/`). Pure: a [`Reducer`] turns (state, action, who) into the next state
//! as JSON, exactly as the web app's reducer does, so either app can be the one that decides
//! (`rtc_core::shared`). No I/O, no clock and no randomness of its own ([`Meta`] brings them), so
//! the same code can be built for the web app (WASM) later.

pub mod activity;
pub mod chess;
pub mod driver;
pub mod lastcard;
pub mod ludo;
pub mod sample;
pub mod sketch;
pub mod tycoon;
pub mod whiteboard;

use serde_json::Value;

/// What a reducer knows about an action besides the action itself (`meta` in
/// `core/sharedState.ts`), all as the deciding app sees it.
pub struct Meta<'a> {
    /// Who the action really came from (from the connection, not from the message).
    pub by: &'a str,
    /// Whether `by` is the host.
    pub is_host: bool,
    /// The deciding app's own peer id (`by == self_id`: it acted itself).
    pub self_id: &'a str,
    /// The host's peer id (`None` while the host is away).
    pub host_id: Option<&'a str>,
    /// Everyone who has this state, the deciding app first.
    pub present: &'a [String],
    /// A peer's lasting app id (the same after a reload), for giving seats back.
    pub client_of: &'a dyn Fn(&str) -> Option<String>,
    /// The host has locked controls to themselves (`settings.playbackLock`).
    pub playback_lock: bool,
    /// Now, in milliseconds since 1970 (`Date.now()`).
    pub now_ms: f64,
    /// A random number in [0, 1) (`Math.random()`).
    pub random: &'a mut dyn FnMut() -> f64,
}

impl Meta<'_> {
    /// `Date.now()` as the web app writes it (whole milliseconds).
    #[must_use]
    pub fn now(&self) -> Value {
        #[allow(clippy::cast_possible_truncation)]
        let ms = self.now_ms.floor() as i64;
        Value::from(ms)
    }
}

/// The rules for one shared state.
pub trait Reducer: Send {
    /// The state before anything happened.
    fn initial(&self) -> Value;
    /// The next state, or `None` to reject the action (not your turn, a bad move, …).
    fn reduce(&self, state: &Value, action: &Value, meta: &mut Meta<'_>) -> Option<Value>;
    /// The copy of `state` that `peer` may see (hands of cards hidden). `None`: everyone sees it
    /// all.
    fn redact(&self, _state: &Value, _peer: &str) -> Option<Value> {
        None
    }
    /// Whether this state has secrets ([`Self::redact`] makes per-peer copies).
    fn redacts(&self) -> bool {
        false
    }
}

/// One activity people can open (`registry.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityDef {
    /// Stable id (`act:<id>` is its state).
    pub id: &'static str,
    /// Name in the menus.
    pub name: &'static str,
    /// Its emoji.
    pub icon: &'static str,
    /// One line for the menu.
    pub description: &'static str,
    /// People needed in the room to start it.
    pub min_people: usize,
}

/// The activities this app has, in the web app's order. `dev`: also the development examples
/// (the web app lists them in development builds).
#[must_use]
pub fn activities(dev: bool) -> Vec<ActivityDef> {
    let mut out: Vec<ActivityDef> = vec![ludo::DEF, chess::DEF, lastcard::DEF, whiteboard::DEF, sketch::DEF, tycoon::DEF];
    if dev {
        out.push(sample::DEF);
    }
    out
}

/// The definition of an activity this app has.
#[must_use]
pub fn find_activity(id: &str, dev: bool) -> Option<ActivityDef> {
    activities(dev).into_iter().find(|a| a.id == id)
}

/// The rules for a shared state key: `activity`, `act:<id>` (and `act:<id>:…` for games that
/// keep several states).
#[must_use]
pub fn reducer_for(key: &str) -> Option<Box<dyn Reducer>> {
    match key {
        activity::KEY => Some(Box::new(activity::Activity)),
        "act:sample-counter" => Some(Box::new(sample::Counter)),
        "act:chess" => Some(Box::new(chess::Chess)),
        "act:ludo" => Some(Box::new(ludo::Ludo)),
        "act:lastcard" => Some(Box::new(lastcard::LastCard)),
        "act:tycoon" => Some(Box::new(tycoon::Tycoon)),
        whiteboard::KEY => Some(Box::new(whiteboard::IndexRules)),
        k if k.starts_with("act:whiteboard:") => Some(Box::new(whiteboard::ChunkRules)),
        sketch::KEY => Some(Box::new(sketch::Sketch)),
        // each turn's board: `act:sketch:t<turn>` (a whiteboard index) and its chunks
        k if k.strip_prefix("act:sketch:t").is_some_and(|rest| rest.contains(':')) => {
            Some(Box::new(whiteboard::ChunkRules))
        }
        k if k.starts_with("act:sketch:t") => Some(Box::new(whiteboard::IndexRules)),
        _ => None,
    }
}

/// The shared state key of an activity (`act:<id>`).
#[must_use]
pub fn activity_key(id: &str) -> String {
    format!("act:{id}")
}

/// `key` belongs to activity `id` (`act:<id>` or `act:<id>:…`).
#[must_use]
pub fn is_activity_key(id: &str, key: &str) -> bool {
    key.strip_prefix("act:")
        .and_then(|rest| rest.strip_prefix(id))
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
}

/// JS `String(x)`, for the few places a reducer turns any value into text.
#[must_use]
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_owned(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), js_number),
        Value::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JS truthiness (`if (x)`).
#[must_use]
pub fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JS `String(n)` for a number (whole numbers without ".0").
#[must_use]
pub fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        #[allow(clippy::cast_possible_truncation)]
        let i = n as i128;
        i.to_string()
    } else {
        n.to_string()
    }
}

/// JS `String(s).slice(0, n)` (counts UTF-16 units, as JS does).
#[must_use]
pub fn js_slice(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_keys() {
        assert_eq!(activity_key("chess"), "act:chess");
        assert!(is_activity_key("chess", "act:chess"));
        assert!(is_activity_key("whiteboard", "act:whiteboard:p1:0"));
        assert!(!is_activity_key("chess", "act:chessboard"));
        assert!(!is_activity_key("chess", "activity"));
    }

    #[test]
    fn js_text() {
        assert_eq!(js_slice("héllo", 3), "hél");
        assert_eq!(js_slice("😀😀", 3), "😀");
        assert_eq!(js_string(&serde_json::json!(null)), "null");
        assert_eq!(js_string(&serde_json::json!(5)), "5");
    }
}
