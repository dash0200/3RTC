//! Dialogs: Leave (`LeaveRoomDialog.tsx`), the QR code (`QrCodeModal.tsx`), Audio & Voice
//! Settings (`AudioSettingsModal.tsx`, with push-to-talk and the desktop's global hotkeys),
//! Server settings (`ServerSettingsModal.tsx`), and the desktop's own: Desktop settings and
//! "Join room …?" for a clicked link.

use gpui_kit::component::Sizable as _;
use gpui_kit::{
    AnyElement, Context, Focusable as _, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px, rgb,
};
use rtc_platform_win::keys::{Binding, Key};
use rtc_protocol::RoomId;
use rtc_ui::button::{Button, Variant};
use rtc_ui::overlay::{dialog, switch};
use rtc_ui::{Icon, icon, tokens};

use crate::settings::{GCP, LOCAL, ORACLE, VoiceMode};
use crate::view::{Dialog, KeyTarget, RoomView};

pub(crate) fn render(
    view: &mut RoomView,
    which: Dialog,
    window: &mut Window,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let close = cx.listener(|v, _: &gpui_kit::ClickEvent, _, cx| v.close_dialog(cx));
    let dismiss = {
        let this = cx.entity().downgrade();
        move |_: &mut Window, cx: &mut gpui_kit::App| {
            let _ = this.update(cx, RoomView::close_dialog);
        }
    };
    match which {
        Dialog::Leave => dialog("leave-dialog", px(360.), leave(view, cx), dismiss).into_any_element(),
        Dialog::Qr => dialog("qr-dialog", px(440.), qr(view, close, cx), dismiss).into_any_element(),
        Dialog::Voice => dialog("voice-dialog", px(580.), voice(view, close, cx), dismiss).into_any_element(),
        Dialog::Server => dialog(
            "server-dialog",
            px(460.),
            server(view, window, close, cx),
            dismiss,
        )
        .into_any_element(),
        Dialog::Desktop => {
            dialog("desktop-dialog", px(520.), desktop(view, close, cx), dismiss).into_any_element()
        }
        Dialog::Link(room) => {
            dialog("link-dialog", px(380.), link(view, room, cx), dismiss).into_any_element()
        }
    }
}

fn head(
    title: &'static str,
    sub: String,
    which: Icon,
    close: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
) -> impl IntoElement {
    div()
        .flex()
        .items_start()
        .gap(px(12.))
        .p(px(20.))
        .child(
            div()
                .size(px(40.))
                .flex_none()
                .rounded(px(10.))
                .bg(gpui_kit::Hsla {
                    a: 0.15,
                    ..tokens::focus()
                })
                .border_1()
                .border_color(gpui_kit::Hsla {
                    a: 0.35,
                    ..tokens::focus()
                })
                .flex()
                .items_center()
                .justify_center()
                .child(icon(which, px(20.), tokens::focus())),
        )
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .text_size(px(18.))
                        .font_weight(FontWeight::BOLD)
                        .child(title),
                )
                .child(div().text_size(px(13.)).text_color(tokens::text_2()).child(sub)),
        )
        .child(
            div()
                .id("close")
                .size(px(30.))
                .rounded(px(8.))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover(|s| s.bg(tokens::raised()))
                .on_click(close)
                .child(icon(Icon::Close, px(16.), tokens::text_2())),
        )
}

fn leave(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let room = view.in_room().map(|r| r.to_string()).unwrap_or_default();
    div()
        .p(px(20.))
        .flex()
        .flex_col()
        .gap(px(10.))
        .items_center()
        .child(
            div()
                .text_size(px(20.))
                .font_weight(FontWeight::BOLD)
                .child(format!("Leave room {room}?")),
        )
        .child(
            div()
                .text_size(px(14.))
                .text_color(tokens::text_2())
                .child("You can rejoin with the same code."),
        )
        .child(div().h(px(6.)))
        .child(
            Button::new("stay", "Stay")
                .variant(Variant::Inverse)
                .full_width()
                .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
        )
        .child(
            Button::new("leave-room", "Leave room")
                .variant(Variant::Destructive)
                .full_width()
                .on_click(cx.listener(|v, _, _, cx| v.leave(cx))),
        )
}

