//! Ludo on screen (`ludo/index.tsx`, `board.ts`): the board (drawn as one SVG picture, rebuilt
//! when the game changes; tokens you can move are buttons over it), the dice, the seats, the
//! house rules, and on the deciding app the computer's turns, turns of people who left, and idle
//! turns.

use std::cell::Cell;
use std::fmt::Write as _;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, Bounds, Context, FontWeight, Pixels, canvas, div, px};
use rtc_core::ActivityCommand;
use rtc_engine::Snapshot;
use rtc_games::ludo::{self, COLORS, HOME, LAST_TRACK, State, act};
use rtc_ui::button::{Button, Variant};
use rtc_ui::tokens;
use serde_json::Value;

use crate::view::RoomView;

const KEY: &str = "act:ludo";
const BOT_DELAY: Duration = Duration::from_millis(900);
const AWAY_DELAY: Duration = Duration::from_millis(4000);
const IDLE_DELAY: Duration = Duration::from_millis(30_000);

const RULES: [(&str, &str, &str); 5] = [
    (
        "sixToLeave",
        "Six needed to leave base",
        "Off: a 1 or a 6 brings a token out",
    ),
    ("threeSixes", "Three sixes in a row lose the turn", ""),
    (
        "safeStars",
        "Star squares are safe",
        "Start squares are always safe",
    ),
    ("captureBonus", "Extra turn for a capture", ""),
    ("homeBonus", "Extra turn for reaching home", ""),
];

/// This device's view of the game.
#[derive(Default)]
pub(crate) struct LudoUi {
    /// The turn played for someone, asked at (seq, mode, delay ms).
    auto_sent: Option<(i64, bool, u64)>,
    /// The seat asked back.
    reclaim_sent: Option<String>,
    /// The board picture and the state it shows.
    /// The board picture (freed as each move replaces it).
    picture: crate::picture::LivePicture,
    /// Where the game area is.
    pub(crate) area: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl std::fmt::Debug for LudoUi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LudoUi").finish_non_exhaustive()
    }
}

fn hex(color: &str) -> &'static str {
    match color {
        "green" => "#2e9e48",
        "yellow" => "#f2b705",
        "blue" => "#1e7fe0",
        _ => "#e53935",
    }
}

fn color_token(color: &str) -> gpui_kit::Hsla {
    tokens::hex(match color {
        "green" => 0x2e_9e48,
        "yellow" => 0xf2_b705,
        "blue" => 0x1e_7fe0,
        _ => 0xe5_3935,
    })
}

// ---- board geometry (`board.ts`) ----------------------------------------------------------

type Pt = (f64, f64);

fn run(x0: f64, y0: f64, dx: f64, dy: f64, n: usize) -> Vec<Pt> {
    (0..n).map(|i| (x0 + dx * i as f64, y0 + dy * i as f64)).collect()
}

fn track() -> Vec<Pt> {
    let mut t = Vec::with_capacity(52);
    t.extend(run(1., 6., 1., 0., 5));
    t.extend(run(6., 5., 0., -1., 6));
    t.push((7., 0.));
    t.extend(run(8., 0., 0., 1., 6));
    t.extend(run(9., 6., 1., 0., 6));
    t.push((14., 7.));
    t.extend(run(14., 8., -1., 0., 6));
    t.extend(run(8., 9., 0., 1., 6));
    t.push((7., 14.));
    t.extend(run(6., 14., 0., -1., 6));
    t.extend(run(5., 8., -1., 0., 6));
    t.push((0., 7.));
    t.push((0., 6.));
    t
}

fn home_column(color: &str) -> Vec<Pt> {
    match color {
        "green" => run(7., 1., 0., 1., 5),
        "yellow" => run(13., 7., -1., 0., 5),
        "blue" => run(7., 13., 0., -1., 5),
        _ => run(1., 7., 1., 0., 5),
    }
}

fn base_origin(color: &str) -> Pt {
    match color {
        "green" => (9., 0.),
        "yellow" => (9., 9.),
        "blue" => (0., 9.),
        _ => (0., 0.),
    }
}

const BASE_SLOTS: [Pt; 4] = [(1.9, 1.9), (4.1, 1.9), (1.9, 4.1), (4.1, 4.1)];

fn center(p: Pt) -> Pt {
    (p.0 + 0.5, p.1 + 0.5)
}

