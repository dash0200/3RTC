//! Tycoon on screen (`tycoon/index.tsx`, `BoardView.tsx`, `art.tsx`): the board (the web app's
//! own drawing of the spaces, `ui/assets/tycoon/board.svg`, with owners, houses, mortgages, dice
//! and tokens drawn over it as a second picture), the title deeds, the turn panel, deals, and the
//! lobby. The computer's turns: `rtc_games::driver`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Bounds, Context, FontWeight, Hsla, Image, ImageFormat, Pixels, canvas, div, img, px,
};
use rtc_core::ActivityCommand;
use rtc_engine::Snapshot;
use rtc_games::tycoon::board::{
    self, JAIL_FINE, Kind, SPACES, START_CASH, START_PAY, STATION_RENT, SURPRISE, TOKENS, TREASURE,
    UTILITY_TIMES,
};
use rtc_games::tycoon::{
    ROUND_OPTIONS, State, act, group_members, group_of, is_buyable, money, mortgage_value, price_of,
    unmortgage_cost,
};
use rtc_ui::button::{Button, Variant};
use rtc_ui::tokens;
use serde_json::Value;

use crate::view::RoomView;

const KEY: &str = "act:tycoon";
const SIZE: f64 = 1000.0;
const C: f64 = 130.0;
const W: f64 = (SIZE - 2.0 * C) / 9.0;

const TOKEN_SVGS: [(&str, &str); 6] = [
    ("auto", include_str!("../../ui/assets/tycoon/token-auto.svg")),
    ("car", include_str!("../../ui/assets/tycoon/token-car.svg")),
    (
        "scooter",
        include_str!("../../ui/assets/tycoon/token-scooter.svg"),
    ),
    ("boat", include_str!("../../ui/assets/tycoon/token-boat.svg")),
    ("plane", include_str!("../../ui/assets/tycoon/token-plane.svg")),
    ("train", include_str!("../../ui/assets/tycoon/token-train.svg")),
];

fn token_name(t: &str) -> &'static str {
    match t {
        "auto" => "Tuk-tuk",
        "car" => "Car",
        "scooter" => "Scooter",
        "boat" => "Boat",
        "plane" => "Plane",
        _ => "Train",
    }
}

/// A deal being put together.
#[derive(Debug, Default, Clone)]
struct Draft {
    to: i64,
    give: Vec<i64>,
    get: Vec<i64>,
    give_cash: i64,
    get_cash: i64,
}

/// This device's view of the game.
#[derive(Default)]
pub(crate) struct TycoonUi {
    /// The title deed open.
    deed: Option<usize>,
    /// The deal being made.
    trading: Option<Draft>,
    /// How to play, open.
    guide: bool,
    /// "Declare bankruptcy" tapped at this seq.
    confirm_bankrupt: Option<i64>,
    /// The card last closed (its seq).
    card_seen: i64,
    /// The card whose closing is timed (its seq).
    card_timer: i64,
    /// The picture over the board, and what it shows.
    /// What changes over the board (freed as each change replaces it).
    overlay: crate::picture::LivePicture,
    /// Token pictures by token and colour.
    token_pics: RefCell<HashMap<(String, String), Arc<Image>>>,
    /// Where the game area is.
    pub(crate) area: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl TycoonUi {
    /// The game closed: its board picture leaves gpui's cache and the GPU.
    pub(crate) fn free_pictures(&self, cx: &mut gpui_kit::App) {
        self.overlay.free(cx);
    }
}

impl std::fmt::Debug for TycoonUi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TycoonUi").finish_non_exhaustive()
    }
}

fn hex_color(s: &str) -> Hsla {
    u32::from_str_radix(s.trim_start_matches('#'), 16).map_or_else(|_| tokens::text_3(), tokens::hex)
}

fn token_inner(token: &str) -> &'static str {
    let svg = TOKEN_SVGS
        .iter()
        .find(|(t, _)| *t == token)
        .map_or(TOKEN_SVGS[0].1, |(_, s)| s);
    let start = svg
        .find("translate(2 1.5)\">")
        .map_or(0, |i| i + "translate(2 1.5)\">".len());
    let end = svg.rfind("</g></svg>").unwrap_or(svg.len());
    &svg[start..end.max(start)]
}

fn token_pic(ui: &TycoonUi, token: &str, color: &str) -> Arc<Image> {
    let key = (token.to_owned(), color.to_owned());
    if let Some(i) = ui.token_pics.borrow().get(&key) {
        return Arc::clone(i);
    }
    let svg = TOKEN_SVGS
        .iter()
        .find(|(t, _)| *t == token)
        .map_or(TOKEN_SVGS[0].1, |(_, s)| s)
        .replace("#COLOR", color);
    let image = Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes()));
    ui.token_pics.borrow_mut().insert(key, Arc::clone(&image));
    image
}

fn token_el(ui: &TycoonUi, token: &str, color: &str, size: f32, ghost: bool) -> impl IntoElement {
    img(token_pic(ui, token, color))
        .size(px(size))
        .flex_none()
        .when(ghost, |el| el.opacity(0.45))
}

/// `spaceTransform`.
fn space_transform(i: usize) -> String {
    let k = (i % 10) as f64;
    if i < 10 {
        format!("translate({} {})", SIZE - C - k * W, SIZE - C)
    } else if i < 20 {
        format!("translate({C} {}) rotate(90)", SIZE - C - k * W)
    } else if i < 30 {
        format!("translate({} {C}) rotate(180)", C + k * W)
    } else {
        format!("translate({} {}) rotate(270)", SIZE - C, C + k * W)
    }
}

/// `spacePoint`.
fn space_point(i: usize, lx: f64, ly: f64) -> (f64, f64) {
    if i.is_multiple_of(10) {
        let (x, y) = [(SIZE - C, SIZE - C), (0.0, SIZE - C), (0.0, 0.0), (SIZE - C, 0.0)][i / 10];
        return (x + C / 2.0, y + C / 2.0);
    }
    let k = (i % 10) as f64;
    if i < 10 {
        (SIZE - C - k * W + lx, SIZE - C + ly)
    } else if i < 20 {
        (C - ly, SIZE - C - k * W + lx)
    } else if i < 30 {
        (C + k * W - lx, C - ly)
    } else {
        (SIZE - C + ly, C + k * W - lx)
    }
}

/// A space's rectangle on the board: x, y, w, h.
fn space_rect(i: usize) -> (f64, f64, f64, f64) {
    if i.is_multiple_of(10) {
        let (x, y) = [(SIZE - C, SIZE - C), (0.0, SIZE - C), (0.0, 0.0), (SIZE - C, 0.0)][i / 10];
        return (x, y, C, C);
    }
    let k = (i % 10) as f64;
    if i < 10 {
        (SIZE - C - k * W, SIZE - C, W, C)
    } else if i < 20 {
        (0.0, SIZE - C - k * W, C, W)
    } else if i < 30 {
        (C + (k - 1.0) * W, 0.0, W, C)
    } else {
        (SIZE - C, C + (k - 1.0) * W, C, W)
    }
}

