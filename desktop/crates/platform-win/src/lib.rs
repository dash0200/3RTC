//! The Windows-only parts of the desktop app (BUILD_SPEC §9, M2):
//!
//! - **Global keys** for push-to-talk and the mute and deafen hotkeys: a small thread reads the
//!   keyboard and mouse buttons' state (`GetAsyncKeyState`) about 60 times a second. Nothing is
//!   hooked or swallowed, so games and anti-cheat see an ordinary app, and the key still does
//!   whatever it does in the app in front.
//! - **The tray icon**, its menu, and notifications shown from it (Windows turns them into its
//!   own notifications and holds them back during Focus Assist / Do not disturb).
//! - **Registry** entries under the user's own key (no admin rights): start with Windows, and
//!   `3rtc://` links.
//! - Small things: hiding and showing the window, its icon, a sound, whether the app in front
//!   runs as administrator (then Windows won't let us see its keys).
//!
//! Everything here also builds on other systems as a stand-in that does nothing, so the rest of
//! the app compiles and tests anywhere. This is the only crate that may use `unsafe`; every
//! block says why it is sound.

pub mod art;
pub mod keys;

#[cfg(windows)]
mod loopback;
#[cfg(not(windows))]
mod other;
#[cfg(windows)]
mod overlay;
#[cfg(windows)]
mod ui_thread;
#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use loopback::{AppSound, audio_apps};
#[cfg(not(windows))]
pub use other::Overlay;
#[cfg(not(windows))]
pub use other::{AppSound, audio_apps};
#[cfg(not(windows))]
pub use other::{
    KeyWatcher, Tray, autostart, foreground_admin_app, hide_window, keys_down, links, play_wav,
    set_window_icon, show_window,
};
#[cfg(windows)]
pub use overlay::Overlay;
#[cfg(windows)]
pub use ui_thread::{ParentWindow, UiThread};
#[cfg(windows)]
pub use win::{
    KeyWatcher, Tray, autostart, foreground_admin_app, hide_window, keys_down, links, play_wav,
    set_window_icon, show_window,
};

/// Whether the real thing is here (Windows) or the stand-ins.
pub const SUPPORTED: bool = cfg!(windows);

/// A watched key combination went down or up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
    /// The id it was watched under.
    pub id: u32,
    /// Held (true) or let go (false).
    pub down: bool,
}

/// Something happened at the tray icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayEvent {
    /// Clicked, or a notification from it was clicked: show the window.
    Open,
    /// A menu item was picked (its id).
    Menu(u32),
}

/// One line in the tray icon's menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuItem {
    /// Something to click.
    Item {
        /// Comes back in [`TrayEvent::Menu`] (not 0).
        id: u32,
        /// What it says.
        label: String,
        /// With a tick.
        checked: bool,
        /// Shown greyed out.
        disabled: bool,
    },
    /// A dividing line.
    Separator,
}

impl MenuItem {
    /// A plain item.
    #[must_use]
    pub fn item(id: u32, label: impl Into<String>) -> Self {
        Self::Item {
            id,
            label: label.into(),
            checked: false,
            disabled: false,
        }
    }

    /// An item with a tick when `checked`.
    #[must_use]
    pub fn check(id: u32, label: impl Into<String>, checked: bool) -> Self {
        Self::Item {
            id,
            label: label.into(),
            checked,
            disabled: false,
        }
    }
}

/// A corner of the screen, for the in-game overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Corner {
    /// Top left.
    #[default]
    TopLeft,
    /// Top right.
    TopRight,
    /// Bottom left.
    BottomLeft,
    /// Bottom right.
    BottomRight,
}

impl Corner {
    /// From the settings' number (0–3).
    #[must_use]
    pub const fn from_index(i: u8) -> Self {
        match i {
            1 => Self::TopRight,
            2 => Self::BottomLeft,
            3 => Self::BottomRight,
            _ => Self::TopLeft,
        }
    }
}

/// One person in the in-game overlay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayLine {
    /// Their name.
    pub name: String,
    /// Talking now.
    pub speaking: bool,
    /// Their mic is off.
    pub muted: bool,
}

/// A program with sound open (for "Share an app's sound").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioApp {
    /// Its process id.
    pub pid: u32,
    /// Its name ("Spotify", "chrome").
    pub name: String,
    /// Playing sound right now.
    pub playing: bool,
}