/// A token's centre (grid units).
fn token_point(t: &[Pt], color: &str, index: usize, progress: i64) -> Pt {
    if progress == -1 {
        let (bx, by) = base_origin(color);
        let (sx, sy) = BASE_SLOTS[index % 4];
        return (bx + sx, by + sy);
    }
    if progress <= LAST_TRACK {
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let i = ((ludo::start_of(color) + progress) % 52) as usize;
        return center(t[i]);
    }
    if progress < HOME {
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let i = (progress - LAST_TRACK - 1) as usize;
        return center(home_column(color)[i]);
    }
    let spot = match color {
        "green" => (7.5, 6.55),
        "yellow" => (8.45, 7.5),
        "blue" => (7.5, 8.45),
        _ => (6.55, 7.5),
    };
    let off = [(-0.2, -0.2), (0.2, -0.2), (-0.2, 0.2), (0.2, 0.2)][index % 4];
    (spot.0 + off.0, spot.1 + off.1)
}

/// Tokens sharing a square: the square's key and (color, index, progress, point).
type Group = (String, Vec<(String, usize, i64, Pt)>);

/// Every token's place, spread out when they share a square: (color, index, x, y, r).
fn place(state: &State, movable: &[(String, i64)]) -> Vec<(String, usize, f64, f64, f64)> {
    let t = track();
    let mut groups: Vec<Group> = Vec::new();
    for color in COLORS {
        let Some(list) = state.tokens.as_ref().and_then(|m| m.get(color)) else {
            continue;
        };
        for (i, &p) in list.iter().enumerate() {
            let pt = token_point(&t, color, i, p);
            let key = if p >= HOME || p == -1 {
                format!("{color}{i}{p}")
            } else {
                format!("{},{}", pt.0, pt.1)
            };
            match groups.iter_mut().find(|g| g.0 == key) {
                Some(g) => g.1.push((color.to_owned(), i, p, pt)),
                None => groups.push((key, vec![(color.to_owned(), i, p, pt)])),
            }
        }
    }
    let slots = |n: usize| -> Vec<Pt> {
        match n {
            1 => vec![(0., 0.)],
            2 => vec![(-0.25, 0.), (0.25, 0.)],
            3 => vec![(-0.23, -0.2), (0.23, -0.2), (0., 0.22)],
            _ => vec![(-0.23, -0.23), (0.23, -0.23), (-0.23, 0.23), (0.23, 0.23)],
        }
    };
    let radius = |n: usize| match n {
        1 => 0.36,
        2 => 0.21,
        _ => 0.19,
    };
    let mut out = Vec::new();
    for (_, g) in groups {
        let n = g.len().min(4);
        for (k, (c, i, p, pt)) in g.into_iter().enumerate() {
            let (dx, dy) = slots(n)[k % 4];
            out.push((
                c,
                i,
                pt.0 + dx,
                pt.1 + dy,
                if p >= HOME { 0.17 } else { radius(n) },
            ));
        }
    }
    // movable tokens last (on top)
    out.sort_by_key(|(c, i, ..)| movable.iter().any(|(mc, mi)| mc == c && *mi as usize == *i));
    out
}

