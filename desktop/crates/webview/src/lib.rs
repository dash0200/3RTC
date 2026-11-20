//! The YouTube, Vimeo and Twitch player: a WebView2 inside the app window (BUILD_SPEC 6.7, 5.9
//! item 1), made when such a video starts and dropped when it ends, so no web view process runs
//! otherwise.
//!
//! It loads `assets/player.html` from the app itself (served as `https://rtc.localhost/`), which
//! hosts the provider's own embedded player; the app sends play, pause and seek, and the page
//! reports its state about twice a second. Nothing here plays or extracts a stream itself.
//!
//! Windows only: elsewhere [`Player::open`] says so (the app is shipped for Windows).

#![deny(missing_docs)]

use raw_window_handle::HasWindowHandle;

/// The page the player runs in.
#[cfg_attr(not(windows), allow(dead_code))]
const PAGE: &str = include_str!("../assets/player.html");

/// What to play.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A YouTube video id.
    YouTube(String),
    /// A Vimeo video's address (`https://vimeo.com/<id>[/<hash>]`).
    Vimeo(String),
    /// A Twitch video (`v<number>`) or channel name.
    Twitch(String),
    /// A direct video file's address (the web view's own `<video>`).
    File(String),
    /// An HLS stream's address (`<video>` with hls.js).
    Hls(String),
}

impl Source {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn query(&self, start: f64, playing: bool) -> String {
        let (kind, id) = match self {
            Self::YouTube(id) => ("youtube", id),
            Self::Vimeo(url) => ("vimeo", url),
            Self::Twitch(id) => ("twitch", id),
            Self::File(url) => ("file", url),
            Self::Hls(url) => ("hls", url),
        };
        let live = matches!(self, Self::Twitch(id) if !id.starts_with('v'));
        format!(
            "kind={kind}&id={}&t={start:.1}&play={}&live={}",
            encode(id),
            u8::from(playing),
            u8::from(live)
        )
    }
}

/// Percent-encodes a query value.
#[cfg_attr(not(windows), allow(dead_code))]
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Where the player sits in the window, in logical pixels from its top left.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    /// Left.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

/// What the player said.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// It's ready (with the video's title when the provider gives one).
    Ready {
        /// The title, or empty.
        title: String,
    },
    /// Where it is (about twice a second, and on every change).
    State {
        /// Playing (not paused).
        playing: bool,
        /// Waiting for data.
        buffering: bool,
        /// Position, seconds.
        time: f64,
        /// Length, seconds (0 for a live stream).
        duration: f64,
    },
    /// A person used the player's own controls: `action` is `play`, `pause` or `seek`.
    User {
        /// What they did.
        action: String,
        /// Where, seconds.
        time: f64,
    },
    /// It played to the end.
    Ended,
    /// Something went wrong (no network, a broken link…).
    Error(String),
    /// The provider refused this video (removed, private, not allowed on other sites).
    Unavailable(String),
    /// Fullscreen state changed in the web player.
    Fullscreen(bool),
}

impl Event {
    /// Reads a message from the page (`None`: not one of ours).
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        // a tiny reader for the page's flat JSON, so this crate needs no JSON library
        let field = |name: &str| -> Option<&str> {
            let key = format!("\"{name}\":");
            let at = text.find(&key)? + key.len();
            let rest = text[at..].trim_start();
            if let Some(s) = rest.strip_prefix('"') {
                let end = s.find('"')?;
                Some(&s[..end])
            } else {
                let end = rest.find([',', '}']).unwrap_or(rest.len());
                Some(rest[..end].trim())
            }
        };
        let num = |name: &str| field(name).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        match field("ev")? {
            "ready" => Some(Self::Ready {
                title: field("title").unwrap_or("").to_owned(),
            }),
            "state" => Some(Self::State {
                playing: field("playing") == Some("true"),
                buffering: field("buffering") == Some("true"),
                time: num("t"),
                duration: num("d"),
            }),
            "user" => Some(Self::User {
                action: field("do").unwrap_or("").to_owned(),
                time: num("t"),
            }),
            "ended" => Some(Self::Ended),
            "fullscreen" => Some(Self::Fullscreen(field("on") == Some("true"))),
            "error" if field("unavailable") == Some("true") => {
                Some(Self::Unavailable(field("message").unwrap_or("").to_owned()))
            }
            "error" => Some(Self::Error(field("message").unwrap_or("").to_owned())),
            _ => None,
        }
    }
}

/// Why the player couldn't open.
#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

#[cfg(windows)]
mod imp {
    //! The web view lives on its own UI thread (`rtc_platform_win::UiThread`): starting
    //! WebView2 runs a nested message loop, which must not run inside GPUI. Every call is a job
    //! sent there; nothing here waits for it.

    use std::borrow::Cow;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::sync::Arc;

