//! Last Card on screen (`lastcard/index.tsx`, `cards.tsx`): the lobby, the table (opponents, the
//! draw and discard piles, your hand) and the colour picker for wilds. What the app does on its
//! own (the computer's turns, getting hidden cards back after the deciding app changed, ...) is
//! `rtc_games::driver`, run for every game by `RoomView::games_after`.

use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, Context, FontWeight, Hsla, div, img, px};
use rtc_core::ActivityCommand;
use rtc_engine::Snapshot;
use rtc_games::lastcard::{
    self, COLORS, Event, MAX_PLAYERS, State, act, card, card_name, color_name, is_wild,
};
use rtc_ui::button::{Button, Variant};
use rtc_ui::tokens;
use serde_json::Value;

use crate::view::RoomView;

const KEY: &str = "act:lastcard";

/// This device's view of the game.
#[derive(Debug, Default)]
pub(crate) struct LastCardUi {
    /// A wild card waiting for its colour: (seq, card).
    picking: Option<(i64, i64)>,
}

/// The cards' colours (`CARD_COLORS`).
fn card_color(c: &str) -> Hsla {
    tokens::hex(match c {
        "r" => 0xe5_484d,
        "y" => 0xf2_b705,
        "g" => 0x2f_a84f,
        "b" => 0x2f_7fe0,
        _ => 0x1d_1f27,
    })
}

fn darker(c: &str) -> Hsla {
    tokens::hex(match c {
        "r" => 0xb9_3338,
        "y" => 0xc9_9300,
        "g" => 0x21_823b,
        "b" => 0x21_5fb0,
        _ => 0x10_1116,
    })
}

/// A card's face, `w` wide (60 × 90 proportions).
fn face(id: i64, w: f32) -> gpui_kit::Div {
    let (c, v) = card(id);
    let u = w / 60.0;
    let symbol = |size: f32| -> AnyElement {
        match v {
            "S" => img("lastcard/skip.svg").size(px(size)).into_any_element(),
            "R" => img("lastcard/reverse.svg").size(px(size)).into_any_element(),
            "W" => img("lastcard/wheel.svg").size(px(size)).into_any_element(),
            "F" => div()
                .relative()
                .size(px(size))
                .flex()
                .items_center()
                .justify_center()
                .child(img("lastcard/wheel.svg").absolute().size(px(size)))
                .child(
                    div()
                        .text_size(px(size * 0.42))
                        .font_weight(FontWeight::BLACK)
                        .text_color(tokens::white())
                        .child("+4"),
                )
                .into_any_element(),
            "D" => div()
                .text_size(px(size * 0.8))
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_color(tokens::white())
                .child("+2")
                .into_any_element(),
            n => div()
                .text_size(px(size))
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_color(tokens::white())
                .child(n.to_owned())
                .into_any_element(),
        }
    };
    let corner = |size: f32| -> AnyElement {
        match v {
            "S" => img("lastcard/skip.svg").size(px(size)).into_any_element(),
            "R" => img("lastcard/reverse.svg").size(px(size)).into_any_element(),
            _ => div()
                .text_size(px(size))
                .line_height(px(size))
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_color(tokens::white())
                .child(
                    match v {
                        "D" => "+2",
                        "F" => "+4",
                        x => x,
                    }
                    .to_owned(),
                )
                .into_any_element(),
        }
    };
    div()
        .relative()
        .flex_none()
        .w(px(w))
        .h(px(w * 1.5))
        .rounded(px(7.0 * u))
        .bg(tokens::white())
        .border_1()
        .border_color(tokens::black(0.25))
        .p(px(3.5 * u))
        .child(
            div()
                .relative()
                .size_full()
                .rounded(px(5.0 * u))
                .bg(card_color(c))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .absolute()
                        .left(px(5.0 * u))
                        .top(px(13.0 * u))
                        .w(px(42.0 * u))
                        .h(px(56.0 * u))
                        .rounded(px(9.0 * u))
                        .bg(darker(c).opacity(0.35)),
                )
                .child(symbol(30.0 * u))
                .child(
                    div()
                        .absolute()
                        .left(px(4.0 * u))
                        .top(px(2.0 * u))
                        .child(corner(10.0 * u)),
                )
                .child(
                    div()
                        .absolute()
                        .right(px(4.0 * u))
                        .bottom(px(2.0 * u))
                        .child(corner(10.0 * u)),
                ),
        )
}

