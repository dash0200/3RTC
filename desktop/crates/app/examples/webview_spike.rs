//! M4 check (BUILD_SPEC section 13): does a YouTube, Vimeo or Twitch player run in a WebView2
//! inside the GPUI window, take commands, report its state, and how does it stack with GPUI
//! drawing? `cargo run -p rtc-app --example webview_spike` (Windows).
//!
//! Buttons: the three providers (each opens a fresh player), Play, Pause, +30 s, Hide/Show, and
//! "Menu", which opens a GPUI popover over the player's corner (to see which one is on top).
//! The line under the buttons shows the player's last report.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use gpui_kit::{
    AppContext as _, Bounds, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, WindowBounds, WindowOptions, div, px,
    rgb, size,
};
use rtc_webview::{Event, Player, Source};

const TOP: f64 = 150.0;
const MARGIN: f64 = 20.0;

struct Spike {
    player: Option<Player>,
    last: Arc<Mutex<String>>,
    menu: bool,
    shown: bool,
    _ticker: gpui_kit::Task<()>,
}

fn sources() -> [(&'static str, Source); 3] {
    let twitch = std::env::var("RTC_SPIKE_TWITCH").unwrap_or_else(|_| "v2000000000".to_owned());
    [
        ("YouTube", Source::YouTube("aqz-KE-bpKQ".to_owned())),
        ("Vimeo", Source::Vimeo("https://vimeo.com/76979871".to_owned())),
        ("Twitch", Source::Twitch(twitch)),
    ]
}

impl Spike {
    fn bounds(window: &Window) -> rtc_webview::Bounds {
        let v = window.viewport_size();
        rtc_webview::Bounds {
            x: MARGIN,
            y: TOP,
            width: f64::from(f32::from(v.width)) - 2.0 * MARGIN,
            height: f64::from(f32::from(v.height)) - TOP - MARGIN,
        }
    }

    fn open(&mut self, i: usize, window: &mut Window) {
        self.player = None; // the old web view goes first
        let (name, source) = sources()[i].clone();
        let last = Arc::clone(&self.last);
        let data = std::env::var_os("LOCALAPPDATA")
            .map_or_else(std::env::temp_dir, std::path::PathBuf::from)
            .join("3RTC")
            .join("WebView2");
        match Player::open(
            &*window,
            Self::bounds(window),
            &source,
            0.0,
            true,
            data,
            move |e: Event| {
                *last.lock().unwrap_or_else(PoisonError::into_inner) = format!("{e:?}");
            },
        ) {
            Ok(p) => {
                self.player = Some(p);
                *self.last.lock().unwrap_or_else(PoisonError::into_inner) =
                    format!("{name}: opened, waiting for it…");
            }
            Err(e) => {
                *self.last.lock().unwrap_or_else(PoisonError::into_inner) =
                    format!("{name}: couldn't open: {e}");
            }
        }
    }
}

fn button(id: &'static str, label: &'static str) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .px(px(14.))
        .py(px(8.))
        .rounded(px(8.))
        .bg(rgb(0x1c_1c23))
        .border_1()
        .border_color(rgb(0x3a_3a45))
        .cursor_pointer()
        .child(label)
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if let Some(p) = &self.player {
            p.set_bounds(Self::bounds(window));
        }
        let last: SharedString = self
            .last
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .into();
        div()
            .size_full()
            .bg(rgb(0x0a_0a0d))
            .text_color(rgb(0xf4_f4f6))
            .relative()
            .child(
                div()
                    .p(px(20.))
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(button("yt", "YouTube").on_click(cx.listener(|v, _, w, cx| {
                                v.open(0, w);
                                cx.notify();
                            })))
                            .child(button("vimeo", "Vimeo").on_click(cx.listener(|v, _, w, cx| {
                                v.open(1, w);
                                cx.notify();
                            })))
                            .child(button("twitch", "Twitch").on_click(cx.listener(|v, _, w, cx| {
                                v.open(2, w);
                                cx.notify();
                            })))
                            .child(div().w(px(20.)))
                            .child(button("play", "Play").on_click(cx.listener(|v, _, _, _| {
                                if let Some(p) = &v.player {
                                    p.play(None);
                                }
                            })))
                            .child(button("pause", "Pause").on_click(cx.listener(|v, _, _, _| {
                                if let Some(p) = &v.player {
                                    p.pause(None);
                                }
                            })))
                            .child(button("seek", "+30 s").on_click(cx.listener(|v, _, _, _| {
                                if let Some(p) = &v.player {
                                    let now = v.last.lock().unwrap_or_else(PoisonError::into_inner).clone();
                                    let t = now
                                        .split("time: ")
                                        .nth(1)
                                        .and_then(|r| r.split(',').next())
                                        .and_then(|t| t.parse::<f64>().ok())
                                        .unwrap_or(0.0);
                                    p.seek(t + 30.0);
                                }
                            })))
                            .child(button("hide", "Hide/Show").on_click(cx.listener(|v, _, _, cx| {
                                v.shown = !v.shown;
                                if let Some(p) = &v.player {
                                    p.set_visible(v.shown);
                                }
                                cx.notify();
                            })))
                            .child(button("menu", "Menu").on_click(cx.listener(|v, _, _, cx| {
                                v.menu = !v.menu;
                                cx.notify();
                            }))),
                    )
                    .child(div().text_size(px(13.)).child(last)),
            )
            .when_menu(self.menu)
    }
}

trait MenuExt {
    fn when_menu(self, on: bool) -> Self;
}

impl MenuExt for gpui_kit::Div {
    fn when_menu(self, on: bool) -> Self {
        if !on {
            return self;
        }
        self.child(
            div()
                .absolute()
                .top(px(120.))
                .left(px(300.))
                .w(px(260.))
                .h(px(160.))
                .p(px(14.))
                .rounded(px(14.))
                .bg(rgb(0x14_1419))
                .border_1()
                .border_color(rgb(0x6a_a8ff))
                .child("A GPUI popover: is it above or below the player?"),
        )
    }
}

fn main() {
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
        let opened = gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..WindowOptions::default()
            },
            cx,
            |_, cx| {
                cx.new(|cx| Spike {
                    player: None,
                    last: Arc::new(Mutex::new("Pick a provider".to_owned())),
                    menu: false,
                    shown: true,
                    // the player reports from its own callback: redraw a few times a second
                    _ticker: cx.spawn(async move |this, cx| {
                        loop {
                            cx.background_executor().timer(Duration::from_millis(250)).await;
                            if this.update(cx, |_, cx| cx.notify()).is_err() {
                                break;
                            }
                        }
                    }),
                })
            },
        );
        if opened.is_err() {
            cx.quit();
        }
        cx.on_window_closed(|cx, _| cx.quit()).detach();
        cx.activate(true);
    });
}
