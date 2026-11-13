//! Screen sharing on screen (`ScreenShareStage.tsx`, `ScreenPointerOverlay.tsx`): the picker,
//! the shared screen in the stage (pictures from the engine's [`ScreenFeed`], drawn by GPUI, so
//! menus and laser pointers draw over it), and the laser pointer both ways.
//!
//! Quality (ADR 0005): the sharer picks the largest picture (Native, 1440p, 1080p, 720p) and 60 or
//! 30 frames a second, in the picker and while sharing; a viewer of a desktop share picks the
//! largest picture they want (Auto, 1440p, 1080p, 720p). Pictures arrive scaled to the size the
//! stage shows them at; a line at the bottom says what's sent and received.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, Bounds, Context, FontWeight, ImageSource, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, ObjectFit, ParentElement as _, Pixels, RenderImage,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Task, canvas, div, img,
    prelude::FluentBuilder as _, px,
};
use rtc_engine::{ScreenFeed, ScreenOptions, ScreenSource, ScreenViewer};
use rtc_ui::button::{Button, Variant};
use rtc_ui::{Icon, icon, tokens};

use crate::view::{Dialog, RoomView};

/// A laser pointer disappears after this long without moving.
const POINTER_TTL: Duration = Duration::from_secs(4);
/// A click ripple lasts this long.
const PING_TTL: Duration = Duration::from_millis(800);
/// Our pointer goes out at most this often (as the web app: ~30 a second).
const POINTER_GAP: Duration = Duration::from_millis(33);

#[derive(Default)]
pub(crate) struct ScreenUi {
    /// Who shares (`None`: nobody).
    pub(crate) sharer: Option<String>,
    /// It's us.
    pub(crate) mine: bool,
    feed: Option<ScreenFeed>,
    /// The latest picture, and its number.
    image: Option<Arc<RenderImage>>,
    seen: u64,
    size: (u32, u32),
    pump: Option<Task<()>>,
    /// "Hide" was pressed (the share goes on; the dock button brings it back).
    pub(crate) dismissed: bool,
    /// Our laser pointer is on.
    pub(crate) laser: bool,
    /// Our own share: show its picture (off: a card, as the web app, so the picture of the
    /// app showing itself doesn't repeat into the distance).
    pub(crate) preview: bool,
    sent_at: Option<Instant>,
    /// Others' pointers: name, x, y (0–1), last seen.
    pointers: HashMap<String, (String, f64, f64, Instant)>,
    /// Click ripples: name, x, y, when.
    pings: Vec<(String, f64, f64, Instant)>,
    /// The screens and windows to pick from (`None`: still looking).
    pub(crate) sources: Option<Vec<ScreenSource>>,
    pub(crate) error: Option<String>,
    /// Where the picture area is (window coordinates).
    area: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The window's scale (physical pixels per logical one).
    scale: Rc<Cell<f32>>,
    /// The size pictures are asked to arrive at (physical pixels).
    target: (u32, u32),
    /// How our share goes out: the GPU encoder, and each viewer.
    pub(crate) sending: Option<(Option<String>, Vec<ScreenViewer>)>,
    /// The quality menu is open.
    menu: bool,
}

/// The picture sizes to choose from (0: the screen's own / as sent).
const SIZES: [u32; 4] = [0, 1440, 1080, 720];

fn size_label(h: u32, zero: &str) -> String {
    if h == 0 { zero.to_owned() } else { format!("{h}p") }
}

impl ScreenUi {
    /// Someone's screen shows in the stage now.
    pub(crate) const fn showing(&self) -> bool {
        self.sharer.is_some() && !self.dismissed
    }
}

/// The picture's rectangle inside `area` (fitted, centred).
fn fitted(area: Bounds<Pixels>, (w, h): (u32, u32)) -> Bounds<Pixels> {
    if w == 0 || h == 0 {
        return area;
    }
    let (aw, ah) = (f32::from(area.size.width), f32::from(area.size.height));
    #[allow(clippy::cast_precision_loss)]
    let s = (aw / w as f32).min(ah / h as f32);
    #[allow(clippy::cast_precision_loss)]
    let (fw, fh) = (w as f32 * s, h as f32 * s);
    Bounds {
        origin: gpui_kit::point(
            area.origin.x + px((aw - fw) / 2.0),
            area.origin.y + px((ah - fh) / 2.0),
        ),
        size: gpui_kit::size(px(fw), px(fh)),
    }
}

