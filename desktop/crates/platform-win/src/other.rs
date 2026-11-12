//! Stand-ins for systems other than Windows: nothing happens, nothing fails. They let the rest of
//! the app build and run its tests on Linux.

use raw_window_handle::HasWindowHandle;

use crate::keys::{Binding, Key};
use crate::{KeyEvent, MenuItem, TrayEvent};

/// Watches key combinations (does nothing here).
#[derive(Debug, Default)]
pub struct KeyWatcher;

impl KeyWatcher {
    /// Starts watching (nothing to watch here).
    pub fn start(_on_event: impl Fn(KeyEvent) + Send + 'static) -> Self {
        Self
    }

    /// The combinations to watch, by id.
    pub fn watch(&self, _bindings: Vec<(u32, Binding)>) {}
}

/// Keys and mouse buttons held right now (none here).
#[must_use]
pub fn keys_down() -> Vec<Key> {
    Vec::new()
}

/// The program in front, if it runs as administrator while we don't (never here).
#[must_use]
pub fn foreground_admin_app() -> Option<String> {
    None
}

/// Plays a WAV file (silently here).
pub fn play_wav(_wav: &'static [u8]) {}

/// Hides the window (not here).
pub fn hide_window(_window: &impl HasWindowHandle) {}

/// Shows the window and brings it to the front (not here).
pub fn show_window(_window: &impl HasWindowHandle) {}

/// Gives the window the 3RTC icon (not here).
pub fn set_window_icon(_window: &impl HasWindowHandle) {}

/// The tray icon (there is none here).
#[derive(Debug)]
pub struct Tray;

impl Tray {
    /// No tray here: always `None`.
    pub fn start(
        _tooltip: &str,
        _menu: Vec<MenuItem>,
        _on_event: impl Fn(TrayEvent) + Send + 'static,
    ) -> Option<Self> {
        None
    }

    /// Replaces the menu.
    pub fn set_menu(&self, _menu: Vec<MenuItem>) {}

    /// Changes the text shown on hover.
    pub fn set_tooltip(&self, _tooltip: &str) {}

    /// Shows a notification.
    pub fn notify(&self, _title: &str, _body: &str) {}
}

/// Starting with Windows (never here).
pub mod autostart {
    /// Whether the app starts with Windows.
    #[must_use]
    pub fn enabled() -> bool {
        false
    }

    /// Turns starting with Windows on (running `command`) or off.
    ///
    /// # Errors
    /// Always: there is no such thing here.
    pub fn set(_on: bool, _command: &str) -> std::io::Result<()> {
        Err(std::io::Error::other("only on Windows"))
    }
}

/// `3rtc://` links (never here).
pub mod links {
    /// Makes `3rtc://` links open `command` (`%1` is the link).
    ///
    /// # Errors
    /// Always: there is no such thing here.
    pub fn register(_command: &str) -> std::io::Result<()> {
        Err(std::io::Error::other("only on Windows"))
    }

    /// The command `3rtc://` links open now, if any.
    #[must_use]
    pub fn registered_command() -> Option<String> {
        None
    }
}
