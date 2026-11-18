//! The room screen (`App.tsx`, the computer layout): header (`Header.tsx`, `.rh-*`), stage
//! (`YouTubeSyncPlayer.tsx` with nothing playing, `.rd-pick`, `.rd-dropzone`), dock
//! (`DesktopDock.tsx`, `.dock-*`) and the side panel (`LiveChat.tsx`, `InvitePanel.tsx`).

use gpui_kit::component::Sizable as _;
use gpui_kit::component::slider::Slider;
use gpui_kit::{
    AnyElement, App, Context, Div, ExternalPaths, Focusable as _, FontWeight, Hsla, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, Stateful, StatefulInteractiveElement as _, Styled as _,
    Window, deferred, div, prelude::FluentBuilder as _, px, rgba,
};
use rtc_engine::{Member, Snapshot};
use rtc_protocol::{PeerId, RoomId};
use rtc_ui::avatar::{self, avatar, muted_badge};
use rtc_ui::button::{Button, Variant};
use rtc_ui::logo::logo_sized;
use rtc_ui::overlay::{menu, menu_item, popover};
use rtc_ui::{Icon, icon, icon_bold, tokens};

use crate::view::{Dialog, Pop, RoomView, Tab};

/// Width of the side panel (`.chat-section` in the computer layout).
pub(crate) const PANEL_WIDTH: f32 = 360.;

fn alpha(color: Hsla, a: f32) -> Hsla {
    Hsla { a, ..color }
}

pub(crate) fn render(
    view: &mut RoomView,
    room: &Snapshot,
    id: RoomId,
    window: &mut Window,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    if view.watch.local.fullscreen {
        if room.watch.showing.is_some() {
            if !window.is_fullscreen() {
                view.watch.local.video_fullscreen_window = true;
                window.toggle_fullscreen();
            }
            view.watch.local.hwnd = rtc_platform_win::raw_hwnd(window);
            view.ensure_fullscreen_watch(cx);
            // full screen: the video (and its bar if local)
            return div()
                .size_full()
                .relative()
                .bg(tokens::black(1.0))
                .child(crate::watch::player_area(view, window, cx))
                .into_any_element();
        }
        view.end_video_fullscreen(window);
    } else if view.watch.local.video_fullscreen_window {
        view.watch.local.video_fullscreen_window = false;
        if window.is_fullscreen() {
            window.toggle_fullscreen();
        }
    }
    if view.screen.fullscreen {
        if view.screen.showing() {
            // full screen: the shared screen only
            view.hide_player();
            return div()
                .id("stage-screen-full")
                .size_full()
                .relative()
                .bg(tokens::black(1.0))
                .child(crate::screen::stage(view, cx))
                .child(crate::fun::layer(view, false))
                .into_any_element();
        }
        view.end_screen_fullscreen(window);
    }
    let is_fs = window.is_fullscreen();
    div()
        .size_full()
        .flex()
        .flex_col()
        .overflow_hidden()
        .child(header(view, room, id, is_fs, cx))
        .child(
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .flex()
                        .flex_col()
                        .child(stage(view, room, window, cx))
                        .children(crate::camera::tiles(view, room, cx))
                        .child(dock(view, room, is_fs, cx)),
                )
                .when(view.panel_open, |el| el.child(panel(view, room, id, window, cx))),
        )
        .into_any_element()
}

// ---- header -------------------------------------------------------------------------------------

