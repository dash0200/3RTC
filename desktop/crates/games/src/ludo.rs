//! Ludo (`ludo/rules.ts`): 2–4 players or the computer; the deciding app rolls the dice, so
//! nobody can fake a roll.
//!
//! Token progress (per colour, 4 tokens): −1 in base; 0..50 on the shared 52-square track,
//! counted from the colour's start square; 51..55 in the home column; 56 home.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ActivityDef, Meta, Reducer, js_slice, js_string, js_truthy};

/// Its menu entry.
pub const DEF: ActivityDef = ActivityDef {
    id: "ludo",
    name: "Ludo",
    icon: "🎲",
    description: "2–4 players (or play the computer), everyone else watches",
    min_people: 1,
};

/// Turn order (clockwise).
pub const COLORS: [&str; 4] = ["red", "green", "yellow", "blue"];
/// Track squares.
pub const TRACK_LENGTH: i64 = 52;
/// The last track square before the home column.
pub const LAST_TRACK: i64 = 50;
/// Home.
pub const HOME: i64 = 56;
const STAR_OFFSET: i64 = 8;

/// A colour's start square.
#[must_use]
pub fn start_of(color: &str) -> i64 {
    match color {
        "green" => 13,
        "yellow" => 26,
        "blue" => 39,
        _ => 0,
    }
}

/// "Red" etc.
#[must_use]
pub fn color_name(color: &str) -> &'static str {
    match color {
        "green" => "Green",
        "yellow" => "Yellow",
        "blue" => "Blue",
        _ => "Red",
    }
}

/// House rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    /// Only a 6 brings a token out (off: a 1 too).
    pub six_to_leave: bool,
    /// Three sixes in a row lose the turn.
    pub three_sixes: bool,
    /// Star squares are safe.
    pub safe_stars: bool,
    /// Capturing gives another turn.
    pub capture_bonus: bool,
    /// Reaching home gives another turn.
    pub home_bonus: bool,
    /// Someone who left: `bot` plays for them, or `skip`.
    pub away_mode: String,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            six_to_leave: true,
            three_sixes: true,
            safe_stars: true,
            capture_bonus: true,
            home_bonus: true,
            away_mode: "bot".to_owned(),
        }
    }
}

/// A seat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seat {
    /// Peer id (`bot-red` for the computer).
    pub id: String,
    /// Name.
    pub name: String,
    /// The computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot: Option<bool>,
    /// Lasting app id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
}

impl Seat {
    /// The computer plays it.
    #[must_use]
    pub fn is_bot(&self) -> bool {
        self.bot == Some(true)
    }
}

/// A captured token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Captured {
    /// Whose.
    pub color: String,
    /// Which.
    pub token: i64,
}

/// What just happened (for the board's animation and the log line).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    /// `start`, `roll`, `move`, `capture`, `home`, `no-move`, `three-sixes`, `skipped`.
    pub kind: String,
    /// Whose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Token moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<i64>,
    /// From.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
    /// To.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<i64>,
    /// The roll.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<i64>,
    /// Tokens sent back to base.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captured: Option<Vec<Captured>>,
}

impl Event {
    fn new(kind: &str, color: Option<&str>) -> Self {
        Self {
            kind: kind.to_owned(),
            color: color.map(str::to_owned),
            token: None,
            from: None,
            to: None,
            value: None,
            captured: None,
        }
    }
}

/// The game (`LudoState`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// `lobby`, `playing`, `over`.
    pub phase: String,
    /// House rules.
    pub rules: Rules,
    /// Seats by colour (all four keys).
    pub seats: BTreeMap<String, Option<Seat>>,
    /// Token progress by colour (playing colours only).
    pub tokens: Option<BTreeMap<String, Vec<i64>>>,
    /// Whose turn.
    pub turn: Option<String>,
    /// The last roll.
    pub dice: Option<i64>,
    /// Rolled and waiting for a move.
    pub rolled: bool,
    /// Tokens that can move.
    pub movable: Vec<i64>,
    /// Sixes in a row.
    pub sixes: i64,
    /// Colours home, in order.
    pub finished: Vec<String>,
    /// What just happened.
    pub event: Option<Event>,
    /// Changes so far.
    pub seq: i64,
    /// When this turn began (ms).
    pub turn_since: Value,
}

