//! Chess in the room (`chess/rules.ts`): two seats, a computer for either, everyone else
//! watches. The shared-state reducer; the chess itself is in [`engine`].

pub mod engine;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ActivityDef, Meta, Reducer, js_slice, js_string, js_truthy};
use engine::{Color, Move, Position};

/// Its menu entry.
pub const DEF: ActivityDef = ActivityDef {
    id: "chess",
    name: "Chess",
    icon: "♟️",
    description: "Two players (or play the computer), everyone else watches",
    min_people: 1,
};

/// Half-moves kept.
pub const MAX_MOVES: usize = 600;

/// A seat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seat {
    /// Peer id (`bot-w` for the computer).
    pub id: String,
    /// Name shown.
    pub name: String,
    /// Lasting app id, to give the seat back after a reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    /// The computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot: Option<bool>,
}

impl Seat {
    /// Played by the computer.
    #[must_use]
    pub fn is_bot(&self) -> bool {
        self.bot == Some(true)
    }

    fn computer(c: Color) -> Self {
        Self {
            id: format!("bot-{}", c.key()),
            name: "Computer".to_owned(),
            cid: None,
            bot: Some(true),
        }
    }
}

/// Both seats.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seats {
    /// White.
    pub w: Option<Seat>,
    /// Black.
    pub b: Option<Seat>,
}

impl Seats {
    /// One side's seat.
    #[must_use]
    pub const fn get(&self, c: Color) -> Option<&Seat> {
        match c {
            Color::W => self.w.as_ref(),
            Color::B => self.b.as_ref(),
        }
    }

    fn set(&mut self, c: Color, s: Option<Seat>) {
        match c {
            Color::W => self.w = s,
            Color::B => self.b = s,
        }
    }
}

/// A move played.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Played {
    /// From square.
    pub from: usize,
    /// To square.
    pub to: usize,
    /// Promotion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promo: Option<String>,
    /// Its name.
    pub san: String,
}

/// How it ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChessResult {
    /// Who won (`None`: a draw).
    pub winner: Option<Color>,
    /// `checkmate`, `resign`, `stalemate`, `repetition`, `fifty`, `material`, `agreed`.
    pub reason: String,
}

/// The game (`ChessState`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// `lobby`, `playing`, `over`.
    pub phase: String,
    /// The seats.
    pub seats: Seats,
    /// The position.
    pub pos: Position,
    /// Moves so far.
    pub moves: Vec<Played>,
    /// Positions since the last capture or pawn move.
    pub reps: Vec<String>,
    /// Who offered a draw.
    pub draw_offer: Option<Color>,
    /// The result.
    pub result: Option<ChessResult>,
    /// Changes so far.
    pub seq: i64,
}

