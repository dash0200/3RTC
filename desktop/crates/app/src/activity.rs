//! Activities on screen (`ActivityStage.tsx`, `ActivityBubble.tsx`, the dock's "Play together"
//! menu): the open game over the stage with its bar (Minimise, Leave, End), the round bubble it
//! becomes when minimised, the "Join <game>" bubble when it isn't loaded here, and the card for a
//! game this version doesn't have.
//!
//! A game is drawn by GPUI over the stage; a video's own window would cover it, so the video
//! hides while the game is open full size and comes back when it's minimised.

use std::time::{Duration, Instant};

use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, Context, FontWeight, MouseButton, deferred, div, px};
use rtc_core::{ActivityCommand, ActivityView, Command};
use rtc_engine::Snapshot;
use rtc_ui::button::{Button, Variant};
use rtc_ui::overlay::{menu, menu_item};
use rtc_ui::tokens;
use serde_json::Value;

use crate::view::RoomView;

/// How long "End for all?" waits for the second tap.
const CONFIRM: Duration = Duration::from_secs(4);

/// The open game on this device.
#[derive(Debug, Default)]
pub(crate) struct ActivityUi {
    /// Shown as its bubble (else full size over the stage).
    pub(crate) minimised: bool,
    /// "End" was tapped once: a second tap until then ends it for everyone.
    confirm_end: Option<Instant>,
    /// The opening shown (a new one opens full size).
    shown: Option<String>,
    /// Chess on this device.
    pub(crate) chess: crate::chess::ChessUi,
    /// Ludo on this device.
    pub(crate) ludo: crate::ludo::LudoUi,
    /// Last Card on this device.
    pub(crate) lastcard: crate::lastcard::LastCardUi,
    /// Tycoon on this device.
    pub(crate) tycoon: crate::tycoon::TycoonUi,
    /// The whiteboard on this device.
    pub(crate) board: crate::whiteboard::BoardUi,
    /// Sketch on this device.
    pub(crate) sketch: crate::sketch::SketchUi,
    /// What each game's state wants this app to do on its own (`rtc_games::driver`).
    drivers: std::collections::HashMap<String, rtc_games::driver::Driver>,
}

impl RoomView {
    fn activity_now(&self) -> Option<ActivityView> {
        self.room.as_ref().and_then(|r| r.activity.clone())
    }

    /// The open game covers the stage (the video's window hides under it).
    pub(crate) fn activity_covers(&self) -> bool {
        self.activity_now()
            .is_some_and(|a| !a.known || (a.loaded && !self.activity.minimised))
    }

    /// The room snapshot changed: a newly opened (or joined) game opens full size.
    pub(crate) fn activity_changed(&mut self) {
        let key = self
            .activity_now()
            .filter(|a| a.loaded)
            .map(|a| a.current.load_key());
        if key != self.activity.shown {
            self.activity.shown = key;
            self.activity.minimised = false;
            self.activity.confirm_end = None;
        }
    }

    pub(crate) fn activity_command(&mut self, c: ActivityCommand, cx: &mut Context<'_, Self>) {
        self.command(Command::Activity(c));
        cx.notify();
    }

    fn end_activity(&mut self, cx: &mut Context<'_, Self>) {
        let confirming = self.activity.confirm_end.is_some_and(|t| t.elapsed() < CONFIRM);
        if confirming {
            self.activity.confirm_end = None;
            self.activity_command(ActivityCommand::End, cx);
        } else {
            self.activity.confirm_end = Some(Instant::now());
            cx.spawn(async move |v, cx| {
                cx.background_executor().timer(CONFIRM).await;
                let _ = v.update(cx, |_, cx| cx.notify());
            })
            .detach();
            cx.notify();
        }
    }

    /// After every room update: what each game wants this app to do on its own (play for the
    /// computer on the deciding app, ask a seat back, hand cards to a new deciding app...), sent
    /// now or after its delay.
    pub(crate) fn games_after(&mut self, cx: &mut Context<'_, Self>) {
        let Some(r) = self.room.as_ref() else { return };
        let mut wanted = Vec::new();
        for (key, v) in &r.stores {
            let present: Vec<String> = v.presence.members.iter().map(|p| p.as_str().to_owned()).collect();
            let seen = rtc_games::driver::Seen {
                me: r.me.as_str(),
                client_id: r.client_id.as_str(),
                name: &r.username,
                present: &present,
                deciding: v.presence.authority.as_ref() == Some(&r.me),
            };
            let driver = self.activity.drivers.entry(key.clone()).or_default();
            wanted.extend(
                driver
                    .update(key, &v.state, &seen)
                    .into_iter()
                    .map(|w| (key.clone(), w)),
            );
        }
        let keys: Vec<String> = r.stores.iter().map(|(k, _)| k.clone()).collect();
        self.activity.drivers.retain(|k, _| keys.contains(k));
        for (key, w) in wanted {
            let action = ActivityCommand::Dispatch {
                key,
                action: w.action,
            };
            if w.delay_ms == 0 {
                self.activity_command(action, cx);
                continue;
            }
            cx.spawn(async move |v, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(w.delay_ms))
                    .await;
                let _ = v.update(cx, |v, cx| v.activity_command(action, cx));
            })
            .detach();
        }
    }

    pub(crate) fn start_activity(&mut self, id: &'static str, cx: &mut Context<'_, Self>) {
        self.pop = None;
        self.activity_command(ActivityCommand::Start(id.to_owned()), cx);
    }
}