/// The QR code as squares, `module` pixels each.
fn qr_grid(text: &str, module: Pixels) -> impl IntoElement {
    let Ok(code) = qrcode::QrCode::new(text.as_bytes()) else {
        return div().into_any_element();
    };
    let width = code.width();
    let colors = code.to_colors();
    div()
        .p(module * 4.)
        .bg(rgb(0x00ff_ffff))
        .rounded(px(12.))
        .flex()
        .flex_col()
        .children(colors.chunks(width).map(|row| {
            div().flex().children(row.iter().map(|c| {
                div().size(module).bg(if *c == qrcode::Color::Dark {
                    rgb(0x0000_0000)
                } else {
                    rgb(0x00ff_ffff)
                })
            }))
        }))
        .into_any_element()
}

fn qr(
    view: &RoomView,
    close: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let Some(room) = view.in_room() else {
        return div().into_any_element();
    };
    let link = RoomView::invite_link(room);
    let copied = view.copied == Some("qr-link");
    let copy_link = link.clone();
    div()
        .flex()
        .flex_col()
        .child(head(
            "Instant Mobile Join",
            format!("Scan with smartphone camera to connect to Room {room}"),
            Icon::Qr,
            close,
        ))
        .child(
            div()
                .bg(rgb(0x00ff_ffff))
                .py(px(20.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(14.))
                .child(qr_grid(&link, px(5.)))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .px(px(14.))
                        .py(px(6.))
                        .rounded_full()
                        .bg(rgb(0x00ef_f6ff))
                        .border_1()
                        .border_color(rgb(0x00cf_e3ff))
                        .text_color(rgb(0x0064_748b))
                        .text_size(px(11.))
                        .font_weight(FontWeight::BOLD)
                        .child("ROOM PIN:")
                        .child(
                            div()
                                .font_family(tokens::FONT_MONO)
                                .text_size(px(20.))
                                .text_color(rgb(0x0003_69a1))
                                .child(room.to_string()),
                        )
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .child("· No app installation required"),
                        ),
                ),
        )
        .child(
            div()
                .p(px(16.))
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .px(px(10.))
                        .py(px(8.))
                        .rounded(px(8.))
                        .bg(tokens::bg())
                        .border_1()
                        .border_color(tokens::line())
                        .overflow_hidden()
                        .font_family(tokens::FONT_MONO)
                        .text_size(px(12.))
                        .child(link),
                )
                .child(
                    Button::new("qr-copy", if copied { "Copied" } else { "Copy Link" })
                        .min_height(px(34.))
                        .padding_x(px(12.))
                        .font_size(px(13.))
                        .on_click(cx.listener(move |v, _, _, cx| v.copy(copy_link.clone(), "qr-link", cx))),
                ),
        )
        .child(
            div()
                .p(px(16.))
                .border_t_1()
                .border_color(tokens::raised())
                .flex()
                .justify_end()
                .child(
                    Button::new("qr-done", "Done")
                        .variant(Variant::Primary)
                        .min_height(px(38.))
                        .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
                ),
        )
        .into_any_element()
}

fn section(tag: &'static str, title: &'static str) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(
            div()
                .px(px(6.))
                .py(px(1.))
                .rounded(px(5.))
                .border_1()
                .border_color(gpui_kit::Hsla {
                    a: 0.45,
                    ..tokens::focus()
                })
                .text_color(tokens::focus())
                .text_size(px(11.))
                .font_weight(FontWeight::BOLD)
                .child(tag),
        )
        .child(
            div()
                .text_size(px(16.))
                .font_weight(FontWeight::BOLD)
                .child(title),
        )
}

