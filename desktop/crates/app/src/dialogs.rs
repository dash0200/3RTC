//! Dialogs: Leave (`LeaveRoomDialog.tsx`), the QR code (`QrCodeModal.tsx`), Audio & Voice
//! Settings (`AudioSettingsModal.tsx`, with push-to-talk and the desktop's global hotkeys),
//! Server settings (`ServerSettingsModal.tsx`), and the desktop's own: Desktop settings and
//! "Join room …?" for a clicked link.

use gpui_kit::component::Sizable as _;
use gpui_kit::{
    AnyElement, Context, Focusable as _, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
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
            dialog("desktop-dialog", px(540.), desktop(view, close, cx), dismiss).into_any_element()
        }
        Dialog::Link(room) => {
            dialog("link-dialog", px(380.), link(view, room, cx), dismiss).into_any_element()
        }
        Dialog::Reactions => dialog(
            "reactions-dialog",
            px(460.),
            crate::fun::editor(view, cx),
            dismiss,
        )
        .into_any_element(),
        Dialog::Image => {
            dialog("image-dialog", px(900.), crate::chat::lightbox(view, cx), dismiss).into_any_element()
        }
        Dialog::Network => {
            dialog("net-dialog", px(800.), crate::net::dialog(view, cx), dismiss).into_any_element()
        }
        Dialog::Screen => dialog(
            "screen-dialog",
            px(520.),
            crate::screen::picker(view, cx),
            dismiss,
        )
        .into_any_element(),
        Dialog::AppSound => dialog(
            "app-sound-dialog",
            px(480.),
            crate::extras::app_sound_dialog(view, cx),
            dismiss,
        )
        .into_any_element(),
        Dialog::Player => dialog(
            "player-dialog",
            px(540.),
            player_shortcuts(view, close, cx),
            dismiss,
        )
        .into_any_element(),
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
        .child({
            let room_ref = view.room.as_ref();
            let is_host = room_ref.and_then(|r| r.host.as_ref()) == room_ref.map(|r| &r.me);
            let current_max = room_ref.map(|r| r.max_users).unwrap_or(32);
            div()
                .px(px(16.))
                .pb(px(14.))
                .flex()
                .items_center()
                .justify_between()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .text_size(px(12.5))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(tokens::text_2())
                                .child("Max Room Peers:"),
                        )
                        .when(is_host, |el| {
                            el.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .child(
                                        Button::new("qr-peer-dec", "-")
                                            .min_height(px(24.))
                                            .padding_x(px(6.))
                                            .on_click(cx.listener(move |v, _, _, cx| {
                                                let next = current_max.saturating_sub(1).max(2);
                                                v.command(rtc_core::Command::SetRoomSize(next));
                                                cx.notify();
                                            })),
                                    )
                                    .child(
                                        div()
                                            .w(px(32.))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .font_weight(FontWeight::BOLD)
                                            .text_color(tokens::accent())
                                            .text_size(px(13.))
                                            .child(current_max.to_string()),
                                    )
                                    .child(
                                        Button::new("qr-peer-inc", "+")
                                            .min_height(px(24.))
                                            .padding_x(px(6.))
                                            .on_click(cx.listener(move |v, _, _, cx| {
                                                let next = current_max + 1;
                                                v.command(rtc_core::Command::SetRoomSize(next));
                                                cx.notify();
                                            })),
                                    )
                                    .children([4u32, 8, 12, 16, 24, 32].into_iter().map(|preset| {
                                        let active = current_max == preset;
                                        Button::new(format!("qr-preset-{preset}"), preset.to_string())
                                            .min_height(px(22.))
                                            .padding_x(px(6.))
                                            .font_size(px(11.))
                                            .variant(if active { Variant::Primary } else { Variant::Ghost })
                                            .on_click(cx.listener(move |v, _, _, cx| {
                                                v.command(rtc_core::Command::SetRoomSize(preset));
                                                cx.notify();
                                            }))
                                    })),
                            )
                        })
                        .when(!is_host, |el| {
                            el.child(
                                div()
                                    .text_size(px(12.5))
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(tokens::accent())
                                    .child(format!("{current_max} (Host managed)")),
                            )
                        }),
                )
                .child(
                    Button::new("qr-open-net", "⚡ Network HUD")
                        .min_height(px(26.))
                        .padding_x(px(8.))
                        .font_size(px(11.5))
                        .variant(Variant::Secondary)
                        .on_click(cx.listener(|v, _, _, cx| v.open_net(cx))),
                )
        })
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
                        .child("Voices and app sounds use this. Echo cancellation and gain control are always on."),
                )
                .child(div().h(px(1.)).bg(tokens::line()))
                .child(section("MIC TEST", "Check Your Microphone"))
                .child(mic_test(view, cx))
                .child(toggle_row(
                    "v-isolation",
                    "✨ Voice Isolation",
                    if view.settings.low_power {
                        "Off while low-power mode is on (More → Desktop)."
                    } else {
                        "Removes background noise (keyboard, fans, traffic) so only your voice gets through."
                    },
                    view.settings.voice_isolation && !view.settings.low_power,
                    view.has_pipeline() && !view.settings.low_power,
                    RoomView::set_isolation,
                    cx,
                ))
                .child(toggle_row(
                    "v-classic",
                    "Classic audio",
                    if view.in_room().is_some() {
                        "Windows' standard voice path, without per-person volume, Voice Isolation or the mic test. Change it outside a room."
                    } else {
                        "Windows' standard voice path, without per-person volume, Voice Isolation or the mic test. Try it if voices break up."
                    },
                    view.settings.classic_audio,
                    view.in_room().is_none(),
                    RoomView::set_classic_audio,
                    cx,
                ))
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
        GCP.to_owned()
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
                v.settings.signal_url = if url == GCP { String::new() } else { url.to_owned() };
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
                .child(choice("srv-gcp", "Google Cloud (default)", GCP))
                .child(choice("srv-oracle", "Oracle Cloud", ORACLE))
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
        KeyTarget::PlayerPlayPause => "rec-pl-play",
        KeyTarget::PlayerFullscreen => "rec-pl-fs",
        KeyTarget::PlayerSeekBackward => "rec-pl-seek-back",
        KeyTarget::PlayerSeekForward => "rec-pl-seek-fwd",
        KeyTarget::PlayerVolumeUp => "rec-pl-vol-up",
        KeyTarget::PlayerVolumeDown => "rec-pl-vol-down",
        KeyTarget::PlayerSubtitles => "rec-pl-subs",
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
        KeyTarget::PlayerPlayPause => "clear-pl-play",
        KeyTarget::PlayerFullscreen => "clear-pl-fs",
        KeyTarget::PlayerSeekBackward => "clear-pl-seek-back",
        KeyTarget::PlayerSeekForward => "clear-pl-seek-fwd",
        KeyTarget::PlayerVolumeUp => "clear-pl-vol-up",
        KeyTarget::PlayerVolumeDown => "clear-pl-vol-down",
        KeyTarget::PlayerSubtitles => "clear-pl-subs",
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

