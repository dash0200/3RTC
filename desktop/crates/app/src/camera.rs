//! Cameras on screen (`features/camera/CameraTiles.tsx`, `CameraStage.tsx`; ADR 0010): the dock's
//! camera button (its caret opens the camera picker, a dock tray in `room.rs`), the row of tiles above the dock (ours mirrored, named "You"),
//! and one camera on the stage, for us only, when its tile is clicked.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::{
    AnyElement, Context, FontWeight, ImageSource, InteractiveElement as _, IntoElement, ObjectFit,
    ParentElement as _, RenderImage, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Task, div, img, prelude::FluentBuilder as _, px,
};
use rtc_engine::{CameraChoice, CameraInfo, CameraView, ScreenFeed, Snapshot};
use rtc_ui::{Icon, icon, icon_bold, tokens};

use crate::view::{Pop, RoomView};

/// Our own camera's key (the others' are their peer ids).
pub(crate) const SELF_KEY: &str = "me";
/// A tile: 176 wide, 16:9 (`.camera-tile`).
const TILE_W: f32 = 176.;
const TILE_H: f32 = 99.;
/// Remote tiles arrive at about this many physical pixels across (enough for 200% scaling).
const TILE_TARGET: (u32, u32) = (400, 225);

/// The cameras as the UI has them.
#[derive(Default)]
pub(crate) struct CameraUi {
    /// What the engine says (ours, and everyone's that's on).
    pub(crate) view: CameraView,
    /// The latest picture of each camera (`SELF_KEY` or a peer id), and its number.
    images: HashMap<String, (u64, Arc<RenderImage>)>,
    /// The camera on the stage, for us only.
    pub(crate) spotlight: Option<String>,
    /// The tiles were hidden at this many cameras (one more turning on brings them back).
    pub(crate) hidden_at: Option<usize>,
    /// The cameras on this PC (for the picker).
    pub(crate) devices: Vec<CameraInfo>,
    pump: Option<Task<()>>,
}

impl CameraUi {
    /// How many cameras are showing (ours included).
    pub(crate) fn count(&self) -> usize {
        self.view.remote.len() + usize::from(self.view.mine.is_some())
    }

    fn feed(&self, key: &str) -> Option<&ScreenFeed> {
        if key == SELF_KEY {
            self.view.mine.as_ref()
        } else {
            self.view
                .remote
                .iter()
                .find(|(p, _)| p.as_str() == key)
                .map(|(_, f)| f)
        }
    }

    /// The camera on the stage, while it's still there.
    pub(crate) fn on_stage(&self) -> Option<&str> {
        self.spotlight.as_deref().filter(|k| self.feed(k).is_some())
    }
}

/// What a click on a tile does: that camera on the stage, or off it if it's there already.
pub(crate) fn next_spotlight(current: Option<&str>, clicked: &str) -> Option<String> {
    (current != Some(clicked)).then(|| clicked.to_owned())
}