impl State {
    /// The start.
    #[must_use]
    pub fn initial() -> Self {
        Self {
            phase: "lobby".to_owned(),
            seats: Seats { w: None, b: None },
            pos: engine::start(),
            moves: Vec::new(),
            reps: Vec::new(),
            draw_offer: None,
            result: None,
            seq: 0,
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

    /// The colour `peer` plays (not the computer's).
    #[must_use]
    pub fn seat_of(&self, peer: &str) -> Option<Color> {
        [Color::W, Color::B]
            .into_iter()
            .find(|&c| self.seats.get(c).is_some_and(|s| !s.is_bot() && s.id == peer))
    }
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

fn is_square(v: &Value) -> Option<usize> {
    let n = v.as_f64()?;
    if n.fract() != 0.0 || !(0.0..64.0).contains(&n) {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(n as usize)
}

/// Plays a legal move and settles the game if it ended.
fn play(state: &State, m: Move) -> State {
    let pos = &state.pos;
    let name = engine::san(pos, m);
    let next = engine::make_move(pos, m);
    let mut moves = state.moves.clone();
    moves.push(Played {
        from: m.from,
        to: m.to,
        promo: m.promo.map(|p| (p as char).to_string()),
        san: name,
    });
    if moves.len() > MAX_MOVES {
        moves.drain(..moves.len() - MAX_MOVES);
    }
    let key = engine::position_key(&next);
    let reps = if next.half == 0 {
        vec![key.clone()]
    } else {
        let mut r = state.reps.clone();
        r.push(key.clone());
        if r.len() > 120 {
            r.drain(..r.len() - 120);
        }
        r
    };
    let result = if engine::legal_moves(&next).is_empty() {
        Some(if engine::in_check(&next, next.turn) {
            ChessResult {
                winner: Some(pos.turn),
                reason: "checkmate".into(),
            }
        } else {
            ChessResult {
                winner: None,
                reason: "stalemate".into(),
            }
        })
    } else if engine::insufficient_material(next.board.as_bytes()) {
        Some(ChessResult {
            winner: None,
            reason: "material".into(),
        })
    } else if reps.iter().filter(|k| **k == key).count() >= 3 {
        Some(ChessResult {
            winner: None,
            reason: "repetition".into(),
        })
    } else if next.half >= 100 {
        Some(ChessResult {
            winner: None,
            reason: "fifty".into(),
        })
    } else {
        None
    };
    let mut s = state.clone();
    s.pos = next;
    s.moves = moves;
    s.reps = reps;
    s.draw_offer = None;
    if let Some(r) = result {
        s.result = Some(r);
        s.phase = "over".into();
    }
    s.seq += 1;
    s
}

/// The chess rules.
pub struct Chess;

fn kind(a: &Value) -> &str {
    a.get("kind").and_then(Value::as_str).unwrap_or("")
}

impl Chess {
    #[allow(clippy::too_many_lines)]
    fn step(state: &State, a: &Value, meta: &mut Meta<'_>) -> Option<State> {
        let by = meta.by;
        let present = |id: &str| meta.present.iter().any(|p| p == id);
        let mut s = state.clone();
        s.seq += 1;
        match kind(a) {
            "sit" => {
                let color = Color::parse(a.get("color")?)?;
                let current = state.seats.get(color);
                let cid = (meta.client_of)(by);
                let away = current.is_some_and(|c| !c.is_bot() && !present(&c.id));
                let coming_back =
                    away && cid.is_some() && current.and_then(|c| c.cid.as_ref()) == cid.as_ref();
                let take_over = coming_back || (away && state.phase == "playing");
                if current.is_some() && !take_over {
                    return None;
                }
                if state.phase == "over" && !coming_back {
                    return None;
                }
                if state.phase == "playing" && !take_over {
                    return None;
                }
                let mine = state.seat_of(by);
                if let Some(m) = mine {
                    if state.phase == "lobby" || coming_back {
                        s.seats.set(m, None);
                    } else {
                        return None;
                    }
                }
                let name = match current {
                    Some(c) if coming_back => c.name.clone(),
                    _ => clean_name(a.get("name").unwrap_or(&Value::Null), color.name()),
                };
                s.seats.set(
                    color,
                    Some(Seat {
                        id: by.to_owned(),
                        name,
                        cid,
                        bot: None,
                    }),
                );
                Some(s)
            }
            "stand" => {
                if state.phase != "lobby" {
                    return None;
                }
                let mine = state.seat_of(by)?;
                s.seats.set(mine, None);
                Some(s)
            }
            k @ ("add-bot" | "clear-seat") => {
                if state.phase != "lobby" || !can_manage(meta) {
                    return None;
                }
                let color = Color::parse(a.get("color")?)?;
                if k == "add-bot" && state.seats.get(color).is_some() {
                    return None;
                }
                s.seats
                    .set(color, (k == "add-bot").then(|| Seat::computer(color)));
                Some(s)
            }
            "swap" => {
                if state.phase != "lobby" {
                    return None;
                }
                if !can_manage(meta) && state.seat_of(by).is_none() {
                    return None;
                }
                s.seats = Seats {
                    w: state.seats.b.clone(),
                    b: state.seats.w.clone(),
                };
                Some(s)
            }
            "start" => {
                if state.phase != "lobby" || state.seats.w.is_none() || state.seats.b.is_none() {
                    return None;
                }
                if !can_manage(meta) && state.seat_of(by).is_none() {
                    return None;
                }
                s.phase = "playing".into();
                s.pos = engine::start();
                s.moves = Vec::new();
                s.reps = vec![engine::position_key(&engine::start())];
                s.draw_offer = None;
                s.result = None;
                Some(s)
            }
            "move" => {
                if state.phase != "playing" {
                    return None;
                }
                let seat = state.seats.get(state.pos.turn)?;
                if seat.is_bot() || seat.id != by {
                    return None;
                }
                let from = is_square(a.get("from")?)?;
                let to = is_square(a.get("to")?)?;
                let promo = a
                    .get("promo")
                    .and_then(Value::as_str)
                    .filter(|p| ["q", "r", "b", "n"].contains(p))
                    .map(|p| p.as_bytes()[0]);
                let m = engine::find_legal(&state.pos, from, to, promo)?;
                Some(play(state, m))
            }
            "resign" => {
                let mine = state.seat_of(by)?;
                if state.phase != "playing" {
                    return None;
                }
                s.phase = "over".into();
                s.result = Some(ChessResult {
                    winner: Some(mine.other()),
                    reason: "resign".into(),
                });
                s.draw_offer = None;
                Some(s)
            }
            "offer-draw" => {
                let mine = state.seat_of(by)?;
                if state.phase != "playing" || state.draw_offer.is_some() {
                    return None;
                }
                if state.seats.get(mine.other()).is_some_and(Seat::is_bot) {
                    return None;
                }
                s.draw_offer = Some(mine);
                Some(s)
            }
            "answer-draw" => {
                let mine = state.seat_of(by)?;
                let offer = state.draw_offer?;
                if state.phase != "playing" {
                    return None;
                }
                let accept = js_truthy(a.get("accept").unwrap_or(&Value::Null));
                if offer == mine {
                    if accept {
                        return None;
                    }
                    s.draw_offer = None;
                    return Some(s);
                }
                if !accept {
                    s.draw_offer = None;
                    return Some(s);
                }
                s.phase = "over".into();
                s.result = Some(ChessResult {
                    winner: None,
                    reason: "agreed".into(),
                });
                s.draw_offer = None;
                Some(s)
            }
            "hand-to-bot" => {
                if state.phase != "playing" {
                    return None;
                }
                let color = Color::parse(a.get("color")?)?;
                let seat = state.seats.get(color)?;
                if seat.is_bot() || present(&seat.id) {
                    return None;
                }
                if !can_manage(meta) && state.seat_of(by).is_none() {
                    return None;
                }
                s.seats.set(color, Some(Seat::computer(color)));
                Some(s)
            }
            "again" => {
                if state.phase != "over" {
                    return None;
                }
                if !can_manage(meta) && state.seat_of(by).is_none() {
                    return None;
                }
                let mut n = State::initial();
                n.seats = Seats {
                    w: state.seats.b.clone(),
                    b: state.seats.w.clone(),
                };
                n.seq = state.seq + 1;
                Some(n)
            }
            "auto" => {
                if state.phase != "playing" || by != meta.self_id {
                    return None;
                }
                if a.get("seq").and_then(Value::as_f64) != Some(state.seq as f64) {
                    return None;
                }
                if !state.seats.get(state.pos.turn).is_some_and(Seat::is_bot) {
                    return None;
                }
                let m = engine::bot_move(&state.pos, meta.random)?;
                Some(play(state, m))
            }
            _ => None,
        }
    }
}

impl Reducer for Chess {
    fn initial(&self) -> Value {
        State::initial().value()
    }

    fn reduce(&self, state: &Value, action: &Value, meta: &mut Meta<'_>) -> Option<Value> {
        let s = State::from_value(state)?;
        Self::step(&s, action, meta).map(|n| n.value())
    }
}

/// Pieces taken so far, by the colour that lost them (`capturedPieces`).
#[must_use]
pub fn captured(board: &str) -> [(Color, Vec<u8>); 2] {
    let full = |t: u8| match t {
        b'p' => 8,
        b'q' => 1,
        _ => 2,
    };
    [Color::W, Color::B].map(|c| {
        let mut out = Vec::new();
        for t in *b"qrbnp" {
            let ch = if c == Color::W { t.to_ascii_uppercase() } else { t };
            let left = board.bytes().filter(|&p| p == ch).count();
            for _ in left..full(t) {
                out.push(t);
            }
        }
        (c, out)
    })
}

/// Actions, for the UI.
pub mod act {
    use serde_json::{Value, json};

    use super::engine::Color;

    /// Take a seat.
    #[must_use]
    pub fn sit(c: Color, name: &str) -> Value {
        json!({ "kind": "sit", "color": c.key(), "name": name })
    }
    /// Leave your seat (lobby).
    #[must_use]
    pub fn stand() -> Value {
        json!({ "kind": "stand" })
    }
    /// The computer takes a seat.
    #[must_use]
    pub fn add_bot(c: Color) -> Value {
        json!({ "kind": "add-bot", "color": c.key() })
    }
    /// Empty a seat.
    #[must_use]
    pub fn clear_seat(c: Color) -> Value {
        json!({ "kind": "clear-seat", "color": c.key() })
    }
    /// Swap colours.
    #[must_use]
    pub fn swap() -> Value {
        json!({ "kind": "swap" })
    }
    /// Start.
    #[must_use]
    pub fn start() -> Value {
        json!({ "kind": "start" })
    }
    /// A move.
    #[must_use]
    pub fn mv(from: usize, to: usize, promo: Option<u8>) -> Value {
        match promo {
            Some(p) => json!({ "kind": "move", "from": from, "to": to, "promo": (p as char).to_string() }),
            None => json!({ "kind": "move", "from": from, "to": to }),
        }
    }
    /// Resign.
    #[must_use]
    pub fn resign() -> Value {
        json!({ "kind": "resign" })
    }
    /// Offer a draw.
    #[must_use]
    pub fn offer_draw() -> Value {
        json!({ "kind": "offer-draw" })
    }
    /// Answer (or take back) a draw offer.
    #[must_use]
    pub fn answer_draw(accept: bool) -> Value {
        json!({ "kind": "answer-draw", "accept": accept })
    }
    /// The computer plays for someone who left.
    #[must_use]
    pub fn hand_to_bot(c: Color) -> Value {
        json!({ "kind": "hand-to-bot", "color": c.key() })
    }
    /// Rematch.
    #[must_use]
    pub fn again() -> Value {
        json!({ "kind": "again" })
    }
    /// The deciding app plays the computer's move.
    #[must_use]
    pub fn auto(seq: i64) -> Value {
        json!({ "kind": "auto", "seq": seq })
    }
}