/// The mic meter (after echo cancelling and noise removal: what others hear) and the test sound.
fn mic_test(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let works = view.has_pipeline();
    // peak to a −60…0 dB scale, as meters show it
    let level = if view.mic_meter > 0.001 {
        (1.0 + 20.0 * view.mic_meter.log10() / 60.0).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let color = if level > 0.9 {
        tokens::danger_text()
    } else if level > 0.7 {
        tokens::warn()
    } else {
        tokens::live_text()
    };
    div()
        .flex()
        .items_center()
        .gap(px(12.))
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(tokens::text_2())
                        .child(if works {
                            "Speak: the bar shows what others hear."
                        } else {
                            "The mic test needs 3RTC's own audio (turn off Classic audio)."
                        }),
                )
                .child(
                    div()
                        .id("mic-meter")
                        .h(px(10.))
                        .rounded_full()
                        .bg(tokens::raised())
                        .overflow_hidden()
                        .child(
                            div()
                                .h_full()
                                .rounded_full()
                                .bg(color)
                                .w(gpui_kit::relative(level)),
                        ),
                ),
        )
        .child(
            Button::new("test-sound", "🔊 Play test sound")
                .min_height(px(38.))
                .disabled(!works)
                .on_click(cx.listener(|v, _, _, _| v.play_test_sound())),
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
        .w_full()
        .flex()
        .flex_col()
        .child(head(
            "Desktop Settings",
            "Startup, the tray, notifications, GPU and in-game overlay".to_owned(),
            Icon::Settings,
            close,
        ))
        .child(
            div()
                .w_full()
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
                .child(toggle_row(
                    "d-low-power",
                    "Low-power mode",
                    "For laptops on battery: calmer animations, Voice Isolation off, and connections checked less often.",
                    view.settings.low_power,
                    true,
                    RoomView::set_low_power,
                    cx,
                ))
                .child(toggle_row(
                    "d-overlay",
                    "In-game overlay",
                    "Shows who's in the call and who's talking in a corner of the screen, over games in borderless or windowed mode. Clicks go through it.",
                    view.settings.overlay,
                    supported,
                    RoomView::set_overlay,
                    cx,
                ))
                .when(view.settings.overlay && supported, |el| el.child(crate::extras::corner_picker(view, cx)))
                .when(!supported, |el| el.child(hint("These work in the Windows app.")))
                .child(graphics(view, cx))
                .child(updates(view, cx)),
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

/// More → Desktop → Updates: this build, what the check found, and its buttons.
/// Settings → Graphics card: Auto, Power saving or High performance (from the next start).
fn graphics(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    use rtc_platform_win::GpuChoice;
    let g = &view.gpu;
    let name = |n: &Option<String>| n.clone().unwrap_or_else(|| "not found".to_owned());
    let same = g.gpus.power_saving.is_some() && g.gpus.power_saving == g.gpus.high_performance;
    let options = [
        (
            GpuChoice::Auto,
            "Auto (recommended)".to_owned(),
            "Windows decides.".to_owned(),
        ),
        (
            GpuChoice::PowerSaving,
            "Power saving".to_owned(),
            name(&g.gpus.power_saving),
        ),
        (
            GpuChoice::HighPerformance,
            "High performance".to_owned(),
            name(&g.gpus.high_performance),
        ),
    ];
    let restart = g.chosen != g.started;
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .pt(px(6.))
        .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child("Graphics card"))
        .child(div().text_size(px(12.)).text_color(tokens::text_3()).child(if same {
            "This computer has one graphics card, so every choice uses it."
        } else {
            "The card that draws 3RTC, plays videos and encodes your screen shares. Windows switches it when 3RTC starts."
        }))
        .children(options.into_iter().enumerate().map(|(n, (choice, title, sub))| {
            let on = g.chosen == choice;
            div()
                .id(("d-gpu", n))
                .flex()
                .items_center()
                .gap(px(12.))
                .p(px(12.))
                .rounded(px(12.))
                .bg(tokens::bg())
                .border_1()
                .border_color(if on { tokens::accent() } else { tokens::line() })
                .cursor_pointer()
                .hover(|s| s.border_color(tokens::line_strong()))
                .on_click(cx.listener(move |v, _, _, cx| v.set_gpu_choice(choice, cx)))
                .child(
                    div()
                        .size(px(16.))
                        .flex_none()
                        .rounded_full()
                        .border_1()
                        .border_color(tokens::line_strong())
                        .when(on, |el| el.border_4().border_color(tokens::accent())),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .child(div().text_size(px(14.)).child(title))
                        .child(div().text_size(px(12.)).text_color(tokens::text_3()).child(sub)),
                )
        }))
        .when(restart, |el| {
            el.child(
                div()
                    .w_full()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(10.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(12.5))
                            .text_color(tokens::focus())
                            .child("Restart 3RTC to switch the graphics card."),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .child(
                                Button::new("d-gpu-restart", "Restart now")
                                    .variant(Variant::Primary)
                                    .min_height(px(32.))
                                    .font_size(px(13.))
                                    .padding_x(px(14.))
                                    .on_click(cx.listener(|v, _, _, cx| v.restart_for_update(cx))),
                            ),
                    ),
            )
        })
}

