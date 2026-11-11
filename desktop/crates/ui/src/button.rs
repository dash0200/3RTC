//! Buttons (`.rd-btn` and its variants).

use gpui_kit::{
    App, ClickEvent, ElementId, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use crate::tokens;

/// Which `.rd-btn-*` look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// The one main action: accent red.
    Primary,
    /// Surface with a border.
    Secondary,
    /// White on dark ("Play for everyone").
    Inverse,
    /// Text only.
    Ghost,
    /// Leave, End: danger colours.
    Destructive,
}

type Handler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// A button.
#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    label: SharedString,
    variant: Variant,
    min_height: Pixels,
    font_size: Pixels,
    padding_x: Pixels,
    weight: Option<FontWeight>,
    disabled: bool,
    full_width: bool,
    on_click: Option<Handler>,
}

impl Button {
    /// A secondary button at the default size (44 high, 15 px text).
    #[must_use]
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            variant: Variant::Secondary,
            min_height: px(44.),
            font_size: px(15.),
            padding_x: px(20.),
            weight: None,
            disabled: false,
            full_width: false,
            on_click: None,
        }
    }

    /// Sets the look.
    #[must_use]
    pub const fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    /// `.rd-btn-lg`: 52 high, 16 px text.
    #[must_use]
    pub fn large(mut self) -> Self {
        self.min_height = px(52.);
        self.font_size = px(16.);
        self
    }

    /// Overrides the height (rules such as `.dh-card .rd-btn-primary`).
    #[must_use]
    pub const fn min_height(mut self, h: Pixels) -> Self {
        self.min_height = h;
        self
    }

    /// Overrides the text size.
    #[must_use]
    pub const fn font_size(mut self, s: Pixels) -> Self {
        self.font_size = s;
        self
    }

    /// Overrides the side padding.
    #[must_use]
    pub const fn padding_x(mut self, p: Pixels) -> Self {
        self.padding_x = p;
        self
    }

    /// Overrides the weight.
    #[must_use]
    pub const fn weight(mut self, w: FontWeight) -> Self {
        self.weight = Some(w);
        self
    }

    /// Greyed out and not clickable.
    #[must_use]
    pub const fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Stretches to the container's width.
    #[must_use]
    pub const fn full_width(mut self) -> Self {
        self.full_width = true;
        self
    }

    /// What a click does.
    #[must_use]
    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Box::new(f));
        self
    }
}

impl RenderOnce for Button {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let transparent = tokens::black(0.0);
        let (bg, border, color, weight) = match self.variant {
            Variant::Primary => (tokens::accent(), transparent, tokens::white(), FontWeight::BOLD),
            Variant::Secondary => (
                tokens::surface(),
                tokens::line_strong(),
                tokens::text(),
                FontWeight::SEMIBOLD,
            ),
            Variant::Inverse => (tokens::white(), tokens::white(), tokens::bg(), FontWeight::BOLD),
            Variant::Ghost => (transparent, transparent, tokens::text_2(), FontWeight::SEMIBOLD),
            Variant::Destructive => (
                tokens::danger_bg(),
                tokens::danger_line(),
                tokens::danger_text(),
                FontWeight::BOLD,
            ),
        };
        let mut el = div()
            .id(self.id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .min_h(self.min_height)
            .px(self.padding_x)
            .rounded(tokens::RADIUS_INPUT)
            .border_1()
            .border_color(border)
            .bg(bg)
            .text_color(color)
            .text_size(self.font_size)
            .font_weight(self.weight.unwrap_or(weight))
            .child(self.label);
        if self.full_width {
            el = el.w_full();
        }
        if self.disabled {
            return el.opacity(0.45).cursor_not_allowed();
        }
        el = el.cursor_pointer();
        el = match self.variant {
            Variant::Primary => el.hover(|s| s.bg(tokens::accent_press())),
            Variant::Secondary => el.hover(|s| s.border_color(tokens::text_3())),
            Variant::Inverse => el.hover(|s| s.bg(gpui_kit::rgb(0x00f0_f0f3))),
            Variant::Ghost => el.hover(|s| s.text_color(tokens::text())),
            Variant::Destructive => el.hover(|s| {
                s.bg(gpui_kit::rgb(0x004a_1c29))
                    .border_color(gpui_kit::rgb(0x007a_2638))
            }),
        };
        if let Some(f) = self.on_click {
            el = el.on_click(f);
        }
        el
    }
}