impl RoomView {
    /// The dock's screen button (`toggleScreenShare`): stop ours, show a hidden one, or pick one.
    pub(crate) fn screen_button(&mut self, cx: &mut Context<'_, Self>) {
        let s = &mut self.screen;
        if s.mine {
            if let Some(e) = &self.engine {
                e.share_screen(None);
            }
        } else if s.sharer.is_some() {
            s.dismissed = !s.dismissed;
            cx.notify();
        } else {
            self.open_screen_picker(cx);
        }
    }

    pub(crate) fn open_screen_picker(&mut self, cx: &mut Context<'_, Self>) {
        self.screen.sources = None;
        self.screen.error = None;
        self.open_dialog(Dialog::Screen, cx);
        let task = cx
            .background_executor()
            .spawn(async { rtc_engine::screen_sources() });
        cx.spawn(async move |this, cx| {
            let list = task.await;
            let _ = this.update(cx, |v, cx| {
                v.screen.sources = Some(list);
                cx.notify();
            });
        })
        .detach();
    }

    fn share_source(&mut self, s: &ScreenSource, cx: &mut Context<'_, Self>) {
        if let Some(e) = &self.engine {
            e.share_screen(Some(s.clone()));
        }
        self.close_dialog(cx);
    }

    /// The engine says who shares now.
    pub(crate) fn on_screen(
        &mut self,
        sharer: Option<String>,
        mine: bool,
        feed: Option<ScreenFeed>,
        cx: &mut Context<'_, Self>,
    ) {
        let s = &mut self.screen;
        let started = sharer.is_some() && s.sharer.is_none();
        s.sharer = sharer;
        s.mine = mine;
        if started {
            s.dismissed = false;
        }
        if s.feed != feed {
            s.feed = feed;
            s.seen = 0;
            if let Some(old) = s.image.take() {
                cx.drop_image(old, None);
            }
        }
        if s.sharer.is_none() {
            s.sending = None;
            s.menu = false;
            s.target = (0, 0);
            s.laser = false;
            s.preview = false;
            s.pointers.clear();
            s.pings.clear();
            s.pump = None;
        } else if s.pump.is_none() {
            // pictures to the screen ~30 times a second while a share is on
            s.pump = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(33)).await;
                    let Ok(()) = this.update(cx, RoomView::screen_tick) else {
                        break;
                    };
                }
            }));
        }
        cx.notify();
    }

    fn screen_tick(&mut self, cx: &mut Context<'_, Self>) {
        let s = &mut self.screen;
        let now = Instant::now();
        let before = (s.pointers.len(), s.pings.len());
        s.pointers.retain(|_, p| now.duration_since(p.3) < POINTER_TTL);
        s.pings.retain(|p| now.duration_since(p.3) < PING_TTL);
        let mut changed = before != (s.pointers.len(), s.pings.len()) || !s.pings.is_empty();
        // someone else's share arrives scaled to the stage (ours: the preview, already small)
        if !s.mine
            && let (Some(feed), Some(a)) = (&s.feed, s.area.get())
        {
            let k = s.scale.get().max(1.0);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let t = (
                (f32::from(a.size.width) * k) as u32,
                (f32::from(a.size.height) * k) as u32,
            );
            if t != s.target {
                s.target = t;
                feed.set_target(t.0, t.1);
            }
        }
        if let Some(feed) = &s.feed {
            let (n, frame) = feed.latest();
            if n != s.seen
                && let Some(f) = frame
                && let Some(buf) = image::RgbaImage::from_raw(f.width, f.height, f.bgra.clone())
            {
                s.seen = n;
                s.size = (f.width, f.height);
                let new = Arc::new(RenderImage::new(vec![image::Frame::new(buf)]));
                if let Some(old) = s.image.replace(new) {
                    cx.drop_image(old, None);
                }
                changed = true;
            }
        }
        if changed && s.showing() {
            cx.notify();
        }
    }

    /// How we share: the largest picture and frames a second (now, and remembered).
    fn set_screen_options(&mut self, max_height: Option<u32>, fps: Option<u32>, cx: &mut Context<'_, Self>) {
        if let Some(h) = max_height {
            self.settings.screen_max_height = h;
        }
        if let Some(f) = fps {
            self.settings.screen_fps = f;
        }
        self.settings.save();
        if let Some(e) = &self.engine {
            e.screen_options(self.screen_options());
        }
        cx.notify();
    }

    pub(crate) const fn screen_options(&self) -> ScreenOptions {
        ScreenOptions {
            max_height: self.settings.screen_max_height,
            fps: if self.settings.screen_fps == 30 { 30 } else { 60 },
        }
    }

    /// The largest picture we want of others' shares (remembered).
    fn set_screen_quality(&mut self, h: u32, cx: &mut Context<'_, Self>) {
        self.settings.screen_quality = h;
        self.settings.save();
        if let Some(e) = &self.engine {
            e.screen_quality(h);
        }
        cx.notify();
    }

    /// The sharer is on the desktop app (only it sends the size we ask for).
    fn sharer_on_desktop(&self) -> bool {
        let Some(name) = &self.screen.sharer else {
            return false;
        };
        self.room.as_ref().is_some_and(|r| {
            r.members
                .iter()
                .any(|(_, m)| m.desktop && m.username.as_deref() == Some(name.as_str()))
        })
    }

    pub(crate) fn on_screen_pointer(&mut self, peer: String, name: String, x: f64, y: f64, active: bool) {
        if active {
            self.screen.pointers.insert(peer, (name, x, y, Instant::now()));
        } else {
            self.screen.pointers.remove(&peer);
        }
    }

    pub(crate) fn on_screen_ping(&mut self, name: String, x: f64, y: f64) {
        self.screen.pings.push((name, x, y, Instant::now()));
        if self.screen.pings.len() > 8 {
            self.screen.pings.remove(0);
        }
    }

    /// Where `p` is on the shared picture (0–1), if it's on it.
    fn on_picture(&self, p: gpui_kit::Point<Pixels>) -> Option<(f64, f64)> {
        let b = fitted(self.screen.area.get()?, self.screen.size);
        let x = (f32::from(p.x) - f32::from(b.origin.x)) / f32::from(b.size.width);
        let y = (f32::from(p.y) - f32::from(b.origin.y)) / f32::from(b.size.height);
        ((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)).then_some((f64::from(x), f64::from(y)))
    }

    fn laser_move(&mut self, p: gpui_kit::Point<Pixels>) {
        if !self.screen.laser {
            return;
        }
        let at = self.on_picture(p);
        let now = Instant::now();
        if at.is_some()
            && self
                .screen
                .sent_at
                .is_some_and(|t| now.duration_since(t) < POINTER_GAP)
        {
            return;
        }
        self.screen.sent_at = Some(now);
        if let Some(e) = &self.engine {
            e.screen_pointer(at);
        }
    }

    fn laser_click(&mut self, p: gpui_kit::Point<Pixels>, cx: &mut Context<'_, Self>) {
        if !self.screen.laser {
            return;
        }
        if let Some((x, y)) = self.on_picture(p) {
            if let Some(e) = &self.engine {
                e.screen_ping(x, y);
            }
            let me = self.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
            self.on_screen_ping(me, x, y);
            cx.notify();
        }
    }
}

