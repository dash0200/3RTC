//! The room screen (`App.tsx`, the computer layout): header (`Header.tsx`, `.rh-*`), stage
//! (`YouTubeSyncPlayer.tsx` with nothing playing, `.rd-pick`, `.rd-dropzone`), dock
//! (`DesktopDock.tsx`, `.dock-*`) and the side panel (`LiveChat.tsx`, `InvitePanel.tsx`).

use gpui_kit::component::Sizable as _;
use gpui_kit::{
    AnyElement, App, Context, Div, Focusable as _, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, Stateful, StatefulInteractiveElement as _, Styled as _, Window,
    deferred, div, prelude::FluentBuilder as _, px, rgba,
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
    div()
        .size_full()
        .flex()
        .flex_col()
        .overflow_hidden()
        .child(header(view, room, id, cx))
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
                        .child(dock(view, room, cx)),
                )
                .when(view.panel_open, |el| el.child(panel(view, room, id, window, cx))),
        )
        .into_any_element()
}

// ---- header -------------------------------------------------------------------------------------

fn header(view: &RoomView, room: &Snapshot, id: RoomId, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
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
        .child(div().flex_1())
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
                            .child(format!("{n} / {}", n.max(4))),
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
    view: &RoomView,
    room: &Snapshot,
    window: &Window,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
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
    div()
        .relative()
        .flex_1()
        .min_h_0()
        .bg(tokens::bg())
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .px(px(32.))
        .py(px(28.))
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
                                    Button::new("play-link", "Play for everyone")
                                        .variant(Variant::Inverse)
                                        .min_height(px(52.))
                                        .padding_x(px(22.))
                                        .font_size(px(16.))
                                        .on_click(cx.listener(|v, _, _, cx| v.play_link(cx))),
                                ),
                        )
                        .child(
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
                                .child(inline_link("share", "share screen", cx)),
                        ),
                ),
        )
}

