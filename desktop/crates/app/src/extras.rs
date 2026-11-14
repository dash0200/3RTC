//! Desktop-only extras (BUILD_SPEC §9): the in-game overlay (feature 7) and sharing one
//! program's sound (feature 8). The Windows parts live in `rtc_platform_win`.

use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _, px,
};
use rtc_core::Phase;
use rtc_platform_win::{AppSound, AudioApp, Corner, Overlay, OverlayLine};
use rtc_ui::button::{Button, Variant};
use rtc_ui::{Icon, tokens};

use crate::view::{Dialog, RoomView};

/// Program sound is sent a little under the voice.
const APP_GAIN: f32 = 0.7;

/// The overlay's corners, in the settings' order.
pub(crate) const CORNERS: [&str; 4] = ["Top left", "Top right", "Bottom left", "Bottom right"];

#[derive(Default)]
pub(crate) struct Extras {
    overlay: Option<Overlay>,
    pub(crate) share_hud: Option<rtc_platform_win::ShareHud>,
    /// Being shared: the program's name and its capture.
    pub(crate) sharing: Option<(String, AppSound)>,
    /// Programs with sound open (`None`: still looking).
    pub(crate) apps: Option<Vec<AudioApp>>,
    pub(crate) app_error: Option<String>,
}

impl RoomView {
    /// Syncs the screen sharing HUD (Teams-like floating pill excluded from capture).
    pub(crate) fn sync_share_hud(&mut self) {
        if !self.screen.mine {
            self.extras.share_hud = None;
            return;
        }

        if self.extras.share_hud.is_none() {
            let tx = self.desktop.sender();
            self.extras.share_hud = rtc_platform_win::ShareHud::start(move |act| {
                let _ = tx.send(crate::desktop::DesktopEvent::ShareHud(act));
            });
        }

        let hud_state = if let Some(controller) = &self.screen.control.controller {
            Some(rtc_platform_win::ShareHudState::Controlling {
                name: controller.clone(),
            })
        } else if let Some((peer, name)) = self.screen.control.asks.first() {
            Some(rtc_platform_win::ShareHudState::ControlRequested {
                peer: peer.as_str().to_owned(),
                name: name.clone(),
            })
        } else {
            let viewers = self
                .room
                .as_ref()
                .map_or(0, |r| r.members.iter().filter(|(_, m)| m.connected).count());
            Some(rtc_platform_win::ShareHudState::Sharing { viewers })
        };

        if let Some(hud) = &self.extras.share_hud {
            hud.update(hud_state);
        }
    }

    /// Shows who's in the call over games (on, in a room), or hides it.
    pub(crate) fn sync_overlay(&mut self) {
        let in_room = self
            .room
            .as_ref()
            .is_some_and(|r| matches!(r.phase, Phase::InRoom(_)));
        if !self.settings.overlay || !in_room {
            self.extras.overlay = None;
            return;
        }
        if self.extras.overlay.is_none() {
            self.extras.overlay = Overlay::start();
        }
        let (Some(o), Some(r)) = (&self.extras.overlay, &self.room) else {
            return;
        };
        let lines: Vec<OverlayLine> = std::iter::once(OverlayLine {
            name: format!("{} (you)", r.username),
            speaking: r.speaking && !r.muted,
            muted: r.muted,
        })
        .chain(
            r.members
                .iter()
                .filter(|(_, m)| m.connected)
                .map(|(_, m)| OverlayLine {
                    name: m.username.clone().unwrap_or_else(|| "Someone".to_owned()),
                    speaking: m.speaking && !m.muted,
                    muted: m.muted,
                }),
        )
        .collect();
        o.show(Corner::from_index(self.settings.overlay_corner), lines);
    }

    pub(crate) fn set_overlay(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.overlay = on;
        self.settings.save();
        self.sync_overlay();
        cx.notify();
    }

    fn set_overlay_corner(&mut self, corner: u8, cx: &mut Context<'_, Self>) {
        self.settings.overlay_corner = corner.min(3);
        self.settings.save();
        self.sync_overlay();
        cx.notify();
    }

    /// "Share an app's sound…": lists the programs with sound open.
    pub(crate) fn open_app_sound(&mut self, cx: &mut Context<'_, Self>) {
        self.extras.apps = None;
        self.extras.app_error = None;
        self.open_dialog(Dialog::AppSound, cx);
        let task = cx
            .background_executor()
            .spawn(async { rtc_platform_win::audio_apps() });
        cx.spawn(async move |this, cx| {
            let apps = task.await;
            let _ = this.update(cx, |v, cx| {
                v.extras.apps = Some(apps);
                cx.notify();
            });
        })
        .detach();
    }

