//! Last Card (`lastcard/rules.ts`): the shedding card game, 2–10 players and the computer.
//!
//! Secret cards: hands and the draw pile are only in the deciding app's copy; [`Reducer::redact`]
//! gives every other peer its own hand. If the deciding app changes mid-game, the new one has only
//! its own copy: it sets `restoring`, players send their hands back (`restore`), and the rest is
//! dealt again from the cards nobody holds.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ActivityDef, Meta, Reducer, js_slice, js_string, js_truthy};

/// Its menu entry.
pub const DEF: ActivityDef = ActivityDef {
    id: "lastcard",
    name: "Last Card",
    icon: "🃏",
    description: "Match colours and symbols, 2–10 players (or the computer)",
    min_people: 1,
};

/// The four colours.
pub const COLORS: [&str; 4] = ["r", "y", "g", "b"];
/// Cards in the deck.
pub const DECK_SIZE: i64 = 108;
/// Cards dealt to each player.
pub const HAND_SIZE: usize = 7;
/// Most players.
pub const MAX_PLAYERS: usize = 10;

/// A card: its colour (`w` for wilds) and value (`0`–`9`, `S`kip, `R`everse, `D`raw two,
/// `W`ild, wild draw `F`our).
#[must_use]
pub fn card(id: i64) -> (&'static str, &'static str) {
    if id >= 104 {
        return ("w", "F");
    }
    if id >= 100 {
        return ("w", "W");
    }
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let color = COLORS[(id / 25).clamp(0, 3) as usize];
    let k = id % 25;
    if k == 0 {
        return (color, "0");
    }
    if k <= 18 {
        const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        return (color, DIGITS[((k + 1) / 2) as usize]);
    }
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    (color, ["S", "R", "D"][((k - 19) / 2) as usize])
}

/// A wild card.
#[must_use]
pub const fn is_wild(id: i64) -> bool {
    id >= 100
}

/// "Red 7", "Wild Draw Four".
#[must_use]
pub fn card_name(id: i64) -> String {
    let (c, v) = card(id);
    let value = match v {
        "S" => "Skip",
        "R" => "Reverse",
        "D" => "Draw Two",
        "W" => "Wild",
        "F" => "Wild Draw Four",
        x => x,
    };
    if c == "w" {
        return value.to_owned();
    }
    format!("{} {value}", color_name(c))
}

/// "Red" etc.
#[must_use]
pub fn color_name(c: &str) -> &'static str {
    match c {
        "y" => "Yellow",
        "g" => "Green",
        "b" => "Blue",
        _ => "Red",
    }
}

/// A player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Player {
    /// Peer id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Lasting app id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    /// The computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot: Option<bool>,
    /// Games won.
    pub wins: i64,
}

impl Player {
    /// The computer plays it.
    #[must_use]
    pub fn is_bot(&self) -> bool {
        self.bot == Some(true)
    }
}

/// House rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    /// +2 on +2, +4 on anything owed.
    pub stacking: bool,
    /// Draw until you get a card you can play.
    pub draw_to_match: bool,
}

/// What just happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    /// `start`, `play`, `draw`, `take`, `caught`, `called`, `win`, `pass`, `restored`.
    pub kind: String,
    /// Who.
    pub seat: i64,
    /// The card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<i64>,
    /// How many cards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    /// Who it hit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<i64>,
    /// The colour chosen for a wild.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl Event {
    fn new(kind: &str, seat: i64) -> Self {
        Self {
            kind: kind.to_owned(),
            seat,
            card: None,
            count: None,
            target: None,
            color: None,
        }
    }
}

/// The game (`LcState`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// `lobby`, `playing`, `over`.
    pub phase: String,
    /// Players in seat order.
    pub players: Vec<Player>,
    /// House rules.
    pub rules: Rules,
    /// Each seat's hand (`None` where this copy doesn't know it).
    pub hands: Vec<Option<Vec<i64>>>,
    /// Cards each seat holds.
    pub counts: Vec<i64>,
    /// The draw pile (`None` except on the deciding app).
    pub draw_pile: Option<Vec<i64>>,
    /// Cards in the draw pile.
    pub draw_count: i64,
    /// The discard pile (top last).
    pub discard: Vec<i64>,
    /// The colour to match.
    pub color: String,
    /// Whose turn.
    pub turn: i64,
    /// 1 or −1.
    pub dir: i64,
    /// Cards owed by the player to move (stacking).
    pub pending_draw: i64,
    /// The player drew this turn.
    pub drew_this_turn: bool,
    /// Called "Last card" in time.
    pub called: Vec<bool>,
    /// Down to one card without calling.
    pub exposed: Option<i64>,
    /// Who won.
    pub winner: Option<i64>,
    /// What just happened.
    pub event: Option<Event>,
    /// Changes so far.
    pub seq: i64,
    /// When this turn began.
    pub turn_since: Value,
    /// Waiting for hands to come back.
    pub restoring: bool,
}

