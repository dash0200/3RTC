//! The 5-box room code entry (`hooks/useRoomCodeInput.ts`, `.dh-code`).
//!
//! One focusable control drawn as five boxes: digits only, typing moves right, Backspace moves
//! left, arrows move, pasting a code (or a link ending in one) fills every box, Enter joins.

use gpui_kit::{
    App, AppContext as _, ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, FontWeight,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _, Pixels, Render,
    Styled as _, Window, div, prelude::FluentBuilder as _,
};

use crate::tokens;

/// Digits in a room code.
pub const CODE_LENGTH: usize = 5;

/// What the code entry reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeEvent {
    /// A digit changed.
    Changed,
    /// Enter was pressed, or the last box was just filled: join with this complete code.
    Submit(String),
}

/// The state of the five boxes.
pub struct CodeInput {
    digits: [Option<char>; CODE_LENGTH],
    cursor: usize,
    focus: FocusHandle,
    box_height: Pixels,
    font_size: Pixels,
}

impl EventEmitter<CodeEvent> for CodeInput {}

impl Focusable for CodeInput {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl CodeInput {
    /// Empty boxes.
    pub fn new(cx: &mut Context<'_, Self>) -> Self {
        Self {
            digits: [None; CODE_LENGTH],
            cursor: 0,
            focus: cx.focus_handle(),
            box_height: gpui_kit::px(48.),
            font_size: gpui_kit::px(20.),
        }
    }

    /// Box height and digit size (they follow the window size on the home screen).
    pub const fn set_metrics(&mut self, box_height: Pixels, font_size: Pixels) {
        self.box_height = box_height;
        self.font_size = font_size;
    }

    /// The digits typed so far, in order, without gaps.
    #[must_use]
    pub fn code(&self) -> String {
        self.digits.iter().flatten().collect()
    }

    /// Every box holds a digit.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.digits.iter().all(Option::is_some)
    }

    /// Clears the boxes.
    pub fn clear(&mut self, cx: &mut Context<'_, Self>) {
        self.digits = [None; CODE_LENGTH];
        self.cursor = 0;
        cx.notify();
    }

    /// Fills from pasted text: the last five digits in it (a bare code, or a link ending in one).
    fn fill(&mut self, text: &str, cx: &mut Context<'_, Self>) {
        let found: Vec<char> = text.chars().filter(char::is_ascii_digit).collect();
        if found.is_empty() {
            return;
        }
        let take = &found[found.len().saturating_sub(CODE_LENGTH)..];
        self.digits = [None; CODE_LENGTH];
        for (slot, d) in self.digits.iter_mut().zip(take) {
            *slot = Some(*d);
        }
        self.cursor = take.len().min(CODE_LENGTH - 1);
        self.changed(true, cx);
    }

    fn changed(&mut self, may_submit: bool, cx: &mut Context<'_, Self>) {
        cx.emit(CodeEvent::Changed);
        if may_submit && self.is_complete() {
            cx.emit(CodeEvent::Submit(self.code()));
        }
        cx.notify();
    }

    fn key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<'_, Self>) {
        let ks = &event.keystroke;
        let command = ks.modifiers.control || ks.modifiers.platform;
        match ks.key.as_str() {
            "v" if command => {
                if let Some(text) = cx.read_from_clipboard().and_then(|c: ClipboardItem| c.text()) {
                    self.fill(&text, cx);
                }
            }
            "backspace" => {
                if self.digits[self.cursor].is_some() {
                    self.digits[self.cursor] = None;
                } else if self.cursor > 0 {
                    self.cursor -= 1;
                    self.digits[self.cursor] = None;
                }
                self.changed(false, cx);
            }
            "left" => {
                self.cursor = self.cursor.saturating_sub(1);
                cx.notify();
            }
            "right" => {
                self.cursor = (self.cursor + 1).min(CODE_LENGTH - 1);
                cx.notify();
            }
            "enter" => {
                if self.is_complete() {
                    cx.emit(CodeEvent::Submit(self.code()));
                }
            }
            key if !command => {
                let mut chars = key.chars();
                if let (Some(c), None) = (chars.next(), chars.next())
                    && c.is_ascii_digit()
                {
                    self.digits[self.cursor] = Some(c);
                    let was_last = self.cursor == CODE_LENGTH - 1;
                    self.cursor = (self.cursor + 1).min(CODE_LENGTH - 1);
                    self.changed(was_last, cx);
                }
            }
            _ => {}
        }
        cx.stop_propagation();
    }
}

impl Render for CodeInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        div()
            .id("room-code")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key))
            .flex()
            .flex_1()
            .min_w_0()
            .gap(gpui_kit::px(6.))
            .children((0..CODE_LENGTH).map(|i| {
                let active = focused && i == self.cursor;
                div()
                    .id(("code-box", i))
                    .flex_1()
                    .h(self.box_height)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(tokens::RADIUS_INPUT)
                    .border_1()
                    .border_color(if active {
                        tokens::focus()
                    } else {
                        tokens::line_strong()
                    })
                    .bg(tokens::bg())
                    .text_color(tokens::text())
                    .font_family(tokens::FONT_MONO)
                    .font_weight(FontWeight::BOLD)
                    .text_size(self.font_size)
                    .cursor_text()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, window, cx| {
                            this.cursor = i;
                            window.focus(&this.focus, cx);
                            cx.notify();
                        }),
                    )
                    .when_some(self.digits[i], |el, d| el.child(d.to_string()))
            }))
    }
}

/// Makes the entity (a convenience for screens).
pub fn code_input(cx: &mut App) -> gpui_kit::Entity<CodeInput> {
    cx.new(CodeInput::new)
}