fn building(out: &mut String, hotel: bool, x: f64, y: f64, s: f64) {
    let w = if hotel { s * 1.9 } else { s };
    let _ = write!(
        out,
        r##"<g transform="translate({} {})"><path d="M0 {}L{} 0L{w} {}V{s}H0Z" fill="{}" stroke="#0d3b20" stroke-width="1" stroke-linejoin="round"/>"##,
        x - w / 2.0,
        y - s,
        s * 0.45,
        w / 2.0,
        s * 0.45,
        if hotel { "#e0393e" } else { "#22a35a" }
    );
    if hotel {
        let _ = write!(
            out,
            r##"<rect x="{}" y="{}" width="{}" height="{}" fill="#7a1418"/>"##,
            w * 0.42,
            s * 0.55,
            w * 0.16,
            s * 0.45
        );
    }
    out.push_str("</g>");
}

fn die(out: &mut String, value: i64, x: f64, y: f64, s: f64) {
    let pips: &[(f64, f64)] = match value {
        1 => &[(1., 1.)],
        2 => &[(0., 0.), (2., 2.)],
        3 => &[(0., 0.), (1., 1.), (2., 2.)],
        4 => &[(0., 0.), (2., 0.), (0., 2.), (2., 2.)],
        5 => &[(0., 0.), (2., 0.), (1., 1.), (0., 2.), (2., 2.)],
        6 => &[(0., 0.), (2., 0.), (0., 1.), (2., 1.), (0., 2.), (2., 2.)],
        _ => &[],
    };
    let _ = write!(
        out,
        r##"<g transform="translate({x} {y})"><rect width="{s}" height="{s}" rx="{}" fill="#fff" stroke="#23252d" stroke-width="2"/>"##,
        s * 0.2
    );
    for (c, r) in pips {
        let _ = write!(
            out,
            r#"<circle cx="{}" cy="{}" r="{}" fill="{}"/>"#,
            s * (0.25 + c * 0.25),
            s * (0.25 + r * 0.25),
            s * 0.085,
            if value == 1 { "#e0393e" } else { "#23252d" }
        );
    }
    out.push_str("</g>");
}

fn text(out: &mut String, x: f64, y: f64, size: f64, weight: u32, fill: &str, t: &str) {
    let _ = write!(
        out,
        r#"<text x="{x}" y="{y}" text-anchor="middle" font-size="{size}" font-weight="{weight}" fill="{fill}" font-family="'Figtree Variable', system-ui, sans-serif">{}</text>"#,
        t.replace('&', "&amp;").replace('<', "&lt;")
    );
}

