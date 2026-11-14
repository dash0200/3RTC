//! Remote control of a shared screen, on screen (desktop to desktop; the engine's
//! [`rtc_engine::ControlView`] says where things stand):
//!
//! - a viewer asks ("Request control") or takes an offer; while in control, their mouse, wheel
//!   and keys over the picture go to the sharer's computer (click the picture first so the keys
//!   come here, not to the chat box);
//! - the sharer allows or says no to each request (a card on the stage, and a Windows
//!   notification when 3RTC isn't in front), offers control from "Give control", and takes it
//!   back with "Take back control" (or, on their own computer, Ctrl+Alt+Shift+X or their mouse);
//! - a chip on the stage says who is in control.

use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, KeyDownEvent, KeyUpEvent,
    Modifiers, ModifiersChangedEvent, MouseButton, ParentElement as _, Pixels, ScrollDelta, ScrollEvent,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use rtc_engine::{ControlCmd, ControlView, InputKind, ScreenInput};
use rtc_ui::button::{Button, Variant};
use rtc_ui::tokens;

use crate::view::RoomView;

/// Pointer moves go out at most this often while in control (~125 a second).
const MOVE_GAP: Duration = Duration::from_millis(8);
/// In Game Mode, pointer deltas go out up to 250 times a second (~4ms) for smooth 360 camera aim.
const GAME_MOVE_GAP: Duration = Duration::from_millis(4);

/// A GPUI key name as a Windows virtual-key code (US layout for the punctuation).
pub(crate) fn vk_for(key: &str) -> Option<u16> {
    let k = key.to_ascii_lowercase();
    let one = |c: char| -> Option<u16> {
        Some(match c {
            'a'..='z' => c.to_ascii_uppercase() as u16,
            '0'..='9' => c as u16,
            ')' => 0x30,
            '!' => 0x31,
            '@' => 0x32,
            '#' => 0x33,
            '$' => 0x34,
            '%' => 0x35,
            '^' => 0x36,
            '&' => 0x37,
            '*' => 0x38,
            '(' => 0x39,
            ';' | ':' => 0xBA,
            '=' | '+' => 0xBB,
            ',' | '<' => 0xBC,
            '-' | '_' => 0xBD,
            '.' | '>' => 0xBE,
            '/' | '?' => 0xBF,
            '`' | '~' => 0xC0,
            '[' | '{' => 0xDB,
            '\\' | '|' => 0xDC,
            ']' | '}' => 0xDD,
            '\'' | '"' => 0xDE,
            ' ' => 0x20,
            _ => return None,
        })
    };
    let mut chars = k.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return one(c);
    }
    if let Some(n) = k.strip_prefix('f').and_then(|n| n.parse::<u16>().ok())
        && (1..=24).contains(&n)
    {
        return Some(0x6F + n);
    }
    if let Some(digit) = k
        .strip_prefix("numpad")
        .or_else(|| k.strip_prefix("kp_"))
        .and_then(|d| d.parse::<u16>().ok())
        && digit <= 9
    {
        return Some(0x60 + digit);
    }
    Some(match k.as_str() {
        "space" => 0x20,
        "enter" | "return" | "numpadenter" => 0x0D,
        "escape" => 0x1B,
        "backspace" => 0x08,
        "tab" => 0x09,
        "delete" => 0x2E,
        "insert" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "capslock" => 0x14,
        "printscreen" => 0x2C,
        "menu" | "contextmenu" => 0x5D,
        "numpadadd" | "add" => 0x6B,
        "numpadsubtract" | "subtract" => 0x6D,
        "numpadmultiply" | "multiply" => 0x6A,
        "numpaddivide" | "divide" => 0x6F,
        "numpaddecimal" | "decimal" => 0x6E,
        "numlock" => 0x90,
        "scrolllock" => 0x91,
        "pause" => 0x13,
        "back" | "browserback" => 0xA6,
        "forward" | "browserforward" => 0xA7,
        _ => return None,
    })
}

/// Modifier keys and their codes (Ctrl, Shift, Alt, Win).
fn modifier_keys(m: Modifiers) -> [(u16, bool); 4] {
    [
        (0x11, m.control),
        (0x10, m.shift),
        (0x12, m.alt),
        (0x5B, m.platform),
    ]
}

