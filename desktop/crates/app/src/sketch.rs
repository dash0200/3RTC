//! Sketch on screen (`sketch/index.tsx`): one person draws a word, everyone else guesses
//! (`rtc_games::sketch`). The board is a whiteboard of its own each turn (`act:sketch:t<turn>`,
//! drawn by [`crate::whiteboard::board`]): the drawer draws, the others watch it live. Guesses are
//! typed here, not in the room chat, so a right answer never spoils it for the others.
//!
//! Opening it is joining it. The deciding app keeps time: it sends `tick` twice a second while a
//! turn is on.

use std::time::Duration;

use gpui_kit::component::input::Input;
use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, Context, FontWeight, ScrollHandle, Window, div, px};
use rtc_core::ActivityCommand;
use rtc_engine::Snapshot;
use rtc_games::sketch::{FeedLine, MAX_PLAYERS, ROUNDS, State, act, board_key};
use rtc_ui::button::{Button, Variant};
use rtc_ui::tokens;
use serde_json::Value;

use crate::view::{RoomView, now_ms};
use crate::whiteboard::Mode;

const KEY: &str = rtc_games::sketch::KEY;
/// How often the screen redraws while a turn is on (the clock); every second one, the deciding
/// app also sends `tick`.
const FRAME: Duration = Duration::from_millis(250);

/// This device's Sketch.
#[derive(Debug, Default)]
pub(crate) struct SketchUi {
    /// The clock is running (redraws, and ticks on the deciding app).
    ticking: bool,
    /// The turn whose board we have (let go when the turn changes).
    board_turn: Option<i64>,
    /// That board's store was opened.
    board_open: bool,
    /// We asked to join and haven't seen ourselves in the game yet.
    asked_join: bool,
    /// For sounds and scrolling: the phase, guesses and drawer last time, and the feed's length.
    last: Option<(String, usize, Option<String>)>,
    feed_len: usize,
    /// The guesses list.
    pub(crate) feed_scroll: ScrollHandle,
}

impl RoomView {
    fn sk_send(&mut self, action: Value, cx: &mut Context<'_, Self>) {
        self.activity_command(
            ActivityCommand::Dispatch {
                key: KEY.to_owned(),
                action,
            },
            cx,
        );
    }

    fn sk_state(&self) -> Option<State> {
        let r = self.room.as_ref()?;
        let (_, v) = r.stores.iter().find(|(k, _)| k == KEY)?;
        State::from_value(&v.state)
    }

    fn sk_deciding(&self) -> bool {
        self.room.as_ref().is_some_and(|r| {
            r.stores
                .iter()
                .find(|(k, _)| k == KEY)
                .is_some_and(|(_, v)| v.presence.authority.as_ref() == Some(&r.me))
        })
    }

    /// What the bubble says.
    pub(crate) fn sketch_attention(&self) -> Option<String> {
        let s = self.sk_state()?;
        let me = self.room.as_ref()?.me.as_str().to_owned();
        match s.phase.as_str() {
            "picking" if s.drawer.as_deref() == Some(me.as_str()) => Some("Your turn to draw".into()),
            "drawing" => Some(format!("{} is drawing", name_of(&s, s.drawer.as_deref()))),
            _ => None,
        }
    }