/// What changes on the board, as one picture the size of the board (transparent elsewhere).
fn overlay_svg(s: &State, highlight: Option<usize>) -> String {
    let mut o = String::from(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><defs><pattern id="m" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="10" fill="#23252d33"/></pattern></defs>"##,
    );
    for i in 0..40 {
        if i % 10 == 0 {
            if highlight == Some(i) {
                let (x, y, w, h) = space_rect(i);
                let _ = write!(
                    o,
                    r##"<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#ffd34d55"/>"##
                );
            }
            continue;
        }
        let _ = write!(o, r#"<g transform="{}">"#, space_transform(i));
        if highlight == Some(i) {
            let _ = write!(o, r##"<rect width="{W}" height="{C}" fill="#ffd34d55"/>"##);
        }
        if let Some(owner) = s.owner[i]
            && let Some(p) = s.player(owner)
        {
            let _ = write!(
                o,
                r#"<rect x="3" y="{}" width="{}" height="6" rx="3" fill="{}"/>"#,
                C - 7.0,
                W - 6.0,
                p.color
            );
        }
        if s.mortgaged[i] {
            let _ = write!(o, r#"<rect width="{W}" height="{C}" fill="url(#m)"/>"#);
            text(&mut o, W / 2.0, C / 2.0 + 8.0, 24.0, 900, "#23252dcc", "M");
        }
        let h = s.houses[i];
        if h == 5 {
            building(&mut o, true, W / 2.0, 21.0, 16.0);
        } else {
            for k in 0..h {
                #[allow(clippy::cast_precision_loss)]
                let x = W / 2.0 + (k as f64 - (h as f64 - 1.0) / 2.0) * 17.0;
                building(&mut o, false, x, 21.0, 14.0);
            }
        }
        o.push_str("</g>");
    }
    let dice = s.dice.unwrap_or([5, 3]);
    die(&mut o, dice[0], SIZE / 2.0 - 70.0, SIZE / 2.0 + 105.0, 62.0);
    die(&mut o, dice[1], SIZE / 2.0 + 8.0, SIZE / 2.0 + 105.0, 62.0);
    if s.rules.jackpot {
        let _ = write!(
            o,
            r##"<g transform="translate({} {})"><rect width="170" height="44" rx="22" fill="#fff8e1" stroke="#b86b2d" stroke-width="2"/>"##,
            C + 40.0,
            C + 40.0
        );
        text(
            &mut o,
            85.0,
            29.0,
            18.0,
            800,
            "#b86b2d",
            &format!("☕ Pot {}", money(s.pot)),
        );
        o.push_str("</g>");
    }
    // tokens: on the same space, side by side
    let mut by_space: Vec<(i64, Vec<usize>)> = Vec::new();
    for (seat, p) in s.players.iter().enumerate() {
        if p.bankrupt {
            continue;
        }
        match by_space.iter_mut().find(|(pos, _)| *pos == p.pos) {
            Some((_, v)) => v.push(seat),
            None => by_space.push((p.pos, vec![seat])),
        }
    }
    for (pos, seats) in &by_space {
        let pos = usize::try_from(*pos).unwrap_or(0) % 40;
        let n = seats.len() as f64;
        for (k, &seat) in seats.iter().enumerate() {
            let p = &s.players[seat];
            let k = k as f64;
            let spread = if n > 1.0 {
                (k - (n - 1.0) / 2.0) * 22.0
            } else {
                0.0
            };
            let in_cell = pos == 10 && p.jail > 0;
            let (x, y) = if pos.is_multiple_of(10) {
                let (bx, by) = space_point(pos, 0.0, 0.0);
                let dx = spread
                    + if in_cell {
                        22.0
                    } else if pos == 10 {
                        -34.0
                    } else {
                        0.0
                    };
                let dy = if in_cell {
                    -20.0
                } else if pos == 10 {
                    34.0
                } else {
                    18.0
                };
                (bx + dx, by + dy)
            } else {
                let extra = if n > 2.0 { (k % 2.0) * 10.0 } else { 0.0 };
                space_point(pos, W / 2.0 + spread * 0.6, C * 0.66 + extra)
            };
            let r = if seat as i64 == s.turn { 19.0 } else { 16.0 };
            let kk = r / 12.0;
            let _ = write!(
                o,
                r##"<g transform="translate({} {}) scale({kk})"><circle cx="14" cy="16" r="12" fill="#00000050"/><circle cx="14" cy="14" r="12" fill="{}" stroke="#fff" stroke-width="2.2"/><g transform="translate(2 2)">{}</g></g>"##,
                x - 14.0 * kk,
                y - 14.0 * kk,
                p.color,
                token_inner(&p.token)
            );
        }
    }
    o.push_str("</svg>");
    o
}

fn btn(id: impl Into<gpui_kit::ElementId>, label: &str) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .min_h(px(32.))
        .px(px(12.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(9.))
        .border_1()
        .border_color(tokens::line_strong())
        .bg(tokens::surface())
        .text_size(px(13.))
        .cursor_pointer()
        .hover(|s| s.bg(tokens::raised()))
        .child(label.to_owned())
}

fn go_btn(
    id: impl Into<gpui_kit::ElementId>,
    label: &str,
    enabled: bool,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .min_h(px(38.))
        .px(px(16.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(10.))
        .bg(tokens::hex(0x1f_9d55))
        .text_color(tokens::white())
        .text_size(px(14.))
        .font_weight(FontWeight::BOLD)
        .when(enabled, |el| el.cursor_pointer().hover(|s| s.opacity(0.9)))
        .when(!enabled, |el| el.opacity(0.45))
        .child(label.to_owned())
}

fn tag(t: &str) -> impl IntoElement {
    div()
        .px(px(6.))
        .rounded(px(6.))
        .text_size(px(11.))
        .bg(tokens::raised())
        .text_color(tokens::text_2())
        .child(t.to_owned())
}

fn muted(t: impl Into<String>) -> impl IntoElement {
    div()
        .text_size(px(13.))
        .text_color(tokens::text_3())
        .child(t.into())
}

fn space_color(i: usize) -> Hsla {
    match SPACES[i].kind {
        Kind::Property { group, .. } => hex_color(board::group_color(group)),
        _ => tokens::hex(0x6b_6e78),
    }
}

fn describe_space(i: usize) -> String {
    match SPACES[i].kind {
        Kind::Start => format!("Collect {} every time you pass or land here.", money(START_PAY)),
        Kind::Jail => format!(
            "Just visiting, unless you were sent here. To get out: pay {}, use a card, or roll doubles (three tries).",
            money(JAIL_FINE)
        ),
        Kind::Parking => {
            "Take a break. With the Coffee Break pot rule on, collect every tax and fine paid so far.".into()
        }
        Kind::GoToJail => "Go straight to Jail. You don’t pass Start.".into(),
        Kind::Tax { amount } => format!("Pay {} to the bank.", money(amount)),
        Kind::Surprise => "Draw a Surprise card.".into(),
        Kind::Treasure => "Draw a Treasure card.".into(),
        _ => String::new(),
    }
}

fn trade_summary(s: &State) -> (String, String) {
    let Some(t) = s.trade.as_ref() else {
        return (String::new(), String::new());
    };
    let list = |props: &[i64], cash: i64| {
        let mut v: Vec<String> = props
            .iter()
            .filter_map(|&i| {
                usize::try_from(i)
                    .ok()
                    .and_then(|i| SPACES.get(i))
                    .map(|sp| sp.name.to_owned())
            })
            .collect();
        if cash != 0 {
            v.push(money(cash));
        }
        v.join(", ")
    };
    (list(&t.give_props, t.give_cash), list(&t.get_props, t.get_cash))
}

fn tradable(s: &State, seat: i64) -> Vec<i64> {
    (0..40)
        .filter(|&i| {
            s.owner[i] == Some(seat)
                && !group_of(i).is_some_and(|g| group_members(g).iter().any(|&k| s.houses[k] > 0))
        })
        .map(|i| i as i64)
        .collect()
}

impl RoomView {
    fn ty_send(&mut self, action: Value, cx: &mut Context<'_, Self>) {
        self.activity_command(
            ActivityCommand::Dispatch {
                key: KEY.to_owned(),
                action,
            },
            cx,
        );
    }

    fn ty_state(&self) -> Option<State> {
        let r = self.room.as_ref()?;
        let (_, v) = r.stores.iter().find(|(k, _)| k == KEY)?;
        State::from_value(&v.state)
    }

    /// After every room update: a card drawn shows for 4.5 s.
    pub(crate) fn tycoon_after(&mut self, cx: &mut Context<'_, Self>) {
        let Some(seq) = self.ty_state().and_then(|s| s.card.map(|c| c.seq)) else {
            return;
        };
        if seq == self.activity.tycoon.card_seen || seq == self.activity.tycoon.card_timer {
            return;
        }
        self.activity.tycoon.card_timer = seq;
        cx.spawn(async move |v, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(4500))
                .await;
            let _ = v.update(cx, |v, cx| {
                v.activity.tycoon.card_seen = v.activity.tycoon.card_seen.max(seq);
                cx.notify();
            });
        })
        .detach();
    }

    /// What the bubble says.
    pub(crate) fn tycoon_attention(&self) -> Option<String> {
        let s = self.ty_state()?;
        let me = s.seat_of(self.room.as_ref()?.me.as_str());
        if s.phase == "playing" && me >= 0 && s.trade.as_ref().is_some_and(|t| t.to == me) {
            return Some("A deal for you".into());
        }
        (s.phase == "playing" && me >= 0 && s.turn == me).then(|| {
            match s.step.as_str() {
                "debt" => "Pay up!",
                "buy" => "Buy it?",
                "roll" => "Roll!",
                _ => "End your turn",
            }
            .to_owned()
        })
    }
}

fn panel_card() -> gpui_kit::Div {
    div()
        .p(px(12.))
        .rounded(px(12.))
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .gap(px(8.))
}

fn modal(
    id: &'static str,
    inner: impl IntoElement,
    close: impl Fn(&mut RoomView, &mut Context<'_, RoomView>) + 'static,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    div()
        .id(id)
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(tokens::black(0.55))
        .on_click(cx.listener(move |v, _, _, cx| {
            close(v, cx);
            cx.notify();
        }))
        .child(
            div()
                .id((id, 1usize))
                .on_click(|_, _, cx| cx.stop_propagation())
                .child(inner),
        )
        .into_any_element()
}

/// The title deed of `pos`, with what we can do there.
#[allow(clippy::too_many_lines)]
fn deed(s: &State, pos: usize, me: i64, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let sp = SPACES[pos];
    let owner = s.owner[pos];
    let mine = me >= 0 && owner == Some(me);
    let my_turn = s.phase == "playing" && s.turn == me;
    let header = match sp.kind {
        Kind::Property { group, .. } => hex_color(board::group_color(group)),
        Kind::Station { .. } => tokens::hex(0x23_252d),
        Kind::Utility { .. } => tokens::hex(0x3a_a0a5),
        _ => tokens::hex(0x6b_6e78),
    };
    let kicker = match sp.kind {
        Kind::Property { .. } => sp.city,
        Kind::Station { .. } => "Transport",
        Kind::Utility { .. } => "Utility",
        _ => "",
    };
    let group_built = group_of(pos).is_some_and(|g| group_members(g).iter().any(|&k| s.houses[k] > 0));
    let why_not = (mine && matches!(sp.kind, Kind::Property { .. }) && s.phase == "playing")
        .then(|| s.build_block(me, pos as i64))
        .flatten();
    let row = |label: String, value: String, now: bool| {
        div()
            .flex()
            .justify_between()
            .px(px(6.))
            .py(px(2.))
            .rounded(px(4.))
            .when(now, |el| el.bg(tokens::hex(0xff_f3c4)))
            .child(label)
            .child(value)
    };
    let mut body = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .p(px(14.))
        .text_size(px(13.))
        .text_color(tokens::hex(0x23_252d));
    match sp.kind {
        Kind::Property { rent, house, .. } => {
            body = body.child(row("Rent".into(), money(rent[0]), false)).child(row(
                "Whole colour set".into(),
                money(rent[0] * 2),
                false,
            ));
            for (h, r) in (1_i64..).zip(&rent[1..5]) {
                body = body.child(row(
                    format!("With {h} house{}", if h > 1 { "s" } else { "" }),
                    money(*r),
                    s.houses[pos] == h,
                ));
            }
            body = body
                .child(row("With a hotel".into(), money(rent[5]), s.houses[pos] == 5))
                .child(row("House / hotel costs".into(), money(house), false));
        }
        Kind::Station { .. } => {
            for (i, r) in STATION_RENT.iter().enumerate() {
                body = body.child(row(
                    format!("Owning {} transport{}", i + 1, if i > 0 { "s" } else { "" }),
                    money(*r),
                    false,
                ));
            }
        }
        Kind::Utility { .. } => {
            body = body.child(format!(
                "Rent is {}× the dice roll, or {}× if the same person owns both utilities.",
                UTILITY_TIMES[0], UTILITY_TIMES[1]
            ));
        }
        _ => body = body.child(describe_space(pos)),
    }
    if is_buyable(pos) {
        body = body
            .child(
                div()
                    .flex()
                    .justify_between()
                    .pt(px(6.))
                    .text_color(tokens::hex(0x6b_6e78))
                    .child(format!("Price {}", money(price_of(pos))))
                    .child(format!("Mortgage {}", money(mortgage_value(pos)))),
            )
            .child(match owner.and_then(|o| s.player(o)) {
                None => div().font_weight(FontWeight::SEMIBOLD).child("For sale"),
                Some(p) => div()
                    .flex()
                    .gap(px(4.))
                    .child("Owned by")
                    .child(
                        div()
                            .font_weight(FontWeight::BOLD)
                            .text_color(hex_color(&p.color))
                            .child(p.name.clone()),
                    )
                    .when(s.mortgaged[pos], |el| el.child(" · mortgaged")),
            });
    }
    if let Some(w) = why_not.clone() {
        body = body.child(
            div()
                .id("ty-build-hint")
                .p(px(8.))
                .rounded(px(8.))
                .bg(tokens::hex(0xff_f3c4))
                .child(format!("🏗️ {w}")),
        );
    }
    let mut actions = div().flex().flex_wrap().gap(px(6.));
    if mine && my_turn {
        if let Kind::Property { house, .. } = sp.kind
            && why_not.is_none()
        {
            let label = format!(
                "Build {} ({})",
                if s.houses[pos] == 4 { "hotel" } else { "house" },
                money(house)
            );
            actions = actions.child(
                go_btn("ty-build", &label, true)
                    .on_click(cx.listener(move |v, _, _, cx| v.ty_send(act::at("build", pos), cx))),
            );
        }
        if s.houses[pos] > 0 {
            let half = match sp.kind {
                Kind::Property { house, .. } => house / 2,
                _ => 0,
            };
            let label = format!(
                "Sell {} (+{})",
                if s.houses[pos] == 5 { "hotel" } else { "a house" },
                money(half)
            );
            actions = actions.child(
                btn("ty-sell", &label)
                    .on_click(cx.listener(move |v, _, _, cx| v.ty_send(act::at("sell", pos), cx))),
            );
        }
        if !s.mortgaged[pos] && !group_built {
            let label = format!("Mortgage (+{})", money(mortgage_value(pos)));
            actions = actions.child(
                btn("ty-mortgage", &label)
                    .on_click(cx.listener(move |v, _, _, cx| v.ty_send(act::at("mortgage", pos), cx))),
            );
        }
        if s.mortgaged[pos] && s.step != "debt" {
            let label = format!("Pay off mortgage ({})", money(unmortgage_cost(pos)));
            actions = actions.child(
                btn("ty-unmortgage", &label)
                    .on_click(cx.listener(move |v, _, _, cx| v.ty_send(act::at("unmortgage", pos), cx))),
            );
        }
    }
    let card = div()
        .w(px(320.))
        .rounded(px(14.))
        .overflow_hidden()
        .bg(tokens::hex(0xfb_f6e9))
        .child(
            div()
                .bg(header)
                .p(px(12.))
                .flex()
                .flex_col()
                .items_center()
                .text_color(tokens::white())
                .child(div().text_size(px(11.)).opacity(0.85).child(kicker))
                .child(
                    div()
                        .text_size(px(18.))
                        .font_weight(FontWeight::BLACK)
                        .child(sp.name),
                ),
        )
        .child(body)
        .child(
            div()
                .p(px(12.))
                .pt_0()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(actions)
                .child(btn("ty-deed-close", "Close").on_click(cx.listener(|v, _, _, cx| {
                    v.activity.tycoon.deed = None;
                    cx.notify();
                }))),
        );
    modal("ty-deed", card, |v, _| v.activity.tycoon.deed = None, cx)
}

fn trade_chip(
    s: &State,
    id: (&'static str, usize),
    i: i64,
    on: bool,
    give: bool,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let pos = usize::try_from(i).unwrap_or(0);
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(5.))
        .px(px(8.))
        .py(px(3.))
        .rounded_full()
        .border_1()
        .border_color(if on {
            tokens::accent()
        } else {
            tokens::line_strong()
        })
        .when(on, |el| el.bg(tokens::accent().opacity(0.18)))
        .text_size(px(12.))
        .cursor_pointer()
        .child(div().size(px(9.)).rounded_full().bg(space_color(pos)))
        .child(format!(
            "{}{}",
            SPACES[pos].name,
            if s.mortgaged[pos] { " (M)" } else { "" }
        ))
        .on_click(cx.listener(move |v, _, _, cx| {
            if let Some(t) = v.activity.tycoon.trading.as_mut() {
                let list = if give { &mut t.give } else { &mut t.get };
                if let Some(k) = list.iter().position(|x| *x == i) {
                    list.remove(k);
                } else {
                    list.push(i);
                }
            }
            cx.notify();
        }))
        .into_any_element()
}

fn cash_stepper(
    id: &'static str,
    value: i64,
    max: i64,
    give: bool,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let mut row = div()
        .flex()
        .items_center()
        .gap(px(6.))
        .text_size(px(13.))
        .child("Cash");
    for (n, (delta, label)) in [(-500, "−500"), (-100, "−100"), (100, "+100"), (500, "+500")]
        .into_iter()
        .enumerate()
    {
        row = row.child(
            btn((id, n), label)
                .min_h(px(26.))
                .px(px(7.))
                .on_click(cx.listener(move |v, _, _, cx| {
                    if let Some(t) = v.activity.tycoon.trading.as_mut() {
                        let c = if give { &mut t.give_cash } else { &mut t.get_cash };
                        *c = (*c + delta).clamp(0, max.max(0));
                    }
                    cx.notify();
                })),
        );
    }
    row.child(div().font_weight(FontWeight::BOLD).child(money(value)))
        .into_any_element()
}

/// Making a deal.
#[allow(clippy::too_many_lines)]
fn trade_dialog(s: &State, me: i64, d: &Draft, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let others: Vec<(i64, String)> = s
        .players
        .iter()
        .enumerate()
        .filter(|(i, p)| *i as i64 != me && !p.bankrupt)
        .map(|(i, p)| (i as i64, p.name.clone()))
        .collect();
    let mine = tradable(s, me);
    let theirs = if d.to >= 0 { tradable(s, d.to) } else { Vec::new() };
    let my_cash = s.player(me).map_or(0, |p| p.cash);
    let their_cash = s.player(d.to).map_or(0, |p| p.cash);
    let empty = d.give.is_empty() && d.get.is_empty() && d.give_cash == 0 && d.get_cash == 0;
    let give_chips: Vec<AnyElement> = mine
        .iter()
        .map(|&i| {
            trade_chip(
                s,
                ("ty-give", usize::try_from(i).unwrap_or(0)),
                i,
                d.give.contains(&i),
                true,
                cx,
            )
        })
        .collect();
    let get_chips: Vec<AnyElement> = theirs
        .iter()
        .map(|&i| {
            trade_chip(
                s,
                ("ty-get", usize::try_from(i).unwrap_or(0)),
                i,
                d.get.contains(&i),
                false,
                cx,
            )
        })
        .collect();
    let give_cash = cash_stepper("ty-give-cash", d.give_cash, my_cash, true, cx);
    let get_cash = cash_stepper("ty-get-cash", d.get_cash, their_cash, false, cx);
    let to_name = others
        .iter()
        .find(|(i, _)| *i == d.to)
        .map_or_else(String::new, |(_, n)| n.clone());
    let card = div()
        .w(px(560.))
        .max_w_full()
        .p(px(18.))
        .rounded(px(14.))
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .text_size(px(17.))
                .font_weight(FontWeight::BOLD)
                .child("Make a deal"),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(6.))
                .text_size(px(13.))
                .child("With")
                .children(others.iter().map(|(i, name)| {
                    let i = *i;
                    let on = i == d.to;
                    btn(("ty-trade-to", usize::try_from(i).unwrap_or(0)), name)
                        .when(on, |el| {
                            el.border_color(tokens::accent())
                                .bg(tokens::accent().opacity(0.18))
                        })
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if let Some(t) = v.activity.tycoon.trading.as_mut() {
                                t.to = i;
                                t.get.clear();
                                t.get_cash = 0;
                            }
                            cx.notify();
                        }))
                })),
        )
        .child(
            div()
                .flex()
                .gap(px(14.))
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child("You give"))
                        .child(if mine.is_empty() {
                            muted("No places to trade").into_any_element()
                        } else {
                            div()
                                .flex()
                                .flex_wrap()
                                .gap(px(5.))
                                .children(give_chips)
                                .into_any_element()
                        })
                        .child(give_cash),
                )
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(if to_name.is_empty() {
                                    "You get".to_owned()
                                } else {
                                    format!("You get (from {to_name})")
                                }),
                        )
                        .child(if theirs.is_empty() {
                            muted("No places to trade").into_any_element()
                        } else {
                            div()
                                .flex()
                                .flex_wrap()
                                .gap(px(5.))
                                .children(get_chips)
                                .into_any_element()
                        })
                        .child(get_cash),
                ),
        )
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(
                    go_btn("ty-trade-send", "Send offer", !empty && d.to >= 0).on_click(cx.listener(
                        move |v, _, _, cx| {
                            let Some(t) = v.activity.tycoon.trading.clone() else {
                                return;
                            };
                            if t.to < 0
                                || (t.give.is_empty()
                                    && t.get.is_empty()
                                    && t.give_cash == 0
                                    && t.get_cash == 0)
                            {
                                return;
                            }
                            v.activity.tycoon.trading = None;
                            v.ty_send(act::trade(t.to, t.give_cash, &t.give, t.get_cash, &t.get), cx);
                        },
                    )),
                )
                .child(
                    btn("ty-trade-cancel", "Cancel").on_click(cx.listener(|v, _, _, cx| {
                        v.activity.tycoon.trading = None;
                        cx.notify();
                    })),
                ),
        );
    modal("ty-trade", card, |v, _| v.activity.tycoon.trading = None, cx)
}