/// A wheel turn as 1/120ths of a notch (GPUI gives lines: three a notch, Shift turns it
/// sideways; we send it as turned, Shift goes along as a key).
fn wheel(e: &ScrollEvent) -> (i32, i32) {
    #[allow(clippy::cast_possible_truncation)]
    let r = |v: f32| v.round() as i32;
    match e.delta {
        ScrollDelta::Lines(p) if e.modifiers.shift && p.y == 0.0 => (0, r(p.x * 40.0)),
        ScrollDelta::Lines(p) => (r(-p.x * 40.0), r(p.y * 40.0)),
        ScrollDelta::Pixels(p) => (r(-f32::from(p.x) * 2.5), r(f32::from(p.y) * 2.5)),
    }
}

impl RoomView {
    pub(crate) fn control(&self, cmd: ControlCmd) {
        if let Some(e) = &self.engine {
            e.control(cmd);
        }
    }

    /// The engine's news about remote control.
    pub(crate) fn on_control(&mut self, c: ControlView, cx: &mut Context<'_, Self>) {
        let s = &mut self.screen;
        // a new request while 3RTC isn't in front: Windows tells the sharer (it needs an answer)
        if !self.active
            && let Some((_, name)) = c
                .asks
                .iter()
                .find(|(p, _)| !s.control.asks.iter().any(|(q, _)| q == p))
        {
            self.desktop.notify(
                &format!("{name} asks to control your screen"),
                "Open 3RTC to allow or say no.",
            );
        }
        if c.offered && !s.control.offered && !self.active {
            self.desktop.notify(
                "You're offered control of the shared screen",
                "Open 3RTC to take it.",
            );
        }
        if !c.mine {
            s.ctl_mods = Modifiers::default();
            s.ctl_keys.clear();
            if s.ctl_game_mode {
                s.ctl_game_mode = false;
                s.ctl_last_pos = None;
                s.ctl_delta = (0, 0);
                rtc_platform_win::unlock_pointer();
            } else {
                rtc_platform_win::set_cursor_visible(true);
            }
        }
        if c.viewers.is_empty() || c.controller.is_some() {
            s.ctl_menu = false;
        }
        s.control = c;
        self.sync_share_hud();
        cx.notify();
    }

    fn ctl_input(&self, i: ScreenInput) {
        self.control(ControlCmd::Input(i));
    }

    /// While in control: the pointer moved over the stage.
    pub(crate) fn ctl_move(&mut self, p: gpui_kit::Point<Pixels>) {
        let (x, y) = self.on_picture_clamped(p);
        let now = Instant::now();
        if self
            .screen
            .ctl_sent
            .is_some_and(|t| now.duration_since(t) < MOVE_GAP)
        {
            return;
        }
        self.screen.ctl_sent = Some(now);
        self.ctl_input(ScreenInput {
            e: InputKind::Move,
            x,
            y,
            ..ScreenInput::default()
        });
    }

    /// While in control and Game Mode is on: accumulate mouse delta for relative motion and
    /// re-center the cursor before it hits the window boundary.
    pub(crate) fn ctl_move_delta(&mut self, p: gpui_kit::Point<Pixels>, window: &mut Window) {
        let Some(last) = self.screen.ctl_last_pos else {
            self.screen.ctl_last_pos = Some(p);
            return;
        };

        let dx = (f32::from(p.x - last.x)).round() as i32;
        let dy = (f32::from(p.y - last.y)).round() as i32;
        self.screen.ctl_last_pos = Some(p);

        self.screen.ctl_delta.0 += dx;
        self.screen.ctl_delta.1 += dy;

        let now = Instant::now();
        if self
            .screen
            .ctl_sent
            .is_none_or(|t| now.duration_since(t) >= GAME_MOVE_GAP)
        {
            let (send_dx, send_dy) = self.screen.ctl_delta;
            if send_dx != 0 || send_dy != 0 {
                self.screen.ctl_sent = Some(now);
                self.screen.ctl_delta = (0, 0);
                self.ctl_input(ScreenInput {
                    e: InputKind::MoveDelta,
                    dx: send_dx,
                    dy: send_dy,
                    ..ScreenInput::default()
                });
            }
        }

        let size = window.viewport_size();
        let w: f32 = size.width.into();
        let h: f32 = size.height.into();
        let px_f: f32 = p.x.into();
        let py_f: f32 = p.y.into();

        if px_f < 120.0 || px_f > (w - 120.0).max(120.0) || py_f < 120.0 || py_f > (h - 120.0).max(120.0) {
            rtc_platform_win::center_cursor(window);
            self.screen.ctl_last_pos = None;
        }
    }