fn bar_btn(id: &'static str, label: &str) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .h(px(32.))
        .px(px(12.))
        .flex()
        .items_center()
        .rounded(px(9.))
        .border_1()
        .border_color(tokens::line())
        .bg(tokens::surface())
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(tokens::text())
        .cursor_pointer()
        .hover(|s| s.bg(tokens::raised()).border_color(tokens::line_strong()))
        .child(label.to_owned())
}

/// The open game, full size over the stage (or the card for one this version doesn't have).
pub(crate) fn stage(view: &RoomView, room: &Snapshot, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let Some(a) = room.activity.clone() else {
        return div().into_any_element();
    };
    if !a.known {
        // opened from a newer app
        let who = if a.current.started_by_name.is_empty() {
            "Someone".to_owned()
        } else {
            a.current.started_by_name.clone()
        };
        return div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .max_w(px(460.))
                    .p(px(24.))
                    .rounded(px(16.))
                    .bg(tokens::surface())
                    .border_1()
                    .border_color(tokens::line())
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .child(div().text_size(px(15.)).text_color(tokens::text()).child(format!(
                        "{who} opened an activity this version of 3RTC doesn't have yet."
                    )))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(
                                Button::new("act-update", "Update app")
                                    .variant(Variant::Primary)
                                    .on_click(cx.listener(|v, _, _, cx| v.check_updates(true, cx))),
                            )
                            .child(
                                Button::new("act-close", "Close it")
                                    .variant(Variant::Secondary)
                                    .on_click(cx.listener(|v, _, _, cx| {
                                        v.activity_command(ActivityCommand::End, cx);
                                    })),
                            ),
                    ),
            )
            .into_any_element();
    }
    let Some(def) = rtc_games::find_activity(&a.current.id, room.dev_activities) else {
        return div().into_any_element();
    };
    let started_by = if a.current.started_by == room.me.as_str() {
        "you".to_owned()
    } else if a.current.started_by_name.is_empty() {
        "someone".to_owned()
    } else {
        a.current.started_by_name.clone()
    };
    let media = room.watch.showing.is_some();
    let confirming = view.activity.confirm_end.is_some_and(|t| t.elapsed() < CONFIRM);
    let bar = div()
        .h(px(52.))
        .flex_none()
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(14.))
        .border_b_1()
        .border_color(tokens::line())
        .child(div().text_size(px(18.)).child(def.icon))
        .child(
            div()
                .text_size(px(15.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(def.name),
        )
        .child(
            div()
                .text_size(px(13.))
                .text_color(tokens::text_3())
                .child(format!("started by {started_by}")),
        )
        .child(div().flex_1())
        .child(
            bar_btn("act-min", if media { "▶ Video" } else { "▾ Minimise" }).on_click(cx.listener(
                |v, _, _, cx| {
                    v.activity.minimised = true;
                    cx.notify();
                },
            )),
        )
        .child(
            bar_btn("act-leave", "Leave")
                .on_click(cx.listener(|v, _, _, cx| v.activity_command(ActivityCommand::Leave, cx))),
        )
        .child(
            div()
                .id("act-end")
                .h(px(32.))
                .px(px(12.))
                .flex()
                .items_center()
                .rounded(px(9.))
                .border_1()
                .border_color(tokens::danger_line())
                .bg(if confirming {
                    tokens::accent()
                } else {
                    tokens::surface()
                })
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(if confirming {
                    tokens::white()
                } else {
                    tokens::danger_text()
                })
                .cursor_pointer()
                .on_click(cx.listener(|v, _, _, cx| v.end_activity(cx)))
                .child(if confirming { "End for all?" } else { "End" }),
        );
    let key = rtc_games::activity_key(&a.current.id);
    let store = room
        .stores
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, s)| s.state.clone());
    div()
        .size_full()
        .flex()
        .flex_col()
        .bg(tokens::bg())
        .child(bar)
        .child(
            div()
                .id("act-body")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(game(view, room, &a.current.id, store.as_ref(), cx)),
        )
        .into_any_element()
}

/// The game itself.
fn game(
    view: &RoomView,
    room: &Snapshot,
    id: &str,
    state: Option<&Value>,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    match (id, state) {
        ("sample-counter", Some(s)) => sample(view, room, s, cx),
        ("chess", Some(s)) => crate::chess::view(view, room, s, cx),
        ("ludo", Some(s)) => crate::ludo::view(view, room, s, cx),
        ("lastcard", Some(s)) => crate::lastcard::view(view, room, s, cx),
        ("tycoon", Some(s)) => crate::tycoon::view(view, room, s, cx),
        ("whiteboard", Some(s)) => crate::whiteboard::view(view, room, s, cx),
        ("sketch", Some(s)) => crate::sketch::view(view, room, s, cx),
        _ => div()
            .p(px(24.))
            .text_color(tokens::text_2())
            .child("Loading…")
            .into_any_element(),
    }
}