impl RoomView {
    /// The engine says what cameras there are.
    pub(crate) fn on_cameras(&mut self, view: CameraView, cx: &mut Context<'_, Self>) {
        let c = &mut self.camera;
        for (_, feed) in &view.remote {
            feed.set_target(TILE_TARGET.0, TILE_TARGET.1);
        }
        c.view = view;
        // pictures of cameras that went are let go
        let keys: Vec<String> = c.images.keys().cloned().collect();
        for k in keys {
            if c.feed(&k).is_none()
                && let Some((_, old)) = c.images.remove(&k)
            {
                cx.drop_image(old, None);
            }
        }
        if c.spotlight.as_deref().is_some_and(|k| c.feed(k).is_none()) {
            c.spotlight = None;
        }
        if c.count() == 0 {
            c.pump = None;
            c.hidden_at = None;
        } else if c.pump.is_none() {
            // pictures to the screen ~30 times a second while any camera shows
            c.pump = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(33)).await;
                    let Ok(()) = this.update(cx, RoomView::camera_tick) else {
                        break;
                    };
                }
            }));
        }
        self.sync_spotlight_target();
        cx.notify();
    }

    /// The camera on the stage comes at its full size; the others at tile size.
    fn sync_spotlight_target(&self) {
        let on = self.camera.on_stage();
        for (p, feed) in &self.camera.view.remote {
            if on == Some(p.as_str()) {
                feed.set_target(0, 0);
            } else {
                feed.set_target(TILE_TARGET.0, TILE_TARGET.1);
            }
        }
    }

    fn camera_tick(&mut self, cx: &mut Context<'_, Self>) {
        let mut changed = false;
        let keys: Vec<(String, ScreenFeed)> = self
            .camera
            .view
            .mine
            .iter()
            .map(|f| (SELF_KEY.to_owned(), f.clone()))
            .chain(
                self.camera
                    .view
                    .remote
                    .iter()
                    .map(|(p, f)| (p.as_str().to_owned(), f.clone())),
            )
            .collect();
        for (key, feed) in keys {
            let (n, frame) = feed.latest();
            if self.camera.images.get(&key).is_some_and(|(seen, _)| *seen == n) {
                continue;
            }
            if let Some(f) = frame
                && let Some(buf) = image::RgbaImage::from_raw(f.width, f.height, f.bgra.clone())
            {
                let new = Arc::new(RenderImage::new(vec![image::Frame::new(buf)]));
                if let Some((_, old)) = self.camera.images.insert(key, (n, new)) {
                    cx.drop_image(old, None);
                }
                changed = true;
            }
        }
        if changed {
            cx.notify();
        }
    }

    /// The dock's camera button: on (the chosen camera) or off.
    pub(crate) fn camera_button(&mut self, cx: &mut Context<'_, Self>) {
        let Some(e) = &self.engine else { return };
        if self.camera.view.on || self.camera.view.starting {
            e.camera(None);
        } else {
            e.camera(Some(CameraChoice::Device(self.settings.camera_device.clone())));
        }
        cx.notify();
    }

    /// Opens or closes the camera picker (and reads the cameras again).
    pub(crate) fn camera_picker(&mut self, cx: &mut Context<'_, Self>) {
        if self.pop != Some(Pop::Camera)
            && let Some(e) = &self.engine
        {
            e.list_cameras();
        }
        self.toggle_pop(Pop::Camera, cx);
    }

    /// The cameras on this PC arrived.
    pub(crate) fn on_camera_devices(&mut self, list: Vec<CameraInfo>) {
        self.camera.devices = list;
    }

    /// Picks a camera (`""`: the default); while ours is on, it switches to it.
    pub(crate) fn choose_camera(&mut self, id: String, cx: &mut Context<'_, Self>) {
        self.pop = None;
        if self.settings.camera_device != id {
            self.settings.camera_device.clone_from(&id);
            self.settings.save();
            if self.camera.view.on
                && let Some(e) = &self.engine
            {
                e.camera(Some(CameraChoice::Device(id)));
            }
        }
        cx.notify();
    }

    /// A tile was clicked: that camera on the stage (or off it).
    pub(crate) fn camera_spotlight(&mut self, key: &str, cx: &mut Context<'_, Self>) {
        self.camera.spotlight = next_spotlight(self.camera.on_stage(), key);
        self.sync_spotlight_target();
        cx.notify();
    }

    /// "Back to the stage" (or Esc).
    pub(crate) fn camera_stage_close(&mut self, cx: &mut Context<'_, Self>) {
        self.camera.spotlight = None;
        self.sync_spotlight_target();
        cx.notify();
    }
}

/// Someone's name on their tile (who the connection says they are).
fn name_of(room: &Snapshot, key: &str) -> String {
    if key == SELF_KEY {
        return "You".to_owned();
    }
    room.members
        .iter()
        .find(|(p, _)| p.as_str() == key)
        .and_then(|(_, m)| m.username.clone())
        .unwrap_or_else(|| "Someone".to_owned())
}

/// The dock's camera button with its picker caret (`.dock-cam`).
pub(crate) fn dock_button(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let on = view.camera.view.on;
    let starting = view.camera.view.starting;
    let label = if starting {
        "Starting camera…"
    } else if on {
        "Turn camera off"
    } else {
        "Turn camera on"
    };
    div()
        .relative()
        .flex()
        .flex_none()
        .rounded(px(13.))
        .bg(if on {
            tokens::hex(0x0026_2630)
        } else {
            tokens::raised()
        })
        .child(
            div()
                .id("camera")
                .w(px(46.))
                .h(px(46.))
                .flex()
                .items_center()
                .justify_center()
                .rounded_l(px(13.))
                .when(!starting, |el| {
                    el.cursor_pointer()
                        .hover(|s| s.bg(tokens::white().opacity(0.05)))
                        .on_click(cx.listener(|v, _, _, cx| v.camera_button(cx)))
                })
                .when(starting, |el| el.opacity(0.7))
                .tooltip(move |window, cx| {
                    gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx)
                })
                .child(icon(
                    if on { Icon::Camera } else { Icon::CameraOff },
                    px(20.),
                    tokens::text(),
                )),
        )
        .child(
            div()
                .id("camera-caret")
                .w(px(32.))
                .h(px(46.))
                .flex()
                .items_center()
                .justify_center()
                .border_l_1()
                .border_color(tokens::line())
                .rounded_r(px(13.))
                .cursor_pointer()
                .hover(|s| s.bg(tokens::white().opacity(0.05)))
                .on_click(cx.listener(|v, _, _, cx| v.camera_picker(cx)))
                .child(icon_bold(Icon::ChevronUp, px(14.), tokens::text_2())),
        )
        .into_any_element()
}

