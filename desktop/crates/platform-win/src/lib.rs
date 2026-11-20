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
//! - **Remote control** of a shared screen: the viewer's input played back with `SendInput`,
//!   a banner, and the sharer taking control back (a hotkey, their own mouse).
//! - **The webcam** (ADR 0010): the cameras on the computer, and reading one as NV12 pictures
//!   through Media Foundation.
//! - Small things: hiding and showing the window, its icon, a sound, whether the app in front
//!   runs as administrator (then Windows won't let us see its keys).
//!
//! Everything here also builds on other systems as a stand-in that does nothing, so the rest of
//! the app compiles and tests anywhere. This is the only crate that may use `unsafe`; every
//! block says why it is sound.

pub mod art;
mod camera_types;
pub mod keys;

#[cfg(windows)]
mod camera;

#[cfg(windows)]
mod control;
#[cfg(windows)]
mod gpu;
#[cfg(windows)]
mod hwenc;

#[cfg(windows)]
mod loopback;
#[cfg(windows)]
mod mpv;
#[cfg(not(windows))]
mod other;
#[cfg(windows)]
mod overlay;
#[cfg(windows)]
mod share_hud;
#[cfg(windows)]
mod ui_thread;
mod video;
#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use camera::{Camera, cameras};
pub use camera_types::{
    CameraError, CameraEvent, CameraEvents, CameraFrame, CameraFrames, CameraInfo, CameraWant, best_mode,
};
#[cfg(windows)]
pub use control::RemoteControl;
#[cfg(windows)]
pub use gpu::{gpu_choice, gpus, set_gpu_choice};
#[cfg(windows)]
pub use hwenc::H264Encoder;
#[cfg(windows)]
pub use loopback::{AppSound, audio_apps, child_processes};
#[cfg(windows)]
pub use mpv::VideoPlayer;
#[cfg(not(windows))]
pub use other::Overlay;
#[cfg(not(windows))]
pub use other::RemoteControl;
#[cfg(not(windows))]
pub use other::ShareHud;
#[cfg(not(windows))]
pub use other::{AppSound, audio_apps, child_processes};
#[cfg(not(windows))]
pub use other::{Camera, cameras};
#[cfg(not(windows))]
pub use other::{H264Encoder, ParentWindow, VideoPlayer};
#[cfg(not(windows))]
pub use other::{
    KeyWatcher, Tray, autostart, center_cursor, cursor_in_bottom_hwnd, cursor_window_state, double_click_ms,
    foreground_admin_app, hide_window, keys_down, links, lock_pointer, memory_mb, play_wav, raw_hwnd,
    set_cursor_visible, set_window_icon, show_window, take_keyboard_focus, unlock_pointer,
};
#[cfg(not(windows))]
pub use other::{gpu_choice, gpus, set_gpu_choice};
#[cfg(windows)]
pub use overlay::Overlay;
#[cfg(windows)]
pub use share_hud::ShareHud;
#[cfg(windows)]
pub use ui_thread::{ParentWindow, UiThread};
pub use video::{EncodedUnit, Rect, StreamSource, Track, TrackKind, VideoAction, VideoEvent, VideoSource};
#[cfg(windows)]
pub use win::{
    KeyWatcher, Tray, autostart, center_cursor, cursor_in_bottom_hwnd, cursor_window_state, double_click_ms,
    foreground_admin_app, hide_window, keys_down, links, lock_pointer, memory_mb, play_wav, raw_hwnd,
    set_cursor_visible, set_window_icon, show_window, take_keyboard_focus, unlock_pointer,
};

/// Which Windows this is, for the log file: "Windows 11 Home 24H2 (build 26100.2314)". Read from
/// the registry; `None` when it can't be (and on other systems).
#[must_use]
pub fn windows_version() -> Option<String> {
    #[cfg(windows)]
    {
        let key = windows_registry::LOCAL_MACHINE
            .open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
            .ok()?;
        let build = key.get_string("CurrentBuildNumber").ok()?;
        let mut name = key
            .get_string("ProductName")
            .unwrap_or_else(|_| "Windows".to_owned());
        // Windows 11 still calls itself "Windows 10" here; its builds start at 22000
        if build.parse::<u32>().is_ok_and(|b| b >= 22_000) {
            name = name.replace("Windows 10", "Windows 11");
        }
        let release = key.get_string("DisplayVersion").unwrap_or_default();
        let patch = key.get_u32("UBR").map(|u| format!(".{u}")).unwrap_or_default();
        Some(format!("{name} {release} (build {build}{patch})").replace("  ", " "))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// The graphics card the app asks Windows for (it applies from the next start).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GpuChoice {
    /// Windows decides.
    #[default]
    Auto,
    /// The card that uses the least power (usually the one in the processor).
    PowerSaving,
    /// The fastest card (usually the separate one).
    HighPerformance,
}

/// The cards Windows would pick for each choice (their names; `None`: couldn't tell).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Gpus {
    /// For "Power saving".
    pub power_saving: Option<String>,
    /// For "High performance".
    pub high_performance: Option<String>,
}

/// What a viewer given remote control acts on: the shared screen or window, by the screen
/// capturer's id for it (`u64::MAX`: the whole desktop).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlArea {
    /// A whole screen.
    Screen(u64),
    /// One window (its handle).
    Window(u64),
}

/// A mouse button, for remote control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseKey {
    /// The left (main) button.
    Left,
    /// The wheel's button.
    Middle,
    /// The right button.
    Right,
}

/// One of the controlling viewer's events, to play back (`x`, `y` 0–1 over the area).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Injection {
    /// The pointer moves there.
    Move {
        /// Across.
        x: f64,
        /// Down.
        y: f64,
    },
    /// The pointer moves relatively by (dx, dy) pixels (e.g. for gaming camera look).
    MoveDelta {
        /// Across pixels.
        dx: i32,
        /// Down pixels.
        dy: i32,
    },
    /// A button goes down or up there.
    Button {
        /// Which.
        button: MouseKey,
        /// Pressed (else let go).
        down: bool,
        /// Across.
        x: f64,
        /// Down.
        y: f64,
    },
    /// The wheel turns there (1/120ths of a notch; up and right positive).
    Wheel {
        /// Across.
        x: f64,
        /// Down.
        y: f64,
        /// Sideways.
        dx: i32,
        /// Up and down.
        dy: i32,
    },
    /// A key (Windows virtual-key code) goes down or up.
    Key {
        /// The key.
        vk: u16,
        /// Pressed (else let go).
        down: bool,
    },
}

/// Why the sharer took control back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TakeBack {
    /// Ctrl+Alt+Shift+X.
    Hotkey,
    /// They used their own mouse.
    Mouse,
}

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

/// What the screen sharing HUD can display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShareHudState {
    /// Screen is being shared to `viewers` count.
    Sharing {
        /// Number of viewers watching.
        viewers: usize,
    },
    /// A peer requested remote control.
    ControlRequested {
        /// Peer ID.
        peer: String,
        /// Peer display name.
        name: String,
    },
    /// A peer currently controls the screen.
    Controlling {
        /// Controller display name.
        name: String,
    },
}

/// An action triggered by user clicking the screen sharing HUD buttons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShareHudAction {
    /// Stop screen sharing.
    StopSharing,
    /// Allow the peer to control.
    AllowControl(String),
    /// Deny the peer's control request.
    DenyControl(String),
    /// Sharer takes back control.
    TakeBackControl,
}