impl State {
    /// The start.
    #[must_use]
    pub fn initial() -> Self {
        Self {
            phase: "lobby".into(),
            players: Vec::new(),
            rules: Rules {
                stacking: false,
                draw_to_match: false,
            },
            hands: Vec::new(),
            counts: Vec::new(),
            draw_pile: Some(Vec::new()),
            draw_count: 0,
            discard: Vec::new(),
            color: "r".into(),
            turn: 0,
            dir: 1,
            pending_draw: 0,
            drew_this_turn: false,
            called: Vec::new(),
            exposed: None,
            winner: None,
            event: None,
            seq: 0,
            turn_since: Value::from(0),
            restoring: false,
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

    /// The seat of `peer` (not a computer's), or −1.
    #[must_use]
    pub fn seat_of(&self, peer: &str) -> i64 {
        self.players
            .iter()
            .position(|p| !p.is_bot() && p.id == peer)
            .map_or(-1, |i| i as i64)
    }

    /// The seat `steps` after `from` in play order.
    #[must_use]
    pub fn next_seat(&self, from: i64, steps: i64) -> i64 {
        let n = self.players.len() as i64;
        if n == 0 {
            return 0;
        }
        (from + self.dir * steps).rem_euclid(n)
    }

    /// The top of the discard pile.
    #[must_use]
    pub fn top(&self) -> Option<i64> {
        self.discard.last().copied()
    }

    /// Can `id` go on the pile now?
    #[must_use]
    pub fn can_play(&self, id: i64) -> bool {
        let Some(top) = self.top() else { return true };
        let (cc, cv) = card(id);
        let (_, tv) = card(top);
        if self.pending_draw > 0 {
            if !self.rules.stacking {
                return false;
            }
            if cv == "F" {
                return true;
            }
            return cv == "D" && tv == "D";
        }
        if cc == "w" {
            return true;
        }
        cc == self.color || cv == tv
    }

    /// Cards seat `seat` can play now.
    #[must_use]
    pub fn playable(&self, seat: i64) -> Vec<i64> {
        let Some(hand) = self.hand(seat) else {
            return Vec::new();
        };
        if self.drew_this_turn {
            return hand
                .last()
                .copied()
                .filter(|&d| self.can_play(d))
                .into_iter()
                .collect();
        }
        hand.iter().copied().filter(|&id| self.can_play(id)).collect()
    }

    /// A seat's hand, if this copy knows it.
    #[must_use]
    pub fn hand(&self, seat: i64) -> Option<&Vec<i64>> {
        usize::try_from(seat)
            .ok()
            .and_then(|i| self.hands.get(i))
            .and_then(Option::as_ref)
    }

    fn count(&self, seat: i64) -> Option<i64> {
        usize::try_from(seat)
            .ok()
            .and_then(|i| self.counts.get(i))
            .copied()
    }

    fn bump(mut self) -> Self {
        self.seq += 1;
        self
    }
}

/// Fisher–Yates with the room's random numbers.
fn shuffle(cards: &[i64], meta: &mut Meta<'_>) -> Vec<i64> {
    let mut a = cards.to_vec();
    for i in (1..a.len()).rev() {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let j = ((meta.random)() * (i + 1) as f64).floor() as usize;
        a.swap(i, j);
    }
    a
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
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => js_number(&a[0]),
        _ => f64::NAN,
    }
}

#[allow(clippy::cast_possible_truncation)]
fn as_int(f: f64) -> Option<i64> {
    (f.fract() == 0.0 && f.is_finite()).then_some(f as i64)
}

/// Takes `n` cards off the draw pile, reshuffling the discard pile (all but the top) when it runs
/// out. Gives them to `seat`.
fn give_cards(s: &State, seat: i64, n: i64, meta: &mut Meta<'_>) -> State {
    let mut draw_pile = s.draw_pile.clone().unwrap_or_default();
    let mut discard = s.discard.clone();
    let mut got = Vec::new();
    for _ in 0..n {
        if draw_pile.is_empty() && discard.len() > 1 {
            let top = discard[discard.len() - 1];
            draw_pile = shuffle(&discard[..discard.len() - 1], meta);
            discard = vec![top];
        }
        if draw_pile.is_empty() {
            break;
        }
        got.push(draw_pile.remove(0));
    }
    let mut out = s.clone();
    let Ok(i) = usize::try_from(seat) else { return out };
    if let Some(h) = out.hands.get_mut(i) {
        let mut hand = h.clone().unwrap_or_default();
        hand.extend(got);
        let len = hand.len() as i64;
        *h = Some(hand);
        if let Some(c) = out.counts.get_mut(i) {
            *c = len;
        }
    }
    out.draw_count = draw_pile.len() as i64;
    out.draw_pile = Some(draw_pile);
    out.discard = discard;
    for (k, c) in out.called.iter_mut().enumerate() {
        if k == i {
            *c = false;
        }
    }
    out
}

fn start_turn(mut s: State, seat: i64, meta: &Meta<'_>) -> State {
    s.turn = seat;
    s.drew_this_turn = false;
    s.turn_since = meta.now();
    s.bump()
}

fn close_exposure(mut s: State, seat: i64) -> State {
    if s.exposed.is_some_and(|e| e != seat) {
        s.exposed = None;
    }
    s
}

fn deal(s: &State, meta: &mut Meta<'_>) -> State {
    let all: Vec<i64> = (0..DECK_SIZE).collect();
    let mut pile = shuffle(&all, meta);
    let n = s.players.len();
    let mut hands: Vec<Vec<i64>> = vec![Vec::new(); n];
    for _ in 0..HAND_SIZE {
        for h in &mut hands {
            h.push(pile.remove(0));
        }
    }
    let i = pile
        .iter()
        .position(|&id| card(id).1.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(0);
    let first = pile.remove(i);
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    let turn = ((meta.random)() * n as f64).floor() as i64;
    let mut o = s.clone();
    o.phase = "playing".into();
    o.counts = hands.iter().map(|h| h.len() as i64).collect();
    o.called = vec![false; n];
    o.hands = hands.into_iter().map(Some).collect();
    o.draw_count = pile.len() as i64;
    o.draw_pile = Some(pile);
    o.discard = vec![first];
    o.color = card(first).0.to_owned();
    o.turn = turn;
    o.dir = 1;
    o.pending_draw = 0;
    o.drew_this_turn = false;
    o.exposed = None;
    o.winner = None;
    let mut e = Event::new("start", turn);
    e.card = Some(first);
    o.event = Some(e);
    o.turn_since = meta.now();
    o.restoring = false;
    o.bump()
}

/// Plays a card already checked as legal.
fn play_card(s0: &State, seat: i64, id: i64, chosen: Option<&str>, meta: &mut Meta<'_>) -> State {
    let mut s = close_exposure(s0.clone(), seat);
    let (cc, cv) = card(id);
    let i = usize::try_from(seat).unwrap_or(0);
    let hand: Vec<i64> = s
        .hand(seat)
        .map(|h| h.iter().copied().filter(|&x| x != id).collect())
        .unwrap_or_default();
    let left = hand.len() as i64;
    if let Some(h) = s.hands.get_mut(i) {
        *h = Some(hand);
    }
    if let Some(c) = s.counts.get_mut(i) {
        *c = left;
    }
    let called_me = s.called.get(i).copied().unwrap_or(false);
    s.exposed = if left == 1 && !called_me {
        Some(seat)
    } else if s.exposed == Some(seat) {
        None
    } else {
        s.exposed
    };
    if let Some(c) = s.called.get_mut(i) {
        *c = false;
    }
    s.discard.push(id);
    s.color = if cc == "w" {
        chosen.unwrap_or("r").to_owned()
    } else {
        cc.to_owned()
    };
    s.drew_this_turn = false;
    if left == 0 {
        if let Some(p) = s.players.get_mut(i) {
            p.wins += 1;
        }
        s.phase = "over".into();
        s.winner = Some(seat);
        s.exposed = None;
        s.pending_draw = 0;
        let mut e = Event::new("win", seat);
        e.card = Some(id);
        s.event = Some(e);
        return s.bump();
    }
    let mut event = Event::new("play", seat);
    event.card = Some(id);
    if cc == "w" {
        event.color = chosen.map(str::to_owned);
    }
    let two = s.players.len() == 2;
    match cv {
        "S" => {
            let mut e = event;
            e.target = Some(s.next_seat(seat, 1));
            let to = s.next_seat(seat, 2);
            s.event = Some(e);
            start_turn(s, to, meta)
        }
        "R" if two => {
            let mut e = event;
            e.target = Some(s.next_seat(seat, 1));
            s.event = Some(e);
            start_turn(s, seat, meta)
        }
        "R" => {
            s.dir = if s.dir == 1 { -1 } else { 1 };
            let to = s.next_seat(seat, 1);
            s.event = Some(event);
            start_turn(s, to, meta)
        }
        "D" | "F" => {
            let owed = s.pending_draw + if cv == "D" { 2 } else { 4 };
            let victim = s.next_seat(seat, 1);
            if s.rules.stacking {
                s.pending_draw = owed;
                s.event = Some(event);
                return start_turn(s, victim, meta);
            }
            s.pending_draw = 0;
            let mut given = give_cards(&s, victim, owed, meta);
            let to = given.next_seat(victim, 1);
            given.pending_draw = 0;
            let mut e = event;
            e.target = Some(victim);
            e.count = Some(owed);
            given.event = Some(e);
            start_turn(given, to, meta)
        }
        _ => {
            let to = s.next_seat(seat, 1);
            s.event = Some(event);
            start_turn(s, to, meta)
        }
    }
}

fn draw_for(s0: &State, seat: i64, meta: &mut Meta<'_>) -> State {
    let mut s = close_exposure(s0.clone(), seat);
    if s.pending_draw > 0 {
        let owed = s.pending_draw;
        s.pending_draw = 0;
        let mut g = give_cards(&s, seat, owed, meta);
        let to = g.next_seat(seat, 1);
        let mut e = Event::new("take", seat);
        e.count = Some(owed);
        g.event = Some(e);
        return start_turn(g, to, meta);
    }
    let mut drawn = 0;
    loop {
        let before = s.hand(seat).map_or(0, Vec::len);
        s = give_cards(&s, seat, 1, meta);
        let after = s.hand(seat).map_or(0, Vec::len);
        if after == before {
            break;
        }
        drawn += 1;
        let got = s.hand(seat).and_then(|h| h.last().copied()).unwrap_or(-1);
        if s.can_play(got) {
            s.drew_this_turn = true;
            let mut e = Event::new("draw", seat);
            e.count = Some(drawn);
            s.event = Some(e);
            return s.bump();
        }
        if !s.rules.draw_to_match || drawn >= 30 {
            break;
        }
    }
    let to = s.next_seat(seat, 1);
    let mut e = Event::new("draw", seat);
    e.count = Some(drawn);
    s.event = Some(e);
    start_turn(s, to, meta)
}

/// What the computer plays now (a card and, for a wild, a colour), or `None` to draw or pass.
pub fn bot_choice(s: &State, seat: i64, meta: &mut Meta<'_>) -> Option<(i64, Option<String>)> {
    let options = s.playable(seat);
    if options.is_empty() {
        return None;
    }
    let hand = s.hand(seat).cloned().unwrap_or_default();
    let next = s.next_seat(seat, 1);
    let next_is_close = s.count(next).unwrap_or(9) <= 2;
    let score = |id: i64| -> i64 {
        let (c, v) = card(id);
        let mut x = 0;
        if c == "w" {
            x -= 20;
        }
        if v == "F" {
            x -= 10;
        }
        if matches!(v, "S" | "R" | "D") {
            x += if next_is_close { 30 } else { 5 };
        }
        if v == "F" && next_is_close {
            x += 45;
        }
        if c != "w" {
            x += hand.iter().filter(|&&h| card(h).0 == c).count() as i64;
        }
        x
    };
    let mut sorted = options;
    sorted.sort_by_key(|&id| std::cmp::Reverse(score(id)));
    let best = sorted[0];
    if !is_wild(best) {
        return Some((best, None));
    }
    let mut tally = [0i64; 4];
    for &h in &hand {
        let (c, _) = card(h);
        if h != best
            && c != "w"
            && let Some(k) = COLORS.iter().position(|x| *x == c)
        {
            tally[k] += 1;
        }
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let start = ((meta.random)() * 4.0).floor() as usize;
    let mut pick = start.min(3);
    for b in 0..4 {
        if tally[b] > tally[pick] {
            pick = b;
        }
    }
    Some((best, Some(COLORS[pick].to_owned())))
}

/// Deals again what this copy doesn't know: hands nobody sent back, and the draw pile.
fn rebuild(s: &State, meta: &mut Meta<'_>) -> State {
    let known: BTreeSet<i64> = s
        .discard
        .iter()
        .copied()
        .chain(s.hands.iter().flatten().flatten().copied())
        .collect();
    let rest: Vec<i64> = (0..DECK_SIZE).filter(|id| !known.contains(id)).collect();
    let mut pool = shuffle(&rest, meta);
    let hands: Vec<Vec<i64>> = s
        .hands
        .iter()
        .enumerate()
        .map(|(i, h)| {
            h.clone().unwrap_or_else(|| {
                let n = usize::try_from(s.counts.get(i).copied().unwrap_or(0))
                    .unwrap_or(0)
                    .min(pool.len());
                pool.drain(..n).collect()
            })
        })
        .collect();
    let mut o = s.clone();
    o.counts = hands.iter().map(|h| h.len() as i64).collect();
    o.hands = hands.into_iter().map(Some).collect();
    o.draw_count = pool.len() as i64;
    o.draw_pile = Some(pool);
    o.restoring = false;
    o.turn_since = meta.now();
    o.event = Some(Event::new("restored", s.turn));
    o.bump()
}

/// This copy is missing secrets it needs to run the game (it just became the deciding app).
#[must_use]
pub fn missing_secrets(s: &State) -> bool {
    s.phase == "playing"
        && (s.draw_pile.is_none()
            || s.hands
                .iter()
                .enumerate()
                .any(|(i, h)| h.is_none() && s.counts.get(i).copied().unwrap_or(0) > 0))
}

/// The Last Card rules.
pub struct LastCard;

impl LastCard {
    #[allow(clippy::too_many_lines)]
    fn step(s: &State, a: &Value, meta: &mut Meta<'_>) -> Option<State> {
        let by = meta.by.to_owned();
        let present = |id: &str| meta.present.iter().any(|p| p == id);
        match a.get("kind").and_then(Value::as_str).unwrap_or("") {
            "join" => {
                let cid = (meta.client_of)(&by).filter(|c| !c.is_empty());
                let back = s.players.iter().position(|p| {
                    !p.is_bot() && p.id != by && cid.is_some() && p.cid == cid && !present(&p.id)
                });
                if let Some(b) = back {
                    let mut o = s.clone();
                    o.players[b].id = by;
                    return Some(o.bump());
                }
                if s.phase != "lobby" || s.seat_of(&by) >= 0 || s.players.len() >= MAX_PLAYERS {
                    return None;
                }
                let name = clean_name(
                    a.get("name").unwrap_or(&Value::Null),
                    &format!("Player {}", s.players.len() + 1),
                );
                let mut o = s.clone();
                o.players.push(Player {
                    id: by,
                    name,
                    cid,
                    bot: None,
                    wins: 0,
                });
                Some(o.bump())
            }
            "leave" => {
                let seat = s.seat_of(&by);
                if s.phase != "lobby" || seat < 0 {
                    return None;
                }
                let mut o = s.clone();
                o.players.remove(usize::try_from(seat).ok()?);
                Some(o.bump())
            }
            "add-bot" => {
                if s.phase != "lobby" || !can_manage(meta) || s.players.len() >= MAX_PLAYERS {
                    return None;
                }
                let n = s.players.iter().filter(|p| p.is_bot()).count() + 1;
                let mut o = s.clone();
                o.players.push(Player {
                    id: format!("bot-{}-{n}", s.seq),
                    name: format!("Computer {n}"),
                    cid: None,
                    bot: Some(true),
                    wins: 0,
                });
                Some(o.bump())
            }
            "remove" => {
                if s.phase != "lobby" || !can_manage(meta) {
                    return None;
                }
                let seat = usize::try_from(as_int(a.get("seat")?.as_f64()?)?).ok()?;
                if seat >= s.players.len() {
                    return None;
                }
                let mut o = s.clone();
                o.players.remove(seat);
                Some(o.bump())
            }
            "rules" => {
                if s.phase != "lobby" || !can_manage(meta) {
                    return None;
                }
                let mut o = s.clone();
                if let Some(r) = a.get("rules") {
                    if let Some(v) = r.get("stacking").and_then(Value::as_bool) {
                        o.rules.stacking = v;
                    }
                    if let Some(v) = r.get("drawToMatch").and_then(Value::as_bool) {
                        o.rules.draw_to_match = v;
                    }
                }
                Some(o.bump())
            }
            "start" => {
                if s.phase != "lobby" || s.players.len() < 2 {
                    return None;
                }
                if !can_manage(meta) && s.seat_of(&by) < 0 {
                    return None;
                }
                Some(deal(s, meta))
            }
            "again" => {
                if s.phase != "over" {
                    return None;
                }
                if !can_manage(meta) && s.seat_of(&by) < 0 {
                    return None;
                }
                let mut o = State::initial();
                o.players = s.players.clone();
                o.rules = s.rules.clone();
                o.seq = s.seq;
                Some(o.bump())
            }
            "resync" => {
                if by != meta.self_id || !missing_secrets(s) || s.restoring {
                    return None;
                }
                let mut o = s.clone();
                o.restoring = true;
                Some(o.bump())
            }
            "restore" => {
                let seat = s.seat_of(&by);
                if !s.restoring || seat < 0 {
                    return None;
                }
                let i = usize::try_from(seat).ok()?;
                if !matches!(s.hands.get(i), Some(None)) {
                    return None;
                }
                let list = a.get("cards")?.as_array()?;
                let nums: Vec<f64> = list.iter().map(|v| js_number(v) + 0.0).collect();
                let taken: BTreeSet<i64> = s
                    .discard
                    .iter()
                    .copied()
                    .chain(s.hands.iter().flatten().flatten().copied())
                    .collect();
                let ints: Vec<Option<i64>> = nums.iter().map(|&f| as_int(f)).collect();
                let mut uniq: Vec<u64> = nums.iter().map(|f| f.to_bits()).collect();
                uniq.sort_unstable();
                uniq.dedup();
                let valid = Some(nums.len() as i64) == s.counts.get(i).copied()
                    && uniq.len() == nums.len()
                    && ints
                        .iter()
                        .all(|x| x.is_some_and(|id| (0..DECK_SIZE).contains(&id) && !taken.contains(&id)));
                if !valid {
                    return None;
                }
                let mut next = s.clone();
                if let Some(h) = next.hands.get_mut(i) {
                    *h = Some(ints.into_iter().flatten().collect());
                }
                let waiting = next.players.iter().enumerate().any(|(k, p)| {
                    !p.is_bot()
                        && next.hands.get(k).is_some_and(Option::is_none)
                        && present(&p.id)
                        && next.counts.get(k).copied().unwrap_or(0) > 0
                });
                Some(if waiting {
                    next.bump()
                } else {
                    rebuild(&next, meta)
                })
            }
            "play" => {
                let seat = s.seat_of(&by);
                if s.phase != "playing" || s.restoring || seat < 0 || seat != s.turn {
                    return None;
                }
                let id = as_int(js_number(a.get("card").unwrap_or(&Value::Null)))?;
                if !s.hand(seat).is_some_and(|h| h.contains(&id)) || !s.playable(seat).contains(&id) {
                    return None;
                }
                let color = a
                    .get("color")
                    .and_then(Value::as_str)
                    .filter(|c| COLORS.contains(c));
                if is_wild(id) && color.is_none() {
                    return None;
                }
                Some(play_card(s, seat, id, color, meta))
            }
            "draw" => {
                let seat = s.seat_of(&by);
                if s.phase != "playing" || s.restoring || seat < 0 || seat != s.turn || s.drew_this_turn {
                    return None;
                }
                Some(draw_for(s, seat, meta))
            }
            "pass" => {
                let seat = s.seat_of(&by);
                if s.phase != "playing" || s.restoring || seat != s.turn || !s.drew_this_turn {
                    return None;
                }
                let mut o = close_exposure(s.clone(), seat);
                o.event = Some(Event::new("pass", seat));
                let to = s.next_seat(seat, 1);
                Some(start_turn(o, to, meta))
            }
            "call" => {
                let seat = s.seat_of(&by);
                if s.phase != "playing" || seat < 0 {
                    return None;
                }
                let mut o = s.clone();
                if s.exposed == Some(seat) {
                    o.exposed = None;
                    o.event = Some(Event::new("called", seat));
                    return Some(o.bump());
                }
                let i = usize::try_from(seat).ok()?;
                if seat == s.turn && s.counts.get(i) == Some(&2) && !s.called.get(i).copied().unwrap_or(false)
                {
                    if let Some(c) = o.called.get_mut(i) {
                        *c = true;
                    }
                    o.event = Some(Event::new("called", seat));
                    return Some(o.bump());
                }
                None
            }
            "catch" => {
                let catcher = s.seat_of(&by);
                let target = js_number(a.get("seat").unwrap_or(&Value::Null));
                #[allow(clippy::cast_precision_loss)]
                let hit = s.exposed.is_some_and(|e| e as f64 == target);
                #[allow(clippy::cast_precision_loss)]
                if s.phase != "playing" || s.restoring || catcher < 0 || catcher as f64 == target || !hit {
                    return None;
                }
                let t = s.exposed?;
                let mut base = s.clone();
                base.exposed = None;
                let mut g = give_cards(&base, t, 2, meta);
                let mut e = Event::new("caught", catcher);
                e.target = Some(t);
                e.count = Some(2);
                g.event = Some(e);
                Some(g.bump())
            }
            "auto" => {
                if s.phase != "playing" || by != meta.self_id {
                    return None;
                }
                #[allow(clippy::cast_precision_loss)]
                let seq_ok = a.get("seq").and_then(Value::as_f64) == Some(s.seq as f64);
                let mode = a.get("mode").and_then(Value::as_str);
                if mode == Some("rebuild") {
                    return (s.restoring && seq_ok).then(|| rebuild(s, meta));
                }
                if s.restoring || !seq_ok {
                    return None;
                }
                if mode == Some("catch") {
                    let catcher = s
                        .players
                        .iter()
                        .enumerate()
                        .position(|(i, p)| p.is_bot() && Some(i as i64) != s.exposed)?;
                    let t = s.exposed?;
                    let mut base = s.clone();
                    base.exposed = None;
                    let mut g = give_cards(&base, t, 2, meta);
                    let mut e = Event::new("caught", catcher as i64);
                    e.target = Some(t);
                    e.count = Some(2);
                    g.event = Some(e);
                    return Some(g.bump());
                }
                let seat = s.turn;
                s.hand(seat)?;
                let i = usize::try_from(seat).ok()?;
                let mut state = s.clone();
                if s.players.get(i).is_some_and(Player::is_bot)
                    && s.counts.get(i) == Some(&2)
                    && let Some(c) = state.called.get_mut(i)
                {
                    *c = true;
                }
                if let Some((card, color)) = bot_choice(&state, seat, meta) {
                    return Some(play_card(&state, seat, card, color.as_deref(), meta));
                }
                if state.drew_this_turn {
                    let to = state.next_seat(seat, 1);
                    let mut o = close_exposure(state, seat);
                    o.event = Some(Event::new("pass", seat));
                    return Some(start_turn(o, to, meta));
                }
                let after = draw_for(&state, seat, meta);
                if after.drew_this_turn && after.turn == seat {
                    if let Some((card, color)) = bot_choice(&after, seat, meta) {
                        return Some(play_card(&after, seat, card, color.as_deref(), meta));
                    }
                    let to = after.next_seat(seat, 1);
                    let mut o = after;
                    o.event = Some(Event::new("pass", seat));
                    return Some(start_turn(o, to, meta));
                }
                Some(after)
            }
            _ => None,
        }
    }
}

/// The copy `peer` may see: their own hand, nobody else's, no draw pile.
#[must_use]
pub fn redact(s: &State, peer: &str) -> State {
    let seat = s.seat_of(peer);
    let mut o = s.clone();
    o.hands = s
        .hands
        .iter()
        .enumerate()
        .map(|(i, h)| if i as i64 == seat { h.clone() } else { None })
        .collect();
    o.draw_pile = None;
    o
}

impl Reducer for LastCard {
    fn initial(&self) -> Value {
        State::initial().value()
    }

    fn reduce(&self, state: &Value, action: &Value, meta: &mut Meta<'_>) -> Option<Value> {
        let s = State::from_value(state)?;
        Self::step(&s, action, meta).map(|n| n.value())
    }

    fn redacts(&self) -> bool {
        true
    }

    fn redact(&self, state: &Value, peer: &str) -> Option<Value> {
        State::from_value(state).map(|s| redact(&s, peer).value())
    }
}

/// Actions, for the UI.
pub mod act {
    use serde_json::{Value, json};

    /// Join the table.
    #[must_use]
    pub fn join(name: &str) -> Value {
        json!({ "kind": "join", "name": name })
    }
    /// Leave the table (lobby).
    #[must_use]
    pub fn leave() -> Value {
        json!({ "kind": "leave" })
    }
    /// Add a computer player.
    #[must_use]
    pub fn add_bot() -> Value {
        json!({ "kind": "add-bot" })
    }
    /// Remove a seat.
    #[must_use]
    pub fn remove(seat: i64) -> Value {
        json!({ "kind": "remove", "seat": seat })
    }
    /// One house rule.
    #[must_use]
    pub fn rule(key: &str, on: bool) -> Value {
        json!({ "kind": "rules", "rules": { key: on } })
    }
    /// Deal.
    #[must_use]
    pub fn start() -> Value {
        json!({ "kind": "start" })
    }
    /// Play a card (a colour for wilds).
    #[must_use]
    pub fn play(card: i64, color: Option<&str>) -> Value {
        match color {
            Some(c) => json!({ "kind": "play", "card": card, "color": c }),
            None => json!({ "kind": "play", "card": card }),
        }
    }
    /// Draw.
    #[must_use]
    pub fn draw() -> Value {
        json!({ "kind": "draw" })
    }
    /// Pass after drawing.
    #[must_use]
    pub fn pass() -> Value {
        json!({ "kind": "pass" })
    }
    /// "Last card!"
    #[must_use]
    pub fn call() -> Value {
        json!({ "kind": "call" })
    }
    /// Catch someone who didn't call.
    #[must_use]
    pub fn catch(seat: i64) -> Value {
        json!({ "kind": "catch", "seat": seat })
    }
    /// Back to the lobby.
    #[must_use]
    pub fn again() -> Value {
        json!({ "kind": "again" })
    }
    /// The new deciding app is missing cards.
    #[must_use]
    pub fn resync() -> Value {
        json!({ "kind": "resync" })
    }
    /// Send our hand back to a new deciding app.
    #[must_use]
    pub fn restore(cards: &[i64]) -> Value {
        json!({ "kind": "restore", "cards": cards })
    }
    /// The deciding app plays (`mode`: `play`, `catch`, `rebuild`).
    #[must_use]
    pub fn auto(seq: i64, mode: Option<&str>) -> Value {
        match mode {
            Some(m) => json!({ "kind": "auto", "seq": seq, "mode": m }),
            None => json!({ "kind": "auto", "seq": seq }),
        }
    }
}

/// What this app does on its own now (see [`crate::driver`]): ask our seat back, hand our cards
/// to a new deciding app, and on the deciding app play for computers, people away and idle
/// players, let computers catch a missed call, and deal again what nobody sent back.
#[must_use]
pub fn wants(s: &State, seen: &crate::driver::Seen<'_>, hand: Option<&[i64]>) -> Vec<crate::driver::Want> {
    use crate::driver::Want;
    let mut out = Vec::new();
    let here = |id: &str| id == seen.me || seen.present.iter().any(|p| p == id);
    let away = |i: usize| s.players.get(i).is_some_and(|p| !p.is_bot() && !here(&p.id));
    let me = s.seat_of(seen.me);
    if me < 0
        && let Some(old) = s
            .players
            .iter()
            .enumerate()
            .position(|(i, p)| !p.is_bot() && p.cid.as_deref() == Some(seen.client_id) && away(i))
    {
        let id = &s.players[old].id;
        out.push(Want {
            key: format!("reclaim:{old}:{id}"),
            delay_ms: 0,
            action: act::join(seen.name),
        });
        // again in a moment, if the first ask came before the others knew which app we are
        out.push(Want {
            key: format!("reclaim2:{old}:{id}"),
            delay_ms: 3000,
            action: act::join(seen.name),
        });
    }
    if s.phase == "playing"
        && s.restoring
        && me >= 0
        && s.hand(me).is_none()
        && let Some(h) = hand
    {
        out.push(Want {
            key: format!("restore:{}", s.seq),
            delay_ms: 0,
            action: act::restore(h),
        });
    }
    if !seen.deciding || s.phase != "playing" {
        return out;
    }
    if missing_secrets(s) && !s.restoring {
        out.push(Want {
            key: format!("resync:{}", s.seq),
            delay_ms: 0,
            action: act::resync(),
        });
        return out;
    }
    if s.restoring {
        out.push(Want {
            key: format!("rebuild:{}", s.seq),
            delay_ms: 6000,
            action: act::auto(s.seq, Some("rebuild")),
        });
        return out;
    }
    if let Some(p) = usize::try_from(s.turn).ok().and_then(|t| s.players.get(t)) {
        let delay = if p.is_bot() {
            1100
        } else if !here(&p.id) {
            5000
        } else {
            45_000
        };
        out.push(Want {
            key: format!("play:{}:{delay}", s.seq),
            delay_ms: delay,
            action: act::auto(s.seq, Some("play")),
        });
    }
    if let Some(x) = s.exposed
        && s.players
            .iter()
            .enumerate()
            .any(|(i, p)| p.is_bot() && i as i64 != x)
    {
        out.push(Want {
            key: format!("catch:{}", s.seq),
            delay_ms: 2600,
            action: act::auto(s.seq, Some("catch")),
        });
    }
    out
}