impl State {
    /// The start.
    #[must_use]
    pub fn initial() -> Self {
        Self {
            phase: "lobby".to_owned(),
            rules: Rules::default(),
            seats: COLORS.iter().map(|c| ((*c).to_owned(), None)).collect(),
            tokens: None,
            turn: None,
            dice: None,
            rolled: false,
            movable: Vec::new(),
            sixes: 0,
            finished: Vec::new(),
            event: None,
            seq: 0,
            turn_since: Value::from(0),
        }
    }

    /// From shared state.
    #[must_use]
    pub fn from_value(v: &Value) -> Option<Self> {
        serde_json::from_value(v.clone()).ok()
    }

    fn value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// A colour's seat.
    #[must_use]
    pub fn seat(&self, c: &str) -> Option<&Seat> {
        self.seats.get(c).and_then(Option::as_ref)
    }

    /// Colours with someone (or the computer) in them, in turn order.
    #[must_use]
    pub fn seated(&self) -> Vec<&'static str> {
        COLORS.into_iter().filter(|c| self.seat(c).is_some()).collect()
    }

    /// The colour `peer` plays.
    #[must_use]
    pub fn seat_of(&self, peer: &str) -> Option<&'static str> {
        COLORS
            .into_iter()
            .find(|c| self.seat(c).is_some_and(|s| !s.is_bot() && s.id == peer))
    }

    fn bump(mut self) -> Self {
        self.seq += 1;
        self
    }
}

/// The track square of a token.
#[must_use]
pub fn abs_square(color: &str, progress: i64) -> i64 {
    (start_of(color) + progress) % TRACK_LENGTH
}

/// Start squares (and stars, with the rule) are safe.
#[must_use]
pub fn is_safe(abs: i64, rules: &Rules) -> bool {
    COLORS.iter().any(|c| {
        abs == start_of(c) || (rules.safe_stars && abs == (start_of(c) + STAR_OFFSET) % TRACK_LENGTH)
    })
}

/// Where a token ends up with `value`, if it can move.
#[must_use]
pub fn target_of(progress: i64, value: i64, rules: &Rules) -> Option<i64> {
    if progress == -1 {
        let can_leave = value == 6 || (!rules.six_to_leave && value == 1);
        return can_leave.then_some(0);
    }
    if progress >= HOME {
        return None;
    }
    let next = progress + value;
    (next <= HOME).then_some(next)
}

/// Tokens of `color` that can move by `value`.
#[must_use]
pub fn movable_tokens(state: &State, color: &str, value: i64) -> Vec<i64> {
    let Some(list) = state.tokens.as_ref().and_then(|t| t.get(color)) else {
        return Vec::new();
    };
    list.iter()
        .enumerate()
        .filter(|(_, p)| target_of(**p, value, &state.rules).is_some())
        .map(|(i, _)| i as i64)
        .collect()
}

#[allow(clippy::cast_possible_truncation)]
fn roll(meta: &mut Meta<'_>) -> i64 {
    1 + ((meta.random)() * 6.0).floor() as i64
}

fn next_color(state: &State, after: Option<&str>) -> Option<String> {
    let playing: Vec<&str> = state
        .seated()
        .into_iter()
        .filter(|c| !state.finished.iter().any(|f| f == c))
        .collect();
    if playing.is_empty() {
        return None;
    }
    let order: Vec<&str> = COLORS
        .into_iter()
        .filter(|c| playing.contains(c) || Some(*c) == after)
        .collect();
    let i = after
        .and_then(|a| order.iter().position(|c| *c == a))
        .map_or(-1, |p| p as i64);
    #[allow(
        clippy::cast_possible_wrap,
        clippy::cast_sign_loss,
        clippy::cast_possible_truncation
    )]
    for k in 1..=order.len() as i64 {
        let c = order[((i + k).rem_euclid(order.len() as i64)) as usize];
        if playing.contains(&c) {
            return Some(c.to_owned());
        }
    }
    None
}

