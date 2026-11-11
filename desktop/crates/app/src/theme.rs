//! The app's look: dark by default, like the web app.

use gpui_kit::App;
use gpui_kit::component::theme::{Theme, ThemeMode};

pub(crate) fn apply(cx: &mut App) {
    Theme::change(ThemeMode::Dark, None, cx);
}