fn header(
    view: &RoomView,
    room: &Snapshot,
    id: RoomId,
    is_fullscreen: bool,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let alone = room.members.is_empty();
    let connected = room.members.iter().any(|(_, m)| m.connected);
    let (tone_bg, tone_fg, text) = if connected {
        (alpha(tokens::live(), 0.12), tokens::live_text(), "Connected")
    } else if alone {
        (tokens::surface(), tokens::text_2(), "Waiting for friends")
    } else {
        (alpha(tokens::warn(), 0.14), tokens::warn(), "Connecting…")
    };
    let copied = view.copied == Some("code");
    let code = id.to_string();
    div()
        .h(px(64.))
        .flex_none()
        .flex()
        .items_center()
        .gap(px(14.))
        .px(px(20.))
        .border_b_1()
        .border_color(tokens::raised())
        .bg(tokens::bg())
        .child(logo_sized(30., 19.))
        .child(
            div()
                .id("room-code")
                .h(px(36.))
                .ml(px(8.))
                .px(px(12.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(10.))
                .border_1()
                .border_color(if copied {
                    alpha(tokens::live(), 0.5)
                } else {
                    tokens::line()
                })
                .bg(tokens::surface())
                .text_color(if copied {
                    tokens::live_text()
                } else {
                    tokens::text_2()
                })
                .text_size(px(14.))
                .cursor_pointer()
                .hover(|s| s.border_color(tokens::line_strong()).text_color(tokens::text()))
                .on_click(cx.listener(move |v, _, _, cx| v.copy(code.clone(), "code", cx)))
                .child(if copied { "Copied" } else { "Room" })
                .child(
                    div()
                        .font_family(tokens::FONT_MONO)
                        .font_weight(FontWeight::BOLD)
                        .text_size(px(15.))
                        .text_color(tokens::text())
                        .child(spaced(&id.to_string())),
                )
                .child(icon(
                    if copied { Icon::Check } else { Icon::Copy },
                    px(15.),
                    tokens::text_2(),
                )),
        )
        .child(crate::watch::header_middle(room))
        .when(room.playback_lock, |el| {
            el.child(
                div()
                    .h(px(32.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded_full()
                    .bg(alpha(tokens::warn(), 0.12))
                    .text_color(tokens::warn())
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(icon(Icon::Lock, px(15.), tokens::warn()))
                    .child("Host controls"),
            )
        })
        .children(crate::watch::header_actions(room, cx))
        .child(
            div()
                .id("conn")
                .h(px(36.))
                .px(px(12.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded_full()
                .bg(tone_bg)
                .text_color(tone_fg)
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .hover(|s| s.opacity(0.85))
                .on_click(cx.listener(|v, _, _, cx| v.open_net(cx)))
                .child(icon_bold(Icon::Signal, px(16.), tone_fg))
                .child(text),
        )
        .child({
            let el = div()
                .id("invite")
                .h(px(40.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(10.))
                .border_1()
                .text_size(px(15.))
                .cursor_pointer()
                .on_click(cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Qr, cx)));
            if alone {
                el.px(px(18.))
                    .bg(tokens::accent())
                    .border_color(tokens::accent())
                    .text_color(tokens::white())
                    .font_weight(FontWeight::BOLD)
                    .hover(|s| s.bg(tokens::accent_press()))
                    .child(icon_bold(Icon::UserPlus, px(17.), tokens::white()))
                    .child("Invite friends")
            } else {
                let n = room.members.len() + 1;
                let limit = room.max_users.max(n as u32);
                el.px(px(16.))
                    .bg(tokens::surface())
                    .border_color(tokens::line())
                    .font_weight(FontWeight::SEMIBOLD)
                    .hover(|s| s.border_color(tokens::line_strong()))
                    .child("Invite")
                    .child(
                        div()
                            .text_color(tokens::text_3())
                            .font_weight(FontWeight::MEDIUM)
                            .child(format!("{n} / {limit}")),
                    )
            }
        })
        .child(
            div()
                .id("panel-toggle")
                .h(px(40.))
                .px(px(14.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(10.))
                .border_1()
                .border_color(if view.panel_open {
                    alpha(tokens::accent(), 0.4)
                } else {
                    tokens::line()
                })
                .bg(if view.panel_open {
                    tokens::raised()
                } else {
                    tokens::surface()
                })
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .hover(|s| s.border_color(tokens::line_strong()).bg(tokens::raised()))
                .on_click(cx.listener(|v, _, _, cx| v.toggle_panel(cx)))
                .child(if view.panel_open { "Hide Panel" } else { "Panel" })
                .when(!view.panel_open && view.unread > 0, |el| {
                    el.child(badge(view.unread.to_string(), true))
                }),
        )
        .child({
            let is_fs = is_fullscreen;
            div()
                .id("room-fullscreen-toggle")
                .h(px(40.))
                .px(px(14.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(10.))
                .border_1()
                .border_color(if is_fs {
                    alpha(tokens::accent(), 0.4)
                } else {
                    tokens::line()
                })
                .bg(if is_fs {
                    tokens::raised()
                } else {
                    tokens::surface()
                })
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .hover(|s| s.border_color(tokens::line_strong()).bg(tokens::raised()))
                .on_click(cx.listener(|v, _, window, cx| v.toggle_app_fullscreen(window, cx)))
                .child(if is_fs { "Exit Full Screen" } else { "Full Screen" })
        })
}

/// Letters spaced out a little (CSS `letter-spacing: 0.08em` on room codes).
fn spaced(code: &str) -> String {
    code.chars()
        .map(|c| c.to_string())
        .collect::<Vec<_>>()
        .join("\u{200a}")
}

fn badge(text: String, accent: bool) -> impl IntoElement {
    div()
        .min_w(px(18.))
        .h(px(18.))
        .px(px(5.))
        .rounded(px(9.))
        .flex()
        .items_center()
        .justify_center()
        .bg(if accent {
            tokens::accent()
        } else {
            tokens::white().opacity(0.12)
        })
        .text_color(if accent { tokens::white() } else { tokens::text_2() })
        .text_size(px(12.))
        .font_weight(FontWeight::BOLD)
        .child(text)
}

// ---- stage --------------------------------------------------------------------------------------

fn stage(
    view: &mut RoomView,
    room: &Snapshot,
    window: &mut Window,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    // a camera on the stage, for us only: over whatever plays there, which keeps running
    // (a video plays on, hidden, as under a dialog)
    if let Some(camera) = crate::camera::stage(view, room, cx) {
        view.hide_player();
        return camera;
    }
    if view.activity_covers() {
        // the open game takes the stage (the video plays on, hidden)
        view.hide_player();
        return div()
            .id("stage-activity")
            .relative()
            .flex_1()
            .min_h_0()
            .bg(tokens::bg())
            .child(crate::activity::stage(view, room, cx))
            .child(crate::fun::layer(view, false))
            .children(crate::fun::banner(view, false))
            .into_any_element();
    }
    let bubble = crate::activity::bubble(view, room, cx);
    if view.screen.showing() {
        // a shared screen takes the stage (the video plays on, hidden)
        view.hide_player();
        return div()
            .id("stage-screen")
            .relative()
            .flex_1()
            .min_h_0()
            .bg(tokens::bg())
            .child(crate::screen::stage(view, cx))
            .child(crate::fun::layer(view, false))
            .children(crate::fun::banner(view, false))
            .children(bubble)
            .into_any_element();
    }
    if room.watch.showing.is_some() {
        // a video plays: the player fills the stage flush edge-to-edge
        // the game's bubble sits under the video (its window would cover it)
        let under = if bubble.is_some() { 52. } else { 0. };
        return div()
            .id("stage-playing")
            .relative()
            .flex_1()
            .min_h_0()
            .bg(tokens::black(1.0))
            .on_drop(cx.listener(|v, paths: &ExternalPaths, _, cx| v.dropped_paths(paths.paths(), cx)))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .bottom(px(under))
                    .child(crate::watch::player_area(view, window, cx)),
            )
            .children(bubble)
            .into_any_element();
    }
    let host_name = room
        .host
        .as_ref()
        .filter(|h| **h != room.me)
        .and_then(|h| room.members.iter().find(|(p, _)| p == h))
        .and_then(|(_, m)| m.username.clone());
    let who = if room.host.as_ref() == Some(&room.me) {
        "In sync · you’re the host".to_owned()
    } else if let Some(name) = host_name {
        format!("In sync · {name} is the host")
    } else {
        "In sync".to_owned()
    };
    let focused = view.link.read(cx).focus_handle(cx).is_focused(window);
    let picks = crate::watch::browser(view, room, cx);
    let link_error = crate::watch::link_error(view, cx);
    let resolving = view.watch.resolving;
    div()
        .id("stage-idle")
        .relative()
        .flex_1()
        .min_h_0()
        .bg(tokens::bg())
        .on_drop(cx.listener(|v, paths: &ExternalPaths, _, cx| v.dropped_paths(paths.paths(), cx)))
        .child(
            div()
                .id("stage-scroll")
                .size_full()
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .items_center()
                .px(px(32.))
                .pt(px(72.))
                .pb(px(28.))
                .gap(px(32.))
                .child(
                    div()
                        .w_full()
                        .max_w(px(760.))
                        .flex()
                        .flex_col()
                        .gap(px(16.))
                        .child(
                            div()
                                .text_center()
                                .font_family(tokens::FONT_DISPLAY_TIGHT_2)
                                .font_weight(FontWeight::BOLD)
                                .text_size(px(34.))
                                .child("What are we watching?"),
                        )
                        .child(
                            div()
                                .w_full()
                                .border(px(1.5))
                                .border_dashed()
                                .border_color(tokens::line_strong())
                                .rounded(px(20.))
                                .bg(tokens::surface())
                                .p(px(18.))
                                .flex()
                                .flex_col()
                                .gap(px(14.))
                                .child(
                                    div()
                                        .flex()
                                        .gap(px(10.))
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .h(px(52.))
                                                .px(px(12.))
                                                .flex()
                                                .items_center()
                                                .rounded(px(12.))
                                                .border_1()
                                                .border_color(if focused {
                                                    tokens::focus()
                                                } else {
                                                    tokens::line_strong()
                                                })
                                                .bg(tokens::bg())
                                                .text_size(px(16.))
                                                .child(
                                                    gpui_kit::component::input::Input::new(&view.link)
                                                        .appearance(false)
                                                        .large(),
                                                ),
                                        )
                                        .child(
                                            Button::new(
                                                "play-link",
                                                if resolving {
                                                    "Checking…"
                                                } else if crate::watch::locked_for_me(room) {
                                                    "Add to queue"
                                                } else {
                                                    "Play for everyone"
                                                },
                                            )
                                            .variant(if crate::watch::locked_for_me(room) {
                                                Variant::Primary
                                            } else {
                                                Variant::Inverse
                                            })
                                            .min_height(px(52.))
                                            .padding_x(px(22.))
                                            .font_size(px(16.))
                                            .on_click(
                                                cx.listener(|v, _, window, cx| {
                                                    v.submit_link(false, window, cx);
                                                }),
                                            ),
                                        ),
                                )
                                .children(link_error)
                                .child(if crate::watch::locked_for_me(room) {
                                    div()
                                        .flex()
                                        .flex_wrap()
                                        .items_center()
                                        .justify_center()
                                        .gap(px(8.))
                                        .text_size(px(14.))
                                        .text_color(tokens::text_3())
                                        .child(icon(Icon::Lock, px(15.), tokens::text_3()))
                                        .child("Host controls are on: links you add go into the queue ·")
                                        .child(inline_link("share", "share screen", cx))
                                } else {
                                    div()
                                        .flex()
                                        .flex_wrap()
                                        .items_center()
                                        .justify_center()
                                        .gap(px(8.))
                                        .text_size(px(15.))
                                        .text_color(tokens::text_2())
                                        .child(icon(Icon::Upload, px(16.), tokens::text_2()))
                                        .child("or drop a video file anywhere here ·")
                                        .child(inline_link("browse", "browse files", cx))
                                        .child(div().text_color(tokens::text_3()).child("MP4, MKV, WebM"))
                                        .child("·")
                                        .child(inline_link("share", "share screen", cx))
                                }),
                        ),
                )
                .child(div().w_full().max_w(px(1180.)).child(picks)),
        )
        .child(
            div()
                .absolute()
                .top(px(16.))
                .left(px(16.))
                .h(px(34.))
                .px(px(14.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded_full()
                .bg(rgba(0x0a0a_0dcc))
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(div().size(px(8.)).rounded_full().bg(tokens::live()))
                .child(who),
        )
        .child(crate::fun::layer(view, false))
        .children(crate::fun::banner(view, false))
        .children(bubble)
        .into_any_element()
}

fn inline_link(id: &'static str, label: &'static str, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    div()
        .id(id)
        .text_color(tokens::text())
        .font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer()
        .on_click(cx.listener(move |v, _, window, cx| {
            if id == "browse" {
                v.choose_video_file(window, cx);
            } else {
                v.open_screen_picker(cx);
            }
        }))
        .child(label)
}

// ---- dock ---------------------------------------------------------------------------------------

fn dock_btn(id: &'static str, which: Icon, active: bool, off: bool) -> Stateful<Div> {
    div()
        .id(id)
        .size(px(46.))
        .flex_none()
        .rounded(px(13.))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .bg(if off {
            tokens::danger_bg()
        } else if active {
            gpui_kit::rgb(0x0026_2630).into()
        } else {
            tokens::raised()
        })
        .hover(|s| s.bg(gpui_kit::rgb(0x0026_2630)))
        .child(icon(
            which,
            px(20.),
            if off {
                tokens::danger_text()
            } else {
                tokens::text()
            },
        ))
}

/// A dock button for something that isn't in the desktop app yet: dimmed, says so when clicked.
fn later_btn(id: &'static str, which: Icon, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    dock_btn(id, which, false, false)
        .opacity(0.45)
        .on_click(cx.listener(|v, _, _, cx| v.show_toast("Coming in the next desktop update", cx)))
}

fn tray_pill(
    id: SharedString,
    icon_opt: Option<Icon>,
    label: SharedString,
    active: bool,
    danger: bool,
) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(42.))
        .px(px(14.))
        .flex()
        .flex_none()
        .items_center()
        .gap(px(8.))
        .rounded(px(12.))
        .cursor_pointer()
        .bg(if danger {
            tokens::danger_bg()
        } else if active {
            gpui_kit::rgb(0x0026_2630).into()
        } else {
            tokens::raised()
        })
        .hover(|s| s.bg(gpui_kit::rgb(0x0026_2630)))
        .children(icon_opt.map(|i| {
            icon(
                i,
                px(17.),
                if danger {
                    tokens::danger_text()
                } else if active {
                    tokens::focus()
                } else {
                    tokens::text_2()
                },
            )
        }))
        .child(
            div()
                .text_size(px(13.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(if danger {
                    tokens::danger_text()
                } else {
                    tokens::text()
                })
                .child(label),
        )
}

fn tray_title(icon_type: Icon, title: &'static str) -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(8.))
        .px(px(12.))
        .h(px(42.))
        .rounded(px(12.))
        .bg(alpha(tokens::focus(), 0.12))
        .border_1()
        .border_color(alpha(tokens::focus(), 0.3))
        .child(icon(icon_type, px(18.), tokens::focus()))
        .child(
            div()
                .text_size(px(13.5))
                .font_weight(FontWeight::BOLD)
                .text_color(tokens::text())
                .child(title),
        )
}

fn tray_done(cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    div()
        .id("tray-done-btn")
        .h(px(42.))
        .px(px(16.))
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .rounded(px(12.))
        .bg(tokens::raised())
        .border_1()
        .border_color(tokens::line())
        .cursor_pointer()
        .hover(|s| {
            s.bg(tokens::white().opacity(0.1))
                .border_color(tokens::line_strong())
        })
        .on_click(cx.listener(|v, _, _, cx| {
            v.pop = None;
            cx.notify();
        }))
        .child(icon(Icon::Close, px(15.), tokens::text_2()))
        .child(
            div()
                .text_size(px(13.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(tokens::text())
                .child("Done"),
        )
}

fn horizontal_tray(
    pop: Pop,
    view: &RoomView,
    room: &Snapshot,
    is_fullscreen: bool,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let content = match pop {
        Pop::Reactions => {
            let reactions = view.settings.quick_reactions.iter().enumerate().map(|(i, e)| {
                let emoji = e.clone();
                div()
                    .id(SharedString::from(format!("tray-react-{i}")))
                    .size(px(44.))
                    .rounded(px(12.))
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .text_size(px(24.))
                    .cursor_pointer()
                    .bg(tokens::raised())
                    .hover(|s| s.bg(tokens::white().opacity(0.12)))
                    .on_click(cx.listener(move |v, _, _, _| v.react(&emoji)))
                    .child(e.clone())
            });
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(14.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .child(tray_title(Icon::Smile, "Reactions"))
                        .child(
                            div()
                                .id("tray-reactions-scroll")
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .overflow_x_scroll()
                                .children(reactions),
                        )
                        .child(
                            div()
                                .id("tray-choose-reactions")
                                .h(px(40.))
                                .px(px(12.))
                                .flex()
                                .flex_none()
                                .items_center()
                                .justify_center()
                                .rounded(px(11.))
                                .border_1()
                                .border_color(tokens::line())
                                .bg(tokens::surface())
                                .cursor_pointer()
                                .hover(|s| s.bg(tokens::raised()).text_color(tokens::text()))
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(tokens::text_2())
                                .on_click(cx.listener(|v, _, _, cx| {
                                    v.pop = None;
                                    v.open_dialog(crate::view::Dialog::Reactions, cx);
                                }))
                                .child("✨ Choose reactions…"),
                        ),
                )
                .child(tray_done(cx))
                .into_any_element()
        }
        Pop::Sounds => {
            let muted = view.settings.soundboard_muted;
            let clips = crate::sounds::CLIPS.iter().enumerate().map(|(i, c)| {
                let playing = view.fun.banner.as_ref().is_some_and(|(s, _)| s.sound_id == c.id);
                div()
                    .id(SharedString::from(format!("tray-sfx-{}", c.id)))
                    .h(px(44.))
                    .px(px(12.))
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(12.))
                    .border_1()
                    .border_color(if playing {
                        tokens::sfx_pink()
                    } else {
                        tokens::line()
                    })
                    .bg(if playing {
                        Hsla {
                            a: 0.15,
                            ..tokens::sfx_purple()
                        }
                    } else {
                        tokens::raised()
                    })
                    .cursor_pointer()
                    .hover(|s| s.bg(tokens::white().opacity(0.1)))
                    .on_click(cx.listener(move |v, _, _, _| v.play_clip(i)))
                    .child(div().text_size(px(18.)).child(c.emoji))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(tokens::text())
                            .child(c.name),
                    )
            });
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(14.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(tray_title(Icon::Music, "Soundboard"))
                        .child(
                            div()
                                .id("tray-soundboard-mute")
                                .h(px(42.))
                                .px(px(10.))
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(px(6.))
                                .rounded(px(11.))
                                .bg(tokens::surface())
                                .border_1()
                                .border_color(tokens::line())
                                .cursor_pointer()
                                .on_click(cx.listener(|v, _, _, cx| v.toggle_soundboard_mute(cx)))
                                .child(icon(
                                    if muted { Icon::SpeakerOff } else { Icon::Speaker },
                                    px(18.),
                                    if muted {
                                        tokens::danger_text()
                                    } else {
                                        tokens::text_2()
                                    },
                                ))
                                .child(
                                    div()
                                        .text_size(px(12.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(if muted {
                                            tokens::danger_text()
                                        } else {
                                            tokens::text_2()
                                        })
                                        .child(if muted { "Muted" } else { "Sound on" }),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(px(2.))
                                .px(px(6.))
                                .h(px(42.))
                                .rounded(px(11.))
                                .bg(tokens::surface())
                                .border_1()
                                .border_color(tokens::line())
                                .child(
                                    div()
                                        .px(px(4.))
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(tokens::text_2())
                                        .child("Vol:"),
                                )
                                .children([0.25f32, 0.5, 0.75, 1.0].map(|lvl| {
                                    let active =
                                        !muted && (view.settings.soundboard_volume - lvl).abs() < 0.13;
                                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                                    let pct = (lvl * 100.0).round() as u32;
                                    div()
                                        .id(SharedString::from(format!("tray-sfx-vol-{pct}")))
                                        .px(px(6.))
                                        .py(px(4.))
                                        .rounded(px(6.))
                                        .cursor_pointer()
                                        .when(active, |s| s.bg(tokens::white().opacity(0.18)))
                                        .text_size(px(12.))
                                        .font_weight(if active {
                                            FontWeight::BOLD
                                        } else {
                                            FontWeight::NORMAL
                                        })
                                        .text_color(if active { tokens::text() } else { tokens::text_2() })
                                        .hover(|s| s.bg(tokens::white().opacity(0.1)))
                                        .on_click(cx.listener(move |v, _, _, cx| {
                                            v.set_soundboard_volume(lvl, cx);
                                        }))
                                        .child(format!("{pct}%"))
                                })),
                        )
                        .child(
                            div()
                                .id("tray-sounds-scroll")
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .overflow_x_scroll()
                                .children(clips),
                        ),
                )
                .child(tray_done(cx))
                .into_any_element()
        }
        Pop::More => {
            let is_host = room.host.as_ref() == Some(&room.me);
            let lock = room.playback_lock;
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(14.))
                .child(
                    div()
                        .id("tray-more-scroll")
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .overflow_x_scroll()
                        .child(tray_title(Icon::More, "More"))
                        .child(
                            tray_pill(
                                SharedString::from("tray-m-fullscreen"),
                                Some(Icon::ScreenShare),
                                SharedString::from(if is_fullscreen {
                                    "Exit full screen (F11)"
                                } else {
                                    "Full screen (F11)"
                                }),
                                false,
                                false,
                            )
                            .on_click(cx.listener(|v, _, window, cx| {
                                v.pop = None;
                                v.toggle_app_fullscreen(window, cx);
                            })),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-m-desktop"),
                                Some(Icon::Settings),
                                SharedString::from("Desktop settings"),
                                false,
                                false,
                            )
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.pop = None;
                                v.open_dialog(Dialog::Desktop, cx);
                            })),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-m-voice"),
                                Some(Icon::Settings),
                                SharedString::from("Voice settings"),
                                false,
                                false,
                            )
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.pop = None;
                                v.open_dialog(Dialog::Voice, cx);
                            })),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-m-player-shortcuts"),
                                Some(Icon::Settings),
                                SharedString::from("Player shortcuts…"),
                                false,
                                false,
                            )
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.pop = None;
                                v.open_dialog(Dialog::Player, cx);
                            })),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-m-server"),
                                Some(Icon::Settings),
                                SharedString::from("Server settings"),
                                false,
                                false,
                            )
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.pop = None;
                                v.open_dialog(Dialog::Server, cx);
                            })),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-m-conn"),
                                Some(Icon::Signal),
                                SharedString::from("Connection details"),
                                false,
                                false,
                            )
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.pop = None;
                                v.open_net(cx);
                            })),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-m-app-sound"),
                                Some(Icon::Speaker),
                                SharedString::from(if view.extras.sharing.is_some() {
                                    "Sharing an app's sound…"
                                } else {
                                    "Share an app's sound…"
                                }),
                                view.extras.sharing.is_some(),
                                false,
                            )
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.pop = None;
                                v.open_app_sound(cx);
                            })),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-m-qr"),
                                Some(Icon::Qr),
                                SharedString::from("Invite with QR code"),
                                false,
                                false,
                            )
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.pop = None;
                                v.open_dialog(Dialog::Qr, cx);
                            })),
                        )
                        .when(is_host, |el| {
                            el.child(
                                tray_pill(
                                    SharedString::from("tray-m-lock"),
                                    Some(Icon::Lock),
                                    SharedString::from(if lock {
                                        "🔒 Only I control: ON"
                                    } else {
                                        "🔓 Everyone controls"
                                    }),
                                    lock,
                                    false,
                                )
                                .on_click(cx.listener(move |v, _, _, cx| {
                                    v.command(rtc_core::Command::SetPlaybackLock(!lock));
                                    cx.notify();
                                })),
                            )
                        })
                        .when(!is_host && lock, |el| {
                            el.child(tray_pill(
                                SharedString::from("tray-m-lock-status"),
                                Some(Icon::Lock),
                                SharedString::from("🔒 Host controls playback"),
                                false,
                                false,
                            ))
                        }),
                )
                .child(tray_done(cx))
                .into_any_element()
        }
        Pop::Volume => {
            let Some((peer, m)) = view
                .volume_for
                .as_ref()
                .and_then(|p| room.members.iter().find(|(q, _)| q == p))
            else {
                return div().child(tray_done(cx)).into_any_element();
            };
            let name = m.username.clone().unwrap_or_else(|| "Peer".to_owned());
            let (volume, muted) = view.peer_volume(m);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let pct = (volume * 100.0).round() as u32;
            let (mute_who, reset_who) = (peer.clone(), peer.clone());
            let preset_btn = |label: &'static str, val: f32, cx: &mut Context<'_, RoomView>| {
                let on = !muted && (volume - val).abs() < 0.04;
                let who = peer.clone();
                div()
                    .id(label)
                    .h(px(38.))
                    .px(px(10.))
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(px(9.))
                    .border_1()
                    .border_color(if on { tokens::focus() } else { tokens::line() })
                    .bg(if on {
                        alpha(tokens::focus(), 0.15)
                    } else {
                        tokens::surface()
                    })
                    .text_color(if on { tokens::focus() } else { tokens::text_2() })
                    .text_size(px(12.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .cursor_pointer()
                    .hover(|s| s.border_color(tokens::line_strong()))
                    .on_click(cx.listener(move |v, _, _, cx| v.set_peer_volume(&who, val, false, cx)))
                    .child(label)
            };
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(14.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .child(avatar(&name, 38., m.speaking && !m.muted, tokens::panel()))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .text_size(px(14.))
                                        .font_weight(FontWeight::BOLD)
                                        .child(name.clone()),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(if muted {
                                            tokens::danger_text()
                                        } else {
                                            tokens::text_2()
                                        })
                                        .child(if muted {
                                            "Muted for you".to_owned()
                                        } else {
                                            format!("{pct}% volume")
                                        }),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .child(preset_btn("50%", 0.5, cx))
                                .child(preset_btn("100%", 1.0, cx))
                                .child(preset_btn("150%", 1.5, cx))
                                .child(preset_btn("200%", 2.0, cx)),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-vol-mute"),
                                Some(if muted { Icon::SpeakerOff } else { Icon::Speaker }),
                                SharedString::from(if muted { "Unmute for Me" } else { "Mute for Me" }),
                                muted,
                                muted,
                            )
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.set_peer_volume(&mute_who, volume, !muted, cx);
                            })),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-vol-reset"),
                                None,
                                SharedString::from("Reset (100%)"),
                                false,
                                false,
                            )
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.set_peer_volume(&reset_who, 1.0, false, cx);
                            })),
                        ),
                )
                .child(tray_done(cx))
                .into_any_element()
        }
        Pop::Devices => {
            let inputs = &view.devices.inputs;
            let outputs = &view.devices.outputs;
            let in_name = inputs
                .iter()
                .find(|d| d.id == view.settings.input_device_id)
                .map_or("System default", |d| d.name.as_str());
            let out_name = outputs
                .iter()
                .find(|d| d.id == view.settings.output_device_id)
                .map_or("System default", |d| d.name.as_str());
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(14.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(tray_title(Icon::Mic, "Audio"))
                        .child(
                            div()
                                .h(px(42.))
                                .px(px(12.))
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .rounded(px(11.))
                                .bg(tokens::raised())
                                .border_1()
                                .border_color(tokens::line())
                                .child(icon(Icon::Mic, px(16.), tokens::text_2()))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .max_w(px(200.))
                                        .overflow_hidden()
                                        .text_ellipsis()
                                        .child(format!("Mic: {in_name}")),
                                ),
                        )
                        .child(
                            div()
                                .h(px(42.))
                                .px(px(12.))
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .rounded(px(11.))
                                .bg(tokens::raised())
                                .border_1()
                                .border_color(tokens::line())
                                .child(icon(Icon::Speaker, px(16.), tokens::text_2()))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .max_w(px(200.))
                                        .overflow_hidden()
                                        .text_ellipsis()
                                        .child(format!("Speaker: {out_name}")),
                                ),
                        )
                        .child(
                            tray_pill(
                                SharedString::from("tray-devices-settings"),
                                Some(Icon::Settings),
                                SharedString::from("Voice settings & mic test…"),
                                false,
                                false,
                            )
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.pop = None;
                                v.open_dialog(Dialog::Voice, cx);
                            })),
                        ),
                )
                .child(tray_done(cx))
                .into_any_element()
        }
        Pop::Camera => {
            // the camera picker: "Default camera" and each camera on this PC (ADR 0010)
            let chosen = view.settings.camera_device.clone();
            let mut rows: Vec<(String, String)> = vec![(String::new(), "Default camera".to_owned())];
            rows.extend(view.camera.devices.iter().map(|c| (c.id.clone(), c.name.clone())));
            let none = view.camera.devices.is_empty();
            let pills = rows.into_iter().enumerate().map(|(i, (id, name))| {
                let active = id == chosen;
                tray_pill(
                    SharedString::from(format!("tray-camera-{i}")),
                    active.then_some(Icon::Check),
                    SharedString::from(name),
                    active,
                    false,
                )
                .on_click(cx.listener(move |v, _, _, cx| v.choose_camera(id.clone(), cx)))
            });
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(14.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(tray_title(Icon::Camera, "Camera"))
                        .child(
                            div()
                                .id("tray-camera-scroll")
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .overflow_x_scroll()
                                .children(pills)
                                .when(none, |el| {
                                    el.child(
                                        div()
                                            .text_size(px(13.5))
                                            .text_color(tokens::text_2())
                                            .child("No camera found"),
                                    )
                                }),
                        ),
                )
                .child(tray_done(cx))
                .into_any_element()
        }
        Pop::Games => {
            let open = room.activity.as_ref().map(|a| a.current.id.clone());
            let people = room.members.len() + 1;
            let activities = rtc_games::activities(room.dev_activities).into_iter().map(|a| {
                let disabled = people < a.min_people || open.as_deref() == Some(a.id);
                tray_pill(
                    SharedString::from(format!("tray-game-{}", a.id)),
                    None,
                    SharedString::from(format!("{}  {}", a.icon, a.name)),
                    open.as_deref() == Some(a.id),
                    false,
                )
                .when(!disabled, |el| {
                    el.on_click(cx.listener(move |v, _, _, cx| {
                        v.pop = None;
                        v.start_activity(a.id, cx);
                    }))
                })
                .when(disabled, |el| el.opacity(0.4).cursor_default())
            });
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(14.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(tray_title(Icon::Games, "Play together"))
                        .child(
                            div()
                                .id("tray-games-scroll")
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .overflow_x_scroll()
                                .children(activities),
                        ),
                )
                .child(tray_done(cx))
                .into_any_element()
        }
    };
    div()
        .h(px(80.))
        .flex_none()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(14.))
        .px(px(20.))
        .bg(tokens::panel())
        .border_t_1()
        .border_color(tokens::raised())
        .child(content)
        .into_any_element()
}