    /// While in control: a button went down (on the picture) or up (anywhere).
    pub(crate) fn ctl_button(
        &mut self,
        button: MouseButton,
        down: bool,
        p: gpui_kit::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let b = match button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            MouseButton::Right => 2,
            MouseButton::Navigate(_) => return,
        };
        let at = if down {
            // the keys come here from now on (not to the chat box)
            if let Some(f) = &self.screen.ctl_focus {
                window.focus(f, cx);
            }
            self.on_picture_clamped(p)
        } else {
            self.on_picture_clamped(p)
        };
        self.ctl_input(ScreenInput {
            e: InputKind::Button,
            x: at.0,
            y: at.1,
            button: b,
            down,
            ..ScreenInput::default()
        });
    }

    pub(crate) fn ctl_wheel(&mut self, e: &ScrollEvent) {
        let Some((x, y)) = self.on_picture(e.position) else {
            return;
        };
        let (dx, dy) = wheel(e);
        if dx == 0 && dy == 0 {
            return;
        }
        self.ctl_input(ScreenInput {
            e: InputKind::Wheel,
            x,
            y,
            dx,
            dy,
            ..ScreenInput::default()
        });
    }

    fn ctl_key(&mut self, vk: u16, down: bool) {
        if down {
            if !self.screen.ctl_keys.contains(&vk) {
                self.screen.ctl_keys.push(vk);
            }
        } else if let Some(i) = self.screen.ctl_keys.iter().position(|&k| k == vk) {
            self.screen.ctl_keys.remove(i);
        } else {
            return;
        }
        self.ctl_input(ScreenInput {
            e: InputKind::Key,
            vk,
            down,
            ..ScreenInput::default()
        });
    }

    pub(crate) fn ctl_key_down(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.screen.ctl_game_mode && e.keystroke.key == "escape" && e.keystroke.modifiers.shift {
            self.set_game_mode(false, window, cx);
            return;
        }
        if let Some(vk) = vk_for(&e.keystroke.key) {
            // held keys repeat as more presses (as on the sharer's own keyboard)
            self.screen.ctl_keys.retain(|&k| k != vk);
            self.ctl_key(vk, true);
        }
    }

    pub(crate) fn toggle_game_mode(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let next = !self.screen.ctl_game_mode;
        self.set_game_mode(next, window, cx);
    }

    pub(crate) fn set_game_mode(&mut self, on: bool, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.screen.ctl_game_mode == on {
            return;
        }
        self.screen.ctl_game_mode = on;
        self.screen.ctl_last_pos = None;
        self.screen.ctl_delta = (0, 0);
        if on {
            if let Some(f) = &self.screen.ctl_focus {
                window.focus(f, cx);
            }
            rtc_platform_win::lock_pointer(window);
            rtc_platform_win::center_cursor(window);
        } else {
            rtc_platform_win::unlock_pointer();
        }
        cx.notify();
    }

    pub(crate) fn ctl_key_up(&mut self, e: &KeyUpEvent) {
        if let Some(vk) = vk_for(&e.keystroke.key) {
            self.ctl_key(vk, false);
        }
    }

    pub(crate) fn ctl_modifiers(&mut self, e: &ModifiersChangedEvent) {
        let before = modifier_keys(self.screen.ctl_mods);
        for ((vk, now), (_, was)) in modifier_keys(e.modifiers).into_iter().zip(before) {
            if now != was {
                self.ctl_key(vk, now);
            }
        }
        self.screen.ctl_mods = e.modifiers;
    }
}