/// The back of a card.
fn back(w: f32) -> gpui_kit::Div {
    let u = w / 60.0;
    div()
        .relative()
        .flex_none()
        .w(px(w))
        .h(px(w * 1.5))
        .flex()
        .items_center()
        .justify_center()
        .child(
            img("lastcard/back.svg")
                .absolute()
                .left_0()
                .top_0()
                .w(px(w))
                .h(px(w * 1.5)),
        )
        .child(
            div()
                .text_size(px(12.0 * u))
                .font_weight(FontWeight::BLACK)
                .text_color(tokens::white())
                .child("LC"),
        )
}

/// What just happened, in words (`eventText`).
fn event_text(e: Option<&Event>, name: &dyn Fn(i64) -> String, me: i64) -> String {
    let Some(e) = e else { return String::new() };
    let who = |seat: i64| if seat == me { "You".to_owned() } else { name(seat) };
    let whom = |seat: i64| if seat == me { "you".to_owned() } else { name(seat) };
    let n = |c: Option<i64>| card_name(c.unwrap_or(0));
    match e.kind.as_str() {
        "start" => format!("{} starts the pile.", n(e.card)),
        "play" => {
            let value = e.card.map(|c| card(c).1);
            let mut text = format!("{} played {}", who(e.seat), n(e.card));
            if let Some(c) = &e.color {
                text += &format!(" → {}", color_name(c));
            }
            let mine = |t: i64, a: &str, b: &str| if t == me { a.to_owned() } else { b.to_owned() };
            match (e.count, e.target) {
                (Some(count), Some(t)) if count != 0 => {
                    text += &format!(
                        ". {} {} {count} and {} skipped",
                        who(t),
                        mine(t, "take", "takes"),
                        mine(t, "are", "is")
                    );
                }
                (_, Some(t)) if matches!(value, Some("S" | "R")) => {
                    text += &format!(". {} {} skipped", who(t), mine(t, "are", "is"));
                }
                _ if value == Some("R") => text += ". Direction reversed",
                _ => {}
            }
            format!("{text}.")
        }
        "draw" => {
            if e.count == Some(1) {
                format!("{} drew a card.", who(e.seat))
            } else {
                format!("{} drew {} cards.", who(e.seat), e.count.unwrap_or(0))
            }
        }
        "take" => format!("{} took {} cards.", who(e.seat), e.count.unwrap_or(0)),
        "pass" => format!("{} kept the card and passed.", who(e.seat)),
        "called" => format!("{} called “Last card!”", who(e.seat)),
        "caught" => format!(
            "{} caught {} not calling “Last card”: +2 cards.",
            who(e.seat),
            whom(e.target.unwrap_or(-1))
        ),
        "restored" => "Cards restored after a reconnect. Play on!".to_owned(),
        "win" => format!("{} won!", who(e.seat)),
        _ => String::new(),
    }
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

fn tag(text: &str, bg: Hsla, fg: Hsla) -> impl IntoElement {
    div()
        .px(px(6.))
        .rounded(px(6.))
        .text_size(px(11.))
        .bg(bg)
        .text_color(fg)
        .child(text.to_owned())
}

fn avatar(bot: bool, name: &str) -> impl IntoElement {
    div()
        .size(px(28.))
        .flex_none()
        .rounded_full()
        .bg(tokens::raised())
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .child(if bot {
            "🤖".to_owned()
        } else {
            name.chars()
                .next()
                .map(|c| c.to_uppercase().collect())
                .unwrap_or_default()
        })
}

impl RoomView {
    fn lc_send(&mut self, action: Value, cx: &mut Context<'_, Self>) {
        self.activity_command(
            ActivityCommand::Dispatch {
                key: KEY.to_owned(),
                action,
            },
            cx,
        );
    }

    fn lc_state(&self) -> Option<State> {
        let r = self.room.as_ref()?;
        let (_, v) = r.stores.iter().find(|(k, _)| k == KEY)?;
        State::from_value(&v.state)
    }

    /// What the bubble says.
    pub(crate) fn lastcard_attention(&self) -> Option<String> {
        let s = self.lc_state()?;
        let me = s.seat_of(self.room.as_ref()?.me.as_str());
        let my_turn = s.phase == "playing" && !s.restoring && me >= 0 && me == s.turn;
        if s.exposed == Some(me) && me >= 0 {
            return Some("Say “Last card!”".to_owned());
        }
        my_turn.then(|| {
            if s.pending_draw > 0 {
                format!("Stack or take {}", s.pending_draw)
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
    let self_id = room.me.as_str().to_owned();
    let host_here = room
        .host
        .as_ref()
        .is_some_and(|h| *h == room.me || present.iter().any(|p| p == h.as_str()));
    let can_manage = room.host.as_ref() == Some(&room.me) || !host_here;
    let me = s.seat_of(&self_id);
    let my_hand = s.hand(me).cloned();
    let my_turn = s.phase == "playing" && !s.restoring && me >= 0 && me == s.turn;
    let players = s.players.clone();
    let name = move |seat: i64| -> String {
        usize::try_from(seat)
            .ok()
            .and_then(|i| players.get(i))
            .map(|p| p.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("Player {}", seat + 1))
    };
    let away = |i: usize| {
        s.players
            .get(i)
            .is_some_and(|p| !p.is_bot() && !present.contains(&p.id))
    };

    // ---- lobby ----
    if s.phase == "lobby" {
        let joined = me >= 0;
        let n = s.players.len();
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
        let rules = [
            (
                "stacking",
                "Stacking: answer +2 with +2 (or +4), the next player takes them all",
                s.rules.stacking,
            ),
            (
                "drawToMatch",
                "Draw until you get a card you can play",
                s.rules.draw_to_match,
            ),
        ];
        let card_ui = div()
            .id("lc-lobby")
            .w(px(460.))
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
                    .flex()
                    .items_center()
                    .gap(px(16.))
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .child(face(34, 44.))
                            .child(div().ml(px(-22.)).mt(px(4.)).child(face(104, 44.)))
                            .child(div().ml(px(-22.)).child(face(73, 44.))),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(div().text_size(px(18.)).font_weight(FontWeight::BOLD).child("Last Card"))
                            .child(div().text_size(px(13.)).text_color(tokens::text_2()).child(
                                "Match the colour or the symbol. First to empty their hand wins. Say “Last card!” when you're down to one.",
                            )),
                    ),
            )
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
                            .child(avatar(p.is_bot(), &p.name))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .text_size(px(14.))
                                    .child(if own { format!("{} (you)", p.name) } else { p.name.clone() })
                                    .when(away(i), |el| el.child(tag("away", tokens::raised(), tokens::text_2())))
                                    .when(p.wins > 0, |el| {
                                        el.child(tag(
                                            &format!("{} win{}", p.wins, if p.wins == 1 { "" } else { "s" }),
                                            tokens::raised(),
                                            tokens::live_text(),
                                        ))
                                    }),
                            )
                            .when(own || can_manage, |el| {
                                el.child(mini_btn(("lc-remove", i), if own { "Leave" } else { "Remove" }).on_click(
                                    cx.listener(move |v, _, _, cx| {
                                        v.lc_send(if own { act::leave() } else { act::remove(i as i64) }, cx);
                                    }),
                                ))
                            })
                    }))
                    .when(s.players.is_empty(), |el| {
                        el.child(div().text_size(px(13.)).text_color(tokens::text_3()).child("Nobody yet."))
                    }),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .items_center()
                    .when(!joined && n < MAX_PLAYERS, |el| {
                        el.child(
                            Button::new("lc-join", "Join the game")
                                .variant(Variant::Primary)
                                .min_height(px(36.))
                                .on_click(cx.listener(|v, _, _, cx| {
                                    let name = v.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
                                    v.lc_send(act::join(&name), cx);
                                })),
                        )
                    })
                    .when(can_manage && n < MAX_PLAYERS, |el| {
                        el.child(
                            mini_btn("lc-bot", "+ Computer")
                                .on_click(cx.listener(|v, _, _, cx| v.lc_send(act::add_bot(), cx))),
                        )
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
                    .children(rules.into_iter().enumerate().map(|(k, (key, label, on))| {
                        div()
                            .id(("lc-rule", k))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .when(can_manage, |el| {
                                el.cursor_pointer()
                                    .on_click(cx.listener(move |v, _, _, cx| v.lc_send(act::rule(key, !on), cx)))
                            })
                            .child(check(on))
                            .child(label)
                    })),
            )
            .child(if can_manage || joined {
                Button::new(
                    "lc-start",
                    if n < 2 {
                        "Need 2 players".to_owned()
                    } else {
                        format!("Deal ({n} players)")
                    },
                )
                .variant(Variant::Primary)
                .full_width()
                .disabled(n < 2)
                .on_click(cx.listener(move |v, _, _, cx| {
                    if n >= 2 {
                        v.lc_send(act::start(), cx);
                    }
                }))
                .into_any_element()
            } else {
                div()
                    .text_size(px(13.))
                    .text_color(tokens::text_3())
                    .child("A player or the host deals.")
                    .into_any_element()
            });
        return div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .p(px(16.))
            .child(card_ui)
            .into_any_element();
    }

    // ---- table ----
    let playable: Vec<i64> = if my_turn { s.playable(me) } else { Vec::new() };
    let n = s.players.len() as i64;
    let others: Vec<usize> = (0..n)
        .map(|k| (if me >= 0 { me } else { -1 } + 1 + k).rem_euclid(n.max(1)))
        .filter(|&i| i != me)
        .filter_map(|i| usize::try_from(i).ok())
        .collect();
    let exposed_other = s.exposed.is_some_and(|x| x != me) && me >= 0;
    let i_me = usize::try_from(me).ok();
    let can_call_ahead = my_turn
        && i_me.is_some_and(|i| s.counts.get(i) == Some(&2) && !s.called.get(i).copied().unwrap_or(false));
    let must_call = me >= 0 && s.exposed == Some(me);
    let status = if s.phase == "over" {
        if s.winner == Some(me) && me >= 0 {
            "You won! 🎉".to_owned()
        } else {
            format!("{} won!", name(s.winner.unwrap_or(0)))
        }
    } else if s.restoring {
        "Someone reconnected: getting everyone’s cards back…".to_owned()
    } else if my_turn {
        if s.pending_draw > 0 {
            if playable.is_empty() {
                format!("Take {} cards.", s.pending_draw)
            } else {
                format!("Stack a draw card or take {}.", s.pending_draw)
            }
        } else if s.drew_this_turn {
            if playable.is_empty() {
                "Your turn."
            } else {
                "Play the card you drew, or keep it."
            }
            .to_owned()
        } else if playable.is_empty() {
            "Nothing to play: draw a card.".to_owned()
        } else {
            "Your turn: play a card or draw.".to_owned()
        }
    } else if usize::try_from(s.turn)
        .ok()
        .and_then(|t| s.players.get(t))
        .is_some_and(lastcard::Player::is_bot)
    {
        format!("{} is thinking…", name(s.turn))
    } else if usize::try_from(s.turn).is_ok_and(away) {
        format!("{} left: playing for them shortly.", name(s.turn))
    } else {
        format!("{}'s turn.", name(s.turn))
    };

    let opponents = others.iter().map(|&i| {
        let p = &s.players[i];
        let count = s.counts.get(i).copied().unwrap_or(0);
        let turn = s.turn == i as i64 && s.phase == "playing";
        let won = s.winner == Some(i as i64);
        div()
            .id(("lc-opp", i))
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(10.))
            .py(px(6.))
            .rounded(px(12.))
            .bg(tokens::surface())
            .border_1()
            .border_color(if turn {
                card_color(&s.color)
            } else if won {
                tokens::live()
            } else {
                tokens::line()
            })
            .child(avatar(p.is_bot(), &p.name))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(13.5))
                            .child(p.name.clone())
                            .when(away(i), |el| {
                                el.child(tag("away", tokens::raised(), tokens::text_2()))
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(12.))
                            .text_color(tokens::text_2())
                            .child(div().flex().children((0..count.min(5)).map(|k| {
                                div()
                                    .w(px(8.))
                                    .h(px(12.))
                                    .when(k > 0, |el| el.ml(px(-4.)))
                                    .rounded(px(2.))
                                    .bg(tokens::hex(0x26_2935))
                                    .border_1()
                                    .border_color(tokens::white())
                            })))
                            .child(format!("{count} card{}", if count == 1 { "" } else { "s" })),
                    ),
            )
            .when(count == 1 && s.exposed != Some(i as i64), |el| {
                el.child(tag("Last card!", tokens::accent(), tokens::white()))
            })
            .when(s.exposed == Some(i as i64) && exposed_other, |el| {
                el.child(
                    Button::new(("lc-catch", i), "Catch!")
                        .variant(Variant::Primary)
                        .min_height(px(30.))
                        .font_size(px(13.))
                        .padding_x(px(12.))
                        .on_click(cx.listener(move |v, _, _, cx| v.lc_send(act::catch(i as i64), cx))),
                )
            })
    });

    let can_draw = my_turn && !s.drew_this_turn;
    let top = s.top();
    let under: Vec<i64> = s.discard.iter().rev().skip(1).take(2).rev().copied().collect();
    let center = div()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(28.))
        .child(
            div()
                .id("lc-draw")
                .relative()
                .when(can_draw, |el| {
                    el.cursor_pointer()
                        .on_click(cx.listener(|v, _, _, cx| v.lc_send(act::draw(), cx)))
                })
                .child(div().absolute().left(px(4.)).top(px(-4.)).child(back(84.)))
                .child(back(84.))
                .child(
                    div()
                        .absolute()
                        .right(px(-8.))
                        .bottom(px(-8.))
                        .px(px(7.))
                        .rounded_full()
                        .bg(tokens::raised())
                        .border_1()
                        .border_color(tokens::line_strong())
                        .text_size(px(12.))
                        .child(s.draw_count.to_string()),
                ),
        )
        .child(
            div()
                .relative()
                .w(px(96.))
                .h(px(140.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(14.))
                .border_2()
                .border_color(card_color(&s.color))
                .children(under.iter().enumerate().map(|(k, &id)| {
                    #[allow(clippy::cast_precision_loss)]
                    let off = (k as f32 - 1.0) * 6.0;
                    div()
                        .absolute()
                        .left(px(6.0 + off))
                        .top(px(7.0 - off))
                        .opacity(0.6)
                        .child(face(id, 84.))
                }))
                .when_some(top, |el, id| el.child(face(id, 84.)))
                .child(
                    div()
                        .absolute()
                        .right(px(-6.))
                        .top(px(-6.))
                        .size(px(16.))
                        .rounded_full()
                        .border_2()
                        .border_color(tokens::white())
                        .bg(card_color(&s.color)),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(4.))
                .text_size(px(26.))
                .text_color(tokens::text_2())
                .child(if s.dir == 1 { "↻" } else { "↺" })
                .when(s.pending_draw > 0, |el| {
                    el.child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(tokens::accent())
                            .child(format!("+{}", s.pending_draw)),
                    )
                }),
        );

    let mut actions = div().flex().items_center().gap(px(8.));
    if my_turn && s.drew_this_turn {
        actions = actions.child(
            mini_btn("lc-keep", "Keep it").on_click(cx.listener(|v, _, _, cx| v.lc_send(act::pass(), cx))),
        );
    }
    if my_turn && !s.drew_this_turn {
        let label = if s.pending_draw > 0 {
            format!("Take {}", s.pending_draw)
        } else {
            "Draw".to_owned()
        };
        actions = actions.child(
            mini_btn("lc-draw-btn", &label).on_click(cx.listener(|v, _, _, cx| v.lc_send(act::draw(), cx))),
        );
    }
    if can_call_ahead || must_call {
        actions = actions.child(
            Button::new("lc-call", "Last card!")
                .variant(if must_call {
                    Variant::Primary
                } else {
                    Variant::Secondary
                })
                .min_height(px(32.))
                .font_size(px(13.))
                .padding_x(px(14.))
                .on_click(cx.listener(|v, _, _, cx| v.lc_send(act::call(), cx))),
        );
    }
    if s.phase == "over" && (can_manage || me >= 0) {
        actions = actions.child(
            Button::new("lc-again", "Play again")
                .variant(Variant::Primary)
                .min_height(px(36.))
                .on_click(cx.listener(|v, _, _, cx| v.lc_send(act::again(), cx))),
        );
    }
    let status_row = div()
        .flex()
        .flex_wrap()
        .items_center()
        .justify_center()
        .gap(px(12.))
        .child(
            div()
                .id("lc-status")
                .max_w(px(560.))
                .text_size(px(15.))
                .text_center()
                .child(status)
                .when(s.phase != "over", |el| {
                    el.child(
                        div()
                            .text_size(px(13.))
                            .text_color(tokens::text_2())
                            .child(event_text(s.event.as_ref(), &name, me)),
                    )
                }),
        )
        .child(actions);

    let hand_el = if me >= 0 {
        match &my_hand {
            Some(hand) => {
                let count = hand.len();
                #[allow(clippy::cast_precision_loss)]
                let overlap = if count > 7 {
                    (0.38 + (count - 7) as f32 * 0.035).min(0.72)
                } else {
                    0.38
                };
                let w = 76.0_f32;
                let picking_card = view
                    .activity
                    .lastcard
                    .picking
                    .filter(|(q, _)| *q == s.seq)
                    .map(|(_, c)| c);
                div()
                    .flex()
                    .justify_center()
                    .pt(px(14.))
                    .children(hand.iter().enumerate().map(|(k, &id)| {
                        let ok = playable.contains(&id);
                        let drawn = s.drew_this_turn && my_turn && k + 1 == count;
                        div()
                            .id(("lc-card", usize::try_from(id).unwrap_or(0)))
                            .when(k > 0, |el| el.ml(px(-w * overlap)))
                            .when(ok, |el| el.mt(px(-12.)).cursor_pointer())
                            .when(!ok && my_turn, |el| el.opacity(0.55))
                            .when(drawn || picking_card == Some(id), |el| el.mt(px(-18.)))
                            .child(face(id, w))
                            .when(ok, |el| {
                                el.on_click(cx.listener(move |v, _, _, cx| {
                                    let seq = v.lc_state().map_or(0, |x| x.seq);
                                    if is_wild(id) {
                                        v.activity.lastcard.picking = Some((seq, id));
                                        cx.notify();
                                    } else {
                                        v.lc_send(act::play(id, None), cx);
                                    }
                                }))
                            })
                    }))
                    .into_any_element()
            }
            None => div()
                .text_size(px(13.))
                .text_color(tokens::text_3())
                .child("Getting your cards…")
                .into_any_element(),
        }
    } else {
        div()
            .text_size(px(13.))
            .text_color(tokens::text_3())
            .child("You're watching this game.")
            .into_any_element()
    };

    let scores = (s.phase == "over").then(|| {
        div()
            .flex()
            .flex_wrap()
            .justify_center()
            .gap(px(8.))
            .children(s.players.iter().enumerate().map(|(i, p)| {
                let won = s.winner == Some(i as i64);
                div()
                    .px(px(10.))
                    .py(px(4.))
                    .rounded_full()
                    .text_size(px(13.))
                    .bg(if won {
                        tokens::live().opacity(0.2)
                    } else {
                        tokens::raised()
                    })
                    .text_color(if won {
                        tokens::live_text()
                    } else {
                        tokens::text_2()
                    })
                    .child(format!("{}: {}", p.name, p.wins))
            }))
    });

    let picker =
        view.activity
            .lastcard
            .picking
            .filter(|(q, _)| *q == s.seq && my_turn)
            .map(|(_, id)| {
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(tokens::black(0.5))
                    .child(
                        div()
                            .p(px(18.))
                            .rounded(px(16.))
                            .bg(tokens::surface())
                            .border_1()
                            .border_color(tokens::line())
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(14.))
                            .child(
                                div()
                                    .text_size(px(15.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Pick a colour"),
                            )
                            .child(div().flex().gap(px(12.)).children(COLORS.iter().enumerate().map(
                                |(k, c)| {
                                    let c = *c;
                                    div()
                                        .id(("lc-pick", k))
                                        .size(px(52.))
                                        .rounded(px(12.))
                                        .bg(card_color(c))
                                        .cursor_pointer()
                                        .hover(|st| st.border_2().border_color(tokens::white()))
                                        .on_click(cx.listener(move |v, _, _, cx| {
                                            v.activity.lastcard.picking = None;
                                            v.lc_send(act::play(id, Some(c)), cx);
                                        }))
                                },
                            )))
                            .child(mini_btn("lc-pick-cancel", "Cancel").on_click(cx.listener(
                                |v, _, _, cx| {
                                    v.activity.lastcard.picking = None;
                                    cx.notify();
                                },
                            ))),
                    )
            });

    div()
        .id("lc-table")
        .size_full()
        .relative()
        .child(
            div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .p(px(16.))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .justify_center()
                        .gap(px(8.))
                        .children(opponents),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(16.))
                        .child(center)
                        .child(status_row),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(10.))
                        .child(hand_el)
                        .children(scores),
                ),
        )
        .children(picker)
        .into_any_element()
}