fn pass_turn(mut state: State, meta: &Meta<'_>) -> State {
    let turn = next_color(&state, state.turn.as_deref());
    state.rolled = false;
    state.movable = Vec::new();
    state.sixes = 0;
    state.turn = turn;
    state.turn_since = meta.now();
    state.bump()
}

fn apply_move(state: &State, index: i64, meta: &Meta<'_>) -> Option<State> {
    let color = state.turn.clone()?;
    let value = state.dice.filter(|d| *d != 0)?;
    let tokens0 = state.tokens.as_ref()?;
    let idx = usize::try_from(index).ok()?;
    let from = *tokens0.get(&color)?.get(idx)?;
    let to = target_of(from, value, &state.rules)?;
    let mut tokens = tokens0.clone();
    if let Some(list) = tokens.get_mut(&color) {
        list[idx] = to;
    }
    let mut captured = Vec::new();
    if to <= LAST_TRACK {
        let abs = abs_square(&color, to);
        if !is_safe(abs, &state.rules) {
            for other in COLORS {
                if other == color {
                    continue;
                }
                let Some(list) = tokens.get_mut(other) else {
                    continue;
                };
                for (i, p) in list.iter_mut().enumerate() {
                    if *p >= 0 && *p <= LAST_TRACK && abs_square(other, *p) == abs {
                        *p = -1;
                        captured.push(Captured {
                            color: other.to_owned(),
                            token: i as i64,
                        });
                    }
                }
            }
        }
    }
    let reached_home = to == HOME;
    let mut finished = state.finished.clone();
    if tokens.get(&color).is_some_and(|l| l.iter().all(|p| *p == HOME)) && !finished.contains(&color) {
        finished.push(color.clone());
    }
    let any_captured = !captured.is_empty();
    let event = Event {
        kind: if any_captured {
            "capture"
        } else if reached_home {
            "home"
        } else {
            "move"
        }
        .to_owned(),
        color: Some(color.clone()),
        token: Some(index),
        from: Some(from),
        to: Some(to),
        value: Some(value),
        captured: Some(captured),
    };
    let still: Vec<&str> = state
        .seated()
        .into_iter()
        .filter(|c| !finished.iter().any(|f| f == c))
        .collect();
    if still.len() <= 1 {
        let mut s = state.clone();
        s.tokens = Some(tokens);
        finished.extend(still.iter().map(|c| (*c).to_owned()));
        s.finished = finished;
        s.phase = "over".into();
        s.turn = None;
        s.rolled = false;
        s.movable = Vec::new();
        s.event = Some(event);
        return Some(s.bump());
    }
    let bonus = !finished.contains(&color)
        && (value == 6
            || (any_captured && state.rules.capture_bonus)
            || (reached_home && state.rules.home_bonus));
    let mut next = state.clone();
    next.tokens = Some(tokens);
    next.finished = finished;
    next.event = Some(event);
    if bonus {
        next.rolled = false;
        next.movable = Vec::new();
        next.sixes = if value == 6 { state.sixes } else { 0 };
        next.turn_since = meta.now();
        return Some(next.bump());
    }
    Some(pass_turn(next, meta))
}

