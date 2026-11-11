//! A one-line text box in the web app's style (`.dh-field input`): our frame around the
//! component library's editing engine (caret, selection, clipboard, IME).

use gpui_kit::component::input::{Input, InputState};
use gpui_kit::{
    App, Entity, Focusable as _, IntoElement, ParentElement as _, Pixels, Styled as _, Window, div, px,
};

use crate::tokens;

/// The text box for `state`, `height` tall. The border turns to the focus colour while typing.
#[must_use]
pub fn text_field(state: &Entity<InputState>, height: Pixels, window: &Window, cx: &App) -> impl IntoElement {
    let focused = state.read(cx).focus_handle(cx).is_focused(window);
    div()
        .h(height)
        .w_full()
        .flex()
        .items_center()
        .px(px(4.))
        .rounded(tokens::RADIUS_INPUT)
        .border_1()
        .border_color(if focused {
            tokens::focus()
        } else {
            tokens::line_strong()
        })
        .bg(tokens::bg())
        .text_color(tokens::text())
        .text_size(px(16.))
        .child(Input::new(state).appearance(false))
}