/// The board as SVG (`Board` in `index.tsx`).
fn board_svg(state: &State, movable: &[(String, i64)]) -> String {
    let mut s = String::from(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 15" width="900" height="900"><rect x="0" y="0" width="15" height="15" fill="#f6f1e7"/>"##,
    );
    for x in 0..15 {
        for y in 0..15 {
            let on_cross = ((6..=8).contains(&x)) != ((6..=8).contains(&y))
                && ((6..=8).contains(&x) || (6..=8).contains(&y));
            if on_cross {
                let _ = write!(
                    s,
                    r##"<rect x="{x}" y="{y}" width="1" height="1" fill="#fffdf8" stroke="#c9c1b1" stroke-width="0.03"/>"##
                );
            }
        }
    }
    let t = track();
    for color in COLORS {
        for (x, y) in home_column(color) {
            let _ = write!(
                s,
                r##"<rect x="{x}" y="{y}" width="1" height="1" fill="{}" stroke="#c9c1b1" stroke-width="0.03"/>"##,
                hex(color)
            );
        }
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let (x, y) = t[ludo::start_of(color) as usize];
        let _ = write!(
            s,
            r##"<rect x="{x}" y="{y}" width="1" height="1" fill="{}" stroke="#c9c1b1" stroke-width="0.03"/>"##,
            hex(color)
        );
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let (x, y) = t[((ludo::start_of(color) + 8) % 52) as usize];
        let _ = write!(
            s,
            r##"<text x="{}" y="{}" font-size="0.62" fill="#9a907e" text-anchor="middle">★</text>"##,
            x + 0.5,
            y + 0.72
        );
    }
    for color in COLORS {
        let (bx, by) = base_origin(color);
        let turn = state.turn.as_deref() == Some(color);
        let _ = write!(
            s,
            r##"<rect x="{bx}" y="{by}" width="6" height="6" fill="{}" stroke="rgba(0,0,0,0.12)" stroke-width="0.04"{}/>"##,
            hex(color),
            if turn {
                r#" style="filter:brightness(1.12)""#
            } else {
                ""
            }
        );
        let _ = write!(
            s,
            r##"<rect x="{}" y="{}" width="4.4" height="4.4" rx="0.5" fill="#fffdf8"/>"##,
            bx + 0.8,
            by + 0.8
        );
        for (sx, sy) in BASE_SLOTS {
            let _ = write!(
                s,
                r##"<circle cx="{}" cy="{}" r="0.5" fill="{}" opacity="0.28"/>"##,
                bx + sx,
                by + sy,
                hex(color)
            );
        }
    }
    for (pts, color) in [
        ("6,6 7.5,7.5 6,9", "red"),
        ("6,6 9,6 7.5,7.5", "green"),
        ("9,6 9,9 7.5,7.5", "yellow"),
        ("6,9 9,9 7.5,7.5", "blue"),
    ] {
        let _ = write!(
            s,
            r##"<polygon points="{pts}" fill="{}" stroke="rgba(0,0,0,0.1)" stroke-width="0.03"/>"##,
            hex(color)
        );
    }
    for color in COLORS {
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let (x, y) = center(t[ludo::start_of(color) as usize]);
        let _ = write!(
            s,
            r##"<circle cx="{x}" cy="{y}" r="0.14" fill="rgba(255,255,255,0.85)"/>"##
        );
    }
    for (color, i, x, y, r) in place(state, movable) {
        let is_movable = movable.iter().any(|(c, m)| *c == color && *m as usize == i);
        if is_movable {
            let _ = write!(
                s,
                r##"<circle cx="{x}" cy="{y}" r="{}" fill="none" stroke="#111" stroke-width="0.07" stroke-dasharray="0.25 0.15"/>"##,
                r + if r < 0.3 { 0.08 } else { 0.2 }
            );
        }
        let _ = write!(
            s,
            r##"<circle cx="{x}" cy="{y}" r="{r}" fill="{}" stroke="#fff" stroke-width="0.09"/>"##,
            hex(&color)
        );
        let _ = write!(
            s,
            r##"<circle cx="{x}" cy="{y}" r="{}" fill="rgba(255,255,255,0.55)"/>"##,
            r * 0.45
        );
    }
    s.push_str("</svg>");
    s
}

fn status_text(state: &State, mine: Option<&str>) -> String {
    let name_of = |c: &str| {
        state
            .seat(c)
            .map_or_else(|| ludo::color_name(c).to_owned(), |s| s.name.clone())
    };
    let who = |c: Option<&str>| match c {
        Some(c) if Some(c) == mine => "You".to_owned(),
        Some(c) => name_of(c),
        None => "Someone".to_owned(),
    };
    if state.phase == "lobby" {
        return "Pick a colour to play. 2 to 4 players; everyone else watches.".to_owned();
    }
    if state.phase == "over" {
        let winner = state.finished.first().map(String::as_str);
        let verb = if winner.is_some() && winner == mine {
            "win"
        } else {
            "wins"
        };
        return format!("{} {verb}! 🎉", who(winner));
    }
    let mut last = String::new();
    if let Some(e) = &state.event {
        let c = e.color.as_deref();
        match e.kind.as_str() {
            "no-move" => last = format!("{} rolled {}: no move. ", who(c), e.value.unwrap_or(0)),
            "three-sixes" => last = format!("{} rolled three sixes: turn lost. ", who(c)),
            "capture" => {
                let names: Vec<String> = e.captured.iter().flatten().map(|x| name_of(&x.color)).collect();
                last = format!("{} captured {}! ", who(c), names.join(", "));
            }
            "home" => last = format!("{} got a token home! ", who(c)),
            "skipped" => last = format!("{} is away: turn skipped. ", who(c)),
            _ => {}
        }
    }
    let now = match state.turn.as_deref() {
        Some(t) if Some(t) == mine => {
            if state.rolled {
                format!("Pick a token to move {}.", state.dice.unwrap_or(0))
            } else {
                "Your turn: roll the dice.".to_owned()
            }
        }
        Some(t) => format!("{}'s turn.", name_of(t)),
        None => String::new(),
    };
    last + &now
}

