//! Design tokens: `:root` in `client-ts/src/index.css` and `redesign.css`.

use gpui_kit::component::theme::{Theme, ThemeMode};
use gpui_kit::{App, Hsla, Pixels, Window, px, rgb, rgba};

/// Text font (`--font-main`).
pub const FONT_MAIN: &str = "Figtree";
/// Display font for headings and the wordmark (`--font-display`).
pub const FONT_DISPLAY: &str = "Bricolage Grotesque";
/// The display font with CSS `letter-spacing: -0.01em` built in (GPUI has no letter-spacing, so
/// the tight headings use a copy of the font with narrower advances). Bold only.
pub const FONT_DISPLAY_TIGHT_1: &str = "Bricolage Grotesque Tight10";
/// As [`FONT_DISPLAY_TIGHT_1`], for `letter-spacing: -0.02em` (the wordmark, h1).
pub const FONT_DISPLAY_TIGHT_2: &str = "Bricolage Grotesque Tight20";
/// As [`FONT_DISPLAY_TIGHT_1`], for `letter-spacing: -0.03em` (the home headline).
pub const FONT_DISPLAY_TIGHT_3: &str = "Bricolage Grotesque Tight30";
/// Monospace font for room codes and build numbers (`--font-mono`).
pub const FONT_MONO: &str = "JetBrains Mono";

macro_rules! colors {
    ($( $(#[$doc:meta])* $name:ident = $hex:literal; )*) => {
        $( $(#[$doc])* #[must_use] pub fn $name() -> Hsla { rgb($hex).into() } )*
    };
}

colors! {
    /// App ground (`--rd-bg`).
    bg = 0x0a_0a0d;
    /// Cards, inputs, sheets (`--rd-surface`).
    surface = 0x14_1419;
    /// Buttons, selected tab (`--rd-raised`).
    raised = 0x1c_1c23;
    /// Deep surface (`--rd-panel`).
    panel = 0x0e_0e12;
    /// Borders (`--rd-line`).
    line = 0x2a_2a33;
    /// Borders for inputs (`--rd-line-strong`).
    line_strong = 0x3a_3a45;
    /// Primary text (`--rd-text`).
    text = 0xf4_f4f6;
    /// Secondary text (`--rd-text-2`).
    text_2 = 0xa9_a9b5;
    /// Hints, timestamps (`--rd-text-3`).
    text_3 = 0x85_858f;
    /// The one primary action (`--rd-accent`).
    accent = 0xe5_143d;
    /// Primary hover and press (`--rd-accent-press`).
    accent_press = 0xc4_0f33;
    /// Speaking, in sync, connected (`--rd-live`).
    live = 0x36_d399;
    /// Live text on dark (`--rd-live-text`).
    live_text = 0x7b_e7bf;
    /// Weak connection, permissions (`--rd-warn`).
    warn = 0xf5_b544;
    /// Mic off, Leave, errors (`--rd-danger-text`).
    danger_text = 0xff_8a9c;
    /// Destructive background (`--rd-danger-bg`).
    danger_bg = 0x3a_1520;
    /// Destructive border (`--rd-danger-line`).
    danger_line = 0x5a_1e2a;
    /// Focus ring, links (`--rd-focus`).
    focus = 0x6a_a8ff;
    /// White, for text on the accent.
    white = 0xff_ffff;
}

/// Black at `alpha` (0–1), for shadows and scrims.
#[must_use]
pub fn black(alpha: f32) -> Hsla {
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    rgba(a).into()
}

/// Chip radius (`--radius-chip`).
pub const RADIUS_CHIP: Pixels = px(8.);
/// Input radius (`--radius-input`).
pub const RADIUS_INPUT: Pixels = px(12.);
/// Video radius (`--radius-video`).
pub const RADIUS_VIDEO: Pixels = px(16.);
/// Sheet and card radius (`--radius-sheet`).
pub const RADIUS_SHEET: Pixels = px(24.);

/// CSS `clamp(min, <percent> of the window's width, max)`.
#[must_use]
pub fn clamp_vw(window: &Window, min: f32, percent: f32, max: f32) -> Pixels {
    let w: f32 = window.viewport_size().width.into();
    px((w * percent / 100.0).clamp(min, max))
}

/// CSS `clamp(min, <percent> of the window's height, max)`.
#[must_use]
pub fn clamp_vh(window: &Window, min: f32, percent: f32, max: f32) -> Pixels {
    let h: f32 = window.viewport_size().height.into();
    px((h * percent / 100.0).clamp(min, max))
}

/// Points the component library's theme at our tokens, so its inputs and carets match.
pub(crate) fn apply_theme(cx: &mut App) {
    Theme::change(ThemeMode::Dark, None, cx);
    let theme = Theme::global_mut(cx);
    theme.background = bg();
    theme.foreground = text();
    theme.muted_foreground = text_3();
    theme.border = line();
    theme.input = line_strong();
    theme.ring = focus();
    theme.caret = text();
    theme.primary = accent();
    theme.primary_foreground = white();
    theme.font_family = FONT_MAIN.into();
}

/// A drop shadow: CSS `box-shadow: 0 <y>px <blur>px rgba(0, 0, 0, <alpha>)`.
#[must_use]
pub fn drop_shadow(y: f32, blur: f32, alpha: f32) -> Vec<gpui_kit::BoxShadow> {
    vec![gpui_kit::BoxShadow {
        color: black(alpha),
        offset: gpui_kit::point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(0.),
        inset: false,
    }]
}