/// The bar's remote-control buttons: ask / waiting / game mode / stop (viewer), give / take back (sharer).
pub(crate) fn bar_button(view: &RoomView, cx: &mut Context<'_, RoomView>) -> Vec<AnyElement> {
    let c = &view.screen.control;
    if view.screen.mine {
        if c.controller.is_some() {
            return vec![
                Button::new("ctl-take-back", "Take back control")
                    .variant(Variant::Inverse)
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.control(ControlCmd::Revoke);
                        cx.notify();
                    }))
                    .into_any_element(),
            ];
        }
        if c.viewers.is_empty() {
            return Vec::new();
        }
        let open = view.screen.ctl_menu;
        return vec![
            crate::screen::bar_btn("ctl-give", "Give control", open)
                .on_click(cx.listener(|v, _, _, cx| {
                    v.screen.ctl_menu = !v.screen.ctl_menu;
                    cx.notify();
                }))
                .into_any_element(),
        ];
    }
    if c.mine {
        let game_mode = view.screen.ctl_game_mode;
        return vec![
            crate::screen::bar_btn(
                "ctl-game-mode",
                if game_mode { "Exit Game Mode" } else { "Game Mode" },
                game_mode,
            )
            .on_click(cx.listener(|v, _, window, cx| {
                v.toggle_game_mode(window, cx);
            }))
            .into_any_element(),
            crate::screen::bar_btn("ctl-ask", "Stop controlling", true)
                .on_click(cx.listener(|v, _, window, cx| {
                    if v.screen.ctl_game_mode {
                        v.set_game_mode(false, window, cx);
                    } else {
                        rtc_platform_win::set_cursor_visible(true);
                    }
                    v.control(ControlCmd::Release);
                    cx.notify();
                }))
                .into_any_element(),
        ];
    }
    let (label, on, cmd) = if c.asked {
        ("Asked… (cancel)", false, ControlCmd::Cancel)
    } else if c.can_ask && c.controller.is_none() {
        ("Request control", false, ControlCmd::Ask)
    } else {
        return Vec::new();
    };
    vec![
        crate::screen::bar_btn("ctl-ask", label, on)
            .on_click(cx.listener(move |v, _, _, cx| {
                v.control(cmd.clone());
                cx.notify();
            }))
            .into_any_element(),
    ]
}

/// "Give control": the desktop viewers, to offer control to.
pub(crate) fn give_menu(view: &RoomView, cx: &mut Context<'_, RoomView>) -> Option<AnyElement> {
    if !view.screen.ctl_menu || !view.screen.mine {
        return None;
    }
    let any_offered = view.screen.control.viewers.iter().any(|v| v.2);
    Some(
        div()
            .absolute()
            .top(px(54.))
            .right(px(12.))
            .w(px(280.))
            .p(px(6.))
            .rounded(px(12.))
            .bg(tokens::surface())
            .border_1()
            .border_color(tokens::line())
            .flex()
            .flex_col()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .px(px(10.))
                    .pt(px(8.))
                    .pb(px(4.))
                    .text_size(px(11.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(tokens::text_3())
                    .child("OFFER CONTROL TO"),
            )
            .children(view.screen.control.viewers.iter().enumerate().map(|(n, (peer, name, offered))| {
                let peer = peer.clone();
                let offered = *offered;
                div()
                    .id(("ctl-offer", n))
                    .h(px(34.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .rounded(px(8.))
                    .cursor_pointer()
                    .hover(|st| st.bg(tokens::raised()))
                    .text_size(px(13.))
                    .child(name.clone())
                    .child(
                        div()
                            .text_color(if offered { tokens::text_3() } else { tokens::live() })
                            .child(if offered { "Offered" } else { "Offer" }),
                    )
                    .on_click(cx.listener(move |v, _, _, cx| {
                        if !offered {
                            v.control(ControlCmd::Offer(peer.clone()));
                        }
                        cx.notify();
                    }))
            }))
            .when(any_offered, |el| {
                el.child(
                    div()
                        .id("ctl-withdraw")
                        .h(px(30.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .rounded(px(8.))
                        .cursor_pointer()
                        .hover(|st| st.bg(tokens::raised()))
                        .text_size(px(12.))
                        .text_color(tokens::text_2())
                        .child("Withdraw offers")
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.control(ControlCmd::Revoke);
                            cx.notify();
                        })),
                )
            })
            .child(
                div()
                    .px(px(10.))
                    .py(px(6.))
                    .text_size(px(11.))
                    .text_color(tokens::text_3())
                    .child(
                        "They can use your mouse and keyboard on what you share. Take it back any time: press \
                         Ctrl+Alt+Shift+X, or click Take back control.",
                    ),
            )
            .into_any_element(),
    )
}

/// Who is in control (a chip under the bar).
pub(crate) fn status_chip(view: &RoomView) -> Option<AnyElement> {
    let c = &view.screen.control;
    if c.mine && view.screen.ctl_game_mode {
        return None;
    }
    let who = c.controller.as_ref()?;
    let sharer = view.screen.sharer.clone().unwrap_or_default();
    let text = if view.screen.mine {
        format!(
            "{who} is controlling your screen · press Ctrl+Alt+Shift+X or click Take back control to take it back"
        )
    } else if c.mine {
        format!("You are controlling {sharer}'s screen · click the picture, then your keys go there too")
    } else {
        format!("{who} is controlling {sharer}'s screen")
    };
    Some(
        div()
            .absolute()
            .top(px(54.))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(
                div()
                    .px(px(12.))
                    .py(px(6.))
                    .rounded_full()
                    .bg(tokens::live())
                    .text_color(gpui_kit::white())
                    .text_size(px(12.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(text),
            )
            .into_any_element(),
    )
}

fn prompt_card(
    id: (&'static str, usize),
    text: String,
    note: &'static str,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .w(px(460.))
        .p(px(16.))
        .rounded(px(14.))
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .gap(px(10.))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(div().text_size(px(15.)).font_weight(FontWeight::BOLD).child(text))
        .child(div().text_size(px(12.)).text_color(tokens::text_2()).child(note))
}

/// The questions to answer: requests (sharer), an offer (viewer).
pub(crate) fn prompts(view: &RoomView, cx: &mut Context<'_, RoomView>) -> Option<AnyElement> {
    let c = &view.screen.control;
    let mut cards: Vec<AnyElement> = Vec::new();
    if view.screen.mine {
        for (n, (peer, name)) in c.asks.iter().take(3).enumerate() {
            let (allow, deny) = (peer.clone(), peer.clone());
            cards.push(
                prompt_card(
                    ("ctl-ask-card", n),
                    format!("{name} asks to control your screen"),
                    "They'll use your mouse and keyboard on what you share. Take it back any time: press Ctrl+Alt+Shift+X, or click Take back control.",
                )
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(Button::new(("ctl-allow", n), "Allow").variant(Variant::Primary).on_click(
                            cx.listener(move |v, _, _, cx| {
                                v.control(ControlCmd::Allow(allow.clone()));
                                cx.notify();
                            }),
                        ))
                        .child(Button::new(("ctl-deny", n), "Say no").variant(Variant::Secondary).on_click(
                            cx.listener(move |v, _, _, cx| {
                                v.control(ControlCmd::Deny(deny.clone()));
                                cx.notify();
                            }),
                        )),
                )
                .into_any_element(),
            );
        }
    } else if c.offered {
        let sharer = view.screen.sharer.clone().unwrap_or_default();
        cards.push(
            prompt_card(
                ("ctl-offer-card", 0),
                format!("{sharer} offers you control of their screen"),
                "Your mouse, wheel and keys over the picture will go to their computer.",
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        Button::new("ctl-accept", "Take control")
                            .variant(Variant::Primary)
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.control(ControlCmd::Accept);
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("ctl-decline", "No thanks")
                            .variant(Variant::Secondary)
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.control(ControlCmd::Decline);
                                cx.notify();
                            })),
                    ),
            )
            .into_any_element(),
        );
    }
    (!cards.is_empty()).then(|| {
        div()
            .absolute()
            .bottom(px(52.))
            .left_0()
            .right_0()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(8.))
            .children(cards)
            .into_any_element()
    })
}

