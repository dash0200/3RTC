//! The home screen, before a room exists: `components/DesktopHome.tsx` and the `.dh-*` rules in
//! `redesign.css`. Sizes written as `clamp(min, % of window, max)` there use the same numbers here.

use gpui_kit::component::input::InputState;
use gpui_kit::{
    AnyElement, App, Context, Entity, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
    rgb,
};
use rtc_ui::button::{Button, Variant};
use rtc_ui::code_input::CodeInput;
use rtc_ui::tokens::{self, clamp_vh, clamp_vw};
use rtc_ui::{Icon, icon, icon_bold, logo::logo, text_field::text_field};

use crate::view::RoomView;

/// The site the header and footer links open in the browser.
const SITE: &str = "https://3rtc.me";

/// What the home screen shows.
pub(crate) struct Home<'a> {
    pub(crate) name: &'a Entity<InputState>,
    pub(crate) code: &'a Entity<CodeInput>,
    /// The signaling server is reachable.
    pub(crate) online: bool,
    /// A create or join is on its way.
    pub(crate) busy: bool,
    /// Why the last join didn't work.
    pub(crate) join_error: Option<SharedString>,
    pub(crate) build: &'static str,
    /// The room you were last in, and whether you hosted it (the rejoin card).
    pub(crate) rejoin: Option<(String, bool)>,
}

/// `RejoinCard.tsx`: "You were in room 12345 · Rejoin".
fn rejoin_card(room: &str, was_host: bool, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let sky = |a: f32| gpui_kit::Hsla {
        a,
        ..rgb(0x7c_c4ff).into()
    };
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .pl(px(16.))
        .pr(px(12.))
        .py(px(10.))
        .rounded(px(14.))
        .bg(sky(0.1))
        .border_1()
        .border_color(sky(0.3))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .text_size(px(14.))
                .line_height(gpui_kit::relative(1.35))
                .child(
                    div()
                        .flex()
                        .gap(px(4.))
                        .child("You were in room")
                        .child(div().font_weight(FontWeight::BOLD).child(room.to_owned())),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(tokens::text_2())
                        .child(if was_host {
                            "Your room: get it back with the same code"
                        } else {
                            "Jump back in"
                        }),
                ),
        )
        .child(
            div()
                .id("rejoin")
                .px(px(14.))
                .py(px(9.))
                .rounded(px(10.))
                .bg(rgb(0x7c_c4ff))
                .text_color(rgb(0x0b_1b2b))
                .text_size(px(14.))
                .font_weight(FontWeight::BOLD)
                .cursor_pointer()
                .on_click(cx.listener(|v, _, _, cx| v.rejoin(cx)))
                .child("Rejoin"),
        )
        .child(
            div()
                .id("rejoin-dismiss")
                .px(px(6.))
                .py(px(4.))
                .text_size(px(18.))
                .text_color(tokens::text_3())
                .cursor_pointer()
                .on_click(cx.listener(|v, _, _, cx| v.dismiss_rejoin(cx)))
                .child("×"),
        )
}

fn link(id: &'static str, label: &'static str, path: &'static str) -> impl IntoElement {
    div()
        .id(id)
        .text_color(tokens::text_2())
        .cursor_pointer()
        .hover(|s| s.text_color(tokens::text()))
        .on_click(move |_, _, cx: &mut App| cx.open_url(&format!("{SITE}{path}")))
        .child(label)
}

fn dot(live: bool) -> impl IntoElement {
    div()
        .size(px(8.))
        .flex_none()
        .rounded_full()
        .bg(if live { tokens::live() } else { tokens::warn() })
}

/// `.dh-av`: a round initial on a colour.
fn avatar(letter: &'static str, color: u32, size: gpui_kit::Pixels, font: gpui_kit::Pixels) -> gpui_kit::Div {
    div()
        .size(size)
        .flex_none()
        .rounded_full()
        .bg(rgb(color))
        .text_color(tokens::bg())
        .flex()
        .items_center()
        .justify_center()
        .font_weight(FontWeight::BOLD)
        .text_size(font)
        .child(letter)
}

