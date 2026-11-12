//! Reactions and the soundboard on screen: the floating emoji over the stage
//! (`FloatingReactions.tsx`), the reactions and soundboard popovers over the dock
//! (`DesktopDock.tsx`, `SoundboardTray.tsx`), the banner saying who played a clip
//! (`Stage.tsx`) and the quick reactions editor (`features/reactions/ReactionsEditor.tsx`).

use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, deferred, div, prelude::FluentBuilder as _,
    px, relative,
};
use rtc_engine::{Reaction, Sound};
use rtc_ui::button::{Button, Variant};
use rtc_ui::overlay::popover;
use rtc_ui::tokens;

use crate::settings::{MAX_REACTIONS, key_for_index};
use crate::sounds::{self, CLIPS};
use crate::view::RoomView;

/// How long a reaction floats (the web app: 2.7–3.3 s).
const FLOAT_MIN_S: f32 = 2.7;
const FLOAT_MAX_S: f32 = 3.3;
/// Most reactions on screen at once (the oldest go first).
const MAX_FLOATS: usize = 30;
/// A combo counter stays this long after the last hit, then fades for 0.4 s.
const COMBO_SHOW: Duration = Duration::from_millis(1300);
const COMBO_FADE: Duration = Duration::from_millis(400);
/// The "… played …" banner.
const BANNER: Duration = Duration::from_millis(1800);
/// At most one reaction pop this often.
const POP_GAP: Duration = Duration::from_millis(70);
/// The floating layer (`.floating-reactions-overlay`): right 28, bottom 24, 180 wide.
const LAYER_W: f32 = 180.0;
const LAYER_H: f32 = 420.0;
/// Redraw rate while something moves.
const FRAME: Duration = Duration::from_millis(16);
/// …in low-power mode.
const FRAME_LOW: Duration = Duration::from_millis(50);

/// One emoji on its way up.
pub(crate) struct Float {
    emoji: SharedString,
    /// The sender's name, on the first of a burst.
    tag: Option<SharedString>,
    lane: f32,
    born: Instant,
    secs: f32,
    scale: f32,
    sway: f32,
    rise: f32,
    /// Low-power mode: a short fade in place (the web app's reduced-motion version).
    calm: bool,
}

/// Someone's combo counter (×3, ×4…).
pub(crate) struct Combo {
    key: String,
    emoji: SharedString,
    count: u32,
    lane: f32,
    last: Instant,
}

/// What's moving on screen, and the clip banner.
#[derive(Default)]
pub(crate) struct FunState {
    floats: Vec<Float>,
    combos: Vec<Combo>,
    /// The clip being played and when.
    pub(crate) banner: Option<(Sound, Instant)>,
    last_pop: Option<Instant>,
    ticker: Option<gpui_kit::Task<()>>,
    /// Reactions editor: the slot being replaced, and the emoji tab shown.
    pub(crate) editor_slot: Option<usize>,
    pub(crate) editor_tab: usize,
}

impl FunState {
    fn busy(&self) -> bool {
        !self.floats.is_empty() || !self.combos.is_empty() || self.banner.is_some()
    }

    /// Drops what's done.
    fn expire(&mut self, now: Instant) {
        self.floats
            .retain(|f| now.duration_since(f.born).as_secs_f32() < f.secs);
        self.combos
            .retain(|c| now.duration_since(c.last) < COMBO_SHOW + COMBO_FADE);
        if self
            .banner
            .as_ref()
            .is_some_and(|(_, at)| now.duration_since(*at) >= BANNER)
        {
            self.banner = None;
        }
    }

    /// Clears everything (left the room).
    pub(crate) fn clear(&mut self) {
        self.floats.clear();
        self.combos.clear();
        self.banner = None;
        self.ticker = None;
    }
}

fn rand_in(a: f32, b: f32) -> f32 {
    a + rand::random::<f32>() * (b - a)
}

fn milestone(n: u32) -> bool {
    n == 5 || (n >= 10 && n.is_multiple_of(10))
}

impl RoomView {
    /// Sends one of our reactions (a key, a button).
    pub(crate) fn react(&mut self, emoji: &str) {
        self.command(rtc_core::Command::React {
            id: rtc_engine::Handle::new_message_id(),
            emoji: emoji.to_owned(),
            lane: f64::from(rand_in(20.0, 80.0)),
        });
    }