fn updates(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    use crate::update::Status;
    let (text, color) = match &view.update {
        Status::Idle => (
            "Checks for new versions a little after starting.".to_owned(),
            tokens::text_2(),
        ),
        Status::Checking => ("Checking for a new version…".to_owned(), tokens::text_2()),
        Status::UpToDate => ("You have the latest version.".to_owned(), tokens::live_text()),
        Status::Downloading(b, p) => (format!("Downloading 3RTC {b}… {p}%"), tokens::focus()),
        Status::Ready(b) => (
            format!("3RTC {b} is ready: it starts the next time you open 3RTC."),
            tokens::live_text(),
        ),
        Status::Failed(e) => (format!("Couldn't update: {e}."), tokens::danger_text()),
        Status::Dev => (
            "A development build: updates are off.".to_owned(),
            tokens::text_3(),
        ),
    };
    let ready = matches!(view.update, Status::Ready(_));
    let busy = matches!(
        view.update,
        Status::Checking | Status::Downloading(..) | Status::Dev
    );
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(10.))
        .pt(px(6.))
        .child(
            div()
                .w_full()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child("Updates"))
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(tokens::text_3())
                                .child(format!("This version: {}", crate::view::BUILD)),
                        ),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .child(if ready {
                            Button::new("restart-update", "Restart now")
                                .variant(Variant::Primary)
                                .min_height(px(34.))
                                .font_size(px(13.))
                                .padding_x(px(14.))
                                .on_click(cx.listener(|v, _, _, cx| v.restart_for_update(cx)))
                                .into_any_element()
                        } else {
                            Button::new("check-update", "Check for updates")
                                .min_height(px(34.))
                                .font_size(px(13.))
                                .padding_x(px(14.))
                                .disabled(busy)
                                .on_click(cx.listener(|v, _, _, cx| v.check_updates(true, cx)))
                                .into_any_element()
                        }),
                ),
        )
        .child(
            div()
                .text_size(px(11.))
                .line_height(gpui_kit::relative(1.4))
                .text_color(tokens::text_3())
                .child("Video files play with mpv (libmpv, LGPL 2.1+, mpv.io; source: github.com/mpv-player/mpv)."),
        )
        .child(
            div()
                .text_size(px(12.5))
                .line_height(gpui_kit::relative(1.4))
                .text_color(color)
                .child(text),
        )
        .child(toggle_row(
            "d-auto-update",
            "Update automatically",
            "New versions download in the background and start the next time you open 3RTC. Your settings are kept.",
            view.settings.auto_update,
            !matches!(view.update, Status::Dev),
            RoomView::set_auto_update,
            cx,
        ))
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