fn voice(
    view: &RoomView,
    close: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let label = |t: &'static str| {
        div()
            .text_size(px(14.))
            .font_weight(FontWeight::SEMIBOLD)
            .child(t)
    };
    let mode = |id: &'static str, emoji: &'static str, title: &'static str, text: &'static str, on: bool| {
        div()
            .id(id)
            .cursor_pointer()
            .flex_1()
            .min_w_0()
            .p(px(14.))
            .rounded(px(12.))
            .border_1()
            .border_color(if on { tokens::focus() } else { tokens::line() })
            .bg(if on {
                gpui_kit::Hsla {
                    a: 0.08,
                    ..tokens::focus()
                }
            } else {
                tokens::bg()
            })
            .opacity(if on { 1.0 } else { 0.55 })
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .text_size(px(15.))
                    .font_weight(FontWeight::BOLD)
                    .child(format!("{emoji} {title}")),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(gpui_kit::relative(1.45))
                    .text_color(tokens::text_2())
                    .child(text),
            )
    };
    let ptt = view.settings.voice_mode == VoiceMode::Ptt;
    div()
        .flex()
        .flex_col()
        .max_h(px(760.))
        .child(head(
            "Audio & Voice Settings",
            "Configure voice transmission modes, push-to-talk hotkeys, and mic levels".to_owned(),
            Icon::Mic,
            close,
        ))
        .child(
            // scrolls when it doesn't fit; the column inside keeps every part at its full height
            div().id("voice-body").flex_1().min_h_0().overflow_y_scroll().child(
            div()
                .px(px(24.))
                .pb(px(16.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(section("DEVICES", "Microphone & Speaker"))
                .child(label("🎙️ Input device"))
                .child(crate::room::device_list(view, true, cx))
                .child(label("🔊 Output device"))
                .child(crate::room::device_list(view, false, cx))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(tokens::text_2())
                        .child("Voices and app sounds use this. Echo cancellation, noise suppression and gain control are always on (the same as Chrome)."),
                )
                .child(div().h(px(1.)).bg(tokens::line()))
                .child(section("INPUT MODE", "Voice Transmission Mode"))
                .child(
                    div()
                        .flex()
                        .gap(px(10.))
                        .child(
                            mode(
                                "open-mic",
                                "🎙️",
                                "Open Mic / Toggle",
                                "Microphone stays live until toggled off. Press M or click microphone button to mute/unmute.",
                                !ptt,
                            )
                            .on_click(cx.listener(|v, _, _, cx| v.set_voice_mode(VoiceMode::Open, cx))),
                        )
                        .child(
                            mode(
                                "ptt",
                                "📻",
                                "Push-to-Talk (PTT)",
                                "Microphone is muted by default. Audio is only transmitted while holding down your designated key, even while another app is in front.",
                                ptt,
                            )
                            .on_click(cx.listener(|v, _, _, cx| v.set_voice_mode(VoiceMode::Ptt, cx))),
                        ),
                )
                .when(ptt, |el| el.child(ptt_panel(view, cx)))
                .child(div().h(px(1.)).bg(tokens::line()))
                .child(section("HOTKEYS", "Global Hotkeys"))
                .child(hint(
                    "Work while other apps are in front, games included. Nothing is blocked: the key still does what it does in that app.",
                ))
                .child(hotkey_row(view, KeyTarget::Mute, "Mute / unmute", &view.settings.mute_keys, cx))
                .child(hotkey_row(view, KeyTarget::Deafen, "Deafen / undeafen", &view.settings.deafen_keys, cx)),
            ),
        )
        .child(
            div()
                .p(px(16.))
                .px(px(24.))
                .border_t_1()
                .border_color(tokens::raised())
                .flex()
                .justify_end()
                .child(
                    Button::new("voice-done", "Done")
                        .variant(Variant::Primary)
                        .min_height(px(38.))
                        .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
                ),
        )
}

