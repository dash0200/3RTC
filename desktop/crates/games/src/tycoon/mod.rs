//! Tycoon (`tycoon/rules.ts`): buy places, collect rent, build houses and hotels, trade, and
//! don't go broke. 2–6 players and the computer; the dice are rolled by the deciding app.

pub mod board;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use self::board::{
    Effect, GO_TO_JAIL, JAIL, JAIL_FINE, Kind, MAX_PLAYERS, PLAYER_COLORS, SPACES, START_CASH, START_PAY,
    STATION_RENT, STATIONS, SURPRISE, TOKENS, TREASURE, UTILITIES, UTILITY_TIMES,
};
use crate::{ActivityDef, Meta, Reducer, js_slice, js_string, js_truthy};

/// Its menu entry.
pub const DEF: ActivityDef = ActivityDef {
    id: "tycoon",
    name: "Tycoon",
    icon: "🏙️",
    description: "Buy, build and bargain around the world, 2–6 players (or the computer)",
    min_people: 1,
};

/// Game lengths offered (rounds; 0: until one is left).
pub const ROUND_OPTIONS: [i64; 3] = [0, 15, 30];
/// What the computer keeps in hand.
const RESERVE: i64 = 2000;

/// A player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// Their colour (`#rrggbb`).
    pub color: String,
    /// Their token.
    pub token: String,
    /// Cash.
    pub cash: i64,
    /// Where they are (0–39).
    pub pos: i64,
    /// 0: free; 1–3: turns in jail so far + 1.
    pub jail: i64,
    /// Get-out-of-jail cards (`s` or `t`: the deck).
    pub jail_cards: Vec<String>,
    /// Out of the game.
    pub bankrupt: bool,
}

impl Player {
    /// The computer plays it.
    #[must_use]
    pub fn is_bot(&self) -> bool {
        self.bot == Some(true)
    }
}

/// Who is paid what (`to: None`: the bank).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payee {
    /// The seat paid, or the bank.
    pub to: Option<i64>,
    /// How much.
    pub amount: i64,
}

/// What the player to move owes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Debt {
    /// Who gets what.
    pub payees: Vec<Payee>,
    /// What for.
    pub reason: String,
    /// `roll` (doubles) or `done`.
    pub after: String,
}

/// A deal on the table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    /// The seq it was offered at.
    pub id: i64,
    /// Who offers.
    pub from: i64,
    /// To whom.
    pub to: i64,
    /// Cash given.
    pub give_cash: i64,
    /// Places given.
    pub give_props: Vec<i64>,
    /// Cash asked.
    pub get_cash: i64,
    /// Places asked.
    pub get_props: Vec<i64>,
}

/// House rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rules {
    /// Taxes and fines go into a pot for whoever lands on Coffee Break.
    pub jackpot: bool,
    /// End after this many rounds (0: until one is left).
    pub rounds: i64,
}

/// A token's last move (for the animation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Move {
    /// Who.
    pub seat: i64,
    /// From.
    pub from: i64,
    /// To.
    pub to: i64,
    /// A jump (card, jail) rather than a walk.
    pub jump: bool,
    /// The seq it happened at.
    pub seq: i64,
}

/// The card just drawn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardShown {
    /// `s` (Surprise) or `t` (Treasure).
    pub deck: String,
    /// Which card.
    pub index: i64,
    /// Who drew it.
    pub seat: i64,
    /// The seq it was drawn at.
    pub seq: i64,
}

/// The two decks' order (card indices, top first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decks {
    /// Surprise.
    pub s: Vec<i64>,
    /// Treasure.
    pub t: Vec<i64>,
}

impl Decks {
    fn get(&self, deck: &str) -> &Vec<i64> {
        if deck == "s" { &self.s } else { &self.t }
    }
    fn get_mut(&mut self, deck: &str) -> &mut Vec<i64> {
        if deck == "s" { &mut self.s } else { &mut self.t }
    }
}

/// The game (`TyState`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// `lobby`, `playing`, `over`.
    pub phase: String,
    /// Players in seat order.
    pub players: Vec<Player>,
    /// House rules.
    pub rules: Rules,
    /// Who owns each space.
    pub owner: Vec<Option<i64>>,
    /// Houses on each space (5: a hotel).
    pub houses: Vec<i64>,
    /// Mortgaged spaces.
    pub mortgaged: Vec<bool>,
    /// Whose turn.
    pub turn: i64,
    /// `roll`, `buy`, `debt`, `done`.
    pub step: String,
    /// The dice.
    pub dice: Option<[i64; 2]>,
    /// Doubles in a row.
    pub doubles: i64,
    /// Doubles: another roll after this.
    pub again: bool,
    /// The place they may buy.
    pub pending_buy: Option<i64>,
    /// What they owe.
    pub debt: Option<Debt>,
    /// The card just drawn.
    pub card: Option<CardShown>,
    /// The decks.
    pub decks: Decks,
    /// The Coffee Break pot.
    pub pot: i64,
    /// A deal on the table.
    pub trade: Option<Trade>,
    /// What happened (the last 14 lines).
    pub log: Vec<String>,
    /// The last move.
    #[serde(rename = "move")]
    pub mv: Option<Move>,
    /// Who won.
    pub winner: Option<i64>,
    /// Rounds completed.
    pub round: i64,
    /// Changes so far.
    pub seq: i64,
    /// When this turn began.
    pub turn_since: Value,
}