fn mini_btn(id: impl Into<gpui_kit::ElementId>, label: &str) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .min_h(px(30.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(8.))
        .border_1()
        .border_color(tokens::line_strong())
        .text_size(px(12.5))
        .cursor_pointer()
        .hover(|s| s.bg(tokens::raised()))
        .child(label.to_owned())
}

fn dice(value: Option<i64>, color: Option<&str>) -> impl IntoElement {
    let pips: &[(f32, f32)] = match value {
        Some(1) => &[(1., 1.)],
        Some(2) => &[(0., 0.), (2., 2.)],
        Some(3) => &[(0., 0.), (1., 1.), (2., 2.)],
        Some(4) => &[(0., 0.), (2., 0.), (0., 2.), (2., 2.)],
        Some(5) => &[(0., 0.), (2., 0.), (1., 1.), (0., 2.), (2., 2.)],
        Some(6) => &[(0., 0.), (2., 0.), (0., 1.), (2., 1.), (0., 2.), (2., 2.)],
        _ => &[],
    };
    let face = color.map_or_else(|| tokens::hex(0xdd_dddd), color_token);
    div()
        .relative()
        .size(px(56.))
        .rounded(px(10.))
        .bg(face)
        .border_2()
        .border_color(tokens::white().opacity(0.85))
        .children(pips.iter().map(|(x, y)| {
            div()
                .absolute()
                .left(px(3.0 + x * 16.8 + 2.4))
                .top(px(3.0 + y * 16.8 + 2.4))
                .size(px(10.))
                .rounded_full()
                .bg(tokens::white())
        }))
}

impl RoomView {
    fn ludo_send(&mut self, action: Value, cx: &mut Context<'_, Self>) {
        self.activity_command(
            ActivityCommand::Dispatch {
                key: KEY.to_owned(),
                action,
            },
            cx,
        );
    }

    fn ludo_state(&self) -> Option<(State, Vec<String>, bool)> {
        let r = self.room.as_ref()?;
        let (_, v) = r.stores.iter().find(|(k, _)| k == KEY)?;
        let members = v.presence.members.iter().map(|p| p.as_str().to_owned()).collect();
        let deciding = v.presence.authority.as_ref() == Some(&r.me);
        Some((State::from_value(&v.state)?, members, deciding))
    }

    /// After every room update: the deciding app plays for computers, people who left and idle
    /// players; a seat we had before a restart is asked back.
    pub(crate) fn ludo_after(&mut self, cx: &mut Context<'_, Self>) {
        let Some((s, present, deciding)) = self.ludo_state() else {
            return;
        };
        let Some(room) = self.room.as_ref() else { return };
        let me = room.me.as_str().to_owned();
        let my_client = room.client_id.clone();
        let username = room.username.clone();
        if deciding
            && s.phase == "playing"
            && let Some(seat) = s.turn.as_deref().and_then(|t| s.seat(t))
        {
            let (delay, skip) = if seat.is_bot() {
                (BOT_DELAY, false)
            } else if !present.contains(&seat.id) {
                (AWAY_DELAY, s.rules.away_mode == "skip")
            } else {
                (IDLE_DELAY, false)
            };
            #[allow(clippy::cast_possible_truncation)]
            let key = (s.seq, skip, delay.as_millis() as u64);
            if self.activity.ludo.auto_sent != Some(key) {
                self.activity.ludo.auto_sent = Some(key);
                let seq = s.seq;
                cx.spawn(async move |v, cx| {
                    cx.background_executor().timer(delay).await;
                    let _ = v.update(cx, |v, cx| {
                        if v.activity.ludo.auto_sent == Some(key)
                            && v.ludo_state().is_some_and(|(s, ..)| s.seq == seq)
                        {
                            v.ludo_send(act::auto(seq, skip), cx);
                        }
                    });
                })
                .detach();
            }
        }
        if s.seat_of(&me).is_none() {
            let old = COLORS.into_iter().find(|c| {
                s.seat(c).is_some_and(|x| {
                    !x.is_bot() && !present.contains(&x.id) && x.cid.as_deref() == Some(my_client.as_str())
                })
            });
            if let Some(c) = old {
                let key = format!("{c}:{}", s.seat(c).map_or("", |x| x.id.as_str()));
                if self.activity.ludo.reclaim_sent.as_ref() != Some(&key) {
                    self.activity.ludo.reclaim_sent = Some(key);
                    self.ludo_send(act::sit(c, &username), cx);
                }
            }
        }
    }