fn server(
    view: &RoomView,
    window: &Window,
    close: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let current = if view.settings.signal_url.is_empty() {
        ORACLE.to_owned()
    } else {
        view.settings.signal_url.clone()
    };
    let choice = |id: &'static str, title: &'static str, url: &'static str| {
        let on = current == url;
        div()
            .id(id)
            .p(px(12.))
            .rounded(px(10.))
            .border_1()
            .border_color(if on { tokens::focus() } else { tokens::line() })
            .bg(tokens::bg())
            .cursor_pointer()
            .hover(|s| s.border_color(tokens::line_strong()))
            .on_click(cx.listener(move |v, _, _, cx| {
                v.settings.signal_url = if url == ORACLE {
                    String::new()
                } else {
                    url.to_owned()
                };
                v.settings.save();
                v.close_dialog(cx);
                v.restart_engine(cx);
            }))
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title),
            )
            .child(
                div()
                    .font_family(tokens::FONT_MONO)
                    .text_size(px(12.))
                    .text_color(tokens::text_3())
                    .child(url),
            )
    };
    let custom_focused = view.server_url.read(cx).focus_handle(cx).is_focused(window);
    div()
        .flex()
        .flex_col()
        .child(head(
            "Server settings",
            "Which signaling server introduces you to your friends".to_owned(),
            Icon::Settings,
            close,
        ))
        .child(
            div()
                .px(px(20.))
                .pb(px(20.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(choice("srv-oracle", "Oracle Cloud (default)", ORACLE))
                .child(choice("srv-gcp", "Google Cloud", GCP))
                .child(choice("srv-local", "This PC (development)", LOCAL))
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .h(px(40.))
                                .px(px(8.))
                                .flex()
                                .items_center()
                                .rounded(px(10.))
                                .border_1()
                                .border_color(if custom_focused {
                                    tokens::focus()
                                } else {
                                    tokens::line_strong()
                                })
                                .bg(tokens::bg())
                                .text_size(px(14.))
                                .child(
                                    gpui_kit::component::input::Input::new(&view.server_url)
                                        .appearance(false)
                                        .large(),
                                ),
                        )
                        .child(
                            Button::new("srv-use", "Use")
                                .min_height(px(40.))
                                .on_click(cx.listener(|v, _, _, cx| {
                                    let url = v.server_url.read(cx).value().trim().to_owned();
                                    if url.starts_with("ws://") || url.starts_with("wss://") {
                                        v.settings.signal_url = url;
                                        v.settings.save();
                                        v.close_dialog(cx);
                                        v.restart_engine(cx);
                                    } else {
                                        v.show_toast("Server addresses start with wss:// or ws://", cx);
                                    }
                                })),
                        ),
                )
                .when(std::env::var("RTC_SIGNAL_URL").is_ok(), |el| {
                    el.child(
                        div()
                            .text_size(px(12.))
                            .text_color(tokens::warn())
                            .child("RTC_SIGNAL_URL is set: it overrides this choice."),
                    )
                }),
        )
}

// ---- push-to-talk and hotkeys -------------------------------------------------------------------

fn sky(a: f32) -> gpui_kit::Hsla {
    gpui_kit::Hsla { a, ..tokens::focus() }
}

fn hint(text: &'static str) -> impl IntoElement {
    div()
        .text_size(px(12.))
        .line_height(gpui_kit::relative(1.45))
        .text_color(tokens::text_2())
        .child(text)
}

fn block_title(title: &'static str, sub: &'static str) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .min_w_0()
        .child(
            div()
                .text_size(px(13.5))
                .font_weight(FontWeight::BOLD)
                .child(title),
        )
        .child(div().text_size(px(11.5)).text_color(tokens::text_2()).child(sub))
}

/// `.ptt-kbd`: a key cap.
fn kbd(label: String) -> impl IntoElement {
    div()
        .px(px(8.))
        .py(px(3.))
        .rounded(px(6.))
        .bg(rgb(0x0f_172a))
        .border_1()
        .border_color(sky(0.4))
        .text_color(tokens::focus())
        .text_size(px(13.))
        .font_weight(FontWeight::EXTRA_BOLD)
        .child(label)
}