fn do_roll(state: &State, meta: &mut Meta<'_>) -> Option<State> {
    let color = state.turn.clone()?;
    state.tokens.as_ref()?;
    let value = roll(meta);
    let sixes = if value == 6 { state.sixes + 1 } else { 0 };
    if state.rules.three_sixes && sixes >= 3 {
        let mut s = state.clone();
        s.dice = Some(value);
        let mut e = Event::new("three-sixes", Some(&color));
        e.value = Some(value);
        s.event = Some(e);
        return Some(pass_turn(s, meta));
    }
    let mut with_roll = state.clone();
    with_roll.dice = Some(value);
    with_roll.sixes = sixes;
    let movable = movable_tokens(&with_roll, &color, value);
    if movable.is_empty() {
        let mut e = Event::new("no-move", Some(&color));
        e.value = Some(value);
        with_roll.event = Some(e);
        return Some(pass_turn(with_roll, meta));
    }
    let list = state
        .tokens
        .as_ref()
        .and_then(|t| t.get(&color))
        .cloned()
        .unwrap_or_default();
    let mut targets: Vec<i64> = movable
        .iter()
        .filter_map(|&i| usize::try_from(i).ok().and_then(|i| list.get(i).copied()))
        .collect();
    targets.sort_unstable();
    targets.dedup();
    if movable.len() == 1 || targets.len() == 1 {
        let mut s = with_roll.clone();
        s.rolled = true;
        s.movable.clone_from(&movable);
        // a move that can't be made leaves the state as it was (rejected)
        return apply_move(&s, movable[0], meta);
    }
    with_roll.rolled = true;
    with_roll.movable = movable;
    let mut e = Event::new("roll", Some(&color));
    e.value = Some(value);
    with_roll.event = Some(e);
    Some(with_roll.bump())
}

/// The computer's pick: capture > home > leave base > safe square > the furthest-back token.
#[must_use]
pub fn bot_choice(state: &State) -> i64 {
    let (Some(color), Some(value), Some(tokens)) = (state.turn.as_deref(), state.dice, state.tokens.as_ref())
    else {
        return 0;
    };
    if value == 0 || state.movable.is_empty() {
        return 0;
    }
    let mut best = state.movable[0];
    let mut best_score = f64::NEG_INFINITY;
    for &i in &state.movable {
        let Some(&from) = usize::try_from(i)
            .ok()
            .and_then(|i| tokens.get(color).and_then(|l| l.get(i)))
        else {
            continue;
        };
        let Some(to) = target_of(from, value, &state.rules) else {
            continue;
        };
        let mut score = 0.0;
        if to == HOME {
            score += 80.0;
        }
        if from == -1 {
            score += 50.0;
        }
        if to <= LAST_TRACK {
            let abs = abs_square(color, to);
            let hits = COLORS.iter().any(|c| {
                *c != color
                    && tokens.get(*c).is_some_and(|l| {
                        l.iter()
                            .any(|p| *p >= 0 && *p <= LAST_TRACK && abs_square(c, *p) == abs)
                    })
            });
            if hits && !is_safe(abs, &state.rules) {
                score += 100.0;
            }
            if is_safe(abs, &state.rules) {
                score += 15.0;
            }
        } else if to > LAST_TRACK {
            score += 30.0;
        }
        #[allow(clippy::cast_precision_loss)]
        {
            score += (HOME - from) as f64 / 10.0;
        }
        if score > best_score {
            best_score = score;
            best = i;
        }
    }
    best
}

fn can_manage(meta: &Meta<'_>) -> bool {
    meta.is_host || meta.host_id.is_none_or(|h| !meta.present.iter().any(|p| p == h))
}

fn clean_name(name: &Value, fallback: &str) -> String {
    let s = if js_truthy(name) {
        js_string(name)
    } else {
        String::new()
    };
    let s = js_slice(s.trim(), 24);
    if s.is_empty() { fallback.to_owned() } else { s }
}

fn color_arg(a: &Value) -> Option<&'static str> {
    let c = a.get("color")?.as_str()?;
    COLORS.into_iter().find(|x| *x == c)
}

/// The Ludo rules.
pub struct Ludo;