fn inline_link(id: &'static str, label: &'static str, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    div()
        .id(id)
        .text_color(tokens::text())
        .font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer()
        .on_click(cx.listener(|v, _, _, cx| {
            v.show_toast("Videos and screen sharing come in the next desktop update", cx);
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

fn dock(view: &RoomView, room: &Snapshot, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let me_host = room.host.as_ref() == Some(&room.me);
    let mic_off = room.muted || room.deafened;
    let speaking = room.speaking && !mic_off;
    let status = if room.deafened {
        "Sound off"
    } else if room.muted {
        "Mic off"
    } else if speaking {
        "Speaking"
    } else {
        "Mic on"
    };
    let mic_label = if room.deafened {
        "Mic blocked"
    } else if room.muted {
        "Mic off"
    } else {
        "Mic on"
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
        .children(room.members.iter().take(3).map(|(_, m)| {
            let name = m.username.clone().unwrap_or_else(|| "Peer".to_owned());
            div()
                .relative()
                .child(avatar(&name, 34., m.speaking && !m.muted, tokens::panel()))
                .when(m.muted, |el| el.child(muted_badge(tokens::panel(), px(14.))))
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
                .on_click(cx.listener(|v, _, _, cx| {
                    v.toggle_mic();
                    cx.notify();
                }))
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
        .when(view.pop == Some(Pop::More), |el| el.child(more_pop(cx)));
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
        .child(
            div()
                .flex_1()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(you)
                .when(!room.members.is_empty(), |el| el.child(peers)),
        )
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.))
                .child(mic)
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
                .child(later_btn("reactions", Icon::Smile, cx))
                .child(later_btn("sounds", Icon::Music, cx))
                .child(later_btn("add-video", Icon::VideoAdd, cx))
                .child(later_btn("screen", Icon::ScreenShare, cx))
                .child(later_btn("games", Icon::Games, cx))
                .child(more),
        )
        .child(
            div().flex_1().flex().justify_end().child(
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

fn more_pop(cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    deferred(
        div().absolute().bottom(px(56.)).right(px(-100.)).occlude().child(
            menu()
                .id("more-pop")
                .on_mouse_down_out(cx.listener(|v, _, _, cx| {
                    v.pop = None;
                    cx.notify();
                }))
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
                    true,
                    None,
                    None,
                ))
                .child(menu_item(
                    "m-qr",
                    Some(Icon::Qr),
                    "Invite with QR code",
                    false,
                    None,
                    Some(Box::new(cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Qr, cx)))),
                )),
        ),
    )
    .with_priority(1)
}

// ---- side panel ---------------------------------------------------------------------------------

/// A tab: which, its label, and a count (text, in the accent colour or not).
type TabSpec = (Tab, &'static str, Option<(String, bool)>);

fn panel(
    view: &RoomView,
    room: &Snapshot,
    id: RoomId,
    window: &mut Window,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
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
        Tab::Queue => queue_tab().into_any_element(),
        Tab::People => people_tab(room, cx).into_any_element(),
        Tab::Logs => logs_tab(view).into_any_element(),
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
        .child(bar)
        .child(div().flex_1().min_h_0().flex().flex_col().child(body))
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

fn chat_tab(
    view: &RoomView,
    room: &Snapshot,
    window: &mut Window,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let focused = view.message.read(cx).focus_handle(cx).is_focused(window);
    let mut rows = Vec::new();
    let mut prev: Option<(&PeerId, f64)> = None;
    for line in &view.chat {
        let starts = prev.is_none_or(|(p, at)| *p != line.from || (line.at - at).abs() > 5.0 * 60_000.0);
        prev = Some((&line.from, line.at));
        let mine = line.from == room.me;
        let name = if mine { "You".to_owned() } else { line.name.clone() };
        let color = avatar::color(&line.name);
        rows.push(
            div()
                .flex()
                .gap(px(10.))
                .items_start()
                .when(starts && !rows.is_empty(), |el| el.mt(px(10.)))
                .child(if starts {
                    avatar(&line.name, 30., false, tokens::surface()).into_any_element()
                } else {
                    div().w(px(30.)).flex_none().into_any_element()
                })
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .items_start()
                        .gap(px(2.))
                        .when(starts, |el| {
                            el.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
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
                                            .text_size(px(12.))
                                            .text_color(tokens::text_3())
                                            .child(clock(line.at)),
                                    ),
                            )
                        })
                        .child(
                            div()
                                .max_w_full()
                                .px(px(12.))
                                .py(px(7.))
                                .rounded(px(12.))
                                .bg(tokens::raised())
                                .text_size(px(14.))
                                .line_height(gpui_kit::relative(1.45))
                                .child(line.text.clone()),
                        ),
                ),
        );
    }
    let send_active = !view.message.read(cx).value().trim().is_empty();
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
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
                .id("chat-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .justify_end()
                .p(px(16.))
                .gap(px(4.))
                .children(rows)
                .into_any_element()
        })
        .child(
            div()
                .p(px(12.))
                .border_t_1()
                .border_color(tokens::raised())
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .pl(px(10.))
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
                            div().flex_1().min_w_0().text_size(px(15.)).child(
                                gpui_kit::component::input::Input::new(&view.message)
                                    .appearance(false)
                                    .large(),
                            ),
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

fn queue_tab() -> impl IntoElement {
    div()
        .flex_1()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .px(px(28.))
        .text_center()
        .child(div().text_size(px(32.)).child("🗒️"))
        .child(
            div()
                .text_size(px(16.))
                .font_weight(FontWeight::SEMIBOLD)
                .child("Queue is empty"),
        )
        .child(
            div()
                .text_size(px(13.))
                .line_height(gpui_kit::relative(1.5))
                .text_color(tokens::text_3())
                .child("Watching together, and its queue, come in the next desktop update."),
        )
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
        .when_some(make_host, |el, peer| {
            el.child(
                div().flex().justify_end().child(
                    Button::new(SharedString::from(format!("host-{peer}")), "👑 Make host")
                        .min_height(px(32.))
                        .padding_x(px(10.))
                        .font_size(px(13.))
                        .on_click(cx.listener(move |v, _, _, _| v.make_host(peer.clone()))),
                ),
            )
        })
        .into_any_element()
}

fn people_tab(room: &Snapshot, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
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
                    let status = if !m.connected {
                        ("Connecting…", false)
                    } else if m.muted {
                        ("Mic off", true)
                    } else if m.speaking {
                        ("Speaking", false)
                    } else {
                        ("Mic on", false)
                    };
                    let host = room.host.as_ref() == Some(peer);
                    let make = (me_host && m.connected).then(|| peer.clone());
                    person_card(
                        &name,
                        false,
                        host,
                        Some(m),
                        m.speaking && !m.muted,
                        status,
                        make,
                        cx,
                    )
                }),
        )
}

fn logs_tab(view: &RoomView) -> impl IntoElement {
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
                .child(format!("{} events recorded", view.logs.len())),
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