    /// After every room update: join, the turn's board (the whiteboard view draws it), sounds,
    /// and the clock.
    pub(crate) fn sketch_after(&mut self, cx: &mut Context<'_, Self>) {
        let Some(s) = self.sk_state() else {
            if let Some(old) = self.activity.sketch.board_turn.take() {
                self.sk_release_board(old, cx);
            }
            let ui = &mut self.activity.sketch;
            ui.board_open = false;
            ui.asked_join = false;
            ui.last = None;
            ui.feed_len = 0;
            if self.activity.board.base.starts_with(KEY) {
                self.activity.board.base.clear();
            }
            return;
        };
        let Some(r) = self.room.as_ref() else { return };
        let me = r.me.as_str().to_owned();
        let name = if r.username.is_empty() {
            "Someone".to_owned()
        } else {
            r.username.clone()
        };

        // opening it is joining it
        if s.player(&me).is_some() {
            self.activity.sketch.asked_join = false;
        } else if !self.activity.sketch.asked_join && s.players.len() < MAX_PLAYERS {
            self.activity.sketch.asked_join = true;
            self.sk_send(act::join(&name), cx);
        }

        // this turn's board (the last one stays up during the reveal); old ones are let go
        let turn = s.board_turn();
        if self.activity.sketch.board_turn != Some(turn) {
            if let Some(old) = self.activity.sketch.board_turn.replace(turn) {
                self.sk_release_board(old, cx);
            }
            self.activity.sketch.board_open = false;
        }
        let key = board_key(turn);
        self.activity.board.base.clone_from(&key);
        if (s.phase == "drawing" || s.phase == "reveal") && !self.activity.sketch.board_open {
            self.activity.sketch.board_open = true;
            self.activity_command(ActivityCommand::Open(key), cx);
        }

        // sounds: our turn to draw, someone got it
        let drawing = s.drawer.as_deref() == Some(me.as_str());
        let now = (s.phase.clone(), s.guessed.len(), s.drawer.clone());
        if let Some((phase, guessed, drawer)) = self.activity.sketch.last.replace(now) {
            if s.phase == "picking" && drawing && (phase != "picking" || drawer != s.drawer) {
                self.ui_sound(&crate::sounds::CHIME, crate::sounds::CHIME_WAV.as_slice());
            } else if s.guessed.len() > guessed && s.phase == "drawing" {
                self.ui_sound(&crate::sounds::POP, crate::sounds::POP_WAV.as_slice());
            }
        }
        if s.feed.len() != self.activity.sketch.feed_len {
            self.activity.sketch.feed_len = s.feed.len();
            self.activity.sketch.feed_scroll.scroll_to_bottom();
        }

        // the clock
        let on = matches!(s.phase.as_str(), "picking" | "drawing" | "reveal");
        if on && !self.activity.sketch.ticking {
            self.activity.sketch.ticking = true;
            cx.spawn(async move |v, cx| {
                let mut n: u64 = 0;
                loop {
                    cx.background_executor().timer(FRAME).await;
                    n += 1;
                    let going = v.update(cx, |v, cx| {
                        let on = v
                            .sk_state()
                            .is_some_and(|s| matches!(s.phase.as_str(), "picking" | "drawing" | "reveal"));
                        if !on {
                            v.activity.sketch.ticking = false;
                            return false;
                        }
                        if n.is_multiple_of(2) && v.sk_deciding() {
                            v.sk_send(act::tick(), cx);
                        }
                        cx.notify();
                        true
                    });
                    if !matches!(going, Ok(true)) {
                        break;
                    }
                }
            })
            .detach();
        }
    }

    /// Lets go of a turn's board: its index and its chunks.
    fn sk_release_board(&mut self, turn: i64, cx: &mut Context<'_, Self>) {
        let key = board_key(turn);
        self.activity_command(ActivityCommand::Release(format!("{key}:")), cx);
        // the index itself (only it: `act:sketch:t1` must not take `act:sketch:t12` along)
        let others = self.room.as_ref().is_some_and(|r| {
            r.stores
                .iter()
                .any(|(k, _)| k.starts_with(&key) && *k != key && !k.starts_with(&format!("{key}:")))
        });
        if !others {
            self.activity_command(ActivityCommand::Release(key), cx);
        }
    }

    /// Sends what's in the guess box.
    pub(crate) fn sk_guess(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let text = self.sketch_guess.read(cx).value().trim().to_owned();
        let Some(s) = self.sk_state() else { return };
        let Some(me) = self.room.as_ref().map(|r| r.me.as_str().to_owned()) else {
            return;
        };
        if text.is_empty() || !can_guess(&s, &me) {
            return;
        }
        self.sketch_guess.update(cx, |m, cx| m.set_value("", window, cx));
        self.sk_send(act::guess(&text), cx);
    }
}