// ---- player shortcuts & controls dialog ---------------------------------------------------------

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn player_shortcuts(
    view: &RoomView,
    close: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
    cx: &mut Context<'_, RoomView>,
) -> impl IntoElement {
    let current_step = view.settings.seek_step_secs.round() as u64;
    let step_chip = |secs: u64, label: &'static str| {
        let on = current_step == secs;
        div()
            .id(SharedString::from(format!("step-chip-{secs}")))
            .px(px(12.))
            .py(px(6.))
            .rounded_full()
            .border_1()
            .border_color(if on { tokens::focus() } else { tokens::line() })
            .bg(if on { sky(0.18) } else { tokens::bg() })
            .text_size(px(13.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(if on { tokens::focus() } else { tokens::text() })
            .cursor_pointer()
            .hover(|s| s.border_color(tokens::line_strong()))
            .on_click(cx.listener(move |v, _, _, cx| v.set_seek_step(secs as f64, cx)))
            .child(label)
    };
    div()
        .w_full()
        .flex()
        .flex_col()
        .child(head(
            "Player Shortcuts & Controls",
            "Customise playback controls, seek step and gestures".to_owned(),
            Icon::Settings,
            close,
        ))
        .child(
            div()
                .p(px(20.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(section(
                    "SEEK DURATION",
                    "Step for arrow keys and side mouse buttons",
                ))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(8.))
                        .child(step_chip(5, "5s (default)"))
                        .child(step_chip(10, "10s"))
                        .child(step_chip(15, "15s"))
                        .child(step_chip(30, "30s"))
                        .child(step_chip(60, "60s")),
                )
                .child(div().h(px(1.)).bg(tokens::line()))
                .child(section("GESTURES & CONTROLS", "Mouse and keyboard shortcuts"))
                .child(toggle_row(
                    "ps-click-play",
                    "Single click to Play / Pause",
                    "Clicking anywhere on the video toggles playback",
                    view.settings.player_click_play,
                    true,
                    RoomView::set_player_click_play,
                    cx,
                ))
                .child(toggle_row(
                    "ps-dblclick-fs",
                    "Double click for Full Screen",
                    "Double-clicking on the video enters or exits full screen mode",
                    view.settings.player_double_click_fullscreen,
                    true,
                    RoomView::set_player_double_click_fullscreen,
                    cx,
                ))
                .child(toggle_row(
                    "ps-scroll-vol",
                    "Mouse wheel adjusts Volume",
                    "Scrolling up or down over the video raises or lowers audio volume",
                    view.settings.player_scroll_volume,
                    true,
                    RoomView::set_player_scroll_volume,
                    cx,
                ))
                .child(toggle_row(
                    "ps-nav-seek",
                    "Mouse side buttons Seek",
                    "Mouse 4th & 5th (back/forward) buttons skip backward or forward",
                    view.settings.player_mouse_nav_seek,
                    true,
                    RoomView::set_player_mouse_nav_seek,
                    cx,
                ))
                .child(toggle_row(
                    "ps-arrow-keys",
                    "Arrow keys Seek & Volume",
                    "Left / Right arrows seek by the step; Up / Down arrows adjust volume",
                    view.settings.player_arrow_keys,
                    true,
                    RoomView::set_player_arrow_keys,
                    cx,
                ))
                .child(div().h(px(1.)).bg(tokens::line()))
                .child(section(
                    "KEYBOARD SHORTCUTS",
                    "Click Record to choose your custom key (or combination)",
                ))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .p(px(14.))
                        .rounded(px(10.))
                        .bg(tokens::bg())
                        .border_1()
                        .border_color(tokens::line())
                        .child(hotkey_row(
                            view,
                            KeyTarget::PlayerPlayPause,
                            "Play / Pause",
                            &view.settings.key_player_play_pause,
                            cx,
                        ))
                        .child(hotkey_row(
                            view,
                            KeyTarget::PlayerFullscreen,
                            "Full Screen",
                            &view.settings.key_player_fullscreen,
                            cx,
                        ))
                        .child(hotkey_row(
                            view,
                            KeyTarget::PlayerSeekBackward,
                            "Seek Backward",
                            &view.settings.key_player_seek_backward,
                            cx,
                        ))
                        .child(hotkey_row(
                            view,
                            KeyTarget::PlayerSeekForward,
                            "Seek Forward",
                            &view.settings.key_player_seek_forward,
                            cx,
                        ))
                        .child(hotkey_row(
                            view,
                            KeyTarget::PlayerVolumeUp,
                            "Volume Up",
                            &view.settings.key_player_volume_up,
                            cx,
                        ))
                        .child(hotkey_row(
                            view,
                            KeyTarget::PlayerVolumeDown,
                            "Volume Down",
                            &view.settings.key_player_volume_down,
                            cx,
                        ))
                        .child(hotkey_row(
                            view,
                            KeyTarget::PlayerSubtitles,
                            "Cycle Subtitles",
                            &view.settings.key_player_subtitles,
                            cx,
                        )),
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
                    Button::new("player-done", "Done")
                        .variant(Variant::Primary)
                        .min_height(px(38.))
                        .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
                ),
        )
}