/// The row of tiles just above the dock (`.camera-tiles--desktop`), or "Show cameras (n)".
pub(crate) fn tiles(view: &RoomView, room: &Snapshot, cx: &mut Context<'_, RoomView>) -> Option<AnyElement> {
    let c = &view.camera;
    let count = c.count();
    if count == 0 {
        return None;
    }
    if c.hidden_at.is_some_and(|at| count <= at) {
        return Some(
            div()
                .flex_none()
                .flex()
                .justify_end()
                .px(px(20.))
                .py(px(6.))
                .child(
                    div()
                        .id("camera-tiles-show")
                        .px(px(12.))
                        .py(px(6.))
                        .rounded_full()
                        .border_1()
                        .border_color(tokens::line_strong())
                        .bg(tokens::surface())
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .cursor_pointer()
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.camera.hidden_at = None;
                            cx.notify();
                        }))
                        .child(format!("Show cameras ({count})")),
                )
                .into_any_element(),
        );
    }
    let mut keys: Vec<String> = c.view.remote.iter().map(|(p, _)| p.as_str().to_owned()).collect();
    if c.view.mine.is_some() {
        keys.push(SELF_KEY.to_owned());
    }
    let on_stage = c.on_stage().map(str::to_owned);
    Some(
        div()
            .flex_none()
            .flex()
            .justify_end()
            .items_end()
            .gap(px(8.))
            .px(px(20.))
            .py(px(8.))
            .bg(tokens::panel())
            .border_t_1()
            .border_color(tokens::raised())
            .children(keys.into_iter().map(|key| {
                let name = name_of(room, &key);
                let lit = on_stage.as_deref() == Some(key.as_str());
                let picture = c.images.get(&key).map(|(_, i)| Arc::clone(i));
                let k = key.clone();
                div()
                    .id(SharedString::from(format!("camera-tile-{key}")))
                    .relative()
                    .flex_none()
                    .w(px(TILE_W))
                    .h(px(TILE_H))
                    .rounded(px(10.))
                    .overflow_hidden()
                    .border_1()
                    .border_color(if lit {
                        tokens::accent()
                    } else {
                        tokens::line_strong()
                    })
                    .bg(tokens::black(1.0))
                    .cursor_pointer()
                    .on_click(cx.listener(move |v, _, _, cx| v.camera_spotlight(&k, cx)))
                    .when_some(picture, |el, p| {
                        el.child(
                            img(ImageSource::from(p))
                                .absolute()
                                .size_full()
                                .object_fit(ObjectFit::Cover),
                        )
                    })
                    .child(name_chip(name, px(11.)))
            }))
            .child(
                div()
                    .id("camera-tiles-hide")
                    .flex_none()
                    .size(px(26.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(tokens::line())
                    .bg(tokens::surface())
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(12.))
                    .text_color(tokens::text_2())
                    .cursor_pointer()
                    .hover(|s| s.text_color(tokens::text()).border_color(tokens::line_strong()))
                    .on_click(cx.listener(move |v, _, _, cx| {
                        v.camera.hidden_at = Some(count);
                        cx.notify();
                    }))
                    .child("✕"),
            )
            .into_any_element(),
    )
}

fn name_chip(name: String, size: gpui_kit::Pixels) -> impl IntoElement {
    div()
        .absolute()
        .left(px(6.))
        .bottom(px(6.))
        .max_w(px(160.))
        .px(px(7.))
        .py(px(2.))
        .rounded(px(6.))
        .bg(tokens::black(0.6))
        .text_color(tokens::white())
        .text_size(size)
        .font_weight(FontWeight::SEMIBOLD)
        .overflow_hidden()
        .text_ellipsis()
        .whitespace_nowrap()
        .child(name)
}

/// One camera filling the stage, for us only (`CameraStage.tsx`), or `None` when none is chosen.
pub(crate) fn stage(view: &RoomView, room: &Snapshot, cx: &mut Context<'_, RoomView>) -> Option<AnyElement> {
    let key = view.camera.on_stage()?.to_owned();
    let picture = view.camera.images.get(&key).map(|(_, i)| Arc::clone(i));
    let name = name_of(room, &key);
    Some(
        div()
            .id("stage-camera")
            .relative()
            .flex_1()
            .min_h_0()
            .bg(tokens::black(1.0))
            .map(|el| match picture {
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
                        .child("Waiting for the picture…"),
                ),
            })
            .child(
                div()
                    .absolute()
                    .left(px(16.))
                    .bottom(px(16.))
                    .px(px(10.))
                    .py(px(4.))
                    .rounded(px(8.))
                    .bg(tokens::black(0.6))
                    .text_color(tokens::white())
                    .text_size(px(14.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(name),
            )
            .child(
                div()
                    .id("camera-stage-close")
                    .absolute()
                    .top(px(16.))
                    .right(px(16.))
                    .px(px(12.))
                    .py(px(6.))
                    .rounded_full()
                    .border_1()
                    .border_color(tokens::line_strong())
                    .bg(tokens::surface().opacity(0.85))
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .cursor_pointer()
                    .hover(|s| s.border_color(tokens::text_3()))
                    .on_click(cx.listener(|v, _, _, cx| v.camera_stage_close(cx)))
                    .child("✕ Back to the stage"),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_shows_a_camera_and_a_second_click_takes_it_off() {
        assert_eq!(next_spotlight(None, "p1").as_deref(), Some("p1"));
        assert_eq!(next_spotlight(Some("p1"), "p1"), None);
        assert_eq!(next_spotlight(Some("p1"), SELF_KEY).as_deref(), Some(SELF_KEY));
    }
}
