//! The 3RTC desktop design system: the web app's look (`client-ts/src/index.css`,
//! `redesign.css`) as GPUI tokens and components.
//!
//! Screens use only what is here: no literal colours or sizes in screen code. Every value comes
//! from the web CSS; the comment beside each one names the rule it mirrors.

#![deny(missing_docs)]

mod assets;
pub mod avatar;
pub mod button;
pub mod code_input;
pub mod icons;
pub mod logo;
pub mod overlay;
pub mod text_field;
pub mod tokens;

pub use assets::{Assets, icon, icon_bold, logo_play};
use gpui_kit::App;
pub use icons::Icon;

/// Sets up fonts and the dark theme. Call once, right after `gpui_kit::init`.
///
/// # Errors
/// If a bundled font can't be registered.
pub fn init(cx: &mut App) -> anyhow::Result<()> {
    cx.text_system().add_fonts(assets::fonts())?;
    tokens::apply_theme(cx);
    let missing = missing_fonts(cx);
    if !missing.is_empty() {
        anyhow::bail!(
            "these bundled fonts can't be found by name: {}",
            missing.join(", ")
        );
    }
    Ok(())
}

/// The bundled font families the system can't find by name (empty when all is well). A font that
/// can't be found falls back silently, so this is checked once at startup and logged.
#[must_use]
pub fn missing_fonts(cx: &App) -> Vec<&'static str> {
    let names = cx.text_system().all_font_names();
    [
        tokens::FONT_MAIN,
        tokens::FONT_DISPLAY,
        tokens::FONT_DISPLAY_TIGHT_1,
        tokens::FONT_DISPLAY_TIGHT_2,
        tokens::FONT_DISPLAY_TIGHT_3,
        tokens::FONT_MONO,
    ]
    .into_iter()
    .filter(|family| !names.iter().any(|n| n == family))
    .collect()
}
