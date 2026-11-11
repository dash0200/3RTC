//! Dialogs: Leave (`LeaveRoomDialog.tsx`), the QR code (`QrCodeModal.tsx`), Audio & Voice
//! Settings (`AudioSettingsModal.tsx`) and Server settings (`ServerSettingsModal.tsx`).

use gpui_kit::component::Sizable as _;
use gpui_kit::{
    AnyElement, Context, Focusable as _, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px, rgb,
};
use rtc_ui::button::{Button, Variant};
use rtc_ui::overlay::dialog;
use rtc_ui::{Icon, icon, tokens};

use crate::settings::{GCP, LOCAL, ORACLE};
use crate::view::{Dialog, RoomView};

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
            div()
                .id("voice-body")
                .px(px(24.))
                .pb(px(16.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .overflow_y_scroll()
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
                        .child(mode(
                            "open-mic",
                            "🎙️",
                            "Open Mic / Toggle",
                            "Microphone stays live until toggled off. Press M or click microphone button to mute/unmute.",
                            true,
                        ))
                        .child(mode(
                            "ptt",
                            "📻",
                            "Push-to-Talk (PTT)",
                            "Comes with global hotkeys in the next desktop update: hold a key to talk, even while a game has focus.",
                            false,
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