    /// Plays a soundboard clip for everyone.
    pub(crate) fn play_clip(&mut self, index: usize) {
        let Some(c) = CLIPS.get(index) else { return };
        self.command(rtc_core::Command::PlaySound {
            sound_id: c.id.to_owned(),
            sound_name: c.name.to_owned(),
            emoji: c.emoji.to_owned(),
        });
    }

    fn deafened(&self) -> bool {
        self.room.as_ref().is_some_and(|r| r.deafened)
    }

    /// A reaction to show (ours or someone's): float it, count the combo, pop.
    pub(crate) fn on_reaction(&mut self, r: Reaction, cx: &mut Context<'_, Self>) {
        let now = Instant::now();
        if !self.deafened() && self.fun.last_pop.is_none_or(|t| now.duration_since(t) >= POP_GAP) {
            self.fun.last_pop = Some(now);
            let volume = if r.from.is_none() { 1.0 } else { 0.8 };
            // the classic audio path plays these through Windows, which would cut a clip short
            if self.has_pipeline()
                && let Some(e) = &self.engine
            {
                e.play_samples(sounds::reaction_pop(r.combo, volume), 1.0, false);
            }
        }
        #[allow(clippy::cast_possible_truncation)]
        let lane = r.lane as f32;
        let big = if milestone(r.combo) { 1.55 } else { 1.0 };
        let tag = (r.combo == 1).then(|| {
            SharedString::from(if r.from.is_none() {
                "You".to_owned()
            } else {
                r.name.clone()
            })
        });
        self.fun.floats.push(Float {
            emoji: r.emoji.clone().into(),
            tag,
            lane,
            born: now,
            secs: if self.settings.low_power {
                1.4
            } else {
                rand_in(FLOAT_MIN_S, FLOAT_MAX_S)
            },
            calm: self.settings.low_power,
            scale: rand_in(0.95, 1.2) * big,
            sway: rand_in(10.0, 22.0) * if rand::random::<bool>() { -1.0 } else { 1.0 },
            rise: rand_in(0.78, 0.95),
        });
        if self.fun.floats.len() > MAX_FLOATS {
            self.fun.floats.remove(0);
        }
        if r.combo >= 3 {
            let key = r
                .from
                .as_ref()
                .map_or_else(|| "self".to_owned(), ToString::to_string);
            self.fun
                .combos
                .retain(|c| c.key != key || c.emoji.as_ref() == r.emoji);
            let lane = lane.clamp(18.0, 82.0);
            if let Some(c) = self.fun.combos.iter_mut().find(|c| c.key == key) {
                c.count = r.combo;
                c.lane = lane;
                c.last = now;
            } else {
                self.fun.combos.push(Combo {
                    key,
                    emoji: r.emoji.into(),
                    count: r.combo,
                    lane,
                    last: now,
                });
            }
        }
        self.animate(cx);
    }

    /// A clip to play (ours or someone's): play it at the soundboard volume and say who.
    pub(crate) fn on_sound(&mut self, s: Sound, cx: &mut Context<'_, Self>) {
        let volume = if self.settings.soundboard_muted {
            0.0
        } else {
            self.settings.soundboard_volume
        };
        if !self.deafened()
            && volume > 0.0
            && let Some(clip) = sounds::clip(&s.sound_id)
        {
            if self.has_pipeline() {
                if let (Some(e), Some(samples)) = (&self.engine, sounds::clip_samples(clip)) {
                    e.play_samples(samples, volume, true);
                }
            } else if let Some(wav) = sounds::clip_wav(clip) {
                rtc_platform_win::play_wav(wav);
            }
        }
        self.fun.banner = Some((s, Instant::now()));
        self.animate(cx);
    }

    /// A short sound of the app's own (chat pop, chime).
    pub(crate) fn ui_sound(&self, samples: &std::sync::Arc<[f32]>, wav: &'static [u8]) {
        if self.has_pipeline() {
            if let Some(e) = &self.engine {
                e.play_samples(std::sync::Arc::clone(samples), 1.0, false);
            }
        } else {
            rtc_platform_win::play_wav(wav);
        }
    }