fn dock(view: &RoomView, room: &Snapshot, is_fullscreen: bool, cx: &mut Context<'_, RoomView>) -> AnyElement {
    if let Some(pop) = view.pop {
        return horizontal_tray(pop, view, room, is_fullscreen, cx);
    }
    let me_host = room.host.as_ref() == Some(&room.me);
    let mic_off = room.muted || room.deafened;
    let speaking = room.speaking && !mic_off;
    // push-to-talk (`DesktopDock.tsx`): "Hold ~ to talk", "Talking"
    let ptt = view.settings.voice_mode == crate::settings::VoiceMode::Ptt;
    let ptt_key = view.settings.ptt_keys.to_string();
    let status: String = if room.deafened {
        "Deafened".into()
    } else if ptt {
        if view.ptt_talking && !room.muted {
            "Talking".into()
        } else {
            format!("Hold {ptt_key} to talk")
        }
    } else if room.muted {
        "Mic off".into()
    } else if speaking {
        "Speaking".into()
    } else {
        "Mic on".into()
    };
    let mic_label: String = if room.deafened {
        "Deafened".into()
    } else if ptt {
        if view.ptt_talking && !room.muted {
            "Talking".into()
        } else {
            format!("Hold {ptt_key}")
        }
    } else if room.muted {
        "Mic off".into()
    } else {
        "Mic on".into()
    };
    let you = div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(10.))
        .child(avatar(&room.username, 36., speaking, tokens::panel()))
        .child(
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .gap(px(4.))
                        .max_w(px(160.))
                        .overflow_hidden()
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(room.username.clone())
                        .child(
                            div()
                                .text_color(tokens::text_3())
                                .font_weight(FontWeight::MEDIUM)
                                .child(if me_host { "(you · host)" } else { "(you)" }),
                        ),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(if mic_off {
                            tokens::danger_text()
                        } else if speaking {
                            tokens::live_text()
                        } else {
                            tokens::text_2()
                        })
                        .child(status),
                ),
        );
    let peers = div()
        .flex()
        .items_center()
        .gap(px(6.))
        .pl(px(10.))
        .border_l_1()
        .border_color(tokens::line())
        .children(room.members.iter().take(3).map(|(peer, m)| {
            let name = m.username.clone().unwrap_or_else(|| "Peer".to_owned());
            let (_, muted_for_me) = view.peer_volume(m);
            let who = peer.clone();
            div()
                .id(SharedString::from(format!("dock-peer-{peer}")))
                .relative()
                .cursor_pointer()
                .on_click(cx.listener(move |v, _, _, cx| v.open_volume(who.clone(), cx)))
                .child(avatar(&name, 34., m.speaking && !m.muted, tokens::panel()))
                .when(m.muted || muted_for_me, |el| {
                    el.child(muted_badge(tokens::panel(), px(14.)))
                })
        }))
        .when(room.members.len() > 3, |el| {
            el.child(
                div()
                    .size(px(32.))
                    .rounded_full()
                    .bg(tokens::raised())
                    .border_1()
                    .border_color(tokens::line())
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(11.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(tokens::text_2())
                    .child(format!("+{}", room.members.len() - 3)),
            )
        });
    let mic = div()
        .relative()
        .flex()
        .flex_none()
        .rounded(px(13.))
        .bg(if mic_off {
            tokens::danger_bg()
        } else {
            tokens::raised()
        })
        .text_color(if mic_off {
            tokens::danger_text()
        } else {
            tokens::text()
        })
        .child(
            div()
                .id("mic")
                .h(px(46.))
                .pl(px(12.))
                .pr(px(14.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded_l(px(13.))
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .hover(|s| s.bg(tokens::white().opacity(0.05)))
                .when(!ptt, |el| {
                    el.on_click(cx.listener(|v, _, _, cx| {
                        v.toggle_mic();
                        cx.notify();
                    }))
                })
                // push-to-talk: hold the button to talk, like the key
                .when(ptt, |el| {
                    el.on_mouse_down(
                        gpui_kit::MouseButton::Left,
                        cx.listener(|v, _, window, cx| v.ptt_button(true, window, cx)),
                    )
                    .on_mouse_up(
                        gpui_kit::MouseButton::Left,
                        cx.listener(|v, _, window, cx| v.ptt_button(false, window, cx)),
                    )
                    .on_mouse_up_out(
                        gpui_kit::MouseButton::Left,
                        cx.listener(|v, _, window, cx| v.ptt_button(false, window, cx)),
                    )
                })
                .child(icon(
                    if mic_off { Icon::MicOff } else { Icon::Mic },
                    px(20.),
                    if mic_off {
                        tokens::danger_text()
                    } else {
                        tokens::text()
                    },
                ))
                .child(mic_label),
        )
        .child(
            div()
                .id("mic-caret")
                .w(px(32.))
                .h(px(46.))
                .flex()
                .items_center()
                .justify_center()
                .border_l_1()
                .border_color(if mic_off {
                    tokens::danger_line()
                } else {
                    tokens::line()
                })
                .rounded_r(px(13.))
                .cursor_pointer()
                .hover(|s| s.bg(tokens::white().opacity(0.05)))
                .on_click(cx.listener(|v, _, _, cx| v.toggle_pop(Pop::Devices, cx)))
                .child(icon_bold(
                    Icon::ChevronUp,
                    px(14.),
                    if mic_off {
                        tokens::danger_text()
                    } else {
                        tokens::text_2()
                    },
                )),
        )
        .when(view.pop == Some(Pop::Devices), |el| {
            el.child(devices_pop(view, cx))
        });
    let more = div()
        .relative()
        .child(
            dock_btn("more", Icon::More, view.pop == Some(Pop::More), false)
                .on_click(cx.listener(|v, _, _, cx| v.toggle_pop(Pop::More, cx))),
        )
        .when(view.pop == Some(Pop::More), |el| {
            el.child(more_pop(view, room, is_fullscreen, cx))
        });
    div()
        .h(px(80.))
        .flex_none()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(14.))
        .px(px(20.))
        .bg(tokens::panel())
        .border_t_1()
        .border_color(tokens::raised())
        .child(div().flex_1().flex().items_center().gap(px(12.)).child(you).when(
            !room.members.is_empty(),
            |el| {
                el.child(
                    div()
                        .relative()
                        .child(peers)
                        .when(view.pop == Some(Pop::Volume), |el| {
                            el.child(volume_pop(view, room, cx))
                        }),
                )
            },
        ))
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.))
                .child(mic)
                .child(crate::camera::dock_button(view, cx))
                .child(
                    dock_btn(
                        "deafen",
                        if room.deafened {
                            Icon::HeadphonesOff
                        } else {
                            Icon::Headphones
                        },
                        false,
                        room.deafened,
                    )
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.toggle_deafen();
                        cx.notify();
                    })),
                )
                .child(
                    div()
                        .relative()
                        .child(
                            dock_btn("reactions", Icon::Smile, view.pop == Some(Pop::Reactions), false)
                                .on_click(cx.listener(|v, _, _, cx| v.toggle_pop(Pop::Reactions, cx))),
                        )
                        .when(view.pop == Some(Pop::Reactions), |el| {
                            el.child(crate::fun::reactions_pop(view, cx))
                        }),
                )
                .child(
                    div()
                        .relative()
                        .child(
                            dock_btn("sounds", Icon::Music, view.pop == Some(Pop::Sounds), false)
                                .on_click(cx.listener(|v, _, _, cx| v.toggle_pop(Pop::Sounds, cx))),
                        )
                        .when(view.pop == Some(Pop::Sounds), |el| {
                            el.child(crate::fun::sounds_pop(view, cx))
                        }),
                )
                .when(!crate::watch::locked_for_me(room), |el| {
                    el.child(
                        dock_btn("add-video", Icon::VideoAdd, false, false)
                            .on_click(cx.listener(|v, _, window, cx| v.choose_video_file(window, cx))),
                    )
                })
                .child(
                    dock_btn(
                        "screen",
                        if view.screen.mine {
                            Icon::ScreenShareOff
                        } else {
                            Icon::ScreenShare
                        },
                        view.screen.sharer.is_some(),
                        false,
                    )
                    .on_click(cx.listener(|v, _, _, cx| v.screen_button(cx))),
                )
                .child(if rtc_games::activities(room.dev_activities).is_empty() {
                    later_btn("games", Icon::Games, cx).into_any_element()
                } else {
                    div()
                        .relative()
                        .child(
                            dock_btn("games", Icon::Games, view.pop == Some(Pop::Games), false)
                                .on_click(cx.listener(|v, _, _, cx| v.toggle_pop(Pop::Games, cx))),
                        )
                        .when(view.pop == Some(Pop::Games), |el| {
                            el.child(crate::activity::games_pop(view, room, cx))
                        })
                        .into_any_element()
                })
                .child(more)
                .when(room.watch.showing.is_some(), |el| {
                    el.child(
                        div()
                            .id("dock-fullscreen")
                            .h(px(46.))
                            .px(px(14.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(13.))
                            .bg(tokens::raised())
                            .text_color(tokens::text())
                            .text_size(px(13.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .cursor_pointer()
                            .hover(|s| s.bg(tokens::white().opacity(0.08)))
                            .on_click(cx.listener(|v, _, window, cx| v.toggle_video_fullscreen(window, cx)))
                            .child("Full screen"),
                    )
                }),
        )
        .child(
            div()
                .flex_1()
                .flex()
                .items_center()
                .justify_end()
                .gap(px(10.))
                .child(crate::fun::dock_reactions(view, cx))
                .child(
                    div()
                        .id("leave")
                        .h(px(42.))
                        .px(px(16.))
                        .flex()
                        .items_center()
                        .rounded(px(11.))
                        .border_1()
                        .border_color(tokens::danger_line())
                        .text_color(tokens::danger_text())
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .cursor_pointer()
                        .hover(|s| s.bg(tokens::danger_bg()))
                        .on_click(cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Leave, cx)))
                        .child("Leave"),
                ),
        )
        .into_any_element()
}