impl Home<'_> {
    pub(crate) fn render(self, window: &mut Window, cx: &mut Context<'_, RoomView>) -> AnyElement {
        let pad_x = clamp_vw(window, 24., 3.5, 48.);
        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_between()
            .bg(tokens::bg())
            .text_color(tokens::text())
            .font_family(tokens::FONT_MAIN)
            .child(self.header(window, pad_x))
            .child(self.main(window, cx, pad_x))
            .child(self.footer(window, cx, pad_x))
            .into_any_element()
    }

    fn header(&self, window: &Window, pad_x: gpui_kit::Pixels) -> impl IntoElement {
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .gap(px(16.))
            .py(clamp_vh(window, 14., 2., 22.))
            .px(pad_x)
            .child(logo(30.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(clamp_vw(window, 20., 2.2, 32.))
                    .text_size(px(15.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(link("nav-how", "How it works", "/watch-videos-together"))
                    .child(link("nav-about", "About", "/about"))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_color(tokens::text_2())
                            .text_size(px(14.))
                            .child(dot(self.online))
                            .child(if self.online { "Ready" } else { "Connecting…" }),
                    ),
            )
    }

    fn main(
        &self,
        window: &mut Window,
        cx: &mut Context<'_, RoomView>,
        pad_x: gpui_kit::Pixels,
    ) -> impl IntoElement {
        let width: f32 = window.viewport_size().width.into();
        div()
            .flex_1()
            .min_h_0()
            .w_full()
            .max_w(px((width * 0.94).min(1480.)))
            .mx_auto()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(clamp_vh(window, 12., 2.2, 26.))
            .px(pad_x)
            .child(Self::hero(window))
            .child(
                div()
                    .w_full()
                    .min_h_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(clamp_vw(window, 24., 3.2, 48.))
                    .child(self.action_column(window, cx))
                    .child(Self::preview(window)),
            )
    }

    fn hero(window: &Window) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .flex_none()
            .items_center()
            .text_center()
            .gap(clamp_vh(window, 6., 1., 10.))
            .max_w(px(820.))
            .child(
                div()
                    .text_color(tokens::warn())
                    .text_size(clamp_vh(window, 13., 1.4, 14.))
                    .font_weight(FontWeight::SEMIBOLD)
                    // the web line ends "· Nothing to install": this is the install
                    .child("Free · No sign-up"),
            )
            .child(
                div()
                    .font_family(tokens::FONT_DISPLAY_TIGHT_3)
                    .font_weight(FontWeight::BOLD)
                    .text_size(clamp_vw(window, 30., 3.4, 50.))
                    .line_height(gpui_kit::relative(1.08))
                    .child("Watch anything together, in perfect sync."),
            )
            .child(
                div()
                    .max_w(px(680.))
                    .text_color(tokens::text_2())
                    .text_size(clamp_vh(window, 14., 1.5, 16.))
                    .line_height(gpui_kit::relative(1.45))
                    .child(
                        "YouTube, any video link, or a movie on your laptop. Talk, chat and react while you \
                         watch — straight between your devices, up to 4 people.",
                    ),
            )
    }

    fn action_column(&self, window: &mut Window, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
        let box_h = clamp_vh(window, 42., 5., 48.);
        self.code
            .update(cx, |c, _| c.set_metrics(box_h, clamp_vw(window, 17., 1.8, 20.)));
        let complete = self.code.read(cx).is_complete();
        let divider_line = || div().flex_1().h(px(1.)).bg(tokens::line());
        let card = div()
            .flex()
            .flex_col()
            .gap(clamp_vh(window, 10., 1.5, 15.))
            .py(clamp_vh(window, 16., 2.2, 22.))
            .px(clamp_vw(window, 18., 2., 26.))
            .bg(tokens::surface())
            .border_1()
            .border_color(tokens::line())
            .rounded(tokens::RADIUS_SHEET)
            .shadow(tokens::drop_shadow(16., 36., 0.4))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Your name"),
                    )
                    .child(text_field(self.name, clamp_vh(window, 40., 4.8, 48.), window, cx)),
            )
            .child(
                Button::new("create", "Create a room")
                    .variant(Variant::Primary)
                    .min_height(clamp_vh(window, 44., 5.2, 50.))
                    .font_size(px(16.))
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, _, cx| this.create(cx))),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .text_color(tokens::text_3())
                    .text_size(px(13.))
                    .child(divider_line())
                    .child("or join a friend’s room")
                    .child(divider_line()),
            )
            .child(
                div().flex().gap(px(10.)).child(self.code.clone()).child(
                    Button::new("join", "Join")
                        .min_height(box_h)
                        .padding_x(px(18.))
                        .weight(FontWeight::BOLD)
                        .disabled(!complete || self.busy)
                        .on_click(cx.listener(|this, _, _, cx| this.join(cx))),
                ),
            )
            .when_some(self.join_error.clone(), |el, message| {
                // `.join-error`
                el.child(
                    div()
                        .text_size(px(14.))
                        .text_color(tokens::danger_text())
                        .child(message),
                )
            });
        div()
            .flex_basis(px(430.))
            .flex_shrink(1.)
            .max_w(px(450.))
            .min_w(px(320.))
            .flex()
            .flex_col()
            .gap(clamp_vh(window, 10., 1.4, 16.))
            .when_some(self.rejoin.clone(), |el, (room, was_host)| {
                el.child(rejoin_card(&room, was_host, cx))
            })
            .child(card)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .px(px(4.))
                    .text_color(tokens::text_2())
                    .text_size(px(13.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(icon_bold(Icon::Check, px(16.), tokens::live()))
                            .child("Video, voice and chat stay between your devices"),
                    ),
            )
    }

    /// `.dh-preview`: a still picture of a room.
    fn preview(window: &Window) -> impl IntoElement {
        let av = clamp_vh(window, 32., 4., 40.);
        let av_font = clamp_vh(window, 13., 1.6, 16.);
        let video_bg = rgb(0x001b_1524);
        let play = clamp_vh(window, 44., 5.5, 56.);
        let video = div()
            .relative()
            .w_full()
            .h(clamp_vh(window, 210., 33., 340.))
            .rounded(tokens::RADIUS_VIDEO)
            .bg(video_bg)
            .overflow_hidden()
            .flex()
            .items_center()
            .justify_center()
            .child(icon(Icon::Play, play, gpui_kit::rgba(0xf4f4_f640).into()))
            .child(
                div()
                    .absolute()
                    .top(px(12.))
                    .left(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .py(px(6.))
                    .px(px(12.))
                    .rounded_full()
                    .bg(gpui_kit::rgba(0x0a0a_0dd9))
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(dot(true))
                    .child("In sync · 4 watching"),
            )
            .child(
                div()
                    .absolute()
                    .left(px(14.))
                    .bottom(px(14.))
                    .flex()
                    .gap(px(10.))
                    .child(
                        // `.dh-av.is-speaking`: a 2 px gap in the video's colour, then a 2 px live ring
                        div()
                            .relative()
                            .size(av)
                            .flex_none()
                            .child(div().absolute().inset(px(-4.)).rounded_full().bg(tokens::live()))
                            .child(div().absolute().inset(px(-2.)).rounded_full().bg(video_bg))
                            .child(avatar("P", 0x006a_a8ff, av, av_font).absolute().inset_0()),
                    )
                    .child(avatar("A", 0x00f5_b544, av, av_font))
                    .child(avatar("M", 0x00c7_9bff, av, av_font))
                    .child(avatar("D", 0x00f4_f4f6, av, av_font)),
            );
        let chat = div()
            .flex()
            .items_center()
            .gap(px(10.))
            .py(px(2.))
            .px(px(6.))
            .child(avatar("A", 0x00f5_b544, px(28.), px(12.)))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .py(px(8.))
                    .px(px(14.))
                    .bg(tokens::raised())
                    .rounded_tl(px(4.))
                    .rounded_tr(px(14.))
                    .rounded_br(px(14.))
                    .rounded_bl(px(14.))
                    .text_size(px(14.))
                    .line_height(gpui_kit::relative(1.4))
                    .child(
                        div()
                            .text_color(tokens::warn())
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Arjun"),
                    )
                    .child("wait, rewind 10s — I missed that"),
            );
        div()
            .flex_basis(px(560.))
            .flex_grow(1.)
            .flex_shrink(1.)
            .max_w(px(760.))
            .min_w(px(360.))
            .flex()
            .flex_col()
            .gap(clamp_vh(window, 10., 1.4, 14.))
            .p(clamp_vh(window, 12., 1.8, 18.))
            .bg(tokens::surface())
            .border_1()
            .border_color(tokens::line())
            .rounded(tokens::RADIUS_SHEET)
            .shadow(tokens::drop_shadow(20., 48., 0.45))
            .child(video)
            .child(chat)
    }

    fn footer(
        &self,
        window: &Window,
        cx: &mut Context<'_, RoomView>,
        pad_x: gpui_kit::Pixels,
    ) -> impl IntoElement {
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_end()
            .gap(px(24.))
            .py(clamp_vh(window, 10., 1.6, 16.))
            .px(pad_x)
            .border_t_1()
            .border_color(tokens::raised())
            .text_size(px(13.))
            .child(
                div()
                    .id("foot-server")
                    .text_color(tokens::text_2())
                    .cursor_pointer()
                    .hover(|s| s.text_color(tokens::text()))
                    .on_click(cx.listener(|v, _, _, cx| v.open_dialog(crate::view::Dialog::Server, cx)))
                    .child("Server settings"),
            )
            .child(link("foot-privacy", "Privacy", "/privacy"))
            .child(link("foot-about", "About", "/about"))
            .child(
                div()
                    .font_family(tokens::FONT_MONO)
                    .font_weight(FontWeight::MEDIUM)
                    .text_size(px(12.))
                    .text_color(tokens::text_3())
                    .child(self.build),
            )
    }
}