    use raw_window_handle::HasWindowHandle;
    use rtc_platform_win::{ParentWindow, UiThread};
    use wry::WebViewBuilderExtWindows as _;
    use wry::dpi::{LogicalPosition, LogicalSize};
    use wry::http::{Response, header::CONTENT_TYPE};

    use super::{Bounds, Error, Event, PAGE, Source};

    thread_local! {
        /// The web view, on its UI thread (one player per thread).
        static VIEW: RefCell<Option<(wry::WebView, wry::WebContext)>> = const { RefCell::new(None) };
    }

    fn rect(b: Bounds) -> wry::Rect {
        wry::Rect {
            position: LogicalPosition::new(b.x, b.y).into(),
            size: LogicalSize::new(b.width.max(1.0), b.height.max(1.0)).into(),
        }
    }

    /// The player (dropping it closes the web view and ends its thread).
    pub(super) struct Player {
        ui: UiThread,
    }

    impl Player {
        pub(super) fn open(
            parent: &impl HasWindowHandle,
            bounds: Bounds,
            source: &Source,
            start: f64,
            playing: bool,
            data_dir: PathBuf,
            on_event: impl Fn(Event) + Send + Sync + 'static,
        ) -> Result<Self, Error> {
            let parent = ParentWindow::of(parent)
                .ok_or_else(|| Error("no window to show the player in".to_owned()))?;
            let ui = UiThread::start("3rtc-player")
                .ok_or_else(|| Error("couldn't start the player's thread".to_owned()))?;
            let url = format!(
                "https://rtc.localhost/player.html?{}",
                source.query(start, playing)
            );
            let on_event = Arc::new(on_event);
            ui.run(move || {
                let mut context = wry::WebContext::new(Some(data_dir));
                let events = Arc::clone(&on_event);
                let built = wry::WebViewBuilder::new_with_web_context(&mut context)
                    .with_https_scheme(true)
                    .with_custom_protocol("rtc".to_owned(), |_, _request| {
                        Response::builder()
                            .header(CONTENT_TYPE, "text/html; charset=utf-8")
                            .body(Cow::Borrowed(PAGE.as_bytes()))
                            .unwrap_or_else(|_| Response::new(Cow::Borrowed(&b""[..])))
                    })
                    .with_ipc_handler(move |req| {
                        if let Some(e) = Event::parse(req.body()) {
                            events(e);
                        }
                    })
                    .with_autoplay(false)
                    // never take the keyboard from the app's text boxes when it opens (keys then
                    // went to YouTube: "f" made it full screen); a click in it still focuses it
                    .with_focused(false)
                    .with_background_color((0, 0, 0, 255))
                    .with_bounds(rect(bounds))
                    .with_url(url)
                    .build_as_child(&parent);
                match built {
                    Ok(view) => VIEW.with_borrow_mut(|v| *v = Some((view, context))),
                    Err(e) => on_event(Event::Error(format!(
                        "The player couldn't start ({e}). Microsoft Edge WebView2 is needed (it comes with Windows 11)."
                    ))),
                }
            });
            Ok(Self { ui })
        }

        fn with_view(&self, f: impl FnOnce(&wry::WebView) + Send + 'static) {
            self.ui.run(move || {
                VIEW.with_borrow(|v| {
                    if let Some((view, _)) = v {
                        f(view);
                    }
                });
            });
        }

        pub(super) fn set_bounds(&self, bounds: Bounds) {
            self.with_view(move |v| {
                let _ = v.set_bounds(rect(bounds));
            });
        }

        pub(super) fn set_visible(&self, visible: bool) {
            self.with_view(move |v| {
                let _ = v.set_visible(visible);
            });
        }

        pub(super) fn command(&self, js: &str) {
            let js = js.to_owned();
            self.with_view(move |v| {
                if let Err(e) = v.evaluate_script(&js) {
                    tracing::debug!("player command: {e}");
                }
            });
        }
    }

    impl Drop for Player {
        fn drop(&mut self) {
            // the web view goes on its own thread, then the thread ends (`UiThread`'s drop)
            self.ui.run(|| drop(VIEW.with_borrow_mut(Option::take)));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::PathBuf;

    use raw_window_handle::HasWindowHandle;

    use super::{Bounds, Error, Event, Source};

    /// The player (not available on this system).
    pub(super) struct Player;

    impl Player {
        pub(super) fn open(
            _parent: &impl HasWindowHandle,
            _bounds: Bounds,
            _source: &Source,
            _start: f64,
            _playing: bool,
            _data_dir: PathBuf,
            _on_event: impl Fn(Event) + Send + Sync + 'static,
        ) -> Result<Self, Error> {
            Err(Error(
                "the YouTube, Vimeo and Twitch player needs Windows".to_owned(),
            ))
        }

        pub(super) const fn set_bounds(&self, _bounds: Bounds) {}

        pub(super) const fn set_visible(&self, _visible: bool) {}

        pub(super) const fn command(&self, _js: &str) {}
    }
}

/// The player in the window.
pub struct Player(imp::Player);

impl std::fmt::Debug for Player {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Player")
    }
}

impl Player {
    /// Opens the player over `parent` at `bounds` with `source`, starting from `start` seconds,
    /// playing or paused, once it's ready. Its web data (cookies, cache) lives in `data_dir`.
    /// The web view runs on its own thread: `on_event` is called there (a WebView2 that can't
    /// start says so with [`Event::Error`]).
    ///
    /// # Errors
    /// No WebView2 runtime, or not Windows.
    pub fn open(
        parent: &impl HasWindowHandle,
        bounds: Bounds,
        source: &Source,
        start: f64,
        playing: bool,
        data_dir: std::path::PathBuf,
        on_event: impl Fn(Event) + Send + Sync + 'static,
    ) -> Result<Self, Error> {
        imp::Player::open(parent, bounds, source, start, playing, data_dir, on_event).map(Self)
    }