impl State {
    /// The start.
    #[must_use]
    pub fn initial() -> Self {
        Self {
            phase: "lobby".into(),
            players: Vec::new(),
            rules: Rules {
                jackpot: false,
                rounds: 0,
            },
            owner: vec![None; 40],
            houses: vec![0; 40],
            mortgaged: vec![false; 40],
            turn: 0,
            step: "roll".into(),
            dice: None,
            doubles: 0,
            again: false,
            pending_buy: None,
            debt: None,
            card: None,
            decks: Decks {
                s: Vec::new(),
                t: Vec::new(),
            },
            pot: 0,
            trade: None,
            log: Vec::new(),
            mv: None,
            winner: None,
            round: 0,
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

    /// The seat of `peer` (not a computer's), or −1.
    #[must_use]
    pub fn seat_of(&self, peer: &str) -> i64 {
        if peer.is_empty() {
            return -1;
        }
        self.players
            .iter()
            .position(|p| !p.is_bot() && p.id == peer)
            .map_or(-1, |i| i as i64)
    }

    /// A seat's player.
    #[must_use]
    pub fn player(&self, seat: i64) -> Option<&Player> {
        usize::try_from(seat).ok().and_then(|i| self.players.get(i))
    }

    fn p(&self, seat: i64) -> &Player {
        &self.players[ix(seat)]
    }

    fn owner_of(&self, pos: usize) -> Option<i64> {
        self.owner.get(pos).copied().flatten()
    }

    fn bump(mut self) -> Self {
        self.seq += 1;
        self
    }

    fn log(mut self, line: String) -> Self {
        self.log.push(line);
        let n = self.log.len();
        if n > 14 {
            self.log.drain(..n - 14);
        }
        self
    }

    fn add_cash(mut self, seat: i64, amount: i64) -> Self {
        self.players[ix(seat)].cash += amount;
        self
    }

    /// Does `seat` own the whole colour group of `pos`?
    #[must_use]
    pub fn owns_group(&self, seat: i64, pos: usize) -> bool {
        group_of(pos).is_some_and(|g| group_members(g).iter().all(|&i| self.owner_of(i) == Some(seat)))
    }

    fn group_has_houses(&self, pos: usize) -> bool {
        group_of(pos).is_some_and(|g| group_members(g).iter().any(|&i| self.houses[i] > 0))
    }

    /// Rent someone landing on `pos` pays now.
    #[must_use]
    pub fn rent_of(&self, pos: usize, dice_total: i64) -> i64 {
        let Some(owner) = self.owner_of(pos) else { return 0 };
        if self.mortgaged[pos] {
            return 0;
        }
        match SPACES[pos].kind {
            Kind::Property { rent, .. } => {
                let h = self.houses[pos];
                if h > 0 {
                    rent[ix(h)]
                } else if self.owns_group(owner, pos) {
                    rent[0] * 2
                } else {
                    rent[0]
                }
            }
            Kind::Station { .. } => {
                let n = STATIONS
                    .iter()
                    .filter(|&&i| self.owner_of(i) == Some(owner))
                    .count();
                STATION_RENT[n - 1]
            }
            Kind::Utility { .. } => {
                let n = UTILITIES
                    .iter()
                    .filter(|&&i| self.owner_of(i) == Some(owner))
                    .count();
                dice_total * UTILITY_TIMES[n - 1]
            }
            _ => 0,
        }
    }

    /// Why `seat` can't build on `pos` now, in words (`None`: it can).
    #[must_use]
    pub fn build_block(&self, seat: i64, pos: i64) -> Option<String> {
        let space = usize::try_from(pos).ok().and_then(|p| SPACES.get(p));
        let (Some(space), Kind::Property { group, .. }) = (space, space.map_or(Kind::Start, |s| s.kind))
        else {
            return Some("Houses go on coloured places only.".into());
        };
        if seat < 0 {
            return Some("Houses go on coloured places only.".into());
        }
        let pos = ix(pos);
        let set = group_members(group);
        let colour = board::group_name(group);
        let mine = set.iter().filter(|&&i| self.owner_of(i) == Some(seat)).count();
        if mine < set.len() {
            let others: Vec<String> = set
                .iter()
                .filter(|&&i| self.owner_of(i) != Some(seat))
                .map(|&i| match self.owner_of(i) {
                    None => format!("{} (for sale)", SPACES[i].name),
                    Some(o) => format!(
                        "{} ({})",
                        SPACES[i].name,
                        self.player(o).map_or("undefined", |p| p.name.as_str())
                    ),
                })
                .collect();
            return Some(format!(
                "Own all {} {colour} places to build: you have {mine}. Still needed: {}.",
                set.len(),
                others.join(", ")
            ));
        }
        let _ = space;
        if self.houses[pos] >= 5 {
            return Some("This place has a hotel: it can’t take more.".into());
        }
        if let Some(&m) = set.iter().find(|&&i| self.mortgaged[i]) {
            return Some(format!("Pay off the mortgage on {} first.", SPACES[m].name));
        }
        if self.phase != "playing" || self.turn != seat {
            return Some("You can build on your turn.".into());
        }
        if self.step == "debt" {
            return Some("Pay what you owe first.".into());
        }
        let fewest = set.iter().map(|&i| self.houses[i]).min().unwrap_or(0);
        if self.houses[pos] > fewest {
            let next = set
                .iter()
                .find(|&&i| self.houses[i] == fewest)
                .copied()
                .unwrap_or(pos);
            return Some(format!(
                "Build evenly: put a house on {} first.",
                SPACES[next].name
            ));
        }
        let cost = house_cost(pos);
        let cash = self.p(seat).cash;
        if cash < cost {
            return Some(format!(
                "A {} here costs {}: you have {}.",
                if self.houses[pos] == 4 { "hotel" } else { "house" },
                money(cost),
                money(cash)
            ));
        }
        None
    }

    /// Everything a player has, at what the bank would give for it now.
    #[must_use]
    pub fn raisable(&self, seat: i64) -> i64 {
        let mut total = self.p(seat).cash;
        for i in 0..40 {
            if self.owner_of(i) != Some(seat) {
                continue;
            }
            total += self.houses[i] * house_cost(i) / 2;
            if !self.mortgaged[i] {
                total += mortgage_value(i);
            }
        }
        total
    }

    /// Cash + places at price (half if mortgaged) + buildings at cost.
    #[must_use]
    pub fn net_worth(&self, seat: i64) -> i64 {
        let mut total = self.p(seat).cash;
        for i in 0..40 {
            if self.owner_of(i) != Some(seat) {
                continue;
            }
            total += if self.mortgaged[i] {
                mortgage_value(i)
            } else {
                price_of(i)
            };
            total += self.houses[i] * house_cost(i);
        }
        total
    }

    fn active(&self) -> Vec<i64> {
        self.players
            .iter()
            .enumerate()
            .filter(|(_, p)| !p.bankrupt)
            .map(|(i, _)| i as i64)
            .collect()
    }

    fn next_active(&self, from: i64) -> i64 {
        let n = self.players.len() as i64;
        for k in 1..=n {
            let i = (from + k) % n;
            if !self.p(i).bankrupt {
                return i;
            }
        }
        from
    }

    fn richest(&self) -> i64 {
        let left = self.active();
        let Some(&first) = left.first() else { return 0 };
        left.iter().fold(first, |b, &i| {
            if self.net_worth(i) > self.net_worth(b) {
                i
            } else {
                b
            }
        })
    }
}

#[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
fn ix(i: i64) -> usize {
    i as usize
}

/// Money as the board shows it: `$15,000`.
#[must_use]
pub fn money(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (k, ch) in digits.chars().enumerate() {
        if k > 0 && (digits.len() - k).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if n < 0 {
        format!("-${out}")
    } else {
        format!("${out}")
    }
}

/// Can `pos` be bought?
#[must_use]
pub fn is_buyable(pos: usize) -> bool {
    matches!(
        SPACES[pos].kind,
        Kind::Property { .. } | Kind::Station { .. } | Kind::Utility { .. }
    )
}

/// What `pos` costs.
#[must_use]
pub fn price_of(pos: usize) -> i64 {
    match SPACES[pos].kind {
        Kind::Property { price, .. } | Kind::Station { price } | Kind::Utility { price, .. } => price,
        _ => 0,
    }
}

/// The colour group of `pos`.
#[must_use]
pub fn group_of(pos: usize) -> Option<&'static str> {
    match SPACES.get(pos)?.kind {
        Kind::Property { group, .. } => Some(group),
        _ => None,
    }
}

/// The places of a colour group.
#[must_use]
pub fn group_members(g: &str) -> Vec<usize> {
    (0..40).filter(|&i| group_of(i) == Some(g)).collect()
}

fn house_cost(pos: usize) -> i64 {
    match SPACES[pos].kind {
        Kind::Property { house, .. } => house,
        _ => 0,
    }
}

/// What the bank lends on `pos`.
#[must_use]
pub fn mortgage_value(pos: usize) -> i64 {
    js_round(price_of(pos) as f64 / 2.0)
}

/// What paying off the mortgage on `pos` costs.
#[must_use]
pub fn unmortgage_cost(pos: usize) -> i64 {
    js_round(mortgage_value(pos) as f64 * 1.1)
}

#[allow(clippy::cast_possible_truncation)]
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

fn jail_free_index(deck: &str) -> i64 {
    let cards: &[board::Card] = if deck == "s" { &SURPRISE } else { &TREASURE };
    cards
        .iter()
        .position(|c| c.effect == Effect::JailFree)
        .map_or(-1, |i| i as i64)
}

fn shuffle(n: usize, meta: &mut Meta<'_>) -> Vec<i64> {
    let mut a: Vec<i64> = (0..n as i64).collect();
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

#[allow(clippy::cast_possible_truncation)]
fn roll_die(meta: &mut Meta<'_>) -> i64 {
    1 + ((meta.random)() * 6.0).floor() as i64
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
    let s = js_slice(s.trim(), 20);
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

/// A board position from an action (an integer 0–39).
fn pos_arg(a: &Value) -> Option<usize> {
    let f = a.get("pos")?.as_f64()?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    (f.fract() == 0.0 && (0.0..40.0).contains(&f)).then_some(f as usize)
}

// ---- paying ----------------------------------------------------------------------------------

fn charge(s: State, seat: i64, payees: Vec<Payee>, reason: &str) -> State {
    let total: i64 = payees.iter().map(|p| p.amount).sum();
    if total <= 0 {
        return s;
    }
    if s.p(seat).cash >= total {
        return settle(s, seat, &payees);
    }
    let after = if s.again { "roll" } else { "done" };
    let mut o = s;
    o.step = "debt".into();
    o.debt = Some(Debt {
        payees,
        reason: reason.to_owned(),
        after: after.into(),
    });
    o
}

fn settle(s0: State, seat: i64, payees: &[Payee]) -> State {
    let mut s = s0;
    for p in payees {
        s = s.add_cash(seat, -p.amount);
        if let Some(to) = p.to {
            s = s.add_cash(to, p.amount);
        } else if s.rules.jackpot {
            s.pot += p.amount;
        }
    }
    s
}

fn bankrupt(s0: &State, seat: i64, now: Value) -> State {
    let mut s = s0.clone();
    let payees = s.debt.as_ref().map(|d| d.payees.clone()).unwrap_or_default();
    let creditor = if payees.len() == 1 { payees[0].to } else { None };
    let mut buildings = 0;
    for i in 0..40 {
        if s.owner[i] != Some(seat) {
            continue;
        }
        buildings += s.houses[i] * house_cost(i) / 2;
        s.houses[i] = 0;
        if creditor.is_some() {
            s.owner[i] = creditor;
        } else {
            s.owner[i] = None;
            s.mortgaged[i] = false;
        }
    }
    let cash = s.p(seat).cash + buildings;
    let cards = s.p(seat).jail_cards.clone();
    if let Some(c) = creditor {
        s = s.add_cash(c, cash.max(0));
        s.players[ix(c)].jail_cards.extend(cards);
    } else {
        for c in &cards {
            let idx = jail_free_index(c);
            s.decks.get_mut(c).push(idx);
        }
    }
    {
        let p = &mut s.players[ix(seat)];
        p.bankrupt = true;
        p.cash = 0;
        p.jail_cards.clear();
    }
    let line = format!(
        "💸 {} went bankrupt{}.",
        s.p(seat).name,
        creditor.map_or(String::new(), |c| format!(" to {}", s.p(c).name))
    );
    s = s.log(line);
    if s.trade.as_ref().is_some_and(|t| t.from == seat || t.to == seat) {
        s.trade = None;
    }
    s.debt = None;
    let left = s.active();
    if left.len() <= 1 {
        s.phase = "over".into();
        s.winner = left.first().copied();
        s.step = "done".into();
        return s.bump();
    }
    if s.turn == seat {
        let next = s.next_active(seat);
        return start_turn(s, next, now);
    }
    s.bump()
}

// ---- moving and landing ----------------------------------------------------------------------

fn start_turn(s: State, seat: i64, now: Value) -> State {
    let first = s.active().first().copied();
    let round = if s.phase == "playing" && Some(seat) == first && s.log.len() > 1 {
        s.round + 1
    } else {
        s.round
    };
    if s.rules.rounds != 0 && round >= s.rules.rounds {
        let winner = s.richest();
        let line = format!(
            "🏆 {} rounds played: {} is the richest.",
            s.rules.rounds,
            s.p(winner).name
        );
        let mut o = s.log(line);
        o.phase = "over".into();
        o.winner = Some(winner);
        o.round = round;
        o.trade = None;
        o.step = "done".into();
        return o.bump();
    }
    let mut o = s;
    o.turn = seat;
    o.step = "roll".into();
    o.dice = None;
    o.doubles = 0;
    o.again = false;
    o.pending_buy = None;
    o.debt = None;
    o.turn_since = now;
    o.round = round;
    o.bump()
}

fn send_to_jail(s: State, seat: i64) -> State {
    let from = s.p(seat).pos;
    let seq = s.seq + 1;
    let mut o = s;
    o.players[ix(seat)].pos = JAIL as i64;
    o.players[ix(seat)].jail = 1;
    o.again = false;
    o.step = "done".into();
    o.mv = Some(Move {
        seat,
        from,
        to: JAIL as i64,
        jump: true,
        seq,
    });
    let line = format!("🚓 {} went to jail.", o.p(seat).name);
    o.log(line)
}

fn move_to(s: State, seat: i64, to: i64, jump: bool, forward: bool) -> State {
    let from = s.p(seat).pos;
    let seq = s.seq + 1;
    let mut o = s;
    o.players[ix(seat)].pos = to;
    o.mv = Some(Move {
        seat,
        from,
        to,
        jump,
        seq,
    });
    if forward && to < from {
        o = o.add_cash(seat, START_PAY);
        let line = format!("🏁 {} passed Start: +{}.", o.p(seat).name, money(START_PAY));
        o = o.log(line);
    }
    o
}

fn draw_card(s0: State, seat: i64, deck: &str, dice_total: i64, meta: &mut Meta<'_>) -> State {
    let mut s = s0;
    let cards: &[board::Card] = if deck == "s" { &SURPRISE } else { &TREASURE };
    let mut order = s.decks.get(deck).clone();
    if order.is_empty() {
        order = shuffle(cards.len(), meta);
    }
    let index = order[0];
    let rest = order[1..].to_vec();
    let c = cards[ix(index)];
    let keep = c.effect == Effect::JailFree;
    *s.decks.get_mut(deck) = if keep {
        rest
    } else {
        let mut r = rest;
        r.push(index);
        r
    };
    s.card = Some(CardShown {
        deck: deck.into(),
        index,
        seat,
        seq: s.seq + 1,
    });
    let line = format!(
        "{} {}: “{}”",
        if deck == "s" { "❓" } else { "🎁" },
        s.p(seat).name,
        c.text
    );
    s = s.log(line);
    match c.effect {
        Effect::Money(amount) => {
            if amount >= 0 {
                s.add_cash(seat, amount)
            } else {
                charge(
                    s,
                    seat,
                    vec![Payee {
                        to: None,
                        amount: -amount,
                    }],
                    "card",
                )
            }
        }
        Effect::Each(amount) => {
            let others: Vec<i64> = s.active().into_iter().filter(|&i| i != seat).collect();
            if amount < 0 {
                let payees = others
                    .iter()
                    .map(|&to| Payee {
                        to: Some(to),
                        amount: -amount,
                    })
                    .collect();
                return charge(s, seat, payees, "card");
            }
            for i in others {
                let pay = s.p(i).cash.min(amount);
                s = s.add_cash(i, -pay).add_cash(seat, pay);
            }
            s
        }
        Effect::MoveTo(to) => {
            let moved = move_to(s, seat, to as i64, true, true);
            land(moved, seat, dice_total, 1, meta)
        }
        Effect::Back(spaces) => {
            let to = (s.p(seat).pos - spaces as i64 + 40) % 40;
            let moved = move_to(s, seat, to, false, false);
            land(moved, seat, dice_total, 1, meta)
        }
        Effect::Nearest(station) => {
            let list: &[usize] = if station { &STATIONS } else { &UTILITIES };
            let pos = s.p(seat).pos;
            let to = list.iter().copied().find(|&i| i as i64 > pos).unwrap_or(list[0]);
            let moved = move_to(s, seat, to as i64, true, true);
            land(moved, seat, dice_total, if station { 2 } else { -1 }, meta)
        }
        Effect::Jail => send_to_jail(s, seat),
        Effect::JailFree => {
            s.players[ix(seat)].jail_cards.push(deck.into());
            s
        }
        Effect::Repairs(house, hotel) => {
            let mut cost = 0;
            for i in 0..40 {
                if s.owner[i] != Some(seat) {
                    continue;
                }
                cost += if s.houses[i] == 5 {
                    hotel
                } else {
                    s.houses[i] * house
                };
            }
            if cost != 0 {
                charge(
                    s,
                    seat,
                    vec![Payee {
                        to: None,
                        amount: cost,
                    }],
                    "repairs",
                )
            } else {
                s
            }
        }
    }
}

fn land(s0: State, seat: i64, dice_total: i64, rent_factor: i64, meta: &mut Meta<'_>) -> State {
    let mut s = s0;
    let pos = ix(s.p(seat).pos);
    let sp = SPACES[pos];
    let name = s.p(seat).name.clone();
    if is_buyable(pos) {
        let Some(owner) = s.owner[pos] else {
            s.step = "buy".into();
            s.pending_buy = Some(pos as i64);
            return s;
        };
        if owner == seat || s.mortgaged[pos] || s.p(owner).bankrupt {
            return s;
        }
        let mut rent = s.rent_of(pos, dice_total);
        if rent_factor == 2 {
            rent *= 2;
        }
        if rent_factor == -1 {
            rent = dice_total * 100;
        }
        let line = format!(
            "🏠 {name} owes {} {} rent for {}.",
            s.p(owner).name,
            money(rent),
            sp.name
        );
        s = s.log(line);
        return charge(
            s,
            seat,
            vec![Payee {
                to: Some(owner),
                amount: rent,
            }],
            &format!("rent for {}", sp.name),
        );
    }
    match sp.kind {
        Kind::Tax { amount } => {
            let line = format!("🧾 {name} pays {}: {}.", sp.name, money(amount));
            s = s.log(line);
            charge(s, seat, vec![Payee { to: None, amount }], sp.name)
        }
        Kind::Surprise => draw_card(s, seat, "s", dice_total, meta),
        Kind::Treasure => draw_card(s, seat, "t", dice_total, meta),
        Kind::GoToJail => send_to_jail(s, seat),
        Kind::Parking if s.rules.jackpot && s.pot > 0 => {
            let pot = s.pot;
            s.pot = 0;
            s = s.add_cash(seat, pot);
            s.log(format!("☕ {name} won the Coffee Break pot: {}!", money(pot)))
        }
        _ => s,
    }
}

fn after_landing(s: State) -> State {
    if s.step == "buy" || s.step == "debt" || s.phase != "playing" {
        return s.bump();
    }
    let again = s.again && s.p(s.turn).jail == 0;
    let mut o = s;
    o.step = if again { "roll" } else { "done" }.into();
    o.bump()
}

fn roll(s0: &State, seat: i64, meta: &mut Meta<'_>) -> State {
    let a = roll_die(meta);
    let b = roll_die(meta);
    let total = a + b;
    let doubles = a == b;
    let p = s0.p(seat).clone();
    let mut s = s0.clone();
    s.dice = Some([a, b]);
    s.card = None;
    if p.jail != 0 {
        if doubles {
            s.players[ix(seat)].jail = 0;
            s = s.log(format!("🎲 {} rolled doubles and walks out of jail.", p.name));
            s.again = false;
        } else if p.jail >= 3 {
            s.players[ix(seat)].jail = 0;
            s = s.log(format!("🎲 {} pays {} to leave jail.", p.name, money(JAIL_FINE)));
            s.again = false;
            s = charge(
                s,
                seat,
                vec![Payee {
                    to: None,
                    amount: JAIL_FINE,
                }],
                "jail fine",
            );
            if s.step == "debt" {
                return s.bump();
            }
        } else {
            s.players[ix(seat)].jail = p.jail + 1;
            s = s.log(format!("🎲 {} rolled {a} + {b}: still in jail.", p.name));
            s.step = "done".into();
            s.again = false;
            return s.bump();
        }
    } else if doubles {
        let count = s.doubles + 1;
        if count >= 3 {
            s.doubles = count;
            return send_to_jail(s, seat).bump();
        }
        s.doubles = count;
        s.again = true;
    } else {
        s.again = false;
    }
    s = s.log(format!(
        "🎲 {} rolled {a} + {b} = {total}{}.",
        p.name,
        if doubles && p.jail == 0 { " (doubles!)" } else { "" }
    ));
    let to = (s.p(seat).pos + total) % 40;
    s = move_to(s, seat, to, false, true);
    if to == GO_TO_JAIL as i64 {
        return send_to_jail(s, seat).bump();
    }
    after_landing(land(s, seat, total, 1, meta))
}

// ---- trades ----------------------------------------------------------------------------------

fn trade_valid(s: &State, t: &Trade) -> bool {
    let (Some(from), Some(to)) = (s.player(t.from), s.player(t.to)) else {
        return false;
    };
    if from.bankrupt || to.bankrupt || t.from == t.to {
        return false;
    }
    if t.give_cash < 0 || t.get_cash < 0 || t.give_cash > from.cash || t.get_cash > to.cash {
        return false;
    }
    if t.give_props.is_empty() && t.get_props.is_empty() && t.give_cash == 0 && t.get_cash == 0 {
        return false;
    }
    let ok = |list: &[i64], seat: i64| {
        list.iter().all(|&i| {
            usize::try_from(i)
                .ok()
                .filter(|&p| p < 40)
                .is_some_and(|p| is_buyable(p) && s.owner[p] == Some(seat) && !s.group_has_houses(p))
        }) && list.iter().collect::<BTreeSet<_>>().len() == list.len()
    };
    ok(&t.give_props, t.from) && ok(&t.get_props, t.to)
}

fn do_trade(s0: &State, t: &Trade) -> State {
    let mut s = s0.clone();
    for &i in &t.give_props {
        s.owner[ix(i)] = Some(t.to);
    }
    for &i in &t.get_props {
        s.owner[ix(i)] = Some(t.from);
    }
    s = s
        .add_cash(t.from, t.get_cash - t.give_cash)
        .add_cash(t.to, t.give_cash - t.get_cash);
    let line = format!("🤝 {} and {} made a deal.", s.p(t.from).name, s.p(t.to).name);
    s.log(line)
}

/// How a computer values a trade offered to it (positive: good for it).
#[must_use]
#[allow(clippy::cast_precision_loss)]
pub fn bot_trade_score(s: &State, t: &Trade) -> f64 {
    let seat = t.to;
    let mut score = (t.give_cash - t.get_cash) as f64;
    let value = |i: usize| price_of(i) as f64 * if s.mortgaged[i] { 0.5 } else { 1.0 };
    for &i in &t.give_props {
        score += value(ix(i)) * 1.1;
    }
    for &i in &t.get_props {
        let i = ix(i);
        score -= value(i) * 1.3;
        if s.owns_group(seat, i) {
            score -= 100_000.0;
        }
        if let Some(g) = group_of(i)
            && group_members(g)
                .iter()
                .all(|&m| m == i || s.owner[m] == Some(t.from))
        {
            score -= price_of(i) as f64 * 1.5;
        }
    }
    score
}

// ---- the computer ----------------------------------------------------------------------------

fn bot_raise(s: &State, seat: i64, meta: &mut Meta<'_>) -> Option<State> {
    let mine: Vec<usize> = (0..40).filter(|&i| s.owner[i] == Some(seat)).collect();
    let mut built: Vec<usize> = mine.iter().copied().filter(|&i| s.houses[i] > 0).collect();
    built.sort_by_key(|&i| std::cmp::Reverse(s.houses[i]));
    for i in built {
        if let Some(n) = core(s, "sell", Some(i), seat, meta) {
            return Some(n);
        }
    }
    let mut plain: Vec<usize> = mine
        .iter()
        .copied()
        .filter(|&i| !s.mortgaged[i] && !s.group_has_houses(i))
        .collect();
    plain.sort_by_key(|&i| price_of(i));
    for i in plain {
        if let Some(n) = core(s, "mortgage", Some(i), seat, meta) {
            return Some(n);
        }
    }
    None
}

fn bot_build(s0: &State, seat: i64, meta: &mut Meta<'_>) -> State {
    let mut s = s0.clone();
    for _ in 0..20 {
        let mut options: Vec<usize> = (0..40)
            .filter(|&i| {
                s.owner[i] == Some(seat)
                    && matches!(SPACES[i].kind, Kind::Property { .. })
                    && s.owns_group(seat, i)
            })
            .collect();
        options.sort_by(|&a, &b| s.houses[a].cmp(&s.houses[b]).then(price_of(b).cmp(&price_of(a))));
        let mut picked = None;
        for i in options {
            if s.p(seat).cash - house_cost(i) >= RESERVE
                && let Some(n) = core(&s, "build", Some(i), seat, meta)
            {
                picked = Some(n);
                break;
            }
        }
        let Some(n) = picked else { break };
        s = n;
    }
    for i in 0..40 {
        if s.owner[i] == Some(seat)
            && s.mortgaged[i]
            && s.p(seat).cash - unmortgage_cost(i) >= RESERVE * 2
            && let Some(n) = core(&s, "unmortgage", Some(i), seat, meta)
        {
            s = n;
        }
    }
    s
}

fn bot_turn(s: &State, meta: &mut Meta<'_>) -> State {
    let seat = s.turn;
    let is_bot = s.p(seat).is_bot();
    match s.step.as_str() {
        "debt" => {
            let mut next = s.clone();
            for _ in 0..80 {
                let total: i64 = next
                    .debt
                    .as_ref()
                    .map_or(0, |d| d.payees.iter().map(|x| x.amount).sum());
                if next.p(seat).cash >= total {
                    return core(&next, "pay-debt", None, seat, meta).unwrap_or(next);
                }
                let Some(raised) = bot_raise(&next, seat, meta) else {
                    break;
                };
                next = raised;
            }
            core(&next, "bankrupt", None, seat, meta).unwrap_or(next)
        }
        "buy" => {
            let pos = ix(s.pending_buy.unwrap_or(0));
            let price = price_of(pos);
            let completes = group_of(pos).is_some_and(|g| {
                group_members(g)
                    .iter()
                    .all(|&i| i == pos || s.owner[i] == Some(seat))
            });
            let cash = s.p(seat).cash;
            let buy = is_bot && (cash - price >= RESERVE || (completes && cash >= price));
            core(s, if buy { "buy" } else { "skip" }, None, seat, meta).unwrap_or_else(|| s.clone())
        }
        "roll" => {
            let mut next = if is_bot {
                bot_build(s, seat, meta)
            } else {
                s.clone()
            };
            if next.p(seat).jail != 0 {
                if !next.p(seat).jail_cards.is_empty() {
                    next = core(&next, "jail-card", None, seat, meta).unwrap_or(next);
                } else if next.p(seat).cash >= JAIL_FINE + RESERVE {
                    next = core(&next, "pay-jail", None, seat, meta).unwrap_or(next);
                }
            }
            core(&next, "roll", None, seat, meta).unwrap_or(next)
        }
        "done" => {
            let next = if is_bot {
                bot_build(s, seat, meta)
            } else {
                s.clone()
            };
            core(&next, "end-turn", None, seat, meta).unwrap_or(next)
        }
        _ => s.clone(),
    }
}

// ---- the reducer -----------------------------------------------------------------------------

/// Turn actions for `seat` (also the computer's); `None`: not allowed.
#[allow(clippy::too_many_lines)]
fn core(s: &State, kind: &str, pos: Option<usize>, seat: i64, meta: &mut Meta<'_>) -> Option<State> {
    if s.phase != "playing" || seat < 0 || s.player(seat).is_none_or(|p| p.bankrupt) {
        return None;
    }
    let my_turn = seat == s.turn;
    let p = s.p(seat).clone();
    let now = meta.now();
    match kind {
        "roll" => (my_turn && s.step == "roll").then(|| roll(s, seat, meta)),
        "pay-jail" => {
            if !my_turn || s.step != "roll" || p.jail == 0 || p.cash < JAIL_FINE {
                return None;
            }
            let mut o = s.clone();
            o.players[ix(seat)].jail = 0;
            o = settle(
                o,
                seat,
                &[Payee {
                    to: None,
                    amount: JAIL_FINE,
                }],
            );
            Some(
                o.log(format!("🔓 {} paid {} to leave jail.", p.name, money(JAIL_FINE)))
                    .bump(),
            )
        }
        "jail-card" => {
            if !my_turn || s.step != "roll" || p.jail == 0 || p.jail_cards.is_empty() {
                return None;
            }
            let card = p.jail_cards[0].clone();
            let mut o = s.clone();
            o.players[ix(seat)].jail = 0;
            o.players[ix(seat)].jail_cards = p.jail_cards[1..].to_vec();
            o.decks.get_mut(&card).push(jail_free_index(&card));
            Some(
                o.log(format!("🔓 {} used a get-out-of-jail card.", p.name))
                    .bump(),
            )
        }
        "buy" => {
            let pos = s.pending_buy?;
            if !my_turn || s.step != "buy" || p.cash < price_of(ix(pos)) {
                return None;
            }
            let mut o = s.clone();
            o.owner[ix(pos)] = Some(seat);
            o.pending_buy = None;
            o = o.add_cash(seat, -price_of(ix(pos)));
            o = o.log(format!(
                "🔑 {} bought {} for {}.",
                p.name,
                SPACES[ix(pos)].name,
                money(price_of(ix(pos)))
            ));
            o.step = if s.again && p.jail == 0 { "roll" } else { "done" }.into();
            Some(o.bump())
        }
        "skip" => {
            if !my_turn || s.step != "buy" {
                return None;
            }
            let mut o = s.clone();
            o.pending_buy = None;
            o.step = if s.again && p.jail == 0 { "roll" } else { "done" }.into();
            Some(o.bump())
        }
        "build" => {
            let pos = pos?;
            if !my_turn || s.build_block(seat, pos as i64).is_some() {
                return None;
            }
            let mut o = s.clone();
            o.houses[pos] += 1;
            let what = if o.houses[pos] == 5 { "a hotel" } else { "a house" };
            o = o.add_cash(seat, -house_cost(pos));
            Some(
                o.log(format!("🏗️ {} built {what} on {}.", p.name, SPACES[pos].name))
                    .bump(),
            )
        }
        "sell" => {
            let pos = pos?;
            if !my_turn || s.owner[pos] != Some(seat) || s.houses[pos] <= 0 {
                return None;
            }
            let most = group_of(pos).map_or(0, |g| {
                group_members(g).iter().map(|&i| s.houses[i]).max().unwrap_or(0)
            });
            if s.houses[pos] < most {
                return None;
            }
            let mut o = s.clone();
            o.houses[pos] -= 1;
            Some(o.add_cash(seat, house_cost(pos) / 2).bump())
        }
        "mortgage" => {
            let pos = pos?;
            if !my_turn || s.owner[pos] != Some(seat) || s.mortgaged[pos] || s.group_has_houses(pos) {
                return None;
            }
            let mut o = s.clone();
            o.mortgaged[pos] = true;
            o = o.add_cash(seat, mortgage_value(pos));
            Some(
                o.log(format!("🏦 {} mortgaged {}.", p.name, SPACES[pos].name))
                    .bump(),
            )
        }
        "unmortgage" => {
            let pos = pos?;
            if !my_turn
                || s.step == "debt"
                || s.owner[pos] != Some(seat)
                || !s.mortgaged[pos]
                || p.cash < unmortgage_cost(pos)
            {
                return None;
            }
            let mut o = s.clone();
            o.mortgaged[pos] = false;
            Some(o.add_cash(seat, -unmortgage_cost(pos)).bump())
        }
        "pay-debt" => {
            let debt = s.debt.as_ref()?;
            if !my_turn || s.step != "debt" {
                return None;
            }
            let total: i64 = debt.payees.iter().map(|x| x.amount).sum();
            if p.cash < total {
                return None;
            }
            let mut o = settle(s.clone(), seat, &debt.payees);
            o.debt = None;
            o.step = if debt.after == "roll" && p.jail == 0 {
                "roll"
            } else {
                "done"
            }
            .into();
            Some(o.bump())
        }
        "bankrupt" => (my_turn && s.step == "debt").then(|| bankrupt(s, seat, now)),
        "end-turn" => {
            if !my_turn || s.step != "done" {
                return None;
            }
            let next = s.next_active(seat);
            Some(start_turn(s.clone(), next, now))
        }
        _ => None,
    }
}

/// The Tycoon rules.
pub struct Tycoon;

impl Tycoon {
    #[allow(clippy::too_many_lines)]
    fn step(s: &State, a: &Value, meta: &mut Meta<'_>) -> Option<State> {
        let by = meta.by.to_owned();
        let present = |id: &str| meta.present.iter().any(|p| p == id);
        let kind = a.get("kind").and_then(Value::as_str).unwrap_or("");
        match kind {
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
                let taken: Vec<&str> = s.players.iter().map(|p| p.token.as_str()).collect();
                let want = a
                    .get("token")
                    .and_then(Value::as_str)
                    .filter(|t| TOKENS.contains(t) && !taken.contains(t));
                let token = want.or_else(|| TOKENS.iter().copied().find(|t| !taken.contains(t)))?;
                let used: Vec<&str> = s.players.iter().map(|p| p.color.as_str()).collect();
                let color = PLAYER_COLORS.iter().copied().find(|c| !used.contains(c))?;
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
                    color: color.into(),
                    token: token.into(),
                    cash: START_CASH,
                    pos: 0,
                    jail: 0,
                    jail_cards: Vec::new(),
                    bankrupt: false,
                });
                Some(o.bump())
            }
            "leave" => {
                let seat = s.seat_of(&by);
                if s.phase != "lobby" || seat < 0 {
                    return None;
                }
                let mut o = s.clone();
                o.players.remove(ix(seat));
                Some(o.bump())
            }
            "add-bot" => {
                if s.phase != "lobby" || !can_manage(meta) || s.players.len() >= MAX_PLAYERS {
                    return None;
                }
                let taken: Vec<&str> = s.players.iter().map(|p| p.token.as_str()).collect();
                let used: Vec<&str> = s.players.iter().map(|p| p.color.as_str()).collect();
                let n = s.players.iter().filter(|p| p.is_bot()).count() + 1;
                let mut o = s.clone();
                o.players.push(Player {
                    id: format!("bot-{}", s.seq),
                    name: format!("Computer {n}"),
                    cid: None,
                    bot: Some(true),
                    color: PLAYER_COLORS.iter().copied().find(|c| !used.contains(c))?.into(),
                    token: TOKENS.iter().copied().find(|t| !taken.contains(t))?.into(),
                    cash: START_CASH,
                    pos: 0,
                    jail: 0,
                    jail_cards: Vec::new(),
                    bankrupt: false,
                });
                Some(o.bump())
            }
            "remove" => {
                if s.phase != "lobby" || !can_manage(meta) {
                    return None;
                }
                let f = a.get("seat")?.as_f64()?;
                if f.fract() != 0.0 || f < 0.0 || f >= s.players.len() as f64 {
                    return None;
                }
                let mut o = s.clone();
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                o.players.remove(f as usize);
                Some(o.bump())
            }
            "token" => {
                let seat = s.seat_of(&by);
                let t = a.get("token").and_then(Value::as_str)?;
                if s.phase != "lobby"
                    || seat < 0
                    || !TOKENS.contains(&t)
                    || s.players
                        .iter()
                        .enumerate()
                        .any(|(i, p)| i as i64 != seat && p.token == t)
                {
                    return None;
                }
                let mut o = s.clone();
                o.players[ix(seat)].token = t.into();
                Some(o.bump())
            }
            "rules" => {
                if s.phase != "lobby" || !can_manage(meta) {
                    return None;
                }
                let mut o = s.clone();
                let r = a.get("rules");
                if let Some(j) = r.and_then(|r| r.get("jackpot")).and_then(Value::as_bool) {
                    o.rules.jackpot = j;
                }
                let rounds = r.and_then(|r| r.get("rounds")).map_or(f64::NAN, js_number);
                #[allow(clippy::cast_precision_loss)]
                if let Some(&n) = ROUND_OPTIONS.iter().find(|&&n| n as f64 == rounds) {
                    o.rules.rounds = n;
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
                let players: Vec<Player> = s
                    .players
                    .iter()
                    .map(|p| Player {
                        cash: START_CASH,
                        pos: 0,
                        jail: 0,
                        jail_cards: Vec::new(),
                        bankrupt: false,
                        ..p.clone()
                    })
                    .collect();
                #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
                let first = ((meta.random)() * players.len() as f64).floor() as i64;
                let ds = shuffle(SURPRISE.len(), meta);
                let dt = shuffle(TREASURE.len(), meta);
                let mut fresh = State::initial();
                fresh.rules = s.rules.clone();
                fresh.log = vec![format!("🎉 Game on! {} goes first.", players[ix(first)].name)];
                fresh.players = players;
                fresh.phase = "playing".into();
                fresh.decks = Decks { s: ds, t: dt };
                fresh.seq = s.seq;
                Some(start_turn(fresh, first, meta.now()))
            }
            "again" => {
                if s.phase != "over" || (!can_manage(meta) && s.seat_of(&by) < 0) {
                    return None;
                }
                let mut o = State::initial();
                o.players = s.players.clone();
                o.rules = s.rules.clone();
                o.seq = s.seq;
                Some(o.bump())
            }
            "end-game" => {
                if s.phase != "playing" || !can_manage(meta) {
                    return None;
                }
                let winner = s.richest();
                let line = format!("🏆 Game ended: {} is the richest.", s.p(winner).name);
                let mut o = s.clone().log(line);
                o.phase = "over".into();
                o.winner = Some(winner);
                o.trade = None;
                Some(o.bump())
            }
            "trade" => {
                let from = s.seat_of(&by);
                if s.phase != "playing" || from < 0 || s.trade.is_some() {
                    return None;
                }
                let props = |k: &str| -> Option<Vec<f64>> {
                    match a.get(k) {
                        Some(v) if js_truthy(v) => Some(v.as_array()?.iter().map(js_number).collect()),
                        _ => Some(Vec::new()),
                    }
                };
                let cash = |k: &str| -> f64 {
                    let n = a.get(k).map_or(f64::NAN, js_number);
                    let n = if n.is_nan() || n == 0.0 { 0.0 } else { n };
                    n.floor()
                };
                let to = a.get("to").map_or(f64::NAN, js_number);
                let give_props = props("giveProps")?;
                let get_props = props("getProps")?;
                let (give_cash, get_cash) = (cash("giveCash"), cash("getCash"));
                let int = |f: f64| {
                    (f.fract() == 0.0 && f.abs() < 1e15).then(|| {
                        #[allow(clippy::cast_possible_truncation)]
                        let i = f as i64;
                        i
                    })
                };
                // anything not a whole number can't be a seat, a place or a sum anyone has
                let (Some(to), Some(give_cash), Some(get_cash)) = (int(to), int(give_cash), int(get_cash))
                else {
                    return None;
                };
                let give_props: Option<Vec<i64>> = give_props.into_iter().map(int).collect();
                let get_props: Option<Vec<i64>> = get_props.into_iter().map(int).collect();
                let t = Trade {
                    id: s.seq,
                    from,
                    to,
                    give_cash,
                    give_props: give_props?,
                    get_cash,
                    get_props: get_props?,
                };
                if !trade_valid(s, &t) {
                    return None;
                }
                let line = format!("🤝 {} offered {} a deal.", s.p(from).name, s.p(t.to).name);
                let mut o = s.clone().log(line);
                o.trade = Some(t);
                Some(o.bump())
            }
            "trade-answer" => {
                let seat = s.seat_of(&by);
                let t = s.trade.as_ref()?;
                if seat != t.to {
                    return None;
                }
                let mut o = if !a.get("accept").is_some_and(js_truthy) {
                    s.clone()
                        .log(format!("🙅 {} said no to the deal.", s.p(seat).name))
                } else if !trade_valid(s, t) {
                    s.clone()
                        .log("🙅 That deal can't happen any more: the cash or places in it changed.".into())
                } else {
                    do_trade(s, t)
                };
                o.trade = None;
                Some(o.bump())
            }
            "trade-cancel" => {
                let seat = s.seat_of(&by);
                if s.trade.as_ref()?.from != seat {
                    return None;
                }
                let mut o = s.clone();
                o.trade = None;
                Some(o.bump())
            }
            "auto" => {
                #[allow(clippy::cast_precision_loss)]
                let seq_ok = a.get("seq").and_then(Value::as_f64) == Some(s.seq as f64);
                if s.phase != "playing" || by != meta.self_id || !seq_ok {
                    return None;
                }
                if a.get("mode").and_then(Value::as_str) == Some("trade") {
                    let t = s.trade.as_ref()?;
                    if !s.player(t.to).is_some_and(Player::is_bot) {
                        return None;
                    }
                    let yes = bot_trade_score(s, t) > 0.0 && trade_valid(s, t);
                    let mut o = if yes {
                        do_trade(s, t)
                    } else {
                        s.clone()
                            .log(format!("🙅 {} said no to the deal.", s.p(t.to).name))
                    };
                    o.trade = None;
                    return Some(o.bump());
                }
                let next = bot_turn(s, meta);
                (next != *s).then_some(next)
            }
            _ => {
                let seat = s.seat_of(&by);
                core(s, kind, pos_arg(a), seat, meta)
            }
        }
    }
}

impl Reducer for Tycoon {
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

    /// Join the table.
    #[must_use]
    pub fn join(name: &str) -> Value {
        json!({ "kind": "join", "name": name })
    }
    /// A plain action (`leave`, `add-bot`, `start`, `roll`, `pay-jail`, `jail-card`, `buy`, `skip`,
    /// `pay-debt`, `bankrupt`, `end-turn`, `trade-cancel`, `end-game`, `again`).
    #[must_use]
    pub fn plain(kind: &str) -> Value {
        json!({ "kind": kind })
    }
    /// Remove a seat.
    #[must_use]
    pub fn remove(seat: i64) -> Value {
        json!({ "kind": "remove", "seat": seat })
    }
    /// Pick a token.
    #[must_use]
    pub fn token(token: &str) -> Value {
        json!({ "kind": "token", "token": token })
    }
    /// The jackpot rule.
    #[must_use]
    pub fn jackpot(on: bool) -> Value {
        json!({ "kind": "rules", "rules": { "jackpot": on } })
    }
    /// The game's length.
    #[must_use]
    pub fn rounds(n: i64) -> Value {
        json!({ "kind": "rules", "rules": { "rounds": n } })
    }
    /// Something done to a place (`build`, `sell`, `mortgage`, `unmortgage`).
    #[must_use]
    pub fn at(kind: &str, pos: usize) -> Value {
        json!({ "kind": kind, "pos": pos })
    }
    /// Offer a deal.
    #[must_use]
    pub fn trade(to: i64, give_cash: i64, give_props: &[i64], get_cash: i64, get_props: &[i64]) -> Value {
        json!({ "kind": "trade", "to": to, "giveCash": give_cash, "giveProps": give_props, "getCash": get_cash, "getProps": get_props })
    }
    /// Answer a deal.
    #[must_use]
    pub fn answer(accept: bool) -> Value {
        json!({ "kind": "trade-answer", "accept": accept })
    }
    /// The deciding app plays (`mode`: `turn` or `trade`).
    #[must_use]
    pub fn auto(seq: i64, mode: &str) -> Value {
        json!({ "kind": "auto", "seq": seq, "mode": mode })
    }
}

/// What this app does on its own now (see [`crate::driver`]): ask our seat back, and on the
/// deciding app play for computers, people away and idle players, and answer deals offered to
/// computers.
#[must_use]
pub fn wants(s: &State, seen: &crate::driver::Seen<'_>) -> Vec<crate::driver::Want> {
    use crate::driver::Want;
    let mut out = Vec::new();
    let here = |id: &str| id == seen.me || seen.present.iter().any(|p| p == id);
    let away = |i: usize| s.players.get(i).is_some_and(|p| !p.is_bot() && !here(&p.id));
    if s.seat_of(seen.me) < 0
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
        out.push(Want {
            key: format!("reclaim2:{old}:{id}"),
            delay_ms: 3000,
            action: act::join(seen.name),
        });
    }
    if !seen.deciding || s.phase != "playing" {
        return out;
    }
    let Some(current) = s.player(s.turn) else {
        return out;
    };
    if s.trade
        .as_ref()
        .is_some_and(|t| s.player(t.to).is_some_and(Player::is_bot))
    {
        out.push(Want {
            key: format!("trade:{}", s.seq),
            delay_ms: 2200,
            action: act::auto(s.seq, "trade"),
        });
    } else {
        // a computer waits while its token walks
        let walking = s.mv.as_ref().is_some_and(|m| m.seq == s.seq && !m.jump);
        let delay = if current.is_bot() {
            1000 + if walking { 900 } else { 0 }
        } else if away(ix(s.turn)) {
            5000
        } else {
            60_000
        };
        out.push(Want {
            key: format!("turn:{}:{delay}", s.seq),
            delay_ms: delay,
            action: act::auto(s.seq, "turn"),
        });
    }
    out
}