/// `.ptt-record-key-btn`: shows the key; click to record a new one.
fn record_button(
    view: &RoomView,
    target: KeyTarget,
    binding: &Binding,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let recording = view.recording == Some(target);
    let id = match target {
        KeyTarget::Ptt => "rec-ptt",
        KeyTarget::Mute => "rec-mute",
        KeyTarget::Deafen => "rec-deafen",
    };
    div()
        .id(id)
        .min_w(px(110.))
        .px(px(14.))
        .py(px(6.))
        .rounded(px(10.))
        .bg(tokens::black(0.4))
        .border_1()
        .border_color(if recording {
            rgb(0xf4_3f5e).into()
        } else {
            sky(0.35)
        })
        .flex()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .cursor_pointer()
        .hover(|s| s.bg(sky(0.1)).border_color(tokens::focus()))
        .on_click(cx.listener(move |v, _, _, cx| v.record_key(target, cx)))
        .map(|el| {
            if recording {
                el.child(
                    div()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::BOLD)
                        .text_color(rgb(0xf4_3f5e))
                        .child("● Press any key or mouse button…"),
                )
            } else if binding.is_empty() {
                el.child(
                    div()
                        .text_size(px(12.5))
                        .text_color(tokens::text_2())
                        .child("Not set · Set key"),
                )
            } else {
                el.child(kbd(binding.to_string())).child(
                    div()
                        .text_size(px(11.))
                        .text_color(tokens::text_3())
                        .child("Change"),
                )
            }
        })
}