    fn share_app(&mut self, app: &AudioApp, cx: &mut Context<'_, Self>) {
        self.stop_app_sound(cx);
        let Some(feed) = self.engine.as_ref().and_then(rtc_engine::Handle::app_feed) else {
            self.extras.app_error = Some(
                "Sharing an app's sound needs 3RTC's own audio. Turn off Classic audio in Voice settings."
                    .to_owned(),
            );
            cx.notify();
            return;
        };
        tracing::info!("app sound: sharing {} (pid {})", app.name, app.pid);
        feed.set(true, APP_GAIN);
        let push = feed.clone();
        match AppSound::start(app.pid, move |s| push.push(s)) {
            Ok(capture) => {
                self.extras.sharing = Some((app.name.clone(), capture));
                self.show_toast(format!("Everyone hears {} now", app.name), cx);
                self.close_dialog(cx);
            }
            Err(e) => {
                feed.set(false, APP_GAIN);
                self.extras.app_error = Some(format!("Couldn't share {}'s sound: {e}", app.name));
            }
        }
        cx.notify();
    }

    /// Stops sharing a program's sound (also when leaving the room).
    pub(crate) fn stop_app_sound(&mut self, cx: &mut Context<'_, Self>) {
        if self.extras.sharing.take().is_some() {
            if let Some(f) = self.engine.as_ref().and_then(rtc_engine::Handle::app_feed) {
                f.set(false, APP_GAIN);
            }
            cx.notify();
        }
    }
}

/// The "Share an app's sound" dialog.
pub(crate) fn app_sound_dialog(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let sharing = view.extras.sharing.as_ref().map(|(n, _)| n.clone());
    let rows: AnyElement = match &view.extras.apps {
        None => div()
            .py(px(20.))
            .text_color(tokens::text_3())
            .child("Looking for apps playing sound…")
            .into_any_element(),
        Some(apps) if apps.is_empty() => div()
            .py(px(20.))
            .text_size(px(14.))
            .text_color(tokens::text_3())
            .child(if cfg!(windows) {
                "No app has sound open. Start the music or game, then open this again."
            } else {
                "Sharing an app's sound works in the Windows app."
            })
            .into_any_element(),
        Some(apps) => div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .children(apps.iter().enumerate().map(|(n, a)| {
                let app = a.clone();
                let on = sharing.as_deref() == Some(a.name.as_str());
                div()
                    .id(("app-row", n))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .p(px(10.))
                    .rounded(px(12.))
                    .bg(tokens::surface())
                    .child(div().size(px(8.)).rounded_full().bg(if a.playing {
                        tokens::live()
                    } else {
                        tokens::text_3()
                    }))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(14.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(a.name.clone()),
                    )
                    .when(a.playing, |el| {
                        el.child(
                            div()
                                .text_size(px(12.))
                                .text_color(tokens::live_text())
                                .child("playing"),
                        )
                    })
                    .child(if on {
                        Button::new(("app-stop", n), "Stop")
                            .variant(Variant::Secondary)
                            .on_click(cx.listener(|v, _, _, cx| v.stop_app_sound(cx)))
                            .into_any_element()
                    } else {
                        Button::new(("app-share", n), "Share")
                            .variant(Variant::Primary)
                            .on_click(cx.listener(move |v, _, _, cx| v.share_app(&app, cx)))
                            .into_any_element()
                    })
            }))
            .into_any_element(),
    };
    div()
        .p(px(24.))
        .flex()
        .flex_col()
        .gap(px(14.))
        .child(div().text_size(px(18.)).font_weight(FontWeight::BOLD).child("Share an app's sound"))
        .child(
            div()
                .text_size(px(14.))
                .text_color(tokens::text_2())
                .child("Everyone hears just that app (a game, a music player), not the rest of your computer. It goes out with your voice, and also while you're muted."),
        )
        .children(view.extras.app_error.clone().map(|e| div().text_size(px(13.)).text_color(tokens::danger_text()).child(e)))
        .child(rows)
        .child(
            div()
                .flex()
                .justify_end()
                .gap(px(8.))
                .when(sharing.is_some(), |el| {
                    el.child(
                        Button::new("app-stop-all", "Stop sharing")
                            .variant(Variant::Secondary)
                            .icon(Icon::Close)
                            .on_click(cx.listener(|v, _, _, cx| v.stop_app_sound(cx))),
                    )
                })
                .child(
                    Button::new("app-refresh", "Refresh")
                        .variant(Variant::Secondary)
                        .on_click(cx.listener(|v, _, _, cx| v.open_app_sound(cx))),
                )
                .child(
                    Button::new("app-done", "Done")
                        .variant(Variant::Primary)
                        .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
                ),
        )
        .into_any_element()
}

/// The overlay's corner picker (in the Desktop settings, under its switch).
pub(crate) fn corner_picker(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    div()
        .pl(px(4.))
        .flex()
        .flex_wrap()
        .gap(px(6.))
        .children(CORNERS.iter().enumerate().map(|(n, name)| {
            #[allow(clippy::cast_possible_truncation)]
            let i = n as u8;
            let on = view.settings.overlay_corner == i;
            div()
                .id(("ov-corner", n))
                .h(px(30.))
                .px(px(12.))
                .flex()
                .items_center()
                .rounded_full()
                .border_1()
                .border_color(if on { tokens::text() } else { tokens::line() })
                .text_size(px(13.))
                .text_color(if on { tokens::text() } else { tokens::text_2() })
                .cursor_pointer()
                .on_click(cx.listener(move |v, _, _, cx| v.set_overlay_corner(i, cx)))
                .child(*name)
        }))
        .into_any_element()
}
