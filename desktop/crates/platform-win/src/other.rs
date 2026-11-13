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

    /// Stops `3rtc://` links opening this app (nothing to stop here).
    ///
    /// # Errors
    /// Never.
    pub fn unregister() -> std::io::Result<()> {
        Ok(())
    }
}

/// The in-game overlay (there is none here).
#[derive(Debug)]
pub struct Overlay;

impl Overlay {
    /// No overlay here: always `None`.
    #[must_use]
    pub const fn start() -> Option<Self> {
        None
    }

    /// Shows people in a corner (nothing here).
    pub fn show(&self, _corner: crate::Corner, _lines: Vec<crate::OverlayLine>) {}
}

/// Programs with sound open (none here).
#[must_use]
pub fn audio_apps() -> Vec<crate::AudioApp> {
    Vec::new()
}

/// One program's sound (not available here).
#[derive(Debug)]
pub struct AppSound {
    stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl Drop for AppSound {
    fn drop(&mut self) {
        if let Some(s) = &self.stop {
            s.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

impl AppSound {
    /// Not available here.
    ///
    /// # Errors
    /// Always: per-app sound needs Windows.
    pub fn start(_pid: u32, _on_samples: impl FnMut(&[f32]) + Send + 'static) -> Result<Self, String> {
        Err("sharing an app's sound needs Windows".to_owned())
    }

    /// Not available here, except for tests: with `RTC_TEST_SCREEN_SOUND=tone`, a stereo tone
    /// (440 Hz left at 0.3, 660 Hz right at 0.1) in 10 ms pieces, until dropped.
    ///
    /// # Errors
    /// Without the test tone: the computer's sound needs Windows.
    pub fn everything_but_us(mut on_samples: impl FnMut(&[f32]) + Send + 'static) -> Result<Self, String> {
        if std::env::var("RTC_TEST_SCREEN_SOUND").as_deref() != Ok("tone") {
            return Err("sharing the computer's sound needs Windows".to_owned());
        }
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut n = 0u64;
            let mut piece = vec![0.0f32; 960];
            let start = std::time::Instant::now();
            while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                for i in 0..480 {
                    #[allow(clippy::cast_precision_loss)]
                    let t = (n + i) as f32 / 48_000.0;
                    piece[i as usize * 2] = 0.3 * (std::f32::consts::TAU * 440.0 * t).sin();
                    piece[i as usize * 2 + 1] = 0.1 * (std::f32::consts::TAU * 660.0 * t).sin();
                }
                n += 480;
                on_samples(&piece);
                // keep to real time
                let due = std::time::Duration::from_millis(n / 48);
                if let Some(wait) = due.checked_sub(start.elapsed()) {
                    std::thread::sleep(wait);
                }
            }
        });
        Ok(Self { stop: Some(stop) })
    }
}

/// A window to put a player in (none here).
#[derive(Debug, Clone, Copy)]
pub struct ParentWindow;

impl ParentWindow {
    /// No windows here: always `None`.
    #[must_use]
    pub const fn of(_window: &impl raw_window_handle::HasWindowHandle) -> Option<Self> {
        None
    }
}

/// The local video player (it needs Windows).
#[derive(Debug)]
pub struct VideoPlayer;

#[allow(clippy::unused_self, missing_docs)]
impl VideoPlayer {
    /// Not available here.
    ///
    /// # Errors
    /// Always: the player needs Windows.
    pub fn open(
        _parent: ParentWindow,
        _rect: crate::Rect,
        _visible: bool,
        _source: crate::VideoSource,
        _start: f64,
        _playing: bool,
        _on_event: impl Fn(crate::VideoEvent) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        Err("the video player needs Windows".to_owned())
    }
    pub const fn set_rect(&self, _rect: crate::Rect) {}
    pub const fn set_visible(&self, _visible: bool) {}
    pub const fn play(&self, _at: Option<f64>) {}
    pub const fn pause(&self, _at: Option<f64>) {}
    pub const fn seek(&self, _secs: f64) {}
    pub const fn toggle_pause(&self) {}
    pub const fn set_volume(&self, _volume: f64) {}
    pub const fn set_mute(&self, _muted: bool) {}
    pub const fn set_subtitle(&self, _id: Option<i64>) {}
    pub const fn set_audio(&self, _id: i64) {}
    pub fn add_subtitle(&self, _path: &std::path::Path) {}
    pub const fn set_subtitle_delay(&self, _secs: f64) {}
    pub const fn set_subtitle_scale(&self, _scale: f64) {}
    pub const fn set_speed(&self, _speed: f64) {}
}

/// The GPU's H.264 encoder: Windows only (Media Foundation); elsewhere it never opens.
#[derive(Debug)]
pub struct H264Encoder;

impl H264Encoder {
    /// Never opens off Windows.
    ///
    /// # Errors
    /// Always.
    pub fn new(_width: u32, _height: u32, _fps: u32, _bitrate: u32) -> Result<Self, String> {
        Err("hardware encoding is Windows only".to_owned())
    }

    /// Which encoder.
    #[must_use]
    pub const fn name(&self) -> &str {
        ""
    }

    /// Frame size.
    #[must_use]
    pub const fn size(&self) -> (u32, u32) {
        (0, 0)
    }

    /// A new target rate.
    pub const fn set_bitrate(&mut self, _bps: u32) {}

    /// Hands one NV12 frame to the encoder.
    ///
    /// # Errors
    /// Always.
    pub fn submit(&mut self, _nv12: &[u8], _timestamp_us: i64, _keyframe: bool) -> Result<bool, String> {
        Err("hardware encoding is Windows only".to_owned())
    }

    /// What's finished.
    ///
    /// # Errors
    /// Always.
    pub fn poll(&mut self) -> Result<Vec<crate::EncodedUnit>, String> {
        Err("hardware encoding is Windows only".to_owned())
    }
}

/// No graphics card choice here.
#[must_use]
pub fn gpus() -> crate::Gpus {
    crate::Gpus::default()
}

/// Always Auto here.
#[must_use]
pub fn gpu_choice(_exe: &str) -> crate::GpuChoice {
    crate::GpuChoice::Auto
}

/// Nothing to save here.
///
/// # Errors
/// Never.
pub fn set_gpu_choice(_exe: &str, _choice: crate::GpuChoice) -> std::io::Result<()> {
    Ok(())
}

/// Remote control's stand-in: nothing is played back (the engine still logs what arrives).
#[derive(Debug)]
pub struct RemoteControl {
    area: crate::ControlArea,
}

impl RemoteControl {
    /// Starts (does nothing here).
    ///
    /// # Errors
    /// Never here.
    pub fn start(
        area: crate::ControlArea,
        _name: &str,
        _on_take_back: impl Fn(crate::TakeBack) + Send + 'static,
    ) -> Result<Self, String> {
        Ok(Self { area })
    }

    /// Plays back nothing here.
    pub fn input(&self, i: crate::Injection) {
        tracing::trace!("control: {i:?} over {:?}", self.area);
    }
}