fn bar_btn(id: &'static str, label: &str, on: bool) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .h(px(34.))
        .px(px(12.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(10.))
        .bg(if on { tokens::text() } else { tokens::black(0.55) })
        .text_color(if on { tokens::bg() } else { tokens::text() })
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer()
        .child(label.to_owned())
}

/// A name's colour for its pointer (the web app's `getAvatarColor`-like: stable per name).
fn color_of(name: &str) -> gpui_kit::Hsla {
    let h = name
        .bytes()
        .fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(u32::from(b)));
    #[allow(clippy::cast_precision_loss)]
    gpui_kit::hsla((h % 360) as f32 / 360.0, 0.75, 0.6, 1.0)
}

/// The stage while a screen is shared.
pub(crate) fn stage(view: &mut RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let s = &view.screen;
    let name = s.sharer.clone().unwrap_or_default();
    let mine = s.mine;
    let area = Rc::clone(&s.area);
    let scale = Rc::clone(&s.scale);
    let picture = if mine && !s.preview { None } else { s.image.clone() };
    let slate = mine && !s.preview;
    let size = s.size;
    let laser = s.laser;
    let now = Instant::now();
    let rect = area.get().map(|a| (a, fitted(a, size)));
    let pointers: Vec<(String, f64, f64)> = s.pointers.values().map(|p| (p.0.clone(), p.1, p.2)).collect();
    let pings: Vec<(f64, f64, f32, String)> = s
        .pings
        .iter()
        .map(|p| {
            (
                p.1,
                p.2,
                now.duration_since(p.3).as_secs_f32() / PING_TTL.as_secs_f32(),
                p.0.clone(),
            )
        })
        .collect();
    let marks = rect.map(|(a, b)| {
        let ox = f32::from(b.origin.x) - f32::from(a.origin.x);
        let oy = f32::from(b.origin.y) - f32::from(a.origin.y);
        let (bw, bh) = (f32::from(b.size.width), f32::from(b.size.height));
        #[allow(clippy::cast_possible_truncation)]
        let at = move |x: f64, y: f64| (px(ox + bw * x as f32), px(oy + bh * y as f32));
        let mut out: Vec<AnyElement> = Vec::new();
        for (who, x, y) in &pointers {
            let (l, t) = at(*x, *y);
            out.push(
                div()
                    .absolute()
                    .left(l - px(7.))
                    .top(t - px(7.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .size(px(14.))
                            .rounded_full()
                            .bg(color_of(who))
                            .border_2()
                            .border_color(tokens::text()),
                    )
                    .child(
                        div()
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(px(6.))
                            .bg(tokens::black(0.7))
                            .text_size(px(12.))
                            .text_color(tokens::text())
                            .child(who.clone()),
                    )
                    .into_any_element(),
            );
        }
        for (x, y, k, who) in &pings {
            let (l, t) = at(*x, *y);
            let r = 10.0 + 30.0 * k;
            out.push(
                div()
                    .absolute()
                    .left(l - px(r))
                    .top(t - px(r))
                    .size(px(r * 2.0))
                    .rounded_full()
                    .border_2()
                    .border_color(gpui_kit::Hsla {
                        a: 1.0 - k,
                        ..color_of(who)
                    })
                    .into_any_element(),
            );
        }
        out
    });
    let title = if mine {
        "You are sharing your screen".to_owned()
    } else {
        format!("{name} is sharing their screen")
    };
    let menu_open = s.menu;
    let stats = stats_line(view);
    let can_ask = !mine && view.sharer_on_desktop();
    let quality_label = if mine {
        let o = view.screen_options();
        format!("{} · {} fps", size_label(o.max_height, "Native"), o.fps)
    } else {
        format!("Quality: {}", size_label(view.settings.screen_quality, "Auto"))
    };
    let menu = menu_open.then(|| quality_menu(view, cx));
    div()
        .id("screen-stage")
        .absolute()
        .top(px(12.))
        .left(px(12.))
        .right(px(12.))
        .bottom(px(12.))
        .rounded(tokens::RADIUS_VIDEO)
        .overflow_hidden()
        .bg(tokens::black(1.0))
        .when(laser, gpui_kit::Styled::cursor_crosshair)
        .on_mouse_move(cx.listener(|v, e: &MouseMoveEvent, _, _| v.laser_move(e.position)))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|v, e: &MouseDownEvent, _, cx| v.laser_click(e.position, cx)),
        )
        .child(
            canvas(
                move |b, window, _| {
                    area.set(Some(b));
                    scale.set(window.scale_factor());
                },
                |_, (), _, _| {},
            )
                .absolute()
                .size_full(),
        )
        .when(slate, |el| {
            el.child(
                div()
                    .absolute()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .w(px(440.))
                            .p(px(28.))
                            .rounded(px(20.))
                            .bg(tokens::surface())
                            .border_1()
                            .border_color(tokens::line())
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(12.))
                            .text_center()
                            .child(icon(Icon::ScreenShare, px(36.), tokens::live()))
                            .child(
                                div()
                                    .text_size(px(20.))
                                    .font_weight(FontWeight::BOLD)
                                    .child("You are sharing your screen"),
                            )
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .text_color(tokens::text_2())
                                    .child("Everyone in the room sees it. Others can point at it with their laser pointer."),
                            )
                            .child(
                                div()
                                    .pt(px(6.))
                                    .flex()
                                    .gap(px(8.))
                                    .child(
                                        Button::new("screen-slate-stop", "Stop sharing")
                                            .variant(Variant::Primary)
                                            .on_click(cx.listener(|v, _, _, cx| {
                                                if let Some(e) = &v.engine {
                                                    e.share_screen(None);
                                                }
                                                cx.notify();
                                            })),
                                    )
                                    .child(
                                        Button::new("screen-slate-preview", "Show preview")
                                            .variant(Variant::Secondary)
                                            .on_click(cx.listener(|v, _, _, cx| {
                                                v.screen.preview = true;
                                                cx.notify();
                                            })),
                                    ),
                            ),
                    ),
            )
        })
        .map(|el| match picture {
            _ if slate => el,
            Some(p) => el.child(
                img(ImageSource::from(p))
                    .absolute()
                    .size_full()
                    .object_fit(ObjectFit::Contain),
            ),
            None => el.child(
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(tokens::text_3())
                    .child(if mine {
                        "Starting…"
                    } else {
                        "Waiting for the picture…"
                    }),
            ),
        })
        .children(marks.into_iter().flatten())
        .child(
            div()
                .absolute()
                .top(px(12.))
                .left(px(12.))
                .right(px(12.))
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .h(px(34.))
                        .px(px(12.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .rounded_full()
                        .bg(tokens::black(0.6))
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(div().size(px(8.)).rounded_full().bg(tokens::live()))
                        .child(title),
                )
                .child(div().flex_1())
                .when(mine || can_ask, |el| {
                    el.child(bar_btn("screen-quality", &quality_label, menu_open).on_click(cx.listener(|v, _, _, cx| {
                        v.screen.menu = !v.screen.menu;
                        cx.notify();
                    })))
                })
                .child(
                    bar_btn("screen-laser", "Laser pointer", laser).on_click(cx.listener(|v, _, _, cx| {
                        v.screen.laser = !v.screen.laser;
                        if !v.screen.laser
                            && let Some(e) = &v.engine
                        {
                            e.screen_pointer(None);
                        }
                        cx.notify();
                    })),
                )
                .when(!mine, |el| {
                    el.child(
                        bar_btn("screen-hide", "Hide", false).on_click(cx.listener(|v, _, _, cx| {
                            v.screen.dismissed = true;
                            cx.notify();
                        })),
                    )
                })
                .when(mine && !slate, |el| {
                    el.child(bar_btn("screen-hide-preview", "Hide preview", false).on_click(cx.listener(|v, _, _, cx| {
                        v.screen.preview = false;
                        cx.notify();
                    })))
                })
                .when(mine && !slate, |el| {
                    el.child(
                        Button::new("screen-stop", "Stop sharing")
                            .variant(Variant::Primary)
                            .on_click(cx.listener(|v, _, _, cx| {
                                if let Some(e) = &v.engine {
                                    e.share_screen(None);
                                }
                                cx.notify();
                            })),
                    )
                }),
        )
        .children(stats.map(|line| {
            div()
                .absolute()
                .bottom(px(12.))
                .left(px(12.))
                .max_w(px(720.))
                .px(px(10.))
                .py(px(5.))
                .rounded(px(8.))
                .bg(tokens::black(0.6))
                .text_size(px(12.))
                .text_color(tokens::text_2())
                .child(line)
        }))
        .children(menu)
        .into_any_element()
}