    /// Redraws about 60 times a second while something moves, then stops.
    fn animate(&mut self, cx: &mut Context<'_, Self>) {
        if self.fun.ticker.is_some() {
            return;
        }
        self.fun.ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                let low = this.update(cx, |v, _| v.settings.low_power).unwrap_or(false);
                cx.background_executor()
                    .timer(if low { FRAME_LOW } else { FRAME })
                    .await;
                let Ok(true) = this.update(cx, |v, cx| {
                    v.fun.expire(Instant::now());
                    cx.notify();
                    let busy = v.fun.busy();
                    if !busy {
                        v.fun.ticker = None;
                    }
                    busy
                }) else {
                    break;
                };
            }
        }));
    }

    /// Keys 1–9 and 0 send your reactions.
    pub(crate) fn reaction_key(&mut self, key: &str) -> bool {
        let Some(i) = (0..self.settings.quick_reactions.len()).find(|i| key_for_index(*i) == key) else {
            return false;
        };
        let emoji = self.settings.quick_reactions[i].clone();
        self.react(&emoji);
        true
    }

    pub(crate) fn set_reactions(&mut self, list: &[String], cx: &mut Context<'_, Self>) {
        self.settings.quick_reactions = crate::settings::clean_reactions(list);
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_soundboard_volume(&mut self, volume: f32, cx: &mut Context<'_, Self>) {
        self.settings.soundboard_volume = ((volume * 20.0).round() / 20.0).clamp(0.0, 1.0);
        if self.settings.soundboard_muted && volume > 0.0 {
            self.settings.soundboard_muted = false;
        }
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn toggle_soundboard_mute(&mut self, cx: &mut Context<'_, Self>) {
        self.settings.soundboard_muted = !self.settings.soundboard_muted;
        self.settings.save();
        cx.notify();
    }

    /// Reactions editor: put `emoji` in the selected slot (or at the end) (`put`).
    pub(crate) fn editor_put(&mut self, emoji: &str, cx: &mut Context<'_, Self>) {
        let mut list = self.settings.quick_reactions.clone();
        let at = list.iter().position(|e| e == emoji);
        if let Some(sel) = self.fun.editor_slot.take() {
            match at {
                Some(a) if a != sel => list.swap(a, sel),
                Some(_) => {}
                None => {
                    if let Some(slot) = list.get_mut(sel) {
                        emoji.clone_into(slot);
                    }
                }
            }
        } else if at.is_some() || list.len() >= MAX_REACTIONS {
            return;
        } else {
            list.push(emoji.to_owned());
        }
        self.set_reactions(&list, cx);
    }

    pub(crate) fn editor_remove(&mut self, index: usize, cx: &mut Context<'_, Self>) {
        let mut list = self.settings.quick_reactions.clone();
        if list.len() <= 1 || index >= list.len() {
            return;
        }
        list.remove(index);
        self.fun.editor_slot = None;
        self.set_reactions(&list, cx);
    }

    pub(crate) fn editor_move(&mut self, index: usize, left: bool, cx: &mut Context<'_, Self>) {
        let mut list = self.settings.quick_reactions.clone();
        let to = if left {
            index.checked_sub(1)
        } else {
            Some(index + 1)
        };
        let Some(to) = to.filter(|t| *t < list.len()) else {
            return;
        };
        list.swap(index, to);
        self.fun.editor_slot = Some(to);
        self.set_reactions(&list, cx);
    }

    /// Typed or pasted emoji: into the selected slot, or added (`addTyped`).
    pub(crate) fn editor_add_typed(&mut self, window: &mut gpui_kit::Window, cx: &mut Context<'_, Self>) {
        let text = self.reaction_input.read(cx).value().to_string();
        let found = rtc_core::fun::split_emojis(&text);
        let Some(first) = found.first().cloned() else {
            return;
        };
        if self.fun.editor_slot.is_some() {
            self.editor_put(&first, cx);
        } else {
            let mut list = self.settings.quick_reactions.clone();
            for e in found {
                if !list.contains(&e) {
                    list.push(e);
                }
            }
            list.truncate(MAX_REACTIONS);
            self.set_reactions(&list, cx);
        }
        self.reaction_input
            .update(cx, |i, cx| i.set_value("", window, cx));
    }
}

/// Where a float is at `t` (0–1 of its life): sideways offset, height (share of its rise),
/// scale, opacity (the web app's keyframes).
fn float_at(f: &Float, t: f32) -> (f32, f32, f32, f32) {
    if f.calm {
        // up 30 px to 60 px; in by 20 %, out after 70 %
        let t = t.clamp(0.0, 1.0);
        let opacity = if t < 0.2 {
            t / 0.2
        } else if t < 0.7 {
            1.0
        } else {
            (1.0 - t) / 0.3
        };
        return (0.0, (30.0 + 30.0 * t) / (f.rise * LAYER_H), 1.0, opacity);
    }
    let s = f.scale;
    let w = f.sway;
    let keys: [(f32, f32, f32, f32, f32); 7] = [
        (0.0, 0.0, 0.0, 0.2, 0.0),
        (0.09, 0.0, 0.05, s * 1.3, 1.0),
        (0.17, w * 0.3, 0.12, s, 1.0),
        (0.42, -w, 0.4, s, 1.0),
        (0.68, w * 0.8, 0.66, s * 0.97, 0.95),
        (0.86, -w * 0.4, 0.85, s * 0.88, 0.75),
        (1.0, 0.0, 1.0, s * 0.6, 0.0),
    ];
    let t = t.clamp(0.0, 1.0);
    let i = keys
        .iter()
        .rposition(|k| k.0 <= t)
        .unwrap_or(0)
        .min(keys.len() - 2);
    let (a, b) = (keys[i], keys[i + 1]);
    let k = ((t - a.0) / (b.0 - a.0)).clamp(0.0, 1.0);
    // ease-in-out between keyframes (the pop-in overshoots a little faster)
    let e = if i == 0 {
        1.0 - (1.0 - k).powi(3)
    } else {
        k * k * (3.0 - 2.0 * k)
    };
    let mix = |x: f32, y: f32| x + (y - x) * e;
    (mix(a.1, b.1), mix(a.2, b.2), mix(a.3, b.3), mix(a.4, b.4))
}

/// The floating reactions and combo counters, over the stage's bottom right.
/// `beside`: a video plays, so they float in the strip beside it (the web view covers the rest).
pub(crate) fn layer(view: &RoomView, beside: bool) -> impl IntoElement {
    let w = if beside {
        crate::watch::REACTION_STRIP - 8.0
    } else {
        LAYER_W
    };
    let now = Instant::now();
    let tag_bg = Hsla {
        a: 0.88,
        ..tokens::reaction_tag()
    };
    div()
        .absolute()
        .right(px(if beside { 4. } else { 28. }))
        .bottom(px(24.))
        .w(px(w))
        .h(px(LAYER_H))
        .children(view.fun.floats.iter().map(|f| {
            let t = now.duration_since(f.born).as_secs_f32() / f.secs;
            let (dx, up, scale, opacity) = float_at(f, t);
            let x = f.lane / 100.0 * w + if beside { dx * 0.4 } else { dx };
            div()
                .absolute()
                .bottom(px(up * f.rise * LAYER_H))
                .left(px(x - 50.0))
                .w(px(100.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(3.))
                .opacity(opacity)
                .child(
                    div()
                        .text_size(px(32. * scale))
                        .line_height(relative(1.))
                        .child(f.emoji.clone()),
                )
                .when_some(f.tag.clone(), |el, tag| {
                    el.child(
                        div()
                            .px(px(7.))
                            .py(px(2.))
                            .rounded_full()
                            .bg(tag_bg)
                            .border_1()
                            .border_color(tokens::white().opacity(0.16))
                            .text_size(px(10.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(tokens::text())
                            .whitespace_nowrap()
                            .child(tag),
                    )
                })
        }))
        .children(view.fun.combos.iter().map(|c| {
            let since = now.duration_since(c.last);
            let fade = if since > COMBO_SHOW {
                1.0 - (since - COMBO_SHOW).as_secs_f32() / COMBO_FADE.as_secs_f32()
            } else {
                1.0
            };
            // a little bigger with each hit, with a pulse right after one
            #[allow(clippy::cast_precision_loss)]
            let grow = (1.0 + c.count as f32 * 0.015).min(1.35);
            let pulse = 1.0 + 0.25 * (1.0 - (since.as_secs_f32() / 0.22).min(1.0));
            let size = 15.0 * grow * pulse;
            div()
                .absolute()
                .bottom(px(6.))
                .left(px(c.lane / 100.0 * LAYER_W - 40.0))
                .w(px(80.))
                .flex()
                .justify_center()
                .opacity(fade.clamp(0.0, 1.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .pl(px(7.))
                        .pr(px(10.))
                        .py(px(4.))
                        .rounded_full()
                        .bg(Hsla {
                            a: 0.9,
                            ..tokens::reaction_tag()
                        })
                        .border_1()
                        .border_color(tokens::white().opacity(0.2))
                        .shadow(tokens::drop_shadow(4., 14., 0.4))
                        .child(div().text_size(px(size * 1.15)).child(c.emoji.clone()))
                        .child(
                            div()
                                .text_size(px(size))
                                .font_weight(FontWeight::EXTRA_BOLD)
                                .text_color(tokens::combo_gold())
                                .child(format!("×{}", c.count)),
                        ),
                )
        }))
}

/// "Riya played Airhorn", over the stage while a clip plays (`.stage-soundboard-hud`).
/// `beside`: a video plays: the banner goes under it, in the stage's bottom edge.
pub(crate) fn banner(view: &RoomView, beside: bool) -> Option<impl IntoElement> {
    let (s, at) = view.fun.banner.as_ref()?;
    let t = at.elapsed().as_secs_f32();
    let bars = (0..5).map(move |i| {
        #[allow(clippy::cast_precision_loss)]
        let h = 3.0 + 7.0 * ((t * 9.0 + i as f32 * 1.3).sin() * 0.5 + 0.5);
        div().w(px(3.)).h(px(h)).rounded(px(2.)).bg(tokens::sfx_lilac())
    });
    Some(
        div()
            .absolute()
            .bottom(px(if beside { 10. } else { 84. }))
            .right(px(if beside {
                crate::watch::REACTION_STRIP + 12.
            } else {
                28.
            }))
            .flex()
            .items_center()
            .gap(px(12.))
            .pl(px(10.))
            .pr(px(16.))
            .py(px(8.))
            .rounded_full()
            .bg(Hsla {
                a: 0.94,
                ..tokens::sfx_ground()
            })
            .border_1()
            .border_color(Hsla {
                a: 0.45,
                ..tokens::sfx_lilac()
            })
            .shadow(tokens::drop_shadow(10., 30., 0.5))
            .child(
                div()
                    .size(px(36.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(Hsla {
                        a: 0.35,
                        ..tokens::sfx_purple()
                    })
                    .border_1()
                    .border_color(Hsla {
                        a: 0.6,
                        ..tokens::sfx_lilac()
                    })
                    .text_size(px(20.))
                    .child(s.emoji.clone()),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .text_size(px(12.5))
                            .child(
                                div()
                                    .font_weight(FontWeight::EXTRA_BOLD)
                                    .text_color(tokens::text())
                                    .child(if s.from.is_none() {
                                        "You".to_owned()
                                    } else {
                                        s.name.clone()
                                    }),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .text_color(tokens::sfx_muted())
                                    .child("played"),
                            )
                            .child(
                                div()
                                    .font_weight(FontWeight::EXTRA_BOLD)
                                    .text_color(tokens::sfx_pink())
                                    .child(s.sound_name.clone()),
                            ),
                    )
                    .child(div().flex().items_end().gap(px(3.)).h(px(10.)).children(bars)),
            ),
    )
}

/// The dock's reactions popover: your set, and "Choose your reactions…".
pub(crate) fn reactions_pop(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    deferred(
        div().absolute().bottom(px(56.)).left(px(-120.)).occlude().child(
            popover()
                .id("reactions-pop")
                .flex()
                .flex_col()
                .on_mouse_down_out(cx.listener(|v, _, _, cx| {
                    v.pop = None;
                    cx.notify();
                }))
                .child(div().flex().gap(px(6.)).children(
                    view.settings.quick_reactions.iter().enumerate().map(|(i, e)| {
                        let emoji = e.clone();
                        div()
                            .id(SharedString::from(format!("dock-react-{i}")))
                            .size(px(44.))
                            .rounded(px(12.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(24.))
                            .cursor_pointer()
                            .hover(|s| s.bg(tokens::white().opacity(0.1)))
                            .on_click(cx.listener(move |v, _, _, _| v.react(&emoji)))
                            .child(e.clone())
                    }),
                ))
                .child(
                    div()
                        .id("choose-reactions")
                        .mt(px(8.))
                        .px(px(8.))
                        .py(px(10.))
                        .rounded(px(10.))
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(tokens::text_2())
                        .cursor_pointer()
                        .hover(|s| s.bg(tokens::raised()).text_color(tokens::text()))
                        .on_click(
                            cx.listener(|v, _, _, cx| v.open_dialog(crate::view::Dialog::Reactions, cx)),
                        )
                        .child("Choose your reactions…"),
                ),
        ),
    )
    .with_priority(1)
}

/// The dock's soundboard (`SoundboardTray`, floating).
pub(crate) fn sounds_pop(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let muted = view.settings.soundboard_muted;
    let volume = view.settings.soundboard_volume;
    let playing = view.fun.banner.as_ref().map(|(s, _)| s.sound_id.clone());
    let lilac = |a: f32| Hsla {
        a,
        ..tokens::sfx_purple()
    };
    let card = |i: usize, playing: bool| {
        let c = CLIPS[i];
        let color = tokens::hex(c.color);
        div()
            .id(SharedString::from(format!("sfx-{}", c.id)))
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(11.))
            .py(px(9.))
            .rounded(px(12.))
            .border_1()
            .border_color(if playing {
                tokens::sfx_pink()
            } else {
                tokens::white().opacity(0.08)
            })
            .bg(if playing {
                lilac(0.15)
            } else {
                tokens::white().opacity(0.04)
            })
            .cursor_pointer()
            .hover(|s| s.bg(tokens::white().opacity(0.08)).border_color(lilac(0.4)))
            .on_click(cx.listener(move |v, _, _, _| v.play_clip(i)))
            .child(
                div()
                    .size(px(34.))
                    .flex_none()
                    .rounded(px(9.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(Hsla { a: 0.2, ..color })
                    .border_1()
                    .border_color(Hsla { a: 0.33, ..color })
                    .text_size(px(18.))
                    .child(c.emoji),
            )
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(px(12.8))
                            .font_weight(FontWeight::BOLD)
                            .text_color(tokens::text())
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(c.name),
                    )
                    .child(
                        div()
                            .text_size(px(10.4))
                            .text_color(tokens::sfx_muted())
                            .child(c.category),
                    ),
            )
    };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let pct = (volume * 100.0).round() as u32;
    let vol_buttons = [0.0f32, 0.25, 0.5, 0.75, 1.0];
    deferred(
        div().absolute().bottom(px(56.)).left(px(-150.)).occlude().child(
            div()
                .id("sounds-pop")
                .w(px(340.))
                .flex()
                .flex_col()
                .px(px(16.))
                .py(px(14.))
                .rounded(px(18.))
                .bg(Hsla {
                    a: 0.96,
                    ..tokens::sfx_ground()
                })
                .border_1()
                .border_color(tokens::white().opacity(0.14))
                .shadow(tokens::drop_shadow(20., 48., 0.75))
                .on_mouse_down_out(cx.listener(|v, _, _, cx| {
                    v.pop = None;
                    cx.notify();
                }))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(10.))
                        .pb(px(12.))
                        .border_b_1()
                        .border_color(tokens::white().opacity(0.08))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .child(
                                    div()
                                        .size(px(32.))
                                        .rounded(px(9.))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .bg(lilac(0.3))
                                        .border_1()
                                        .border_color(lilac(0.45))
                                        .child(rtc_ui::icon(
                                            rtc_ui::Icon::Music,
                                            px(18.),
                                            tokens::sfx_pink(),
                                        )),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .child(
                                            div()
                                                .text_size(px(15.2))
                                                .font_weight(FontWeight::EXTRA_BOLD)
                                                .child("Soundboard"),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(11.5))
                                                .text_color(tokens::sfx_muted())
                                                .child("Instant SFX synchronized across room peers"),
                                        ),
                                ),
                        )
                        .child(
                            div()
                                .id("sounds-close")
                                .size(px(28.))
                                .rounded(px(8.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(tokens::white().opacity(0.06))
                                .border_1()
                                .border_color(tokens::white().opacity(0.1))
                                .text_color(tokens::sfx_muted())
                                .cursor_pointer()
                                .on_click(cx.listener(|v, _, _, cx| {
                                    v.pop = None;
                                    cx.notify();
                                }))
                                .child("✕"),
                        ),
                )
                .child(
                    div()
                        .my(px(12.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .id("sounds-mute")
                                .size(px(30.))
                                .rounded(px(8.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(if muted {
                                    tokens::danger_bg()
                                } else {
                                    tokens::white().opacity(0.06)
                                })
                                .cursor_pointer()
                                .on_click(cx.listener(|v, _, _, cx| v.toggle_soundboard_mute(cx)))
                                .child(rtc_ui::icon(
                                    if muted {
                                        rtc_ui::Icon::HeadphonesOff
                                    } else {
                                        rtc_ui::Icon::Headphones
                                    },
                                    px(16.),
                                    if muted {
                                        tokens::danger_text()
                                    } else {
                                        tokens::text_2()
                                    },
                                )),
                        )
                        .child(
                            div()
                                .flex_1()
                                .flex()
                                .gap(px(4.))
                                .children(vol_buttons.iter().map(|v| {
                                    let v = *v;
                                    let on = !muted && volume + 0.001 >= v && v > 0.0;
                                    div()
                                        .id(SharedString::from(format!("sfx-vol-{v}")))
                                        .flex_1()
                                        .h(px(8.))
                                        .rounded_full()
                                        .bg(if on {
                                            tokens::sfx_lilac()
                                        } else {
                                            tokens::white().opacity(0.1)
                                        })
                                        .cursor_pointer()
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            view.set_soundboard_volume(v, cx);
                                        }))
                                })),
                        )
                        .child(
                            div()
                                .w(px(46.))
                                .text_right()
                                .text_size(px(12.))
                                .font_weight(FontWeight::BOLD)
                                .text_color(tokens::sfx_muted())
                                .child(if muted {
                                    "Muted".to_owned()
                                } else {
                                    format!("{pct}%")
                                }),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(8.))
                        .children((0..CLIPS.len()).map(|i| {
                            let is = playing.as_deref() == Some(CLIPS[i].id);
                            div().w(px(146.)).child(card(i, is))
                        })),
                )
                .child(
                    div()
                        .mt(px(12.))
                        .text_size(px(11.5))
                        .text_color(tokens::sfx_muted())
                        .child("💡 Clicking any clip plays it instantly for all room peers."),
                ),
        ),
    )
    .with_priority(1)
}

/// "Your quick reactions" (`ReactionsEditor.tsx`).
pub(crate) fn editor(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let list = view.settings.quick_reactions.clone();
    let full = list.len() >= MAX_REACTIONS;
    let selected = view.fun.editor_slot;
    let hint = match selected {
        Some(i) => format!(
            "Pick an emoji to replace {}",
            list.get(i).cloned().unwrap_or_default()
        ),
        None if full => "All 10 used: tap one to replace it".to_owned(),
        None => format!("Tap an emoji to add it ({}/{MAX_REACTIONS})", list.len()),
    };
    let cats = crate::emoji::CATEGORIES;
    let tab = view.fun.editor_tab.min(cats.len() - 1);
    let typed_ok = !rtc_core::fun::split_emojis(&view.reaction_input.read(cx).value()).is_empty();
    let slots = list.iter().enumerate().map(|(i, e)| {
        let is = selected == Some(i);
        div()
            .relative()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(2.))
            .child(
                div()
                    .id(SharedString::from(format!("rx-slot-{i}")))
                    .size(px(46.))
                    .rounded(px(12.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(24.))
                    .bg(if is {
                        Hsla {
                            a: 0.15,
                            ..tokens::focus()
                        }
                    } else {
                        tokens::bg()
                    })
                    .border_1()
                    .border_color(if is { tokens::focus() } else { tokens::line() })
                    .cursor_pointer()
                    .on_click(cx.listener(move |v, _, _, cx| {
                        v.fun.editor_slot = if v.fun.editor_slot == Some(i) {
                            None
                        } else {
                            Some(i)
                        };
                        cx.notify();
                    }))
                    .child(e.clone()),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .font_family(tokens::FONT_MONO)
                    .text_color(tokens::text_3())
                    .child(key_for_index(i)),
            )
            .when(list.len() > 1, |el| {
                el.child(
                    div()
                        .id(SharedString::from(format!("rx-remove-{i}")))
                        .absolute()
                        .top(px(-6.))
                        .right(px(-6.))
                        .size(px(18.))
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(tokens::raised())
                        .border_1()
                        .border_color(tokens::line_strong())
                        .text_size(px(12.))
                        .text_color(tokens::text_2())
                        .cursor_pointer()
                        .on_click(cx.listener(move |v, _, _, cx| v.editor_remove(i, cx)))
                        .child("×"),
                )
            })
    });
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .p(px(20.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(px(18.))
                        .font_weight(FontWeight::BOLD)
                        .child("Your quick reactions"),
                )
                .child(
                    div()
                        .id("rx-close")
                        .size(px(32.))
                        .rounded(px(8.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_color(tokens::text_2())
                        .cursor_pointer()
                        .hover(|s| s.bg(tokens::raised()))
                        .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx)))
                        .child("✕"),
                ),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(10.))
                .children(slots)
                .when(!full, |el| {
                    el.child(
                        div()
                            .size(px(46.))
                            .rounded(px(12.))
                            .border_1()
                            .border_dashed()
                            .border_color(tokens::line_strong())
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_color(tokens::text_3())
                            .child("+"),
                    )
                }),
        )
        .child(div().text_size(px(13.)).text_color(tokens::text_2()).child(hint))
        .when_some(selected, |el, i| {
            el.child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        Button::new("rx-left", "◀ Move left")
                            .min_height(px(32.))
                            .font_size(px(13.))
                            .disabled(i == 0)
                            .on_click(cx.listener(move |v, _, _, cx| v.editor_move(i, true, cx))),
                    )
                    .child(
                        Button::new("rx-right", "Move right ▶")
                            .min_height(px(32.))
                            .font_size(px(13.))
                            .disabled(i + 1 >= list.len())
                            .on_click(cx.listener(move |v, _, _, cx| v.editor_move(i, false, cx))),
                    ),
            )
        })
        .child(crate::emoji::tabs("rx-tab", tab, cx, |v, t, _, cx| {
            v.fun.editor_tab = t;
            cx.notify();
        }))
        .child(
            div()
                .id("rx-grid")
                .max_h(px(200.))
                .overflow_y_scroll()
                .flex()
                .flex_wrap()
                .gap(px(4.))
                .children(cats[tab].emojis.iter().map(|e| {
                    let used = view.settings.quick_reactions.iter().any(|q| q == e);
                    let disabled = full && selected.is_none() && !used;
                    let emoji = (*e).to_owned();
                    div()
                        .id(SharedString::from(format!("rx-pick-{e}")))
                        .size(px(38.))
                        .rounded(px(8.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(22.))
                        .when(used, |el| {
                            el.bg(Hsla {
                                a: 0.15,
                                ..tokens::focus()
                            })
                        })
                        .when(disabled, |el| el.opacity(0.35))
                        .when(!disabled, |el| {
                            el.cursor_pointer()
                                .hover(|s| s.bg(tokens::raised()))
                                .on_click(cx.listener(move |v, _, _, cx| v.editor_put(&emoji, cx)))
                        })
                        .child(*e)
                })),
        )
        .child(
            div()
                .flex()
                .gap(px(8.))
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .px(px(10.))
                        .rounded(px(10.))
                        .border_1()
                        .border_color(tokens::line_strong())
                        .bg(tokens::bg())
                        .child(
                            gpui_kit::component::input::Input::new(&view.reaction_input).appearance(false),
                        ),
                )
                .child(
                    Button::new("rx-add", if selected.is_some() { "Replace" } else { "Add" })
                        .min_height(px(36.))
                        .disabled(!typed_ok)
                        .on_click(cx.listener(|v, _, window, cx| v.editor_add_typed(window, cx))),
                ),
        )
        .child(
            div()
                .flex()
                .justify_between()
                .pt(px(4.))
                .child(
                    Button::new("rx-reset", "Reset to default")
                        .variant(Variant::Ghost)
                        .min_height(px(36.))
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.fun.editor_slot = None;
                            v.set_reactions(&[], cx);
                        })),
                )
                .child(
                    Button::new("rx-done", "Done")
                        .variant(Variant::Primary)
                        .min_height(px(36.))
                        .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
                ),
        )
        .into_any_element()
}

/// Whether anything of ours is still moving (for tests).
#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::{Float, float_at, milestone};

    #[test]
    fn a_float_pops_in_rises_and_fades() {
        let f = Float {
            emoji: "🔥".into(),
            tag: None,
            lane: 50.0,
            born: Instant::now(),
            secs: 3.0,
            scale: 1.0,
            sway: 12.0,
            rise: 0.9,
            calm: false,
        };
        let (_, up0, s0, o0) = float_at(&f, 0.0);
        assert!(up0.abs() < 1e-6 && (s0 - 0.2).abs() < 1e-6 && o0.abs() < 1e-6);
        let (_, up, _, o) = float_at(&f, 0.5);
        assert!(up > 0.4 && up < 0.66 && o > 0.9);
        let (_, up1, _, o1) = float_at(&f, 1.0);
        assert!((up1 - 1.0).abs() < 1e-6 && o1.abs() < 1e-6);
        assert!(milestone(5) && milestone(20) && !milestone(15));
    }
}