/// A device list in the devices popover and the voice settings (the web app's `<select>`).
pub(crate) fn device_list(view: &RoomView, input: bool, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let (list, chosen) = if input {
        (&view.devices.inputs, &view.settings.input_device_id)
    } else {
        (&view.devices.outputs, &view.settings.output_device_id)
    };
    let mut rows: Vec<(String, String)> = vec![(String::new(), "System default".to_owned())];
    rows.extend(list.iter().map(|d| (d.id.clone(), d.name.clone())));
    div()
        .flex()
        .flex_col()
        // it clips its rows, so in a scrolling column it would otherwise shrink to nothing
        .flex_none()
        .rounded(px(10.))
        .border_1()
        .border_color(tokens::line_strong())
        .bg(tokens::bg())
        .overflow_hidden()
        .children(rows.into_iter().enumerate().map(|(i, (id, name))| {
            let selected = *chosen == id;
            let label = name.clone();
            div()
                .id(SharedString::from(format!(
                    "{}-{i}",
                    if input { "in" } else { "out" }
                )))
                .px(px(12.))
                .py(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(14.))
                .cursor_pointer()
                .when(selected, |el| el.bg(tokens::raised()))
                .hover(|s| s.bg(tokens::raised()))
                .on_click(cx.listener(move |v, _, _, cx| {
                    if input {
                        v.pick_input(id.clone(), label.clone(), cx);
                    } else {
                        v.pick_output(id.clone(), label.clone(), cx);
                    }
                }))
                .child(div().w(px(16.)).when(selected, |el| {
                    el.child(icon_bold(Icon::Check, px(14.), tokens::live()))
                }))
                .child(div().flex_1().overflow_hidden().child(name))
        }))
        .when(list.is_empty(), |el| {
            el.child(
                div()
                    .px(px(12.))
                    .pb(px(8.))
                    .text_size(px(12.))
                    .text_color(tokens::text_3())
                    .child("No sound card found: the app sends silence."),
            )
        })
}