/// `.ptt-preset-chip` / `.chip-preset-small`.
fn chip(
    id: impl Into<gpui_kit::ElementId>,
    label: String,
    on: bool,
    f: impl Fn(&mut RoomView, &mut Context<'_, RoomView>) + 'static,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    div()
        .id(id.into())
        .px(px(8.))
        .py(px(3.))
        .rounded(px(6.))
        .bg(if on {
            sky(0.15)
        } else {
            tokens::white().opacity(0.05)
        })
        .border_1()
        .border_color(if on {
            sky(0.45)
        } else {
            tokens::white().opacity(0.1)
        })
        .text_color(if on { tokens::focus() } else { tokens::text_2() })
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer()
        .hover(|s| s.bg(tokens::white().opacity(0.1)).text_color(tokens::text()))
        .on_click(cx.listener(move |v, _, _, cx| f(v, cx)))
        .child(label)
}

/// The push-to-talk keys offered with one click (the web app's, without Space: a global Space
/// would open the mic whenever you type anywhere).
const PTT_PRESETS: [Key; 7] = [
    Key::BACKQUOTE,
    Key::MOUSE_4,
    Key::MOUSE_5,
    Key::CAPS_LOCK,
    Key::CTRL,
    Key::ALT,
    Key(0x56), // V
];

/// The release delays offered (`AudioSettingsModal.tsx`).
const RELEASE_PRESETS: [(u32, &str); 5] = [
    (0, "0ms (Instant)"),
    (150, "150ms"),
    (200, "200ms (Default)"),
    (350, "350ms"),
    (500, "500ms"),
];

fn ptt_panel(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let keys = view.settings.ptt_keys.clone();
    let release = view.settings.ptt_release_ms;
    let chime = view.settings.ptt_chime;
    let presets: Vec<_> = PTT_PRESETS
        .iter()
        .enumerate()
        .map(|(i, k)| {
            let b = Binding::key(*k);
            let on = keys == b;
            chip(
                ("ptt-preset", i),
                k.label(),
                on,
                move |v, cx| v.set_binding(KeyTarget::Ptt, b.clone(), cx),
                cx,
            )
            .into_any_element()
        })
        .collect();
    let delays: Vec<_> = RELEASE_PRESETS
        .iter()
        .map(|(ms, label)| {
            let ms = *ms;
            chip(
                ("ptt-delay", ms as usize),
                (*label).to_owned(),
                release == ms,
                move |v, cx| v.set_ptt_release(ms, cx),
                cx,
            )
            .into_any_element()
        })
        .collect();
    div()
        .flex()
        .flex_col()
        .gap(px(16.))
        .p(px(16.))
        .rounded(px(16.))
        .bg(tokens::white().opacity(0.025))
        .border_1()
        .border_color(sky(0.2))
        // the hotkey
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .child(block_title(
                            "Push-to-Talk Hotkey",
                            "Hold this key to broadcast voice (a mouse side button works too)",
                        ))
                        .child(record_button(view, KeyTarget::Ptt, &keys, cx)),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.))
                        .mt(px(4.))
                        .child(
                            div()
                                .text_size(px(11.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(tokens::text_3())
                                .mr(px(2.))
                                .child("Popular Presets:"),
                        )
                        .children(presets),
                )
                .when_some(view.admin_app.clone(), |el, app| {
                    el.child(
                        div()
                            .text_size(px(12.))
                            .text_color(tokens::danger_text())
                            .child(format!(
                                "⚠️ {app} runs as administrator: Windows keeps its keys from other apps, so push-to-talk can't see them while it's in front."
                            )),
                    )
                })
                .when(!RoomView::desktop_supported(), |el| {
                    el.child(hint("Global keys work in the Windows app."))
                }),
        )
        // the release delay
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(block_title(
                            "Release Delay (Grace Period)",
                            "Prevents cutting off your last words when releasing key",
                        ))
                        .child(
                            div()
                                .px(px(8.))
                                .py(px(2.))
                                .rounded(px(6.))
                                .bg(sky(0.15))
                                .border_1()
                                .border_color(sky(0.3))
                                .text_color(tokens::focus())
                                .text_size(px(12.))
                                .font_weight(FontWeight::EXTRA_BOLD)
                                .child(format!("{release} ms")),
                        ),
                )
                .child(div().flex().flex_wrap().gap(px(6.)).children(delays)),
        )
        // the chirps
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .px(px(14.))
                .py(px(10.))
                .rounded(px(12.))
                .bg(tokens::white().opacity(0.03))
                .border_1()
                .border_color(tokens::white().opacity(0.07))
                .child(block_title(
                    "PTT Radio Chirp Sounds",
                    "Play subtle audio chime when activating and releasing transmission",
                ))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .id("chime-preview")
                                .px(px(9.))
                                .py(px(4.))
                                .rounded(px(8.))
                                .bg(tokens::white().opacity(0.06))
                                .border_1()
                                .border_color(tokens::white().opacity(0.12))
                                .text_size(px(12.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(tokens::text_2())
                                .cursor_pointer()
                                .hover(|s| s.bg(tokens::white().opacity(0.12)).text_color(tokens::text()))
                                .on_click(|_, _, _| crate::desktop::chirp(true))
                                .child("🔊 Preview Sound"),
                        )
                        .child(
                            div()
                                .id("chime-switch")
                                .cursor_pointer()
                                .on_click(cx.listener(move |v, _, _, cx| v.set_ptt_chime(!chime, cx)))
                                .child(switch(chime)),
                        ),
                ),
        )
}