    /// What the bubble says.
    pub(crate) fn ludo_attention(&self) -> Option<String> {
        let (s, ..) = self.ludo_state()?;
        let me = self.room.as_ref()?.me.as_str().to_owned();
        let mine = s.seat_of(&me)?;
        (s.phase == "playing" && s.turn.as_deref() == Some(mine) && (!s.rolled || !s.movable.is_empty()))
            .then(|| {
                if s.rolled {
                    "Move a token".to_owned()
                } else {
                    "Your turn".to_owned()
                }
            })
    }
}

/// The game.
#[allow(clippy::too_many_lines)]
pub(crate) fn view(
    view: &RoomView,
    room: &Snapshot,
    store: &Value,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let Some(s) = State::from_value(store) else {
        return div().into_any_element();
    };
    let present: Vec<String> = room
        .stores
        .iter()
        .find(|(k, _)| k == KEY)
        .map(|(_, v)| v.presence.members.iter().map(|p| p.as_str().to_owned()).collect())
        .unwrap_or_default();
    let me = room.me.as_str().to_owned();
    let host_here = room
        .host
        .as_ref()
        .is_some_and(|h| *h == room.me || present.iter().any(|p| p == h.as_str()));
    let can_manage = room.host.as_ref() == Some(&room.me) || !host_here;
    let mine = s.seat_of(&me);
    let away = |c: &str| s.seat(c).is_some_and(|x| !x.is_bot() && !present.contains(&x.id));
    let can_pick = s.phase == "playing" && s.rolled && s.turn.as_deref() == mine && mine.is_some();
    let movable: Vec<(String, i64)> = if can_pick {
        s.movable
            .iter()
            .map(|&i| (mine.unwrap_or_default().to_owned(), i))
            .collect()
    } else {
        Vec::new()
    };

    // the board picture, rebuilt when the game changes
    let svg = board_svg(&s, &movable);
    let picture = view.activity.ludo.picture.for_svg(svg, cx);
    let area = view.activity.ludo.area.get();
    let avail_w = area.map_or(640.0, |a| f32::from(a.size.width) - 300.0 - 40.0);
    let avail_h = area.map_or(640.0, |a| f32::from(a.size.height) - 32.0);
    let size = avail_w.min(avail_h).clamp(240.0, 900.0);
    let unit = size / 15.0;
    let hits = place(&s, &movable).into_iter().filter_map(|(c, i, x, y, r)| {
        movable
            .iter()
            .any(|(mc, mi)| *mc == c && *mi as usize == i)
            .then(|| {
                #[allow(clippy::cast_possible_truncation)]
                let (cx_, cy_, rr) = (
                    (x * f64::from(unit)) as f32,
                    (y * f64::from(unit)) as f32,
                    ((r.max(0.3) + 0.2) * f64::from(unit)) as f32,
                );
                let token = i as i64;
                div()
                    .id(("ludo-token", i))
                    .absolute()
                    .left(px(cx_ - rr))
                    .top(px(cy_ - rr))
                    .size(px(rr * 2.0))
                    .rounded_full()
                    .cursor_pointer()
                    .on_click(cx.listener(move |v, _, _, cx| v.ludo_send(act::mv(token), cx)))
            })
    });
    let board = div()
        .relative()
        .flex_none()
        .size(px(size))
        .rounded(px(10.))
        .overflow_hidden()
        .child(div().size(px(size)).child(view.activity.ludo.picture.paint(picture)))
        .children(hits);

    // ---- the panel ----
    let mut panel = div()
        .id("ludo-panel")
        .w(px(280.))
        .flex_none()
        .max_h_full()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(div().text_size(px(15.)).child(status_text(&s, mine)));
    if s.phase == "playing" {
        let my_turn = s.turn.as_deref() == mine && mine.is_some() && !s.rolled;
        let shown = if s.rolled {
            s.dice
        } else {
            s.event.as_ref().and_then(|e| e.value)
        };
        let dcolor = s
            .event
            .as_ref()
            .and_then(|e| e.color.clone())
            .or_else(|| s.turn.clone());
        panel = panel.child(
            div()
                .flex()
                .items_center()
                .gap(px(14.))
                .child(dice(shown, dcolor.as_deref()))
                .child(if my_turn {
                    Button::new("ludo-roll", "Roll")
                        .variant(Variant::Primary)
                        .on_click(cx.listener(|v, _, _, cx| v.ludo_send(act::roll(), cx)))
                        .into_any_element()
                } else {
                    div()
                        .text_size(px(13.))
                        .text_color(tokens::text_2())
                        .child(if s.turn.as_deref() == mine && mine.is_some() {
                            "Tap a glowing token"
                        } else if mine.is_some() {
                            "Wait for your turn"
                        } else {
                            "Watching"
                        })
                        .into_any_element()
                }),
        );
    }
    let seats = COLORS.map(|color| {
        let ci = COLORS.iter().position(|c| *c == color).unwrap_or(0);
        let seat = s.seat(color).cloned();
        let home = s
            .tokens
            .as_ref()
            .and_then(|t| t.get(color))
            .map_or(0, |l| l.iter().filter(|p| **p >= HOME).count());
        let place = s.finished.iter().position(|f| f == color);
        let is_away = away(color);
        let mut row = div()
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(10.))
            .py(px(6.))
            .min_h(px(40.))
            .rounded(px(10.))
            .bg(tokens::surface())
            .border_1()
            .border_color(if s.turn.as_deref() == Some(color) {
                color_token(color)
            } else {
                tokens::surface()
            })
            .child(div().size(px(14.)).rounded_full().bg(color_token(color)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(14.))
                    .text_color(if seat.is_some() {
                        tokens::text()
                    } else {
                        tokens::text_3()
                    })
                    .child(seat.as_ref().map_or_else(
                        || "Free".to_owned(),
                        |x| {
                            if x.id == me {
                                format!("{} (you)", x.name)
                            } else {
                                x.name.clone()
                            }
                        },
                    ))
                    .when(is_away, |el| el.child(tag("away")))
                    .when_some(place, |el, p| el.child(tag(&format!("#{}", p + 1)))),
            )
            .when(s.phase != "lobby" && seat.is_some(), |el| {
                el.child(
                    div()
                        .text_size(px(12.))
                        .text_color(tokens::text_2())
                        .child(format!("{home}/4 home")),
                )
            });
        if s.phase == "lobby" && seat.is_none() {
            row = row
                .child(
                    mini_btn(("ludo-sit", ci), if mine.is_some() { "Switch" } else { "Sit" }).on_click(
                        cx.listener(move |v, _, _, cx| {
                            let name = v.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
                            v.ludo_send(act::sit(color, &name), cx);
                        }),
                    ),
                )
                .when(can_manage, |el| {
                    el.child(
                        mini_btn(("ludo-bot", ci), "+ Computer")
                            .on_click(cx.listener(move |v, _, _, cx| v.ludo_send(act::add_bot(color), cx))),
                    )
                });
        } else if s.phase == "lobby" && seat.as_ref().is_some_and(|x| x.id == me || can_manage) {
            let own = seat.as_ref().is_some_and(|x| x.id == me);
            row = row.child(
                mini_btn(("ludo-leave", ci), if own { "Leave" } else { "Remove" }).on_click(cx.listener(
                    move |v, _, _, cx| {
                        v.ludo_send(if own { act::stand() } else { act::clear_seat(color) }, cx);
                    },
                )),
            );
        } else if s.phase == "playing" && is_away && mine.is_none() {
            row = row.child(mini_btn(("ludo-take", ci), "Take seat").on_click(cx.listener(
                move |v, _, _, cx| {
                    let name = v.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
                    v.ludo_send(act::sit(color, &name), cx);
                },
            )));
        }
        row.id(("ludo-seat", ci))
    });
    panel = panel.child(div().flex().flex_col().gap(px(6.)).children(seats));
    if s.phase == "lobby" {
        let rule_on = |k: &str| match k {
            "sixToLeave" => s.rules.six_to_leave,
            "threeSixes" => s.rules.three_sixes,
            "safeStars" => s.rules.safe_stars,
            "captureBonus" => s.rules.capture_bonus,
            _ => s.rules.home_bonus,
        };
        let seated = s.seated().len();
        let check = |on: bool| {
            div()
                .size(px(16.))
                .rounded(px(4.))
                .border_1()
                .border_color(tokens::line_strong())
                .when(on, |el| el.bg(tokens::accent()).border_color(tokens::accent()))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(11.))
                .text_color(tokens::white())
                .child(if on { "✓" } else { "" })
        };
        panel = panel.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .text_size(px(13.5))
                .child(div().font_weight(FontWeight::SEMIBOLD).child(if can_manage {
                    "Rules".to_owned()
                } else {
                    "Rules (the host sets these)".to_owned()
                }))
                .children(RULES.iter().enumerate().map(|(n, (k, label, _))| {
                    let on = rule_on(k);
                    let key = *k;
                    div()
                        .id(("ludo-rule", n))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .when(can_manage, |el| {
                            el.cursor_pointer().on_click(cx.listener(move |v, _, _, cx| {
                                v.ludo_send(act::rule(key, Value::Bool(!on)), cx);
                            }))
                        })
                        .child(check(on))
                        .child(*label)
                }))
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("If a player leaves"),
                )
                .children(
                    [
                        ("bot", "The computer plays for them"),
                        ("skip", "Skip their turns"),
                    ]
                    .into_iter()
                    .enumerate()
                    .map(|(n, (value, label))| {
                        let on = s.rules.away_mode == value;
                        div()
                            .id(("ludo-away", n))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .when(can_manage, |el| {
                                el.cursor_pointer().on_click(cx.listener(move |v, _, _, cx| {
                                    v.ludo_send(act::rule("awayMode", Value::from(value)), cx);
                                }))
                            })
                            .child(
                                div()
                                    .size(px(16.))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(tokens::line_strong())
                                    .when(on, |el| el.border_4().border_color(tokens::accent())),
                            )
                            .child(label)
                    }),
                )
                .child(if can_manage {
                    Button::new(
                        "ludo-start",
                        if seated < 2 {
                            "Need 2 players".to_owned()
                        } else {
                            format!("Start game ({seated} players)")
                        },
                    )
                    .variant(Variant::Primary)
                    .full_width()
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if seated >= 2 {
                            v.ludo_send(act::start(), cx);
                        }
                    }))
                    .into_any_element()
                } else {
                    div()
                        .text_size(px(13.))
                        .text_color(tokens::text_3())
                        .child("The host starts the game.")
                        .into_any_element()
                }),
        );
    }
    if s.phase == "over" {
        let names: Vec<(String, String)> = s
            .finished
            .iter()
            .map(|c| {
                (
                    c.clone(),
                    s.seat(c)
                        .map_or_else(|| ludo::color_name(c).to_owned(), |x| x.name.clone()),
                )
            })
            .collect();
        panel = panel.child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .children(names.into_iter().enumerate().map(|(i, (c, n))| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_size(px(14.))
                        .child(format!("{}.", i + 1))
                        .child(div().size(px(12.)).rounded_full().bg(color_token(&c)))
                        .child(n)
                }))
                .when(can_manage, |el| {
                    el.child(
                        Button::new("ludo-again", "Play again")
                            .variant(Variant::Primary)
                            .on_click(cx.listener(|v, _, _, cx| v.ludo_send(act::again(), cx))),
                    )
                }),
        );
    }

    let area_cell = Rc::clone(&view.activity.ludo.area);
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
                .items_center()
                .justify_center()
                .gap(px(20.))
                .p(px(16.))
                .child(board)
                .child(panel),
        )
        .into_any_element()
}

fn tag(text: &str) -> impl IntoElement {
    div()
        .px(px(6.))
        .rounded(px(6.))
        .text_size(px(11.))
        .bg(tokens::raised())
        .text_color(tokens::text_2())
        .child(text.to_owned())
}