fn devices_pop(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let label = |t: &'static str| {
        div()
            .text_size(px(14.))
            .font_weight(FontWeight::SEMIBOLD)
            .child(t)
    };
    deferred(
        div().absolute().bottom(px(56.)).left_0().occlude().child(
            popover()
                .id("devices-pop")
                .w(px(320.))
                .flex()
                .flex_col()
                .gap(px(6.))
                .on_mouse_down_out(cx.listener(|v, _, _, cx| {
                    v.pop = None;
                    cx.notify();
                }))
                .child(label("🎙️ Input device"))
                .child(device_list(view, true, cx))
                .child(div().h(px(4.)))
                .child(label("🔊 Output device"))
                .child(device_list(view, false, cx))
                .child(
                    div()
                        .id("voice-settings-link")
                        .mt(px(8.))
                        .px(px(8.))
                        .py(px(10.))
                        .rounded(px(10.))
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(tokens::text_2())
                        .cursor_pointer()
                        .hover(|s| s.bg(tokens::raised()).text_color(tokens::text()))
                        .on_click(cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Voice, cx)))
                        .child("Voice settings & mic test…"),
                ),
        ),
    )
    .with_priority(1)
}

/// A person's volume for you (`PeerAudioPopover` in `PeerVoiceRoster.tsx`): the slider
/// (0–200%), presets, mute for me and reset.
fn volume_pop(view: &RoomView, room: &Snapshot, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let Some((peer, m)) = view
        .volume_for
        .as_ref()
        .and_then(|p| room.members.iter().find(|(q, _)| q == p))
    else {
        return div().into_any_element();
    };
    let name = m.username.clone().unwrap_or_else(|| "Peer".to_owned());
    let (volume, muted) = view.peer_volume(m);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let pct = (volume * 100.0).round() as u32;
    let works = view.has_pipeline();
    let status = if m.speaking && !m.muted {
        ("Speaking", tokens::live_text())
    } else if muted {
        ("You muted them", tokens::danger_text())
    } else if m.muted {
        ("Mic off", tokens::text_2())
    } else {
        ("Mic on", tokens::text_2())
    };
    let badge_text = if muted {
        "0% (Muted)".to_owned()
    } else if pct > 100 {
        format!("{pct}% (Boosted)")
    } else if pct == 100 {
        "100% (Default)".to_owned()
    } else {
        format!("{pct}%")
    };
    let badge_color = if muted || pct == 0 {
        tokens::danger_text()
    } else if pct > 100 {
        tokens::warn()
    } else {
        tokens::focus()
    };
    let preset = |label: &'static str, val: f32| {
        let on = !muted && (volume - val).abs() < 0.04;
        let who = peer.clone();
        div()
            .id(label)
            .flex_1()
            .py(px(6.))
            .flex()
            .justify_center()
            .rounded(px(8.))
            .border_1()
            .border_color(if on { tokens::focus() } else { tokens::line() })
            .bg(if on {
                alpha(tokens::focus(), 0.12)
            } else {
                tokens::bg()
            })
            .text_color(if on { tokens::focus() } else { tokens::text_2() })
            .text_size(px(12.))
            .font_weight(FontWeight::SEMIBOLD)
            .cursor_pointer()
            .hover(|s| s.border_color(tokens::line_strong()))
            .on_click(cx.listener(move |v, _, _, cx| v.set_peer_volume(&who, val, false, cx)))
            .child(label)
    };
    let (mute_who, reset_who) = (peer.clone(), peer.clone());
    deferred(
        div().absolute().bottom(px(56.)).left_0().occlude().child(
            popover()
                .id("volume-pop")
                .w(px(300.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .on_mouse_down_out(cx.listener(|v, _, _, cx| {
                    v.pop = None;
                    cx.notify();
                }))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(avatar(&name, 36., m.speaking && !m.muted, tokens::surface()))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().text_size(px(15.)).font_weight(FontWeight::BOLD).child(name.clone()))
                                .child(div().text_size(px(12.)).text_color(status.1).child(status.0)),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Individual Volume"),
                        )
                        .child(
                            div()
                                .px(px(7.))
                                .py(px(1.))
                                .rounded(px(6.))
                                .bg(alpha(badge_color, 0.15))
                                .text_color(badge_color)
                                .text_size(px(12.))
                                .font_weight(FontWeight::BOLD)
                                .child(badge_text),
                        ),
                )
                .when_some(view.volume_slider.as_ref().filter(|_| works), |el, state| {
                    el.child(Slider::new(state).accessibility_label(format!("Volume for {name}")))
                        .child(
                            div()
                                .flex()
                                .justify_between()
                                .text_size(px(11.))
                                .text_color(tokens::text_2())
                                .child("0%")
                                .child("100%")
                                .child("200%"),
                        )
                        .child(
                            div()
                                .flex()
                                .gap(px(6.))
                                .child(preset("50%", 0.5))
                                .child(preset("100%", 1.0))
                                .child(preset("150%", 1.5))
                                .child(preset("200%", 2.0)),
                        )
                        .child(
                            div()
                                .flex()
                                .gap(px(8.))
                                .child(
                                    Button::new("volume-mute", if muted { "Unmute for Me" } else { "Mute for Me" })
                                        .variant(if muted { Variant::Primary } else { Variant::Secondary })
                                        .min_height(px(34.))
                                        .font_size(px(13.))
                                        .on_click(cx.listener(move |v, _, _, cx| {
                                            v.set_peer_volume(&mute_who, volume, !muted, cx);
                                        })),
                                )
                                .child(
                                    Button::new("volume-reset", "Reset (100%)")
                                        .min_height(px(34.))
                                        .font_size(px(13.))
                                        .on_click(cx.listener(move |v, _, _, cx| {
                                            v.set_peer_volume(&reset_who, 1.0, false, cx);
                                        })),
                                ),
                        )
                })
                .when(!works, |el| {
                    el.child(
                        div()
                            .text_size(px(12.))
                            .line_height(gpui_kit::relative(1.45))
                            .text_color(tokens::text_2())
                            .child("Per-person volume needs 3RTC's own audio. Turn off Classic audio in Voice settings."),
                    )
                }),
        ),
    )
    .with_priority(1)
    .into_any_element()
}

