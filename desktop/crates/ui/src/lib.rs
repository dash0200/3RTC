//! The 3RTC desktop design system: the web app's look (`client-ts/src/index.css`,
//! `redesign.css`) as GPUI tokens and components.
//!
//! Screens use only what is here: no literal colours or sizes in screen code. Every value comes
//! from the web CSS; the comment beside each one names the rule it mirrors.

#![deny(missing_docs)]

mod assets;
pub mod button;
pub mod code_input;
pub mod logo;
pub mod text_field;
pub mod tokens;

pub use assets::{Assets, Icon, icon};
use gpui_kit::App;

/// Sets up fonts and the dark theme. Call once, right after `gpui_kit::init`.
///
/// # Errors
/// If a bundled font can't be registered.
pub fn init(cx: &mut App) -> anyhow::Result<()> {
    cx.text_system().add_fonts(assets::fonts())?;
    tokens::apply_theme(cx);
    Ok(())
}