fn guide(cx: &mut Context<'_, RoomView>) -> AnyElement {
    let h = |t: &str| div().pt(px(6.)).font_weight(FontWeight::BOLD).child(t.to_owned());
    let p = |t: String| div().text_color(tokens::text_2()).child(t);
    let rents: Vec<String> = STATION_RENT.iter().map(|r| money(*r)).collect();
    let card = div()
        .id("ty-guide-card")
        .w(px(560.))
        .max_w_full()
        .max_h(px(620.))
        .overflow_y_scroll()
        .p(px(18.))
        .rounded(px(14.))
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .gap(px(6.))
        .text_size(px(13.5))
        .child(div().text_size(px(17.)).font_weight(FontWeight::BOLD).child("How to play Tycoon"))
        .child(h("The goal"))
        .child(p("Buy places, charge rent, and be the last one with money. With a round limit (set in the lobby), the richest after the last round wins: cash, places and houses all count.".into()))
        .child(h("Your turn"))
        .child(p("1. Tap 🎲 Roll. Your token moves that many spaces.\n2. Landed on a place nobody owns? Buy it, or say No thanks.\n3. Someone else’s place? You pay them rent, automatically.\n4. Build or make deals if you like, then tap End turn.".into()))
        .child(p(format!(
            "Everyone starts with {} and gets {} each time they pass Start. Doubles: roll again. Three doubles in a row: straight to jail.",
            money(START_CASH),
            money(START_PAY)
        )))
        .child(h("🏗️ Building houses and hotels"))
        .child(p("Own every place of one colour (most colours have 3 places, brown and dark blue have 2). On your turn, tap one of those places and then Build house. Build evenly: every place in the set needs a house before any gets a second one. After 4 houses, the next one is a hotel. Owning a whole set doubles the rent even before you build.".into()))
        .child(h("Transport and utilities"))
        .child(p(format!(
            "Transport rent goes up with how many you own: {}. Utilities charge {}× the dice roll, or {}× if you own both. You can’t build on these.",
            rents.join(", "),
            UTILITY_TIMES[0],
            UTILITY_TIMES[1]
        )))
        .child(h("🤝 Deals"))
        .child(p("Tap Make a deal to offer places and cash to another player for theirs. They accept or decline. Places in a set with houses on it can’t be traded.".into()))
        .child(h("Short of money"))
        .child(p("Mortgage a place for half its price; it charges no rent until you pay that back (plus 10%). Sell houses for half what they cost. If you owe more than you have, raise the money and tap Pay. If you can’t, declare bankruptcy.".into()))
        .child(h("Jail, cards and Coffee Break"))
        .child(p(format!(
            "To get out of jail: pay {}, use a get-out card, or roll doubles (on the third try you pay and go). With the Coffee Break pot rule on, whoever lands on Coffee Break collects every tax and fine paid so far.",
            money(JAIL_FINE)
        )))
        .child(h("Left, or away from the keys?"))
        .child(p("If someone leaves, the game plays for them. If you don’t move for a minute, it plays your turn for you.".into()))
        .child(go_btn("ty-guide-close", "Got it", true).on_click(cx.listener(|v, _, _, cx| {
            v.activity.tycoon.guide = false;
            cx.notify();
        })));
    modal("ty-guide", card, |v, _| v.activity.tycoon.guide = false, cx)
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
    let ui = &view.activity.tycoon;
    let present: Vec<String> = room
        .stores
        .iter()
        .find(|(k, _)| k == KEY)
        .map(|(_, v)| v.presence.members.iter().map(|p| p.as_str().to_owned()).collect())
        .unwrap_or_default();
    let self_id = room.me.as_str().to_owned();
    let host_here = room
        .host
        .as_ref()
        .is_some_and(|h| *h == room.me || present.iter().any(|p| p == h.as_str()));
    let can_manage = room.host.as_ref() == Some(&room.me) || !host_here;
    let me = s.seat_of(&self_id);
    let my_turn = s.phase == "playing" && me >= 0 && s.turn == me;
    let away = |i: usize| {
        s.players
            .get(i)
            .is_some_and(|p| !p.is_bot() && p.id != self_id && !present.contains(&p.id))
    };

    // ---- lobby ----
    if s.phase == "lobby" {
        let joined = me >= 0;
        let n = s.players.len();
        let taken: Vec<&str> = s.players.iter().map(|p| p.token.as_str()).collect();
        let my_color = s.player(me).map(|p| p.color.clone()).unwrap_or_default();
        let my_token = s.player(me).map(|p| p.token.clone()).unwrap_or_default();
        let check = |on: bool| {
            div()
                .size(px(16.))
                .flex_none()
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
        let card = div()
            .id("ty-lobby")
            .w(px(480.))
            .max_w_full()
            .max_h_full()
            .overflow_y_scroll()
            .p(px(20.))
            .rounded(px(16.))
            .bg(tokens::surface())
            .border_1()
            .border_color(tokens::line())
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(
                div()
                    .text_size(px(34.))
                    .font_weight(FontWeight::BLACK)
                    .text_color(tokens::hex(0xe0_393e))
                    .text_center()
                    .child("TYCOON"),
            )
            .child(div().text_size(px(13.)).text_color(tokens::text_2()).text_center().child(
                "Buy famous streets around the world, collect rent, build houses and hotels, make deals. Last one standing wins.",
            ))
            .child(div().flex().justify_center().child(btn("ty-guide-open", "📖 How to play").on_click(cx.listener(|v, _, _, cx| {
                v.activity.tycoon.guide = true;
                cx.notify();
            }))))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .children(s.players.iter().enumerate().map(|(i, p)| {
                        let own = p.id == self_id;
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .child(token_el(ui, &p.token, &p.color, 32., false))
                            .child(
                                div()
                                    .flex_1()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .text_size(px(14.))
                                    .child(if own { format!("{} (you)", p.name) } else { p.name.clone() })
                                    .when(away(i), |el| el.child(tag("away"))),
                            )
                            .when(own || can_manage, |el| {
                                el.child(btn(("ty-remove", i), if own { "Leave" } else { "Remove" }).on_click(cx.listener(
                                    move |v, _, _, cx| {
                                        v.ty_send(if own { act::plain("leave") } else { act::remove(i as i64) }, cx);
                                    },
                                )))
                            })
                    }))
                    .when(s.players.is_empty(), |el| el.child(muted("Nobody yet."))),
            )
            .when(joined, |el| {
                el.child(div().flex().gap(px(6.)).justify_center().children(TOKENS.iter().enumerate().map(|(k, t)| {
                    let t = *t;
                    let mine = my_token == t;
                    let ghost = taken.contains(&t) && !mine;
                    div()
                        .id(("ty-token", k))
                        .p(px(4.))
                        .rounded(px(10.))
                        .border_2()
                        .border_color(if mine { tokens::accent() } else { tokens::surface() })
                        .when(!ghost, Styled::cursor_pointer)
                        .flex()
                        .flex_col()
                        .items_center()
                        .child(token_el(ui, t, &my_color, 34., ghost))
                        .child(div().text_size(px(10.)).text_color(tokens::text_3()).child(token_name(t)))
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if !ghost {
                                v.ty_send(act::token(t), cx);
                            }
                        }))
                })))
            })
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .items_center()
                    .when(!joined && n < 6, |el| {
                        el.child(
                            Button::new("ty-join", "Join the game")
                                .variant(Variant::Primary)
                                .min_height(px(36.))
                                .on_click(cx.listener(|v, _, _, cx| {
                                    let name = v.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
                                    v.ty_send(act::join(&name), cx);
                                })),
                        )
                    })
                    .when(can_manage && n < 6, |el| {
                        el.child(btn("ty-bot", "+ Computer").on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("add-bot"), cx))))
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .text_size(px(13.5))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(if can_manage {
                        "House rules"
                    } else {
                        "House rules (the host sets these)"
                    }))
                    .child({
                        let on = s.rules.jackpot;
                        div()
                            .id("ty-jackpot")
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .when(can_manage, |el| {
                                el.cursor_pointer()
                                    .on_click(cx.listener(move |v, _, _, cx| v.ty_send(act::jackpot(!on), cx)))
                            })
                            .child(check(on))
                            .child(div().flex_1().min_w_0().child("Coffee Break pot: taxes and fines pile up for whoever lands on Coffee Break"))
                    })
                    .child(div().pt(px(4.)).child("Game length"))
                    .children(ROUND_OPTIONS.iter().enumerate().map(|(k, &r)| {
                        let on = s.rules.rounds == r;
                        div()
                            .id(("ty-rounds", k))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .when(can_manage, |el| {
                                el.cursor_pointer()
                                    .on_click(cx.listener(move |v, _, _, cx| v.ty_send(act::rounds(r), cx)))
                            })
                            .child(
                                div()
                                    .size(px(16.))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(tokens::line_strong())
                                    .when(on, |el| el.border_4().border_color(tokens::accent())),
                            )
                            .child(if r == 0 {
                                "Until one player is left".to_owned()
                            } else {
                                format!("{r} rounds, then richest wins")
                            })
                    })),
            )
            .child(if can_manage || joined {
                Button::new(
                    "ty-start",
                    if n < 2 {
                        "Need 2 players".to_owned()
                    } else {
                        format!("Start ({n} players)")
                    },
                )
                .variant(Variant::Primary)
                .full_width()
                .disabled(n < 2)
                .on_click(cx.listener(move |v, _, _, cx| {
                    if n >= 2 {
                        v.ty_send(act::plain("start"), cx);
                    }
                }))
                .into_any_element()
            } else {
                muted("A player or the host starts the game.").into_any_element()
            });
        return div()
            .size_full()
            .relative()
            .child(
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .p(px(16.))
                    .child(card),
            )
            .when(ui.guide, |el| el.child(guide(cx)))
            .into_any_element();
    }

    // ---- table ----
    let current = s.player(s.turn).cloned();
    let debt_total: i64 = s
        .debt
        .as_ref()
        .map_or(0, |d| d.payees.iter().map(|p| p.amount).sum());
    let my_places: Vec<usize> = if me >= 0 {
        (0..40).filter(|&i| s.owner[i] == Some(me)).collect()
    } else {
        Vec::new()
    };
    let can_build_now = my_turn && my_places.iter().any(|&i| s.build_block(me, i as i64).is_none());
    let status = if s.phase == "over" {
        if s.winner == Some(me) && me >= 0 {
            "You won! 🏆".to_owned()
        } else {
            format!(
                "{} won! 🏆",
                s.player(s.winner.unwrap_or(0)).map_or("", |p| p.name.as_str())
            )
        }
    } else if let Some(c) = &current {
        if !my_turn {
            if c.is_bot() {
                format!("{} is playing…", c.name)
            } else if away(usize::try_from(s.turn).unwrap_or(0)) {
                format!("{} left: playing for them shortly.", c.name)
            } else {
                format!("{}'s turn.", c.name)
            }
        } else {
            match s.step.as_str() {
                "roll" if c.jail > 0 => "You’re in jail: roll doubles, pay, or use a card.".to_owned(),
                "roll" if s.doubles > 0 => "Doubles! Roll again.".to_owned(),
                "roll" => "Your turn: roll the dice.".to_owned(),
                "buy" => {
                    let p = usize::try_from(s.pending_buy.unwrap_or(0)).unwrap_or(0);
                    format!("Buy {} for {}?", SPACES[p].name, money(price_of(p)))
                }
                "debt" => format!(
                    "You owe {} ({}). Sell houses or mortgage places, then pay.",
                    money(debt_total),
                    s.debt.as_ref().map_or("", |d| d.reason.as_str())
                ),
                _ if can_build_now => {
                    "You can build: tap a place marked 🏗️ in Your places. Or make a deal, or end your turn."
                        .to_owned()
                }
                _ => "Make a deal, or end your turn.".to_owned(),
            }
        }
    } else {
        String::new()
    };

    // the board: the web app's drawing, what changes over it, and a click target per space
    let highlight = (s.step == "buy")
        .then(|| s.pending_buy.and_then(|p| usize::try_from(p).ok()))
        .flatten();
    let svg = overlay_svg(&s, highlight);
    let overlay = ui.overlay.for_svg(svg, cx);
    let area = ui.area.get();
    let avail_w = area.map_or(640.0, |a| f32::from(a.size.width) - 340.0 - 40.0);
    let avail_h = area.map_or(640.0, |a| f32::from(a.size.height) - 32.0);
    let size = avail_w.min(avail_h).clamp(260.0, 980.0);
    #[allow(clippy::cast_possible_truncation)]
    let k = size / SIZE as f32;
    let hits = (0..40).map(|i| {
        let (x, y, w, h) = space_rect(i);
        #[allow(clippy::cast_possible_truncation)]
        div()
            .id(("ty-space", i))
            .absolute()
            .left(px(x as f32 * k))
            .top(px(y as f32 * k))
            .w(px(w as f32 * k))
            .h(px(h as f32 * k))
            .cursor_pointer()
            .hover(|st| st.bg(tokens::hex(0xff_d34d).opacity(0.18)))
            .on_click(cx.listener(move |v, _, _, cx| {
                v.activity.tycoon.deed = Some(i);
                cx.notify();
            }))
    });
    let card_shown = s.card.as_ref().filter(|c| c.seq != ui.card_seen).and_then(|c| {
        let cards: &[board::Card] = if c.deck == "s" { &SURPRISE } else { &TREASURE };
        let card = cards.get(usize::try_from(c.index).ok()?)?;
        Some((
            c.deck.clone(),
            c.seq,
            card.text,
            s.player(c.seat).map(|p| p.name.clone()).unwrap_or_default(),
        ))
    });
    let board_el = div()
        .relative()
        .flex_none()
        .size(px(size))
        .rounded(px(10.))
        .overflow_hidden()
        .child(img("tycoon/board.svg").absolute().size(px(size)))
        .child(div().absolute().size(px(size)).child(ui.overlay.paint(overlay)))
        .children(hits)
        .when_some(card_shown, |el, (deck, seq, text, who)| {
            el.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .id("ty-card")
                            .w(px(size * 0.42))
                            .p(px(16.))
                            .rounded(px(14.))
                            .bg(if deck == "s" {
                                tokens::hex(0xff_7a1a)
                            } else {
                                tokens::hex(0x3a_a0a5)
                            })
                            .border_2()
                            .border_color(tokens::hex(0x23_252d))
                            .text_color(tokens::white())
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .cursor_pointer()
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.activity.tycoon.card_seen = seq;
                                cx.notify();
                            }))
                            .child(div().font_weight(FontWeight::BLACK).child(if deck == "s" {
                                "❓ SURPRISE"
                            } else {
                                "🎁 TREASURE"
                            }))
                            .child(
                                div()
                                    .text_size(px(15.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(text),
                            )
                            .child(div().text_size(px(12.)).opacity(0.85).child(who)),
                    ),
            )
        });

    // ---- the panel ----
    let mut turn_box = panel_card()
        .border_color(current.as_ref().map_or(tokens::line(), |c| hex_color(&c.color)))
        .child(div().id("ty-status").text_size(px(14.5)).child(status));
    if my_turn && let Some(c) = &current {
        let mut actions = div().flex().flex_wrap().gap(px(8.));
        match s.step.as_str() {
            "roll" => {
                actions = actions.child(
                    go_btn("ty-roll", "🎲 Roll", true)
                        .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("roll"), cx))),
                );
                if c.jail > 0 && c.cash >= JAIL_FINE {
                    actions = actions.child(
                        btn("ty-pay-jail", &format!("Pay {}", money(JAIL_FINE)))
                            .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("pay-jail"), cx))),
                    );
                }
                if c.jail > 0 && !c.jail_cards.is_empty() {
                    actions = actions.child(
                        btn("ty-jail-card", "Use card")
                            .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("jail-card"), cx))),
                    );
                }
            }
            "buy" => {
                let p = usize::try_from(s.pending_buy.unwrap_or(0)).unwrap_or(0);
                let can = c.cash >= price_of(p);
                actions = actions
                    .child(
                        go_btn("ty-buy", &format!("Buy {}", money(price_of(p))), can).on_click(cx.listener(
                            move |v, _, _, cx| {
                                if can {
                                    v.ty_send(act::plain("buy"), cx);
                                }
                            },
                        )),
                    )
                    .child(
                        btn("ty-skip", "No thanks")
                            .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("skip"), cx))),
                    )
                    .child(
                        btn("ty-details", "Details").on_click(cx.listener(move |v, _, _, cx| {
                            v.activity.tycoon.deed = Some(p);
                            cx.notify();
                        })),
                    );
            }
            "debt" => {
                let can = c.cash >= debt_total;
                actions = actions.child(
                    go_btn("ty-pay", &format!("Pay {}", money(debt_total)), can).on_click(cx.listener(
                        move |v, _, _, cx| {
                            if can {
                                v.ty_send(act::plain("pay-debt"), cx);
                            }
                        },
                    )),
                );
                let seq = s.seq;
                actions = actions.child(if ui.confirm_bankrupt == Some(seq) {
                    btn("ty-bankrupt-yes", "Yes, I’m bankrupt")
                        .border_color(tokens::danger_line())
                        .bg(tokens::danger_bg())
                        .text_color(tokens::danger_text())
                        .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("bankrupt"), cx)))
                } else {
                    btn("ty-bankrupt", "Declare bankruptcy").on_click(cx.listener(move |v, _, _, cx| {
                        v.activity.tycoon.confirm_bankrupt = Some(seq);
                        cx.notify();
                    }))
                });
            }
            "done" => {
                actions = actions.child(
                    go_btn("ty-end-turn", "End turn", true)
                        .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("end-turn"), cx))),
                );
            }
            _ => {}
        }
        turn_box = turn_box.child(actions);
    }
    if s.phase == "over" && (can_manage || me >= 0) {
        turn_box = turn_box.child(
            Button::new("ty-again", "Play again")
                .variant(Variant::Primary)
                .min_height(px(36.))
                .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("again"), cx))),
        );
    }
    let mut panel = div()
        .id("ty-panel")
        .w(px(340.))
        .flex_none()
        .max_h_full()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(turn_box);
    if s.phase == "playing"
        && let Some(t) = s.trade.as_ref().filter(|t| t.to == me && me >= 0)
    {
        let (give, get) = trade_summary(&s);
        let from = s.player(t.from).map_or(String::new(), |p| p.name.clone());
        let line = if !give.is_empty() && !get.is_empty() {
            format!("{from} offers {give} for your {get}.")
        } else if !give.is_empty() {
            format!("{from} offers you {give}.")
        } else {
            format!("{from} asks you for {get}.")
        };
        panel = panel.child(
            panel_card()
                .border_color(tokens::warn())
                .child(div().text_size(px(13.5)).child(line))
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            go_btn("ty-accept", "Accept", true)
                                .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::answer(true), cx))),
                        )
                        .child(
                            btn("ty-decline", "Decline")
                                .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::answer(false), cx))),
                        ),
                ),
        );
    }
    if let Some(t) = s.trade.as_ref().filter(|t| t.from == me && me >= 0) {
        let to = s.player(t.to).map_or(String::new(), |p| p.name.clone());
        panel = panel.child(
            panel_card()
                .child(
                    div()
                        .text_size(px(13.5))
                        .child(format!("Waiting for {to} to answer your offer…")),
                )
                .child(
                    btn("ty-withdraw", "Withdraw")
                        .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("trade-cancel"), cx))),
                ),
        );
    }
    panel = panel.child(
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .children(s.players.iter().enumerate().map(|(i, p)| {
                let turn = i as i64 == s.turn && s.phase == "playing";
                let places = (0..40).filter(|&k| s.owner[k] == Some(i as i64)).count();
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(10.))
                    .py(px(6.))
                    .rounded(px(10.))
                    .bg(tokens::surface())
                    .border_1()
                    .border_color(if turn {
                        hex_color(&p.color)
                    } else if s.winner == Some(i as i64) {
                        tokens::live()
                    } else {
                        tokens::line()
                    })
                    .when(p.bankrupt, |el| el.opacity(0.55))
                    .child(token_el(ui, &p.token, &p.color, 28., p.bankrupt))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(5.))
                                    .text_size(px(13.5))
                                    .child(format!(
                                        "{}{}",
                                        p.name,
                                        if i as i64 == me { " (you)" } else { "" }
                                    ))
                                    .when(away(i), |el| el.child(tag("away")))
                                    .when(p.jail > 0, |el| el.child(tag("in jail"))),
                            )
                            .child(div().text_size(px(11.5)).text_color(tokens::text_3()).child(
                                if p.bankrupt {
                                    "bankrupt".to_owned()
                                } else {
                                    format!("{places} places · worth {}", money(s.net_worth(i as i64)))
                                },
                            )),
                    )
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::BOLD)
                            .child(money(p.cash)),
                    )
            })),
    );
    if me >= 0 && s.player(me).is_some_and(|p| !p.bankrupt) && s.phase == "playing" {
        panel = panel
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_size(px(13.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Your places")
                    .when(s.trade.is_none(), |el| {
                        el.child(btn("ty-deal", "🤝 Make a deal").on_click(cx.listener(move |v, _, _, cx| {
                            let first = v
                                .ty_state()
                                .and_then(|s| {
                                    s.players
                                        .iter()
                                        .enumerate()
                                        .find(|(i, p)| *i as i64 != me && !p.bankrupt)
                                        .map(|(i, _)| i as i64)
                                })
                                .unwrap_or(-1);
                            v.activity.tycoon.trading = Some(Draft { to: first, ..Draft::default() });
                            cx.notify();
                        })))
                    }),
            )
            .child(if my_places.is_empty() {
                muted("None yet. Tap any space on the board for details. Own every place of one colour to build houses.").into_any_element()
            } else {
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(5.))
                    .children(my_places.iter().map(|&i| {
                        let set = matches!(SPACES[i].kind, Kind::Property { .. }) && s.owns_group(me, i);
                        let h = s.houses[i];
                        let houses = if h == 5 {
                            " 🏨".to_owned()
                        } else if h > 0 {
                            format!(" {}", "🏠".repeat(usize::try_from(h).unwrap_or(0)))
                        } else {
                            String::new()
                        };
                        div()
                            .id(("ty-chip", i))
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .px(px(8.))
                            .py(px(3.))
                            .rounded_full()
                            .border_1()
                            .border_color(if set { space_color(i) } else { tokens::line_strong() })
                            .when(s.mortgaged[i], |el| el.opacity(0.6))
                            .text_size(px(12.))
                            .cursor_pointer()
                            .child(div().size(px(9.)).rounded_full().bg(space_color(i)))
                            .child(format!("{}{}{}", SPACES[i].name, if set && h == 0 { " 🏗️" } else { "" }, houses))
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.activity.tycoon.deed = Some(i);
                                cx.notify();
                            }))
                    }))
                    .into_any_element()
            });
    }
    panel = panel
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(3.))
                .text_size(px(12.5))
                .text_color(tokens::text_2())
                .children(s.log.iter().rev().take(6).cloned()),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .child(
                    btn("ty-guide-open2", "📖 How to play").on_click(cx.listener(|v, _, _, cx| {
                        v.activity.tycoon.guide = true;
                        cx.notify();
                    })),
                )
                .when(can_manage && s.phase == "playing", |el| {
                    el.child(
                        btn("ty-end-game", "End game now (richest wins)")
                            .on_click(cx.listener(|v, _, _, cx| v.ty_send(act::plain("end-game"), cx))),
                    )
                }),
        );

    let area_cell = Rc::clone(&ui.area);
    let deed_el = ui.deed.map(|p| deed(&s, p, me, cx));
    let trade_el = ui
        .trading
        .clone()
        .filter(|_| me >= 0)
        .map(|d| trade_dialog(&s, me, &d, cx));
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
                .child(board_el)
                .child(panel),
        )
        .children(deed_el)
        .children(trade_el)
        .when(ui.guide, |el| el.child(guide(cx)))
        .into_any_element()
}