/// The development example: a shared counter.
fn sample(_view: &RoomView, room: &Snapshot, state: &Value, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let (count, line) = rtc_games::sample::view(state);
    let name = room.username.clone();
    let host = room.host.as_ref() == Some(&room.me);
    let key = "act:sample-counter";
    let send = move |action: Value| ActivityCommand::Dispatch {
        key: key.to_owned(),
        action,
    };
    let (n1, n2) = (name.clone(), name);
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(18.))
        .p(px(24.))
        .child(
            div()
                .text_size(px(64.))
                .font_weight(FontWeight::BOLD)
                .child(count.to_string()),
        )
        .child(
            div()
                .flex()
                .gap(px(10.))
                .child(
                    Button::new("sample-minus", "−1")
                        .variant(Variant::Secondary)
                        .on_click(cx.listener(move |v, _, _, cx| {
                            v.activity_command(send(rtc_games::sample::add(-1, &n1)), cx);
                        })),
                )
                .child(
                    Button::new("sample-plus", "+1")
                        .variant(Variant::Primary)
                        .on_click(cx.listener(move |v, _, _, cx| {
                            v.activity_command(send(rtc_games::sample::add(1, &n2)), cx);
                        })),
                )
                .when(host, |el| {
                    el.child(
                        Button::new("sample-reset", "Reset")
                            .variant(Variant::Secondary)
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.activity_command(send(rtc_games::sample::reset()), cx);
                            })),
                    )
                }),
        )
        .child(div().text_size(px(14.)).text_color(tokens::text_2()).child(line))
        .into_any_element()
}

/// The round bubble at the stage's corner: "Join <game>" when it isn't loaded here, or the
/// minimised game.
pub(crate) fn bubble(view: &RoomView, room: &Snapshot, cx: &mut Context<'_, RoomView>) -> Option<AnyElement> {
    let a = room.activity.as_ref()?;
    if !a.known || (a.loaded && !view.activity.minimised) {
        return None;
    }
    let def = rtc_games::find_activity(&a.current.id, room.dev_activities)?;
    let invite = !a.loaded;
    let tag = if invite {
        Some(format!("Join {}", def.name))
    } else if a.current.id == "chess" {
        view.chess_attention()
    } else if a.current.id == "ludo" {
        view.ludo_attention()
    } else if a.current.id == "lastcard" {
        view.lastcard_attention()
    } else if a.current.id == "tycoon" {
        view.tycoon_attention()
    } else if a.current.id == "sketch" {
        view.sketch_attention()
    } else {
        None
    };
    Some(
        div()
            .id("act-bubble")
            .absolute()
            .bottom(px(4.))
            .right(px(14.))
            .flex()
            .items_center()
            .gap(px(8.))
            .cursor_pointer()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |v, _, _, cx| {
                if invite {
                    v.activity_command(ActivityCommand::Join, cx);
                } else {
                    v.activity.minimised = false;
                    cx.notify();
                }
            }))
            .children(tag.map(|t| {
                div()
                    .px(px(10.))
                    .py(px(4.))
                    .rounded_full()
                    .bg(tokens::surface())
                    .border_1()
                    .border_color(tokens::line())
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(t)
            }))
            .child(
                div()
                    .size(px(52.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(tokens::raised())
                    .border_2()
                    .border_color(if invite {
                        tokens::text_3()
                    } else {
                        tokens::line_strong()
                    })
                    .text_size(px(24.))
                    .child(def.icon),
            )
            .into_any_element(),
    )
}

/// The dock's "Play together" menu.
pub(crate) fn games_pop(
    view: &RoomView,
    room: &Snapshot,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let open = room.activity.as_ref().map(|a| a.current.id.clone());
    let people = room.members.len() + 1;
    let _ = view;
    deferred(
        div().absolute().bottom(px(56.)).right(px(-100.)).occlude().child(
            menu()
                .id("games-pop")
                .min_w(px(260.))
                .on_mouse_down_out(cx.listener(|v, _, _, cx| {
                    v.pop = None;
                    cx.notify();
                }))
                .child(
                    div()
                        .px(px(12.))
                        .pt(px(6.))
                        .pb(px(4.))
                        .text_size(px(12.))
                        .text_color(tokens::text_3())
                        .child("Play together"),
                )
                .children(rtc_games::activities(room.dev_activities).into_iter().map(|a| {
                    let disabled = people < a.min_people || open.as_deref() == Some(a.id);
                    menu_item(
                        a.id,
                        None,
                        format!("{}  {}", a.icon, a.name),
                        disabled,
                        None,
                        Some(Box::new(
                            cx.listener(move |v, _, _, cx| v.start_activity(a.id, cx)),
                        )),
                    )
                })),
        ),
    )
}