fn more_pop(
    view: &RoomView,
    room: &Snapshot,
    is_fullscreen: bool,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let is_host = room.host.as_ref() == Some(&room.me);
    let lock = room.playback_lock;
    deferred(
        div().absolute().bottom(px(56.)).right(px(-100.)).occlude().child(
            menu()
                .id("more-pop")
                .on_mouse_down_out(cx.listener(|v, _, _, cx| {
                    v.pop = None;
                    cx.notify();
                }))
                .child(menu_item(
                    "m-fullscreen",
                    None,
                    if is_fullscreen {
                        "Exit full screen (F11)"
                    } else {
                        "Full screen (F11)"
                    },
                    false,
                    None,
                    Some(Box::new(cx.listener(|v, _, window, cx| {
                        v.pop = None;
                        v.toggle_app_fullscreen(window, cx);
                    }))),
                ))
                .child(menu_item(
                    "m-voice",
                    Some(Icon::Settings),
                    "Voice settings",
                    false,
                    None,
                    Some(Box::new(
                        cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Voice, cx)),
                    )),
                ))
                .child(menu_item(
                    "m-conn",
                    Some(Icon::Signal),
                    "Connection details",
                    false,
                    None,
                    Some(Box::new(cx.listener(|v, _, _, cx| v.open_net(cx)))),
                ))
                .child(menu_item(
                    "m-app-sound",
                    Some(Icon::Speaker),
                    if view.extras.sharing.is_some() {
                        "Sharing an app's sound…"
                    } else {
                        "Share an app's sound…"
                    },
                    false,
                    None,
                    Some(Box::new(cx.listener(|v, _, _, cx| v.open_app_sound(cx)))),
                ))
                .child(menu_item(
                    "m-qr",
                    Some(Icon::Qr),
                    "Invite with QR code",
                    false,
                    None,
                    Some(Box::new(cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Qr, cx)))),
                ))
                .when(is_host, |el| {
                    el.child(menu_item(
                        "m-lock",
                        Some(Icon::Lock),
                        "Only I control playback",
                        false,
                        Some(rtc_ui::overlay::switch(lock).into_any_element()),
                        Some(Box::new(cx.listener(move |v, _, _, cx| {
                            v.pop = None;
                            v.command(rtc_core::Command::SetPlaybackLock(!lock));
                            cx.notify();
                        }))),
                    ))
                })
                .when(!is_host && lock, |el| {
                    el.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .min_h(px(44.))
                            .px(px(12.))
                            .text_size(px(14.))
                            .text_color(tokens::text_2())
                            .child(icon(Icon::Lock, px(18.), tokens::text_2()))
                            .child("The host controls playback"),
                    )
                })
                .child(menu_item(
                    "m-desktop",
                    Some(Icon::Settings),
                    "Desktop settings",
                    false,
                    None,
                    Some(Box::new(
                        cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Desktop, cx)),
                    )),
                ))
                .child(menu_item(
                    "m-player-shortcuts",
                    Some(Icon::Settings),
                    "Player shortcuts…",
                    false,
                    None,
                    Some(Box::new(
                        cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Player, cx)),
                    )),
                ))
                .child(menu_item(
                    "m-server",
                    Some(Icon::Settings),
                    "Server settings",
                    false,
                    None,
                    Some(Box::new(
                        cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Server, cx)),
                    )),
                )),
        ),
    )
    .with_priority(1)
}

// ---- side panel ---------------------------------------------------------------------------------

/// A tab: which, its label, and a count (text, in the accent colour or not).
type TabSpec = (Tab, &'static str, Option<(String, bool)>);

fn panel(
    view: &mut RoomView,
    room: &Snapshot,
    id: RoomId,
    window: &mut Window,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let alone = room.members.is_empty();
    let mut tabs: Vec<TabSpec> = Vec::new();
    if alone {
        tabs.push((Tab::Invite, "Invite", None));
    }
    tabs.push((
        Tab::Chat,
        "Chat",
        (view.unread > 0 && view.tab != Tab::Chat).then(|| (view.unread.to_string(), true)),
    ));
    tabs.push((Tab::Queue, "Queue", None));
    tabs.push((
        Tab::People,
        "People",
        Some(((room.members.len() + 1).to_string(), false)),
    ));
    tabs.push((
        Tab::Logs,
        "Logs",
        (view.logs_unseen > 0).then(|| (view.logs_unseen.to_string(), false)),
    ));
    let tab = if view.tab == Tab::Invite && !alone {
        Tab::Chat
    } else {
        view.tab
    };
    let bar = div()
        .flex()
        .flex_none()
        .gap(px(4.))
        .p(px(12.))
        .border_b_1()
        .border_color(tokens::raised())
        .children(tabs.into_iter().map(|(t, label, count)| {
            let active = t == tab;
            div()
                .id(label)
                .flex_1()
                .h(px(40.))
                .flex()
                .items_center()
                .justify_center()
                .gap(px(6.))
                .rounded(px(10.))
                .text_size(px(14.))
                .font_weight(if active {
                    FontWeight::BOLD
                } else {
                    FontWeight::SEMIBOLD
                })
                .text_color(if active { tokens::text() } else { tokens::text_2() })
                .when(active, |el| el.bg(tokens::raised()))
                .cursor_pointer()
                .hover(|s| s.text_color(tokens::text()))
                .on_click(cx.listener(move |v, _, _, cx| v.set_tab(t, cx)))
                .child(label)
                .when_some(count, |el, (n, accent)| {
                    if t == Tab::People {
                        el.child(div().font_weight(FontWeight::SEMIBOLD).child(n))
                    } else {
                        el.child(badge(n, accent))
                    }
                })
        }));
    let body = match tab {
        Tab::Invite => invite_tab(view, id, cx).into_any_element(),
        Tab::Chat => chat_tab(view, room, window, cx).into_any_element(),
        Tab::Queue => crate::watch::queue_tab(view, room, window, cx),
        Tab::People => people_tab(view, room, cx).into_any_element(),
        Tab::Logs => logs_tab(view, cx).into_any_element(),
    };
    div()
        .w(px(PANEL_WIDTH))
        .h_full()
        .flex_none()
        .flex()
        .flex_col()
        .bg(tokens::surface())
        .border_l_1()
        .border_color(tokens::line())
        .relative()
        .on_drop(cx.listener(|v, paths: &ExternalPaths, _, cx| v.dropped(paths, cx)))
        .child(bar)
        .child(div().flex_1().min_h_0().flex().flex_col().child(body))
        .child(drop_hint())
        .into_any_element()
}

/// "Drop to send": over the side panel while files or a folder are dragged over it, so it's
/// clear the drop will work (`RoomView::dropped` takes them). Hidden otherwise, and never in
/// the way of the mouse.
fn drop_hint() -> impl IntoElement {
    div()
        .absolute()
        .inset_0()
        .p(px(12.))
        .opacity(0.)
        // its own hitbox doesn't block the mouse: the panel under it still takes the drop
        .drag_over::<ExternalPaths>(|s, _, _, _| s.opacity(1.))
        .child(
            div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(8.))
                .rounded(px(14.))
                .border(px(2.))
                .border_dashed()
                .border_color(tokens::accent())
                .bg(tokens::surface().opacity(0.94))
                .child(div().text_size(px(34.)).child("📎"))
                .child(
                    div()
                        .text_size(px(16.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(tokens::text())
                        .child("Drop to send in chat"),
                )
                .child(
                    div()
                        .text_size(px(12.5))
                        .text_color(tokens::text_2())
                        .child("A picture, a file or a folder"),
                ),
        )
}

fn invite_tab(view: &RoomView, id: RoomId, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let copied = view.copied == Some("link");
    let link = RoomView::invite_link(id);
    let whatsapp = format!(
        "https://wa.me/?text={}",
        urlencode(&format!("Join me on 3RTC: {link}"))
    );
    div()
        .flex_1()
        .flex()
        .flex_col()
        .gap(px(20.))
        .px(px(16.))
        .py(px(20.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .font_family(tokens::FONT_DISPLAY_TIGHT_1)
                        .font_weight(FontWeight::BOLD)
                        .text_size(px(24.))
                        .child("You’re the first one here"),
                )
                .child(
                    div()
                        .text_size(px(15.))
                        .line_height(gpui_kit::relative(1.5))
                        .text_color(tokens::text_2())
                        .child("Send your friends the link, or have them type this code on 3rtc.me."),
                ),
        )
        .child(div().flex().gap(px(8.)).children(id.to_string().chars().map(|c| {
            div()
                .flex_1()
                .h(px(60.))
                .rounded(px(12.))
                .bg(tokens::raised())
                .flex()
                .items_center()
                .justify_center()
                .font_family(tokens::FONT_MONO)
                .font_weight(FontWeight::BOLD)
                .text_size(px(28.))
                .child(c.to_string())
        })))
        .child(
            Button::new(
                "copy-link",
                if copied { "Link copied" } else { "Copy invite link" },
            )
            .variant(Variant::Primary)
            .min_height(px(48.))
            .font_size(px(16.))
            .full_width()
            .on_click(cx.listener(move |v, _, _, cx| v.copy(link.clone(), "link", cx))),
        )
        .child(
            div()
                .flex()
                .gap(px(10.))
                .child(
                    div().flex_1().child(
                        Button::new("whatsapp", "WhatsApp")
                            .full_width()
                            .on_click(move |_, _, cx: &mut App| cx.open_url(&whatsapp)),
                    ),
                )
                .child(
                    div().flex_1().child(
                        Button::new("show-qr", "Show QR code")
                            .full_width()
                            .on_click(cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Qr, cx))),
                    ),
                ),
        )
        // the desktop app's own link, for friends who have it too
        .child({
            let app_link = crate::links::app_link(id);
            let copied_app = view.copied == Some("app-link");
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(13.))
                .text_color(tokens::text_3())
                .child("Friends with the desktop app:")
                .child(
                    div()
                        .id("copy-app-link")
                        .font_family(tokens::FONT_MONO)
                        .text_color(tokens::text_2())
                        .cursor_pointer()
                        .hover(|s| s.text_color(tokens::text()))
                        .on_click(cx.listener({
                            let app_link = app_link.clone();
                            move |v, _, _, cx| v.copy(app_link.clone(), "app-link", cx)
                        }))
                        .child(if copied_app { "Copied".to_owned() } else { app_link }),
                )
        })
        .child(div().flex_1())
        .child(
            div()
                .pt(px(16.))
                .border_t_1()
                .border_color(tokens::raised())
                .flex()
                .flex_col()
                .gap(px(4.))
                .text_size(px(14.))
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Chat, queue and people show up here"),
                )
                .child(
                    div()
                        .text_color(tokens::text_3())
                        .child("Switch tabs above once friends arrive."),
                ),
        )
}