    /// Moves or resizes it (the stage changed).
    pub fn set_bounds(&self, bounds: Bounds) {
        self.0.set_bounds(bounds);
    }

    /// Hides it (a dialog is open over the stage) or shows it again.
    pub fn set_visible(&self, visible: bool) {
        self.0.set_visible(visible);
    }

    /// Plays (first going to `at` if it's more than 1.2 s away).
    pub fn play(&self, at: Option<f64>) {
        self.0.command(&with_time("play", at));
    }

    /// Pauses (at `at`).
    pub fn pause(&self, at: Option<f64>) {
        self.0.command(&with_time("pause", at));
    }

    /// Host control on for this person: the player's own controls can't be used (a see-through
    /// cover over the page), or can again.
    pub fn set_locked(&self, locked: bool) {
        self.0.command(&format!(
            "window.rtc && window.rtc.cmd({{do:'lock',on:{locked}}})"
        ));
    }

    /// Goes to `secs`.
    pub fn seek(&self, secs: f64) {
        if secs.is_finite() {
            self.0.command(&format!(
                "window.rtc && window.rtc.cmd({{do:'seek',t:{:.3}}})",
                secs.max(0.0)
            ));
        }
    }

    /// Tells the web player to request or exit fullscreen.
    pub fn set_fullscreen(&self, on: bool) {
        self.0.command(&format!(
            "window.rtc && window.rtc.cmd({{do:'fullscreen',on:{on}}})"
        ));
    }
}

fn with_time(what: &str, at: Option<f64>) -> String {
    match at.filter(|t| t.is_finite()) {
        Some(t) => format!(
            "window.rtc && window.rtc.cmd({{do:'{what}',t:{:.3}}})",
            t.max(0.0)
        ),
        None => format!("window.rtc && window.rtc.cmd({{do:'{what}'}})"),
    }
}

#[cfg(test)]
mod tests {
    use super::{Event, Source, encode};

    #[test]
    fn reads_the_pages_messages() {
        assert_eq!(
            Event::parse(r#"{"ev":"state","playing":true,"buffering":false,"t":12.5,"d":300}"#),
            Some(Event::State {
                playing: true,
                buffering: false,
                time: 12.5,
                duration: 300.0
            })
        );
        assert_eq!(
            Event::parse(r#"{"ev":"user","do":"seek","t":42}"#),
            Some(Event::User {
                action: "seek".into(),
                time: 42.0
            })
        );
        assert_eq!(
            Event::parse(r#"{"ev":"error","unavailable":true,"message":"removed or private"}"#),
            Some(Event::Unavailable("removed or private".into()))
        );
        assert_eq!(
            Event::parse(r#"{"ev":"ready","title":"Big Buck Bunny"}"#),
            Some(Event::Ready {
                title: "Big Buck Bunny".into()
            })
        );
        assert_eq!(Event::parse(r#"{"ev":"ended"}"#), Some(Event::Ended));
        assert_eq!(
            Event::parse(r#"{"ev":"fullscreen","on":true}"#),
            Some(Event::Fullscreen(true))
        );
        assert_eq!(
            Event::parse(r#"{"ev":"fullscreen","on":false}"#),
            Some(Event::Fullscreen(false))
        );
        assert_eq!(Event::parse(r#"{"x":1}"#), None);
        assert_eq!(Event::parse("not json"), None);
    }

    #[test]
    fn sources_become_the_pages_address() {
        assert_eq!(
            Source::Vimeo("https://vimeo.com/76979871".into()).query(5.0, true),
            "kind=vimeo&id=https%3A%2F%2Fvimeo.com%2F76979871&t=5.0&play=1&live=0"
        );
        assert!(
            Source::Twitch("somebody".into())
                .query(0.0, false)
                .ends_with("&play=0&live=1")
        );
        assert_eq!(encode("a b&c"), "a%20b%26c");
    }
}