impl Ludo {
    #[allow(clippy::too_many_lines)]
    fn step(state: &State, a: &Value, meta: &mut Meta<'_>) -> Option<State> {
        let by = meta.by.to_owned();
        let present = |id: &str| meta.present.iter().any(|p| p == id);
        match a.get("kind").and_then(Value::as_str).unwrap_or("") {
            "sit" => {
                let color = color_arg(a)?;
                let current = state.seat(color);
                let cid = (meta.client_of)(&by);
                let away = current.is_some_and(|c| !c.is_bot() && !present(&c.id));
                let coming_back =
                    away && cid.is_some() && current.and_then(|c| c.cid.as_ref()) == cid.as_ref();
                let take_over = coming_back || (away && state.phase == "playing");
                if current.is_some() && !take_over {
                    return None;
                }
                if state.phase == "playing" && !take_over {
                    return None;
                }
                let mut s = state.clone();
                if let Some(mine) = state.seat_of(&by) {
                    if state.phase == "lobby" || coming_back {
                        s.seats.insert(mine.to_owned(), None);
                    } else if state.phase == "playing" {
                        return None;
                    }
                }
                let name = match current {
                    Some(c) if coming_back => c.name.clone(),
                    _ => clean_name(a.get("name").unwrap_or(&Value::Null), color_name(color)),
                };
                s.seats.insert(
                    color.to_owned(),
                    Some(Seat {
                        id: by,
                        name,
                        bot: None,
                        cid,
                    }),
                );
                Some(s.bump())
            }
            "stand" => {
                if state.phase != "lobby" {
                    return None;
                }
                let mine = state.seat_of(&by)?;
                let mut s = state.clone();
                s.seats.insert(mine.to_owned(), None);
                Some(s.bump())
            }
            k @ ("add-bot" | "clear-seat") => {
                if state.phase != "lobby" || !can_manage(meta) {
                    return None;
                }
                let color = color_arg(a)?;
                if k == "add-bot" && state.seat(color).is_some() {
                    return None;
                }
                let mut s = state.clone();
                s.seats.insert(
                    color.to_owned(),
                    (k == "add-bot").then(|| Seat {
                        id: format!("bot-{color}"),
                        name: "Computer".into(),
                        bot: Some(true),
                        cid: None,
                    }),
                );
                Some(s.bump())
            }
            "rules" => {
                if state.phase != "lobby" || !can_manage(meta) {
                    return None;
                }
                let mut s = state.clone();
                if let Some(r) = a.get("rules") {
                    let b = |k: &str| r.get(k).and_then(Value::as_bool);
                    if let Some(v) = b("sixToLeave") {
                        s.rules.six_to_leave = v;
                    }
                    if let Some(v) = b("threeSixes") {
                        s.rules.three_sixes = v;
                    }
                    if let Some(v) = b("safeStars") {
                        s.rules.safe_stars = v;
                    }
                    if let Some(v) = b("captureBonus") {
                        s.rules.capture_bonus = v;
                    }
                    if let Some(v) = b("homeBonus") {
                        s.rules.home_bonus = v;
                    }
                    if let Some(m) = r
                        .get("awayMode")
                        .and_then(Value::as_str)
                        .filter(|m| *m == "bot" || *m == "skip")
                    {
                        s.rules.away_mode = m.to_owned();
                    }
                }
                Some(s.bump())
            }
            "start" => {
                if state.phase != "lobby" || !can_manage(meta) {
                    return None;
                }
                let colors = state.seated();
                if colors.len() < 2 {
                    return None;
                }
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    clippy::cast_precision_loss
                )]
                let turn = colors[((meta.random)() * colors.len() as f64).floor() as usize];
                let mut s = state.clone();
                s.phase = "playing".into();
                s.tokens = Some(
                    colors
                        .iter()
                        .map(|c| ((*c).to_owned(), vec![-1, -1, -1, -1]))
                        .collect(),
                );
                s.turn = Some(turn.to_owned());
                s.dice = None;
                s.rolled = false;
                s.movable = Vec::new();
                s.sixes = 0;
                s.finished = Vec::new();
                s.event = Some(Event::new("start", Some(turn)));
                s.turn_since = meta.now();
                Some(s.bump())
            }
            "again" => {
                if state.phase == "lobby" || !can_manage(meta) {
                    return None;
                }
                let mut s = State::initial();
                s.rules = state.rules.clone();
                s.seats = state.seats.clone();
                s.seq = state.seq;
                Some(s.bump())
            }
            "roll" => {
                if state.phase != "playing" || state.rolled {
                    return None;
                }
                let seat = state.seat(state.turn.as_deref()?)?;
                if seat.is_bot() || seat.id != by {
                    return None;
                }
                do_roll(state, meta)
            }
            "move" => {
                if state.phase != "playing" || !state.rolled {
                    return None;
                }
                let seat = state.seat(state.turn.as_deref()?)?;
                let token = a.get("token").and_then(Value::as_f64)?;
                #[allow(clippy::cast_precision_loss)]
                if seat.is_bot() || seat.id != by || !state.movable.iter().any(|m| *m as f64 == token) {
                    return None;
                }
                #[allow(clippy::cast_possible_truncation)]
                apply_move(state, token as i64, meta)
            }
            "auto" => {
                if state.phase != "playing" || by != meta.self_id {
                    return None;
                }
                #[allow(clippy::cast_precision_loss)]
                if a.get("seq").and_then(Value::as_f64) != Some(state.seq as f64) {
                    return None;
                }
                if a.get("mode").and_then(Value::as_str) == Some("skip") {
                    let mut s = state.clone();
                    s.event = Some(Event::new("skipped", state.turn.as_deref()));
                    return Some(pass_turn(s, meta));
                }
                if !state.rolled {
                    return do_roll(state, meta);
                }
                apply_move(state, bot_choice(state), meta)
            }
            _ => None,
        }
    }
}