pub(crate) fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn date_label(at_ms: f64) -> String {
    use chrono::{Datelike, TimeZone as _};
    #[allow(clippy::cast_possible_truncation)]
    let ms = at_ms as i64;
    let Some(dt) = chrono::Local.timestamp_millis_opt(ms).single() else {
        return "Today".to_string();
    };
    let now = chrono::Local::now();
    let today = now.date_naive();
    let msg_date = dt.date_naive();
    let yesterday = today - chrono::Duration::days(1);
    if msg_date == today {
        "Today".to_string()
    } else if msg_date == yesterday {
        "Yesterday".to_string()
    } else if msg_date.year() == today.year() {
        dt.format("%B %-d").to_string()
    } else {
        dt.format("%B %-d, %Y").to_string()
    }
}

fn chat_tab(
    view: &RoomView,
    room: &Snapshot,
    window: &mut Window,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    use chrono::TimeZone as _;
    let focused = view.message.read(cx).focus_handle(cx).is_focused(window);
    let targets = crate::chat::mention_targets(room);
    let mut rows = Vec::new();
    let mut prev: Option<(&PeerId, f64)> = None;
    let mut prev_date: Option<chrono::NaiveDate> = None;
    for (i, line) in view.chat.iter().enumerate() {
        #[allow(clippy::cast_possible_truncation)]
        let msg_date = chrono::Local
            .timestamp_millis_opt(line.at as i64)
            .single()
            .map(|d| d.date_naive());
        if msg_date != prev_date {
            prev_date = msg_date;
            rows.push(
                div()
                    .w_full()
                    .py(px(6.))
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .px(px(10.))
                            .py(px(3.))
                            .rounded_full()
                            .bg(tokens::raised())
                            .text_size(px(11.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(tokens::text_2())
                            .child(date_label(line.at)),
                    )
                    .into_any_element(),
            );
        }

        if view.chat_first_unread == Some(i) {
            rows.push(
                div()
                    .w_full()
                    .my(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(div().flex_1().h(px(1.)).bg(tokens::accent().opacity(0.4)))
                    .child(
                        div()
                            .px(px(8.))
                            .py(px(2.))
                            .rounded_full()
                            .bg(tokens::accent().opacity(0.15))
                            .text_size(px(11.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(tokens::accent())
                            .child(format!("{} Unread Messages", view.chat_unread_count.max(1))),
                    )
                    .child(div().flex_1().h(px(1.)).bg(tokens::accent().opacity(0.4)))
                    .into_any_element(),
            );
        }

        let starts = prev.is_none_or(|(p, at)| *p != line.from || (line.at - at).abs() > 5.0 * 60_000.0);
        prev = Some((&line.from, line.at));
        let mine = line.from == room.me;
        let name = if mine { "You".to_owned() } else { line.name.clone() };
        let color = avatar::color(&line.name);
        let bubble_group: SharedString = format!("msg-bubble-{i}").into();
        rows.push(
            div()
                .flex()
                .gap(px(10.))
                .items_start()
                .when(mine, gpui_kit::Styled::flex_row_reverse)
                .when(starts && !rows.is_empty(), |el| el.mt(px(10.)))
                .child(if starts && !mine {
                    avatar(&line.name, 30., false, tokens::surface()).into_any_element()
                } else if !mine {
                    div().w(px(30.)).flex_none().into_any_element()
                } else {
                    div().into_any_element()
                })
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .when(mine, gpui_kit::Styled::items_end)
                        .when(!mine, gpui_kit::Styled::items_start)
                        .gap(px(2.))
                        .when(starts, |el| {
                            el.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .when(mine, gpui_kit::Styled::flex_row_reverse)
                                    .child(
                                        div()
                                            .text_size(px(14.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(color)
                                            .child(name),
                                    )
                                    .when(line.is_host, |el| {
                                        el.child(
                                            div()
                                                .px(px(6.))
                                                .py(px(1.))
                                                .rounded(px(6.))
                                                .bg(tokens::raised())
                                                .text_color(tokens::text_2())
                                                .text_size(px(12.))
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child("HOST"),
                                        )
                                    })
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(4.))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(tokens::text_3())
                                                    .child(clock(line.at)),
                                            )
                                            .when(mine, |el| {
                                                el.child(
                                                    div()
                                                        .text_size(px(11.))
                                                        .text_color(tokens::focus())
                                                        .font_weight(FontWeight::BOLD)
                                                        .child("✓✓"),
                                                )
                                            }),
                                    ),
                            )
                        })
                        .children(crate::chat::picture_view(view, line, mine, cx))
                        .children(line.reply.as_ref().map(crate::chat::quote_view))
                        .when(!line.text.is_empty(), |el| {
                            let text = crate::chat::rich_text(
                                SharedString::from(format!("msg-text-{i}")),
                                &line.text,
                                &targets,
                            );
                            let copy_text = line.text.clone();
                            let quote = rtc_core::Quote {
                                id: line.id.clone(),
                                name: line.name.clone(),
                                text: rtc_core::chat_format::plain_snippet(
                                    &line.text,
                                    rtc_core::chat_format::REPLY_SNIPPET_CHARS,
                                ),
                                mine,
                            };
                            el.child(
                                div()
                                    .id(SharedString::from(format!("bubble-{i}")))
                                    .group(bubble_group.clone())
                                    .relative()
                                    .max_w_full()
                                    .px(px(12.))
                                    .py(px(7.))
                                    .rounded(px(12.))
                                    .bg(if mine {
                                        tokens::focus().opacity(0.15)
                                    } else {
                                        tokens::raised()
                                    })
                                    .border_1()
                                    .border_color(if line.mentions_me {
                                        tokens::focus()
                                    } else if mine {
                                        tokens::focus().opacity(0.3)
                                    } else {
                                        tokens::line()
                                    })
                                    .cursor_pointer()
                                    .on_click(cx.listener(|v, event: &gpui_kit::ClickEvent, _, _| {
                                        if event.click_count() >= 2 {
                                            v.react("❤️");
                                        }
                                    }))
                                    .child(
                                        div()
                                            .text_size(px(14.))
                                            .line_height(gpui_kit::relative(1.45))
                                            .child(text),
                                    )
                                    .child(
                                        div()
                                            .id(SharedString::from(format!("copy-msg-{i}")))
                                            .absolute()
                                            .top(px(4.))
                                            .right(px(4.))
                                            .size(px(20.))
                                            .rounded(px(4.))
                                            .bg(tokens::surface().opacity(0.9))
                                            .hover(|s| s.bg(tokens::raised()))
                                            .cursor_pointer()
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .opacity(0.0)
                                            .group_hover(bubble_group.clone(), |s| s.opacity(1.0))
                                            .on_click(cx.listener(move |v, _, _, cx| {
                                                v.copy(copy_text.clone(), "chat-msg", cx);
                                                v.show_toast("Message copied", cx);
                                            }))
                                            .child(icon(Icon::Copy, px(12.), tokens::text_2())),
                                    )
                                    .child(
                                        div()
                                            .id(SharedString::from(format!("reply-msg-{i}")))
                                            .absolute()
                                            .top(px(4.))
                                            .right(px(28.))
                                            .size(px(20.))
                                            .rounded(px(4.))
                                            .bg(tokens::surface().opacity(0.9))
                                            .hover(|s| s.bg(tokens::raised()))
                                            .cursor_pointer()
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .text_size(px(12.))
                                            .text_color(tokens::text_2())
                                            .opacity(0.0)
                                            .group_hover(bubble_group, |s| s.opacity(1.0))
                                            .on_click(cx.listener(move |v, _, window, cx| {
                                                v.reply_to = Some(quote.clone());
                                                let input = v.message.read(cx).focus_handle(cx);
                                                input.focus(window, cx);
                                                cx.notify();
                                            }))
                                            .child("↩"),
                                    ),
                            )
                        }),
                )
                .into_any_element(),
        );
    }
    let send_active = !view.message.read(cx).value().trim().is_empty() || view.pending.is_some();
    let show_scroll_btn = view.chat_unread_count > 0 || !view.is_chat_at_bottom();
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .on_drop(cx.listener(|v, paths: &ExternalPaths, _, cx| v.dropped(paths, cx)))
        .child(if rows.is_empty() {
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(6.))
                .px(px(20.))
                .text_center()
                .child(
                    div()
                        .text_size(px(16.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("No messages yet"),
                )
                .child(
                    div()
                        .text_size(px(14.))
                        .text_color(tokens::text_3())
                        .child("Say hi to everyone in the room."),
                )
                .into_any_element()
        } else {
            div()
                .relative()
                .flex_1()
                .min_h_0()
                .child(
                    div()
                        .id("chat-scroll")
                        .track_scroll(&view.chat_scroll)
                        .on_scroll(cx.listener(|v, _, _, cx| {
                            if v.is_chat_at_bottom()
                                && (v.chat_unread_count > 0 || v.chat_first_unread.is_some())
                            {
                                v.chat_unread_count = 0;
                                v.chat_first_unread = None;
                                cx.notify();
                            }
                        }))
                        .size_full()
                        .overflow_y_scroll()
                        .flex()
                        .flex_col()
                        .p(px(16.))
                        .gap(px(4.))
                        .child(div().flex_1().min_h_0())
                        .children(rows),
                )
                .when(show_scroll_btn, |el| {
                    el.child(
                        div()
                            .id("chat-scroll-bottom")
                            .absolute()
                            .bottom(px(12.))
                            .right(px(16.))
                            .size(px(38.))
                            .rounded_full()
                            .bg(tokens::surface())
                            .hover(|s| s.bg(tokens::raised()))
                            .border_1()
                            .border_color(tokens::line_strong())
                            .shadow(tokens::drop_shadow(4., 12., 0.35))
                            .cursor_pointer()
                            .flex()
                            .items_center()
                            .justify_center()
                            .on_click(cx.listener(|v, _, _, cx| v.scroll_chat_to_bottom(cx)))
                            .child(
                                div()
                                    .text_size(px(16.))
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(tokens::text_2())
                                    .child("↓"),
                            )
                            .when(view.chat_unread_count > 0, |badge_el| {
                                badge_el.child(
                                    div()
                                        .absolute()
                                        .top(px(-6.))
                                        .right(px(-6.))
                                        .px(px(6.))
                                        .h(px(18.))
                                        .min_w(px(18.))
                                        .rounded_full()
                                        .bg(tokens::accent())
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_size(px(11.))
                                        .font_weight(FontWeight::BOLD)
                                        .text_color(tokens::white())
                                        .child(if view.chat_unread_count > 99 {
                                            "99+".to_string()
                                        } else {
                                            view.chat_unread_count.to_string()
                                        }),
                                )
                            }),
                    )
                })
                .into_any_element()
        })
        .child(
            div()
                .p(px(12.))
                .border_t_1()
                .border_color(tokens::raised())
                .children(crate::chat::pending_card(view, cx))
                .children(crate::chat::reply_bar(view, cx))
                .when(view.emoji_open, |el| {
                    el.child(crate::chat::emoji_picker(view, cx))
                })
                .child(crate::chat::quick_reactions(view, cx))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .pl(px(4.))
                        .pr(px(4.))
                        .py(px(4.))
                        .rounded(px(14.))
                        .border_1()
                        .border_color(if focused {
                            tokens::focus()
                        } else {
                            tokens::line_strong()
                        })
                        .bg(tokens::bg())
                        .child(
                            div()
                                .id("emoji-toggle")
                                .size(px(36.))
                                .flex_none()
                                .rounded(px(10.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .bg(if view.emoji_open {
                                    tokens::raised()
                                } else {
                                    tokens::bg()
                                })
                                .hover(|s| s.bg(tokens::raised()))
                                .on_click(cx.listener(|v, _, _, cx| {
                                    v.emoji_open = !v.emoji_open;
                                    cx.notify();
                                }))
                                .child(icon(Icon::Smile, px(18.), tokens::text_2())),
                        )
                        .child(div().flex_1().min_w_0().text_size(px(15.)).child({
                            let this = cx.entity().downgrade();
                            gpui_kit::component::input::Input::new(&view.message)
                                .appearance(false)
                                .large()
                                .on_paste(move |item, _, app| {
                                    this.update(app, |v, cx| v.paste_picture(item, cx))
                                        .unwrap_or(false)
                                })
                        }))
                        .child(
                            div()
                                .id("attach")
                                .size(px(36.))
                                .flex_none()
                                .rounded(px(10.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .hover(|s| s.bg(tokens::raised()))
                                .on_click(cx.listener(|v, _, _, cx| v.attach_clicked(cx)))
                                .child(icon(Icon::Image, px(18.), tokens::text_2())),
                        )
                        .child(
                            div()
                                .id("attach-folder")
                                .size(px(36.))
                                .flex_none()
                                .rounded(px(10.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .hover(|s| s.bg(tokens::raised()))
                                .on_click(cx.listener(|v, _, _, cx| v.attach_folder_clicked(cx)))
                                .child(icon(Icon::Folder, px(18.), tokens::text_2())),
                        )
                        .child(
                            div()
                                .id("send")
                                .size(px(40.))
                                .flex_none()
                                .rounded(px(10.))
                                .bg(tokens::accent())
                                .flex()
                                .items_center()
                                .justify_center()
                                .cursor_pointer()
                                .opacity(if send_active { 1.0 } else { 0.9 })
                                .on_click(cx.listener(|v, _, window, cx| v.send_chat_clicked(window, cx)))
                                .child(icon_bold(Icon::Send, px(18.), tokens::white())),
                        ),
                ),
        )
}

fn clock(at_ms: f64) -> String {
    use chrono::TimeZone as _;
    #[allow(clippy::cast_possible_truncation)]
    let ms = at_ms as i64;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map_or_else(crate::view::time_now, |t| t.format("%-I:%M %p").to_string())
}

// a render helper: each argument is one thing the card shows
#[allow(clippy::too_many_arguments)]
fn person_card(
    name: &str,
    you: bool,
    host: bool,
    member: Option<&Member>,
    speaking: bool,
    status: (&'static str, bool),
    make_host: Option<PeerId>,
    volume: Option<(PeerId, String)>,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let chip = |t: &'static str, color: Hsla| {
        div()
            .px(px(5.))
            .rounded(px(4.))
            .bg(alpha(color, 0.15))
            .text_color(color)
            .text_size(px(11.))
            .font_weight(FontWeight::BOLD)
            .child(t)
    };
    div()
        .p(px(14.))
        .rounded(px(14.))
        .border_1()
        .border_color(if you {
            alpha(tokens::focus(), 0.35)
        } else {
            tokens::line()
        })
        .bg(tokens::bg())
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(avatar(name, 36., speaking, tokens::bg()))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .text_size(px(15.))
                                        .font_weight(FontWeight::BOLD)
                                        .child(name.to_owned()),
                                )
                                .when(you, |el| el.child(chip("YOU", tokens::focus())))
                                .when(host, |el| el.child(chip("HOST", tokens::warn())))
                                .when(member.is_some_and(|m| m.desktop), |el| {
                                    el.child(chip("DESKTOP", tokens::text_2()))
                                }),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(if status.1 {
                                    tokens::danger_text()
                                } else if speaking {
                                    tokens::live_text()
                                } else {
                                    tokens::text_2()
                                })
                                .child(status.0),
                        ),
                ),
        )
        .when(make_host.is_some() || volume.is_some(), |el| {
            el.child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .when_some(volume, |el, (peer, label)| {
                        el.child(
                            Button::new(SharedString::from(format!("volume-{peer}")), label)
                                .min_height(px(32.))
                                .padding_x(px(10.))
                                .font_size(px(13.))
                                .on_click(cx.listener(move |v, _, _, cx| v.open_volume(peer.clone(), cx))),
                        )
                    })
                    .when_some(make_host, |el, peer| {
                        el.child(
                            Button::new(SharedString::from(format!("host-{peer}")), "👑 Make host")
                                .min_height(px(32.))
                                .padding_x(px(10.))
                                .font_size(px(13.))
                                .on_click(cx.listener(move |v, _, _, _| v.make_host(peer.clone()))),
                        )
                    }),
            )
        })
        .into_any_element()
}

fn people_tab(view: &RoomView, room: &Snapshot, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let me_host = room.host.as_ref() == Some(&room.me);
    let my_status = if room.deafened {
        ("🔇 Sound off", true)
    } else if room.muted {
        ("🔇 Mic Muted", true)
    } else if room.speaking {
        ("Speaking", false)
    } else {
        ("Mic on", false)
    };
    div()
        .id("people")
        .flex_1()
        .overflow_y_scroll()
        .p(px(16.))
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .pb(px(12.))
                .border_b_1()
                .border_color(tokens::raised())
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(icon(Icon::Mic, px(18.), tokens::focus()))
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(16.))
                                .font_weight(FontWeight::BOLD)
                                .child("People"),
                        )
                        .child(
                            div()
                                .px(px(8.))
                                .py(px(2.))
                                .rounded_full()
                                .bg(alpha(tokens::focus(), 0.15))
                                .border_1()
                                .border_color(alpha(tokens::focus(), 0.4))
                                .text_color(tokens::focus())
                                .text_size(px(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(format!("{} in Room", room.members.len() + 1)),
                        ),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(tokens::text_2())
                        .child("A green ring means someone is talking."),
                ),
        )
        .child(person_card(
            &room.username,
            true,
            me_host,
            None,
            room.speaking && !room.muted,
            my_status,
            None,
            None,
            cx,
        ))
        .when(!room.members.is_empty(), |el| {
            el.child(
                div()
                    .pt(px(4.))
                    .text_size(px(13.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(tokens::text_2())
                    .child(format!("WITH YOU ({})", room.members.len())),
            )
        })
        .children(
            room.members
                .iter()
                .map(|(peer, m)| (peer, m))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|(peer, m)| {
                    let name = m.username.clone().unwrap_or_else(|| "Connecting…".to_owned());
                    let (volume, muted_for_me) = view.peer_volume(m);
                    let status = if !m.connected {
                        ("Connecting…", false)
                    } else if muted_for_me {
                        ("Muted by you", true)
                    } else if m.muted {
                        ("Mic off", true)
                    } else if m.speaking {
                        ("Speaking", false)
                    } else {
                        ("Mic on", false)
                    };
                    let host = room.host.as_ref() == Some(peer);
                    let make = (me_host && m.connected).then(|| peer.clone());
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    let pct = (volume * 100.0).round() as u32;
                    let vol = (m.connected && view.has_pipeline()).then(|| {
                        let label = if muted_for_me {
                            "🔇 Muted".to_owned()
                        } else {
                            format!("🔊 {pct}%")
                        };
                        (peer.clone(), label)
                    });
                    person_card(
                        &name,
                        false,
                        host,
                        Some(m),
                        m.speaking && !m.muted,
                        status,
                        make,
                        vol,
                        cx,
                    )
                }),
        )
}

fn logs_tab(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    // After a connection to someone failed: its full log, to paste where it's needed
    let connection_log = view.connection_log.clone();
    let copied = view.copied == Some("connection-log");
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(14.))
                .py(px(10.))
                .border_b_1()
                .border_color(tokens::raised())
                .text_size(px(12.))
                .text_color(tokens::text_2())
                .child(div().size(px(6.)).rounded_full().bg(tokens::focus()))
                .child(
                    div()
                        .flex_1()
                        .child(format!("{} events recorded", view.logs.len())),
                )
                .when_some(connection_log, |el, log| {
                    el.child(
                        Button::new(
                            "copy-connection-log",
                            if copied { "Copied" } else { "Copy connection log" },
                        )
                        .on_click(cx.listener(move |v, _, _, cx| {
                            v.copy(log.clone(), "connection-log", cx);
                        })),
                    )
                }),
        )
        .child(
            div()
                .id("logs")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .p(px(14.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .children(view.logs.iter().rev().map(|l| {
                    div()
                        .flex()
                        .gap(px(12.))
                        .px(px(10.))
                        .py(px(8.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(tokens::line())
                        .bg(tokens::bg())
                        .text_size(px(13.))
                        .child(
                            div()
                                .flex_none()
                                .font_family(tokens::FONT_MONO)
                                .text_size(px(11.))
                                .text_color(tokens::text_3())
                                .child(l.time.clone()),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .line_height(gpui_kit::relative(1.4))
                                .child(l.text.clone()),
                        )
                })),
        )
}