fn name_of(s: &State, id: Option<&str>) -> String {
    id.and_then(|id| s.player(id))
        .map(|p| p.name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Someone".to_owned())
}

fn can_guess(s: &State, me: &str) -> bool {
    s.phase == "drawing"
        && s.player(me).is_some()
        && s.drawer.as_deref() != Some(me)
        && !s.guessed.iter().any(|g| g == me)
}

fn sk_btn(id: impl Into<gpui_kit::ElementId>, label: &str) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .h(px(34.))
        .px(px(14.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(9.))
        .border_1()
        .border_color(tokens::line_strong())
        .bg(tokens::surface())
        .text_size(px(14.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(tokens::text())
        .cursor_pointer()
        .hover(|s| s.bg(tokens::raised()))
        .child(label.to_owned())
}

fn feed_line(l: &FeedLine) -> AnyElement {
    let (color, weight) = match l.kind.as_str() {
        "correct" => (tokens::live_text(), FontWeight::SEMIBOLD),
        "close" => (tokens::warn(), FontWeight::SEMIBOLD),
        "info" => (tokens::text_3(), FontWeight::NORMAL),
        _ => (tokens::text(), FontWeight::NORMAL),
    };
    let row = div().text_size(px(13.)).text_color(color).font_weight(weight);
    if l.kind == "guess" {
        row.flex()
            .flex_wrap()
            .gap(px(4.))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(format!("{}:", l.name)),
            )
            .child(l.text.clone())
            .into_any_element()
    } else {
        row.child(l.text.clone()).into_any_element()
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
    let me = room.me.as_str().to_owned();
    let present: Vec<String> = room
        .stores
        .iter()
        .find(|(k, _)| k == KEY)
        .map(|(_, v)| v.presence.members.iter().map(|p| p.as_str().to_owned()).collect())
        .unwrap_or_default();
    let joined = s.player(&me).is_some();
    let drawing = s.drawer.as_deref() == Some(me.as_str());
    let i_guessed = s.guessed.contains(&me);
    let guessing = can_guess(&s, &me);
    #[allow(clippy::cast_possible_wrap)]
    let now = now_ms() as i64;
    let seconds_left = if s.deadline > 0 {
        ((s.deadline - now).max(0) + 999) / 1000
    } else {
        0
    };
    let turns = s.total_turns();
    let round = (s.turn / (s.players.len() as i64).max(1) + 1).min(ROUNDS);
    let mut ranked = s.players.clone();
    ranked.sort_by_key(|p| std::cmp::Reverse(p.score));
    let enough = s.players.iter().filter(|p| present.contains(&p.id)).count() >= 2;
    let drawer_name = name_of(&s, s.drawer.as_deref());

    // ---- what the top bar says ----
    let timer = |secs: i64| {
        div()
            .px(px(8.))
            .py(px(2.))
            .rounded(px(7.))
            .bg(if secs <= 10 {
                tokens::danger_bg()
            } else {
                tokens::raised()
            })
            .text_color(if secs <= 10 {
                tokens::danger_text()
            } else {
                tokens::text()
            })
            .font_weight(FontWeight::BOLD)
            .child(format!("{secs}s"))
    };
    let banner: AnyElement = match s.phase.as_str() {
        "lobby" => div()
            .child(format!(
                "{} player{} ready{}",
                s.players.len(),
                if s.players.len() == 1 { "" } else { "s" },
                if enough { "" } else { " · needs 2 or more" }
            ))
            .into_any_element(),
        "picking" => div()
            .child(if drawing {
                format!("Pick a word to draw · {seconds_left}s")
            } else {
                format!("{drawer_name} is picking a word… {seconds_left}s")
            })
            .into_any_element(),
        "drawing" => {
            let word = if drawing {
                div()
                    .text_size(px(20.))
                    .font_weight(FontWeight::BOLD)
                    .child(s.word.clone())
            } else {
                div().flex().gap(px(5.)).children(s.hint.chars().map(|c| {
                    if c == ' ' {
                        div().w(px(10.))
                    } else {
                        div()
                            .w(px(16.))
                            .h(px(26.))
                            .border_b_2()
                            .border_color(tokens::text())
                            .flex()
                            .justify_center()
                            .text_size(px(19.))
                            .font_weight(FontWeight::BOLD)
                            .child(if c == '_' { String::new() } else { c.to_string() })
                    }
                }))
            };
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(word)
                .when(!drawing, |el| {
                    el.child(
                        div()
                            .text_size(px(12.))
                            .text_color(tokens::text_3())
                            .child(s.length.to_string()),
                    )
                })
                .child(timer(seconds_left))
                .into_any_element()
        }
        "reveal" => {
            if s.revealed.is_empty() {
                div().child("Next turn…").into_any_element()
            } else {
                div()
                    .flex()
                    .gap(px(5.))
                    .child("The word was")
                    .child(div().font_weight(FontWeight::BOLD).child(s.revealed.clone()))
                    .into_any_element()
            }
        }
        _ => div()
            .child(format!(
                "Game over · {}",
                ranked
                    .first()
                    .map(|p| format!("{} wins!", p.name))
                    .unwrap_or_default()
            ))
            .into_any_element(),
    };
    let top = div()
        .flex()
        .items_center()
        .gap(px(12.))
        .px(px(14.))
        .py(px(8.))
        .border_b_1()
        .border_color(tokens::line())
        .child(
            div()
                .flex_none()
                .text_size(px(13.))
                .text_color(tokens::text_2())
                .font_weight(FontWeight::SEMIBOLD)
                .child(if s.phase == "lobby" || s.phase == "over" {
                    "Sketch".to_owned()
                } else {
                    format!("Round {round} of {ROUNDS}")
                }),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .justify_center()
                .text_size(px(15.))
                .text_color(tokens::text())
                .child(banner),
        )
        .when((s.phase == "picking" || s.phase == "drawing") && drawing, |el| {
            el.child(
                sk_btn("sk-skip", "Skip").on_click(cx.listener(|v, _, _, cx| v.sk_send(act::skip(), cx))),
            )
        });

    // ---- the board area ----
    let center = || {
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(14.))
            .p(px(20.))
    };
    let lead = |t: String| {
        div()
            .max_w(px(420.))
            .text_size(px(15.))
            .text_color(tokens::text_2())
            .text_center()
            .child(t)
    };
    let main: AnyElement = match s.phase.as_str() {
        "lobby" | "over" => {
            let over = s.phase == "over";
            let mut c = center();
            if over {
                c = c.child(div().flex().flex_col().gap(px(6.)).children(
                    ranked.iter().take(3).enumerate().map(|(i, p)| {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_size(px(17.))
                            .child(["🥇", "🥈", "🥉"][i])
                            .child(p.name.clone())
                            .child(div().font_weight(FontWeight::BOLD).child(p.score.to_string()))
                    }),
                ));
            }
            c.child(lead(if over {
                "Thanks for playing!".to_owned()
            } else {
                format!(
                    "Take turns drawing a word while everyone else guesses. Everyone draws {ROUNDS} times."
                )
            }))
            .child(if over {
                Button::new("sk-again", "Play again")
                    .variant(Variant::Primary)
                    .min_height(px(38.))
                    .disabled(!joined)
                    .on_click(cx.listener(|v, _, _, cx| v.sk_send(act::again(), cx)))
            } else {
                Button::new("sk-start", if enough { "Start" } else { "Waiting for players…" })
                    .variant(Variant::Primary)
                    .min_height(px(38.))
                    .disabled(!joined || !enough)
                    .on_click(cx.listener(|v, _, _, cx| v.sk_send(act::start(), cx)))
            })
            .into_any_element()
        }
        "picking" if drawing => center()
            .child(lead("Pick a word to draw".to_owned()))
            .child(div().flex().flex_wrap().justify_center().gap(px(10.)).children(
                s.choices.iter().enumerate().map(|(i, w)| {
                    sk_btn(("sk-choice", i), w)
                        .h(px(44.))
                        .px(px(20.))
                        .text_size(px(16.))
                        .on_click(cx.listener(move |v, _, _, cx| v.sk_send(act::pick(i), cx)))
                }),
            ))
            .into_any_element(),
        "picking" => center()
            .child(lead(format!("{drawer_name} is picking a word…")))
            .into_any_element(),
        _ => {
            let key = board_key(s.board_turn());
            let board = room
                .stores
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.state.clone());
            match board {
                Some(b) if view.activity.board.base == key => {
                    let mode = Mode {
                        read_only: !drawing || s.phase != "drawing",
                        game: true,
                        can_clear: drawing,
                        empty: Some(if drawing {
                            format!("Draw “{}” (no letters!)", s.word)
                        } else {
                            format!("{drawer_name} is about to draw…")
                        }),
                    };
                    crate::whiteboard::board(view, room, &b, &mode, cx)
                }
                _ => center().child(lead("Loading…".to_owned())).into_any_element(),
            }
        }
    };

    // ---- the side: scores, guesses, the guess box ----
    let players = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .children(ranked.iter().map(|p| {
            let is_drawer = s.drawer.as_deref() == Some(p.id.as_str());
            let done = s.guessed.contains(&p.id);
            let away = !present.contains(&p.id);
            let gained = s.gained.get(&p.id).copied().unwrap_or(0);
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(10.))
                .py(px(6.))
                .rounded(px(8.))
                .when(is_drawer, |el| el.bg(tokens::raised()))
                .when(away, |el| el.opacity(0.5))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(13.5))
                        .text_color(tokens::text())
                        .child(format!(
                            "{}{}{}",
                            if is_drawer {
                                "✏️ "
                            } else if done {
                                "✅ "
                            } else {
                                ""
                            },
                            p.name,
                            if p.id == me { " (you)" } else { "" }
                        )),
                )
                .when(s.phase == "reveal" && gained > 0, |el| {
                    el.child(
                        div()
                            .text_size(px(12.))
                            .text_color(tokens::live_text())
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(format!("+{gained}")),
                    )
                })
                .child(
                    div()
                        .text_size(px(13.5))
                        .font_weight(FontWeight::BOLD)
                        .child(p.score.to_string()),
                )
        }));
    let feed = div()
        .id("sk-feed")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .track_scroll(&view.activity.sketch.feed_scroll)
        .p(px(10.))
        .rounded(px(10.))
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .gap(px(4.))
        .children(s.feed.iter().map(feed_line));
    let hint = if drawing {
        "You are drawing"
    } else if i_guessed {
        "You got it!"
    } else if s.phase == "drawing" {
        "Type your guess, then Enter"
    } else {
        "Guesses go here"
    };
    let has_text = !view.sketch_guess.read(cx).value().trim().is_empty();
    let guess_box = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .h(px(36.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .rounded(px(9.))
                        .border_1()
                        .border_color(tokens::line_strong())
                        .bg(tokens::surface())
                        .when(!guessing, |el| el.opacity(0.5))
                        // `sk_guess` ignores the box while guessing isn't allowed
                        .child(Input::new(&view.sketch_guess).appearance(false)),
                )
                .child(
                    Button::new("sk-guess", "Guess")
                        .variant(Variant::Primary)
                        .min_height(px(36.))
                        .disabled(!guessing || !has_text)
                        .on_click(cx.listener(|v, _, window, cx| v.sk_guess(window, cx))),
                ),
        )
        .child(div().text_size(px(11.5)).text_color(tokens::text_3()).child(hint));
    let side = div()
        .w(px(270.))
        .flex_none()
        .h_full()
        .min_h_0()
        .flex()
        .flex_col()
        .gap(px(10.))
        .p(px(12.))
        .border_l_1()
        .border_color(tokens::line())
        .child(players)
        .child(feed)
        .child(guess_box)
        .when(s.phase != "lobby" && s.phase != "over", |el| {
            el.child(
                div()
                    .text_size(px(12.))
                    .text_color(tokens::text_3())
                    .child(format!("Turn {} of {turns}", (s.turn + 1).min(turns))),
            )
        });

    div()
        .size_full()
        .flex()
        .flex_col()
        .child(top)
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .child(div().flex_1().min_w_0().h_full().child(main))
                .child(side),
        )
        .into_any_element()
}