fn hotkey_row(
    view: &RoomView,
    target: KeyTarget,
    label: &'static str,
    binding: &Binding,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let set = !binding.is_empty();
    let clear_id = match target {
        KeyTarget::Ptt => "clear-ptt",
        KeyTarget::Mute => "clear-mute",
        KeyTarget::Deafen => "clear-deafen",
    };
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .child(
            div()
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(label),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(record_button(view, target, binding, cx))
                .when(set, |el| {
                    el.child(
                        div()
                            .id(clear_id)
                            .size(px(28.))
                            .rounded(px(8.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .cursor_pointer()
                            .hover(|s| s.bg(tokens::raised()))
                            .on_click(
                                cx.listener(move |v, _, _, cx| v.set_binding(target, Binding::default(), cx)),
                            )
                            .child(icon(Icon::Close, px(14.), tokens::text_2())),
                    )
                }),
        )
}

// ---- desktop settings -------------------------------------------------------------------------

fn toggle_row(
    id: &'static str,
    title: &'static str,
    text: &'static str,
    on: bool,
    enabled: bool,
    f: impl Fn(&mut RoomView, bool, &mut Context<'_, RoomView>) + 'static,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(14.))
        .p(px(14.))
        .rounded(px(12.))
        .bg(tokens::bg())
        .border_1()
        .border_color(tokens::line())
        .when(!enabled, |el| el.opacity(0.5))
        .when(enabled, |el| {
            el.cursor_pointer()
                .hover(|s| s.border_color(tokens::line_strong()))
                .on_click(cx.listener(move |v, _, _, cx| f(v, !on, cx)))
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(3.))
                .child(
                    div()
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .line_height(gpui_kit::relative(1.45))
                        .text_color(tokens::text_2())
                        .child(text),
                ),
        )
        .child(switch(on))
}

fn desktop(
    view: &RoomView,
    close: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let supported = RoomView::desktop_supported();
    let tray = view.has_tray();
    div()
        .flex()
        .flex_col()
        .child(head(
            "Desktop",
            "Startup, the tray, notifications and links".to_owned(),
            Icon::Settings,
            close,
        ))
        .child(
            div()
                .px(px(24.))
                .pb(px(16.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(toggle_row(
                    "d-autostart",
                    "Start with Windows",
                    "Opens quietly in the tray when you sign in, so the rejoin card is one click away.",
                    view.autostart,
                    supported,
                    RoomView::set_autostart,
                    cx,
                ))
                .child(toggle_row(
                    "d-tray",
                    "Keep running in the tray",
                    "Closing the window keeps your call going. Quit from the tray icon by the clock.",
                    view.settings.close_to_tray && tray,
                    tray,
                    RoomView::set_close_to_tray,
                    cx,
                ))
                .child(toggle_row(
                    "d-notify",
                    "Notifications",
                    "When someone joins or @mentions you while 3RTC isn't in front. Windows holds them back during Do not disturb.",
                    view.settings.notifications,
                    supported,
                    RoomView::set_notifications,
                    cx,
                ))
                .child(toggle_row(
                    "d-links",
                    "Open 3rtc:// links",
                    "Room links open here. You're always asked before joining.",
                    view.settings.open_links,
                    supported,
                    RoomView::set_open_links,
                    cx,
                ))
                .when(!supported, |el| el.child(hint("These work in the Windows app."))),
        )
        .child(
            div()
                .p(px(16.))
                .px(px(24.))
                .border_t_1()
                .border_color(tokens::raised())
                .flex()
                .justify_end()
                .child(
                    Button::new("desktop-done", "Done")
                        .variant(Variant::Primary)
                        .min_height(px(38.))
                        .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
                ),
        )
}

// ---- a clicked link ----------------------------------------------------------------------------

fn link(view: &RoomView, room: RoomId, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let current = view.in_room().filter(|r| *r != room);
    div()
        .p(px(20.))
        .flex()
        .flex_col()
        .gap(px(10.))
        .items_center()
        .child(
            div()
                .text_size(px(20.))
                .font_weight(FontWeight::BOLD)
                .child(format!("Join room {room}?")),
        )
        .child(
            div()
                .text_size(px(14.))
                .text_color(tokens::text_2())
                .text_center()
                .child(match current {
                    Some(c) => format!("A link asked to open this room. You'll leave room {c} first."),
                    None => "A link asked to open this room.".to_owned(),
                }),
        )
        .child(div().h(px(6.)))
        .child(
            Button::new("link-join", "Join room")
                .variant(Variant::Primary)
                .full_width()
                .on_click(cx.listener(move |v, _, _, cx| v.join_from_link(room, cx))),
        )
        .child(
            Button::new("link-not-now", "Not now")
                .variant(Variant::Inverse)
                .full_width()
                .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
        )
}