#[cfg(test)]
mod tests {
    use super::vk_for;

    #[test]
    fn keys_map_to_windows_codes() {
        assert_eq!(vk_for("a"), Some(0x41));
        assert_eq!(vk_for("Z"), Some(0x5A));
        assert_eq!(vk_for("7"), Some(0x37));
        assert_eq!(vk_for("!"), Some(0x31));
        assert_eq!(vk_for("f1"), Some(0x70));
        assert_eq!(vk_for("f12"), Some(0x7B));
        assert_eq!(vk_for("enter"), Some(0x0D));
        assert_eq!(vk_for("escape"), Some(0x1B));
        assert_eq!(vk_for("left"), Some(0x25));
        assert_eq!(vk_for("/"), Some(0xBF));
        assert_eq!(vk_for("space"), Some(0x20));
        assert_eq!(vk_for("numpad0"), Some(0x60));
        assert_eq!(vk_for("numpad9"), Some(0x69));
        assert_eq!(vk_for("kp_5"), Some(0x65));
        assert_eq!(vk_for("numpadadd"), Some(0x6B));
        assert_eq!(vk_for("numpadenter"), Some(0x0D));
        assert_eq!(vk_for("pause"), Some(0x13));
        assert_eq!(vk_for("back"), Some(0xA6));
        assert_eq!(vk_for("forward"), Some(0xA7));
        assert_eq!(vk_for("shift"), None);
        assert_eq!(vk_for("f99"), None);
    }
}