impl Reducer for Ludo {
    fn initial(&self) -> Value {
        State::initial().value()
    }

    fn reduce(&self, state: &Value, action: &Value, meta: &mut Meta<'_>) -> Option<Value> {
        let s = State::from_value(state)?;
        Self::step(&s, action, meta).map(|n| n.value())
    }
}

/// Actions, for the UI.
pub mod act {
    use serde_json::{Value, json};

    /// Take a colour.
    #[must_use]
    pub fn sit(color: &str, name: &str) -> Value {
        json!({ "kind": "sit", "color": color, "name": name })
    }
    /// Leave your seat (lobby).
    #[must_use]
    pub fn stand() -> Value {
        json!({ "kind": "stand" })
    }
    /// The computer takes a colour.
    #[must_use]
    pub fn add_bot(color: &str) -> Value {
        json!({ "kind": "add-bot", "color": color })
    }
    /// Empty a seat.
    #[must_use]
    pub fn clear_seat(color: &str) -> Value {
        json!({ "kind": "clear-seat", "color": color })
    }
    /// Change one house rule.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)]
    pub fn rule(key: &str, value: Value) -> Value {
        json!({ "kind": "rules", "rules": { key: value } })
    }
    /// Start.
    #[must_use]
    pub fn start() -> Value {
        json!({ "kind": "start" })
    }
    /// Back to the lobby.
    #[must_use]
    pub fn again() -> Value {
        json!({ "kind": "again" })
    }
    /// Roll.
    #[must_use]
    pub fn roll() -> Value {
        json!({ "kind": "roll" })
    }
    /// Move a token.
    #[must_use]
    pub fn mv(token: i64) -> Value {
        json!({ "kind": "move", "token": token })
    }
    /// The deciding app plays (`mode`: `skip` someone who left).
    #[must_use]
    pub fn auto(seq: i64, skip: bool) -> Value {
        if skip {
            json!({ "kind": "auto", "seq": seq, "mode": "skip" })
        } else {
            json!({ "kind": "auto", "seq": seq })
        }
    }
}
