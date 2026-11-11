//! The 3RTC mark and wordmark (`components/Logo.tsx`, `.rd-logo`).

use gpui_kit::{FontWeight, IntoElement, ParentElement as _, Styled as _, div, px};

use crate::{Icon, icon, tokens};

/// The logo at `size` (the mark's side; the web default is 30).
#[must_use]
pub fn logo(size: f32) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .text_color(tokens::text())
        .child(
            div()
                .size(px(size))
                .flex_none()
                .rounded(px(size * 0.27))
                .bg(tokens::accent())
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::LogoPlay, px((size * 0.42).round()), tokens::white())),
        )
        .child(
            div()
                .font_family(tokens::FONT_DISPLAY_TIGHT_2)
                .font_weight(FontWeight::BOLD)
                .text_size(px(size * 0.68))
                .child("3RTC"),
        )
}