/// What's sent or received, for the line at the bottom of the stage.
fn stats_line(view: &RoomView) -> Option<String> {
    let s = &view.screen;
    let st = s.feed.as_ref()?.stats();
    if st.width == 0 {
        return None;
    }
    if !s.mine {
        return Some(format!("{}×{} · {} fps", st.width, st.height, st.fps));
    }
    let mut line = format!("Sending {}×{} · {} fps", st.width, st.height, st.fps);
    if let Some((encoder, viewers)) = &s.sending {
        match encoder {
            Some(name) => line.push_str(&format!(" · GPU encoding ({name})")),
            None => line.push_str(" · software encoding"),
        }
        let each: Vec<String> = viewers
            .iter()
            .map(|v| {
                format!(
                    "{} {}p{}{}",
                    v.name,
                    v.height,
                    if v.hardware { " GPU" } else { "" },
                    if v.web { " (web)" } else { "" }
                )
            })
            .collect();
        if !each.is_empty() {
            line.push_str(" · ");
            line.push_str(&each.join(", "));
        }
    }
    Some(line)
}

fn menu_row(id: (&'static str, usize), label: String, on: bool) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .h(px(32.))
        .px(px(10.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(8.))
        .cursor_pointer()
        .hover(|st| st.bg(tokens::raised()))
        .text_size(px(13.))
        .child(
            div()
                .w(px(14.))
                .text_color(tokens::live())
                .child(if on { "✓" } else { "" }),
        )
        .child(label)
}

fn menu_head(label: &'static str) -> gpui_kit::Div {
    div()
        .px(px(10.))
        .pt(px(8.))
        .pb(px(4.))
        .text_size(px(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(tokens::text_3())
        .child(label)
}

/// The quality menu: the sharer's size and frames, or the viewer's size.
fn quality_menu(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let mine = view.screen.mine;
    let panel = div()
        .absolute()
        .top(px(54.))
        .right(px(12.))
        .w(px(260.))
        .p(px(6.))
        .rounded(px(12.))
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
    if mine {
        let o = view.screen_options();
        panel
            .child(menu_head("PICTURE SIZE"))
            .children(SIZES.iter().enumerate().map(|(n, &h)| {
                let label = if h == 0 {
                    "Native (the screen's own size)".to_owned()
                } else {
                    format!("{h}p")
                };
                menu_row(("screen-size", n), label, o.max_height == h)
                    .on_click(cx.listener(move |v, _, _, cx| v.set_screen_options(Some(h), None, cx)))
            }))
            .child(menu_head("FRAMES A SECOND"))
            .children([60u32, 30].into_iter().enumerate().map(|(n, f)| {
                let label = if f == 60 {
                    "60 (smooth)".to_owned()
                } else {
                    "30 (less data)".to_owned()
                };
                menu_row(("screen-fps", n), label, o.fps == f)
                    .on_click(cx.listener(move |v, _, _, cx| v.set_screen_options(None, Some(f), cx)))
            }))
            .child(
                div()
                    .px(px(10.))
                    .py(px(6.))
                    .text_size(px(11.))
                    .text_color(tokens::text_3())
                    .child("Each viewer also gets at most what they ask for; web viewers at most 1440p."),
            )
            .into_any_element()
    } else {
        let q = view.settings.screen_quality;
        panel
            .child(menu_head("QUALITY YOU RECEIVE"))
            .children(SIZES.iter().enumerate().map(|(n, &h)| {
                let label = if h == 0 {
                    "Auto (as sent)".to_owned()
                } else {
                    format!("Up to {h}p")
                };
                menu_row(("screen-want", n), label, q == h)
                    .on_click(cx.listener(move |v, _, _, cx| v.set_screen_quality(h, cx)))
            }))
            .into_any_element()
    }
}

/// What a picker choice does.
type Act = Box<dyn Fn(&mut RoomView, &mut Context<'_, RoomView>)>;

/// A row of choices for the picker.
fn chips(id: &'static str, items: Vec<(String, bool, Act)>, cx: &mut Context<'_, RoomView>) -> gpui_kit::Div {
    div()
        .flex()
        .gap(px(6.))
        .children(items.into_iter().enumerate().map(|(n, (label, on, act))| {
            div()
                .id((id, n))
                .h(px(30.))
                .px(px(12.))
                .flex()
                .items_center()
                .rounded_full()
                .border_1()
                .border_color(if on { tokens::text() } else { tokens::line() })
                .bg(if on { tokens::text() } else { tokens::surface() })
                .text_color(if on { tokens::bg() } else { tokens::text() })
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .on_click(cx.listener(move |v, _, _, cx| act(v, cx)))
                .child(label)
        }))
}

/// "Share your screen": the screens, then the windows.
pub(crate) fn picker(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let rows: AnyElement = match &view.screen.sources {
        None => div()
            .py(px(20.))
            .text_color(tokens::text_3())
            .child("Looking for screens and windows…")
            .into_any_element(),
        Some(list) if list.is_empty() => div()
            .py(px(20.))
            .text_color(tokens::text_3())
            .child("Nothing to share was found.")
            .into_any_element(),
        Some(list) => div()
            .id("screen-list")
            .max_h(px(380.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(6.))
            .children(list.iter().enumerate().map(|(n, s)| {
                let src = s.clone();
                div()
                    .id(("screen-row", n))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .p(px(10.))
                    .rounded(px(12.))
                    .bg(tokens::surface())
                    .hover(|st| st.bg(tokens::raised()))
                    .cursor_pointer()
                    .on_click(cx.listener(move |v, _, _, cx| v.share_source(&src, cx)))
                    .child(icon(
                        if s.window { Icon::Image } else { Icon::ScreenShare },
                        px(18.),
                        tokens::text_2(),
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(14.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(s.title.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(tokens::text_3())
                            .child(if s.window { "Window" } else { "Screen" }),
                    )
            }))
            .into_any_element(),
    };
    div()
        .p(px(24.))
        .flex()
        .flex_col()
        .gap(px(14.))
        .child(
            div()
                .text_size(px(18.))
                .font_weight(FontWeight::BOLD)
                .child("Share your screen"),
        )
        .child(
            div()
                .text_size(px(14.))
                .text_color(tokens::text_2())
                .child("Everyone in the room sees it. Pick a whole screen, or one window."),
        )
        .children(view.screen.error.clone().map(|e| {
            div()
                .text_size(px(13.))
                .text_color(tokens::danger_text())
                .child(e)
        }))
        .child(rows)
        .child({
            let o = view.screen_options();
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .w(px(90.))
                                .text_size(px(13.))
                                .text_color(tokens::text_2())
                                .child("Picture"),
                        )
                        .child(chips(
                            "screen-pick-size",
                            SIZES
                                .iter()
                                .map(|&h| {
                                    let act: Act =
                                        Box::new(move |v, cx| v.set_screen_options(Some(h), None, cx));
                                    (size_label(h, "Native"), o.max_height == h, act)
                                })
                                .collect(),
                            cx,
                        )),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .w(px(90.))
                                .text_size(px(13.))
                                .text_color(tokens::text_2())
                                .child("Frames"),
                        )
                        .child(chips(
                            "screen-pick-fps",
                            [60u32, 30]
                                .into_iter()
                                .map(|f| {
                                    let act: Act =
                                        Box::new(move |v, cx| v.set_screen_options(None, Some(f), cx));
                                    (format!("{f} fps"), o.fps == f, act)
                                })
                                .collect(),
                            cx,
                        )),
                )
        })
        .child(
            div().flex().justify_end().child(
                Button::new("screen-cancel", "Cancel")
                    .variant(Variant::Secondary)
                    .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
            ),
        )
        .into_any_element()
}
