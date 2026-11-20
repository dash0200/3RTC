//! The watch party on screen: the player (a WebView2 over the stage, `rtc_webview`, or mpv for a
//! file from this computer, `local_video.rs`), the paste
//! box, quick picks (`QuickPicksBrowser.tsx`), the header's sync pill, "Now playing", Skip and
//! Exit (`Header.tsx`), and the Queue tab (`LiveChat.tsx`). The rules live in `rtc_core`
//! (`WatchCommand`, `PlayerCmd`); this file shows them and turns clicks into commands.
//!
//! The web view draws over GPUI (BUILD_SPEC 5.9 item 1): it's hidden while a popover or dialog
//! is open, floating reactions move into a strip beside it, and toasts sit under it.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::Sizable as _;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::{
    AnyElement, AppContext as _, Bounds, Context, Entity, FontWeight, Hsla, Image, ImageFormat,
    InteractiveElement as _, IntoElement, MouseButton, MouseDownEvent, NavigationDirection, ObjectFit,
    ParentElement as _, Pixels, ScrollDelta, ScrollEvent, SharedString, StatefulInteractiveElement as _,
    Styled as _, StyledImage as _, Window, canvas, div, img, prelude::FluentBuilder as _, px,
};
use rtc_core::{Command, PlayerCmd, PlayerReport, Showing, UserAction, WatchCommand};
use rtc_engine::Snapshot;
use rtc_protocol::media::{Link, Media, Provider, detect_link};
use rtc_ui::button::{Button, Variant};
use rtc_ui::{Icon, icon, tokens};

use crate::quick_picks::{self, Picks, Video};
use crate::view::RoomView;

/// What opens in the stage: a web player, or a video file in mpv.
#[derive(Debug, Clone)]
enum What {
    Web(rtc_webview::Source),
    File(std::path::PathBuf),
    /// A torrent stream (HTTP range stream for mpv, local file for WebRTC peer range sharing).
    Torrent {
        url: String,
        path: std::path::PathBuf,
        size: Option<u64>,
    },
    /// Someone's file, streamed to us.
    Stream(rtc_engine::StreamReader),
}

/// What the player should open once the stage has a size.
#[derive(Debug, Clone)]
struct Open {
    what: What,
    start: f64,
    playing: bool,
}

/// The player in the stage: the web view (YouTube, links) or mpv (a file from this computer).
pub(crate) enum Live {
    Web(rtc_webview::Player),
    Video(rtc_platform_win::VideoPlayer),
}

impl Live {
    pub(crate) fn play(&self, at: Option<f64>) {
        match self {
            Self::Web(p) => p.play(at),
            Self::Video(p) => p.play(at),
        }
    }

    pub(crate) fn pause(&self, at: Option<f64>) {
        match self {
            Self::Web(p) => p.pause(at),
            Self::Video(p) => p.pause(at),
        }
    }

    pub(crate) fn seek(&self, to: f64) {
        match self {
            Self::Web(p) => p.seek(to),
            Self::Video(p) => p.seek(to),
        }
    }

    fn set_visible(&self, on: bool) {
        match self {
            Self::Web(p) => p.set_visible(on),
            Self::Video(p) => p.set_visible(on),
        }
    }

    fn set_fullscreen(&self, on: bool) {
        if let Self::Web(p) = self {
            p.set_fullscreen(on);
        }
    }

    pub(crate) fn set_bottom_clip(&self, clip_px: i32) {
        if let Self::Video(p) = self {
            p.set_bottom_clip(clip_px);
        }
    }

    /// Follows the stage (`scale`: physical pixels per logical one).
    fn place(&self, b: Bounds<Pixels>, scale: f32) {
        match self {
            Self::Web(p) => p.set_bounds(rect(b)),
            Self::Video(p) => p.set_rect(physical(b, scale)),
        }
    }

    /// The local video player, if that's what plays.
    pub(crate) const fn video(&self) -> Option<&rtc_platform_win::VideoPlayer> {
        match self {
            Self::Video(p) => Some(p),
            Self::Web(_) => None,
        }
    }
}

pub(crate) struct WatchUi {
    pub(crate) player: Rc<RefCell<Option<Live>>>,
    pending: Option<Open>,
    opening: bool,
    /// Why the player couldn't open (shown on the stage).
    pub(crate) error: Option<SharedString>,
    /// The stage's player rectangle (window coordinates, logical pixels).
    stage: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The window's scale when the stage was last measured.
    pub(crate) scale: Rc<Cell<f32>>,
    shown: Rc<Cell<bool>>,
    /// A video file from this computer (`local_video.rs`).
    pub(crate) local: crate::local_video::LocalUi,
    events: tokio::sync::mpsc::UnboundedSender<rtc_webview::Event>,
    pub(crate) link_error: Option<SharedString>,
    pub(crate) queue_error: Option<SharedString>,
    pub(crate) resolving: bool,
    pub(crate) picks: Picks,
    pub(crate) group: Option<String>,
    pub(crate) category: Option<String>,
    thumbs: HashMap<String, Option<Arc<Image>>>,
    /// Videos YouTube refused this session (quick picks skip them).
    pub(crate) unavailable: HashSet<String>,
    pub(crate) queue_link: Entity<InputState>,
    pub(crate) region_open: bool,
    /// Live torrent pre-buffering / connection status.
    pub(crate) torrent_status: Option<SharedString>,
    /// Live swarm stats for the active torrent stream (for the person hosting it).
    pub(crate) torrent_stats: Option<TorrentStatsInfo>,
    /// Stream URL for active torrent playback via local HTTP server.
    pub(crate) torrent_stream_url: Option<String>,
    /// A multi-file torrent waiting for the user to pick the file to stream.
    pub(crate) torrent_choice: Option<TorrentChoice>,
    /// Torrent subtitle files that arrived before the player was up (loaded when it is).
    pub(crate) torrent_subs: Vec<std::path::PathBuf>,
    /// The first torrent subtitle went to the room already (the rest only load here).
    pub(crate) torrent_sub_shared: bool,
    /// Host control as last told to the web player (`None`: not yet, e.g. a new player).
    lock_applied: Cell<Option<bool>>,
}

/// The file list of a multi-file torrent, shown as a picker under the paste box.
#[derive(Debug, Clone)]
pub(crate) struct TorrentChoice {
    pub(crate) title: String,
    pub(crate) files: Vec<crate::torrent::TorrentFileEntry>,
    /// The file id we'd pick on our own (marked "Suggested").
    pub(crate) suggested: usize,
    /// The file Play starts (the suggested one at first).
    pub(crate) selected: usize,
    /// Subtitle files ticked to load with it (those matching it at first).
    pub(crate) subs: HashSet<usize>,
    /// Folders the user opened (every folder starts folded shut).
    pub(crate) expanded: HashSet<String>,
    /// The user ticked, unticked, selected or deselected subtitles: picking another file leaves
    /// their choice alone.
    pub(crate) subs_chosen: bool,
}

/// Swarm statistics for active torrent playback.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct TorrentStatsInfo {
    pub(crate) seeds: usize,
    pub(crate) peers: usize,
    pub(crate) total_peers: usize,
    pub(crate) speed_bps: u64,
}

/// Host control is on and we aren't the host: playback is the host's (`useHostControls`), so
/// the controls that change it for everyone are hidden.
pub(crate) fn locked_for_me(room: &Snapshot) -> bool {
    room.playback_lock && room.host.as_ref() != Some(&room.me)
}

impl WatchUi {
    pub(crate) fn new(
        window: &mut Window,
        cx: &mut Context<'_, RoomView>,
        events: tokio::sync::mpsc::UnboundedSender<rtc_webview::Event>,
    ) -> Self {
        Self {
            player: Rc::new(RefCell::new(None)),
            pending: None,
            opening: false,
            error: None,
            stage: Rc::new(Cell::new(None)),
            scale: Rc::new(Cell::new(1.0)),
            shown: Rc::new(Cell::new(true)),
            lock_applied: Cell::new(None),
            local: crate::local_video::LocalUi::new(),
            events,
            link_error: None,
            queue_error: None,
            resolving: false,
            picks: quick_picks::load_saved(),
            group: None,
            category: None,
            thumbs: HashMap::new(),
            unavailable: HashSet::new(),
            queue_link: cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("Paste a link (YouTube, magnet:?, Vimeo, Twitch, .mp4…)")
            }),
            region_open: false,
            torrent_status: None,
            torrent_stats: None,
            torrent_stream_url: None,
            torrent_choice: None,
            torrent_subs: Vec::new(),
            torrent_sub_shared: false,
        }
    }
}

fn source(s: &Showing) -> Option<rtc_webview::Source> {
    Some(match s {
        Showing::YouTube { id, .. } => rtc_webview::Source::YouTube(id.clone()),
        Showing::Link(m) => match m.provider {
            Provider::Vimeo => rtc_webview::Source::Vimeo(m.url.clone()),
            Provider::Twitch => {
                rtc_webview::Source::Twitch(m.video.clone().or_else(|| m.channel.clone()).unwrap_or_default())
            }
            Provider::File => rtc_webview::Source::File(m.url.clone()),
            Provider::Hls => rtc_webview::Source::Hls(m.url.clone()),
        },
        Showing::Local { .. } => return None,
    })
}

fn web_data_dir() -> std::path::PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map_or_else(std::env::temp_dir, std::path::PathBuf::from)
        .join("3RTC")
        .join("WebView2")
}

/// Logical bounds to physical pixels (mpv's child window is placed in those).
#[allow(clippy::cast_possible_truncation)]
pub(crate) fn physical(b: Bounds<Pixels>, scale: f32) -> rtc_platform_win::Rect {
    let px = |v: Pixels| (f32::from(v) * scale).round() as i32;
    rtc_platform_win::Rect {
        x: px(b.origin.x),
        y: px(b.origin.y),
        width: px(b.size.width),
        height: px(b.size.height),
    }
}

fn rect(b: Bounds<Pixels>) -> rtc_webview::Bounds {
    rtc_webview::Bounds {
        x: f64::from(f32::from(b.origin.x)),
        y: f64::from(f32::from(b.origin.y)),
        width: f64::from(f32::from(b.size.width)),
        height: f64::from(f32::from(b.size.height)),
    }
}

/// `noembed.com` (as the web app), else a quick pick's title, else "YouTube Video (id)".
fn youtube_title(id: &str, picks: &Picks) -> String {
    let fetched = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(2500)))
        .build()
        .new_agent()
        .get(&format!(
            "https://noembed.com/embed?url=https://www.youtube.com/watch?v={id}"
        ))
        .call()
        .ok()
        .and_then(|r| {
            r.into_body()
                .with_config()
                .limit(256 * 1024)
                .read_to_string()
                .ok()
        })
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(str::to_owned))
        .filter(|t| !t.is_empty());
    fetched
        .or_else(|| quick_picks::title_of(picks, id))
        .unwrap_or_else(|| format!("YouTube Video ({id})"))
}

fn vimeo_title(url: &str) -> String {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(4)))
        .build()
        .new_agent()
        .get("https://vimeo.com/api/oembed.json")
        .query("url", url)
        .call()
        .ok()
        .and_then(|r| {
            r.into_body()
                .with_config()
                .limit(256 * 1024)
                .read_to_string()
                .ok()
        })
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| {
            v.get("title")
                .and_then(|t| t.as_str())
                .map(|t| t.chars().take(200).collect())
        })
        .unwrap_or_default()
}

/// A link with no known site and no video extension: is it a video at all? (`probeVideoUrl`)
fn probe(url: &str) -> bool {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(6)))
        .build()
        .new_agent()
        .get(url)
        .header("Range", "bytes=0-1023")
        .call()
        .ok()
        .and_then(|r| {
            r.headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .map(str::to_ascii_lowercase)
        })
        .is_some_and(|t| t.starts_with("video/") || t.starts_with("audio/") || t.contains("mpegurl"))
}

/// What a resolved paste becomes.
enum Resolved {
    YouTube(String, String),
    Media(Media),
    Magnet(String),
}

/// The paste box: from text to something to play (`resolvePastedLink`), off the UI thread.
fn resolve(text: &str, picks: &Picks) -> Result<Resolved, String> {
    let trimmed = text.trim();
    if trimmed.starts_with("magnet:?") {
        return Ok(Resolved::Magnet(trimmed.to_owned()));
    }
    match detect_link(trimmed)? {
        Link::YouTube(id) => {
            let title = youtube_title(&id, picks);
            Ok(Resolved::YouTube(id, title))
        }
        Link::Media { mut media, guessed } => {
            if guessed && !probe(&media.url) {
                return Err("That link isn't a video this browser can play. Paste a YouTube, magnet:?, Vimeo or Twitch link, or a direct video link (.mp4, .webm, .m3u8).".to_owned());
            }
            if media.provider == Provider::Vimeo {
                let t = vimeo_title(&media.url);
                if !t.is_empty() {
                    media.title = Some(t);
                }
            }
            if media.title.is_none() {
                media.title = Some(media.fallback_title());
            }
            Ok(Resolved::Media(media))
        }
    }
}

fn new_id() -> String {
    format!("{:016x}{:08x}", rand::random::<u64>(), rand::random::<u32>())
}

impl RoomView {
    /// Starts the quick picks download and listens to the player.
    pub(crate) fn start_watch(
        &mut self,
        mut events: tokio::sync::mpsc::UnboundedReceiver<rtc_webview::Event>,
        cx: &mut Context<'_, Self>,
    ) {
        cx.spawn(async move |this, cx| {
            while let Some(e) = events.recv().await {
                if this.update(cx, |v, cx| v.on_player_event(e, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        self.refresh_picks(cx);
    }

    pub(crate) fn refresh_picks(&mut self, cx: &mut Context<'_, Self>) {
        let urls = self.settings.signaling_urls();
        let region = if self.settings.qp_region.is_empty() {
            quick_picks::GLOBAL.to_owned()
        } else {
            self.settings.qp_region.clone()
        };
        let task = cx
            .background_executor()
            .spawn(async move { quick_picks::fetch(&urls, &region) });
        cx.spawn(async move |this, cx| {
            if let Some(p) = task.await {
                let _ = this.update(cx, |v, cx| {
                    v.watch.picks = p;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub(crate) fn set_region(&mut self, code: &str, cx: &mut Context<'_, Self>) {
        self.settings.qp_region = code.to_owned();
        self.settings.save();
        self.watch.picks.region = Some(code.to_owned());
        self.watch.region_open = false;
        self.refresh_picks(cx);
        cx.notify();
    }

    fn thumb(&mut self, id: &str, cx: &mut Context<'_, Self>) -> Option<Arc<Image>> {
        if let Some(t) = self.watch.thumbs.get(id) {
            return t.clone();
        }
        self.watch.thumbs.insert(id.to_owned(), None);
        let owned = id.to_owned();
        let task = cx
            .background_executor()
            .spawn(async move { quick_picks::thumbnail(&owned) });
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            if let Some(bytes) = task.await {
                let _ = this.update(cx, |v, cx| {
                    v.watch
                        .thumbs
                        .insert(id, Some(Arc::new(Image::from_bytes(ImageFormat::Jpeg, bytes))));
                    cx.notify();
                });
            }
        })
        .detach();
        None
    }

    pub(crate) fn watch_cmd(&self, c: WatchCommand) {
        self.command(Command::Watch(c));
    }

    /// Tells the web player (YouTube/Vimeo/Twitch) to enter or exit fullscreen.
    pub(crate) fn set_web_player_fullscreen(&self, on: bool) {
        if let Some(p) = self.watch.player.borrow().as_ref() {
            p.set_fullscreen(on);
        }
    }

    /// What the room told the player to do.
    pub(crate) fn on_player_cmd(&mut self, c: PlayerCmd, cx: &mut Context<'_, Self>) {
        let player = Rc::clone(&self.watch.player);
        match c {
            PlayerCmd::Open {
                showing,
                start,
                playing,
            } => {
                // the old player goes first (one at a time)
                player.borrow_mut().take();
                self.watch.error = None;
                let what = match &showing {
                    Showing::Local { name, size, from, .. } => {
                        if from.is_none() {
                            if let Some(url) = self.watch.torrent_stream_url.take() {
                                if let Some(path) = self.watch.local.path_for(name) {
                                    What::Torrent {
                                        url,
                                        path,
                                        size: Some(*size),
                                    }
                                } else if let Some(path) = &self.watch.local.file {
                                    What::Torrent {
                                        url,
                                        path: path.clone(),
                                        size: Some(*size),
                                    }
                                } else {
                                    What::File(self.watch.local.file.clone().unwrap_or_default())
                                }
                            } else if let Some(path) = self.watch.local.path_for(name) {
                                What::File(path)
                            } else if let Some(reader) = self.watch.local.stream_for(name) {
                                What::Stream(reader)
                            } else {
                                self.watch.error =
                                    Some("Choose the video file again to play it here.".into());
                                cx.notify();
                                return;
                            }
                        } else {
                            // We are streaming from a peer: cancel any local torrent in background
                            crate::torrent::TorrentService::cancel_stream(&self.runtime);
                            self.watch.torrent_stream_url = None;
                            self.watch.torrent_stats = None;
                            self.watch.torrent_status = None;
                            self.watch.torrent_choice = None;

                            if let Some(path) = self.watch.local.path_for(name) {
                                What::File(path)
                            } else if let Some(reader) = self.watch.local.stream_for(name) {
                                What::Stream(reader)
                            } else {
                                self.watch.error =
                                    Some("Choose the video file again to play it here.".into());
                                cx.notify();
                                return;
                            }
                        }
                    }
                    other => match source(other) {
                        Some(s) => What::Web(s),
                        None => return,
                    },
                };
                self.watch.local.reset();
                self.watch.pending = Some(Open { what, start, playing });
            }
            PlayerCmd::Play { at, .. } => {
                if let Some(p) = player.borrow().as_ref() {
                    p.play(at);
                } else if let Some(o) = &mut self.watch.pending {
                    o.playing = true;
                    o.start = at.unwrap_or(o.start);
                }
            }
            PlayerCmd::Pause { at, .. } => {
                if let Some(p) = player.borrow().as_ref() {
                    p.pause(at);
                } else if let Some(o) = &mut self.watch.pending {
                    o.playing = false;
                    o.start = at.unwrap_or(o.start);
                }
            }
            PlayerCmd::Seek { to, .. } => {
                if let Some(p) = player.borrow().as_ref() {
                    p.seek(to);
                } else if let Some(o) = &mut self.watch.pending {
                    o.start = to;
                }
            }
            PlayerCmd::Close => {
                player.borrow_mut().take();
                self.watch.pending = None;
                self.watch.error = None;
                self.watch.local.reset();
                self.end_local_sharing();
            }
            PlayerCmd::Subtitles { name, vtt } => self.room_subtitles(&name, &vtt, cx),
        }
        cx.notify();
    }

    fn on_player_event(&mut self, e: rtc_webview::Event, cx: &mut Context<'_, Self>) {
        use rtc_webview::Event as E;
        let report = match e {
            E::Ready { title } => {
                // the page can take commands now: host controls again (a lock sent while it was
                // still loading, as when joining a room with them on, went nowhere)
                self.watch.lock_applied.set(None);
                cx.notify();
                (!title.is_empty()).then_some(PlayerReport::Title(title))
            }
            E::State {
                playing,
                buffering,
                time,
                duration,
            } => Some(PlayerReport::State {
                time,
                playing,
                buffering,
                duration,
            }),
            E::User { action, time } => {
                let action = match action.as_str() {
                    "play" => UserAction::Play,
                    "pause" => UserAction::Pause,
                    _ => UserAction::Seek,
                };
                Some(PlayerReport::User { action, time })
            }
            E::Ended => Some(PlayerReport::Ended),
            E::Error(message) => {
                if !message.is_empty() {
                    if message.starts_with("The player couldn't start") {
                        self.watch.error = Some(message.into());
                        cx.notify();
                    } else {
                        self.show_toast(message, cx);
                    }
                }
                None
            }
            E::Unavailable(reason) => {
                self.video_unavailable(&reason, cx);
                None
            }
            E::Fullscreen(on) => {
                self.watch.local.fullscreen = on;
                if !on {
                    self.watch.local.fullscreen_controls = false;
                    self.watch.local.controls_left_at = None;
                }
                cx.notify();
                None
            }
        };
        if let Some(r) = report {
            self.watch_cmd(WatchCommand::Player(r));
        }
    }

    /// YouTube refused the video: next in the queue, else the next working quick pick in its
    /// category (`handlePlayerError`).
    fn video_unavailable(&mut self, reason: &str, cx: &mut Context<'_, Self>) {
        let Some(room) = &self.room else { return };
        let Some(Showing::YouTube { id, .. }) = &room.watch.showing else {
            return;
        };
        let id = id.clone();
        self.watch.unavailable.insert(id.clone());
        if !room.watch.queue.is_empty() {
            self.show_toast(format!("Unavailable ({reason}), playing next"), cx);
            self.watch_cmd(WatchCommand::Player(PlayerReport::Unavailable));
            return;
        }
        let next = self
            .watch
            .picks
            .categories
            .iter()
            .find(|c| c.videos.iter().any(|v| v.id == id))
            .and_then(|c| {
                let at = c.videos.iter().position(|v| v.id == id).unwrap_or(0);
                (1..c.videos.len())
                    .map(|step| &c.videos[(at + step) % c.videos.len()])
                    .find(|v| !self.watch.unavailable.contains(&v.id))
                    .cloned()
            });
        match next {
            Some(v) => {
                self.show_toast(format!("Unavailable ({reason}), trying another"), cx);
                self.watch_cmd(WatchCommand::PlayYouTube {
                    id: v.id,
                    title: v.title,
                });
            }
            None => self.show_toast(format!("Video unavailable ({reason})"), cx),
        }
    }

    /// "Play for everyone" (or "+ Add" in the Queue tab).
    pub(crate) fn submit_link(&mut self, to_queue: bool, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.watch.resolving {
            return;
        }
        // host control: a guest's link goes in the queue for the host to play
        let to_queue = to_queue || self.room.as_ref().is_some_and(locked_for_me);
        let input = if to_queue {
            self.watch.queue_link.clone()
        } else {
            self.link.clone()
        };
        let text = input.read(cx).value().trim().to_owned();
        if text.is_empty() {
            return;
        }
        // quick answer for what can't be played at all
        if !text.starts_with("magnet:?") {
            match detect_link(&text) {
                Ok(_) => {}
                Err(e) => {
                    if to_queue {
                        self.watch.queue_error = Some(e.into());
                    } else {
                        self.watch.link_error = Some(e.into());
                    }
                    cx.notify();
                    return;
                }
            }
        }
        self.watch.resolving = true;
        self.watch.link_error = None;
        self.watch.queue_error = None;
        let picks = self.watch.picks.clone();
        let task = cx
            .background_executor()
            .spawn(async move { resolve(&text, &picks) });
        cx.spawn_in(window, async move |this, cx| {
            let res = task.await;
            let _ = this.update_in(cx, |v, window, cx| {
                v.watch.resolving = false;
                match res {
                    Err(e) => {
                        if to_queue {
                            v.watch.queue_error = Some(e.into());
                        } else {
                            v.watch.link_error = Some(e.into());
                        }
                    }
                    Ok(r) => {
                        input.update(cx, |i, cx| i.set_value("", window, cx));
                        match (r, to_queue) {
                            (Resolved::Magnet(magnet), _) => {
                                v.play_torrent(crate::torrent::TorrentInput::Magnet(magnet), cx);
                                return;
                            }
                            (Resolved::YouTube(id, title), false) => {
                                crate::torrent::TorrentService::cancel_stream(&v.runtime);
                                v.watch.torrent_status = None;
                                v.watch.torrent_choice = None;
                                v.watch.torrent_stats = None;
                                v.watch_cmd(WatchCommand::PlayYouTube { id, title });
                            }
                            (Resolved::Media(m), false) => {
                                crate::torrent::TorrentService::cancel_stream(&v.runtime);
                                v.watch.torrent_status = None;
                                v.watch.torrent_choice = None;
                                v.watch.torrent_stats = None;
                                v.watch_cmd(WatchCommand::PlayLink(m));
                            }
                            (Resolved::YouTube(id, title), true) => {
                                v.watch_cmd(WatchCommand::QueueAdd {
                                    id: new_id(),
                                    video_id: Some(id),
                                    media: None,
                                    title,
                                    autoplay: true,
                                });
                            }
                            (Resolved::Media(m), true) => {
                                v.watch_cmd(WatchCommand::QueueAdd {
                                    id: new_id(),
                                    video_id: None,
                                    title: m.display_title(),
                                    media: Some(m),
                                    autoplay: true,
                                });
                            }
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Cancels active torrent streaming/preloading and clears status.
    pub(crate) fn cancel_torrent(&mut self, cx: &mut Context<'_, Self>) {
        crate::torrent::TorrentService::cancel_stream(&self.runtime);
        self.watch.torrent_status = None;
        self.watch.torrent_choice = None;
        self.watch.torrent_subs.clear();
        self.watch.torrent_stats = None;
        self.watch.torrent_stream_url = None;
        self.watch.link_error = None;
        cx.notify();
    }

    /// The user picked a file from a multi-file torrent: only that file downloads and plays.
    pub(crate) fn play_torrent_choice(&mut self, cx: &mut Context<'_, Self>) {
        let Some(choice) = self.watch.torrent_choice.take() else {
            return;
        };
        let file_id = choice.selected;
        let name = choice
            .files
            .iter()
            .find(|f| f.id == file_id)
            .map(|f| f.name.clone())
            .unwrap_or_default();
        let mut subs: Vec<usize> = choice.subs.into_iter().collect();
        subs.sort_unstable();
        if crate::torrent::TorrentService::choose_file(file_id, subs) {
            self.watch.torrent_status = Some(format!("🧲 Starting “{name}”…").into());
        } else {
            self.watch.link_error = Some("That torrent was closed. Open it again to pick a file.".into());
        }
        cx.notify();
    }

    /// Picker: this file is the one Play starts. Its matching subtitles get ticked instead, until
    /// the user has ticked or unticked any themselves (then their choice stays).
    pub(crate) fn select_torrent_file(&mut self, file_id: usize, cx: &mut Context<'_, Self>) {
        if let Some(choice) = &mut self.watch.torrent_choice
            && choice.selected != file_id
            && crate::torrent::can_play_pick(&choice.files, file_id)
        {
            choice.selected = file_id;
            if !choice.subs_chosen {
                choice.subs = crate::torrent::matching_subtitles(&choice.files, file_id)
                    .into_iter()
                    .collect();
            }
            cx.notify();
        }
    }

    /// Picker: tick or untick a subtitle file to load with the video.
    pub(crate) fn toggle_torrent_subtitle(&mut self, file_id: usize, cx: &mut Context<'_, Self>) {
        if let Some(choice) = &mut self.watch.torrent_choice {
            if !choice.subs.remove(&file_id) {
                choice.subs.insert(file_id);
            }
            choice.subs_chosen = true;
            cx.notify();
        }
    }

    /// Picker: tick every subtitle file (`on`) or none ("Select all" / "Deselect all").
    pub(crate) fn set_all_torrent_subtitles(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        if let Some(choice) = &mut self.watch.torrent_choice {
            choice.subs = if on {
                crate::torrent::subtitle_ids(&choice.files).into_iter().collect()
            } else {
                HashSet::new()
            };
            choice.subs_chosen = true;
            cx.notify();
        }
    }

    /// Opens a folder of the torrent file picker, or folds it shut again.
    pub(crate) fn toggle_torrent_folder(&mut self, folder: String, cx: &mut Context<'_, Self>) {
        if let Some(choice) = &mut self.watch.torrent_choice {
            if !choice.expanded.remove(&folder) {
                choice.expanded.insert(folder);
            }
            cx.notify();
        }
    }

    /// Starts streaming and playback for a BitTorrent magnet link or `.torrent` file.
    pub(crate) fn play_torrent(&mut self, input: crate::torrent::TorrentInput, cx: &mut Context<'_, Self>) {
        if self.room.as_ref().is_some_and(locked_for_me) {
            self.watch.link_error = Some("Host controls are on: only the host can start a video.".into());
            cx.notify();
            return;
        }
        // Cancel any currently running torrent stream first so only the new one loads
        crate::torrent::TorrentService::cancel_stream(&self.runtime);
        self.watch.torrent_stats = None;
        self.watch.torrent_stream_url = None;
        self.watch.torrent_choice = None;
        self.watch.torrent_subs.clear();
        self.watch.torrent_sub_shared = false;
        self.watch.link_error = None;
        self.watch.torrent_status = Some("🧲 Connecting to BitTorrent swarm...".into());
        cx.notify();

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        crate::torrent::set_keep(self.settings.keep_torrents);
        crate::torrent::TorrentService::start_stream(&self.runtime, input, tx);

        cx.spawn(async move |this, cx| {
            while let Some(prog) = rx.recv().await {
                let Ok(()) = this.update(cx, |v, cx| {
                    match prog {
                        crate::torrent::TorrentProgress::Connecting { title } => {
                            v.watch.torrent_status =
                                Some(format!("🧲 Connecting to BitTorrent swarm for “{title}”…").into());
                        }
                        crate::torrent::TorrentProgress::GettingFiles { title, secs } => {
                            v.watch.torrent_status = Some(
                                format!("🧲 Getting the file list for “{title}” from peers… {secs} s").into(),
                            );
                        }
                        crate::torrent::TorrentProgress::ChooseFile {
                            title,
                            files,
                            suggested,
                        } => {
                            v.watch.torrent_status = None;
                            let subs = crate::torrent::matching_subtitles(&files, suggested)
                                .into_iter()
                                .collect();
                            v.watch.torrent_choice = Some(TorrentChoice {
                                title,
                                files,
                                suggested,
                                selected: suggested,
                                subs,
                                expanded: HashSet::new(),
                                subs_chosen: false,
                            });
                        }
                        crate::torrent::TorrentProgress::Subtitle { path } => {
                            v.torrent_subtitle(path, cx);
                        }
                        crate::torrent::TorrentProgress::Resolved {
                            title,
                            filename,
                            size,
                            stream_url,
                            file_path,
                        } => {
                            let size_fmt = rtc_protocol::image::format_size(size);
                            v.watch.torrent_status =
                                Some(format!("📁 “{filename}” ({size_fmt}) • {title}").into());
                            v.watch.local.file = Some(file_path.clone());
                            v.watch.torrent_stream_url = Some(stream_url.clone());
                            v.share_own_torrent(&file_path, Some(&filename), Some(size), Some(stream_url));
                        }
                        crate::torrent::TorrentProgress::Buffering {
                            downloaded,
                            target,
                            seeds,
                            peers,
                            total_peers,
                            speed_bps,
                            index_pending,
                        } => {
                            let d_mb = downloaded as f64 / (1024.0 * 1024.0);
                            let t_mb = target as f64 / (1024.0 * 1024.0);
                            let sp_mb = speed_bps as f64 / (1024.0 * 1024.0);
                            v.watch.torrent_status = Some(
                                if index_pending && downloaded >= target {
                                    // an MP4 with its index at the end: that part comes first
                                    format!(
                                        "⏳ Fetching the video's index from the end of the file • s:{seeds} p:{peers}({total_peers}) • {sp_mb:.1} MB/s"
                                    )
                                } else {
                                    format!(
                                        "⏳ Pre-buffering: {d_mb:.1} / {t_mb:.1} MB • s:{seeds} p:{peers}({total_peers}) • {sp_mb:.1} MB/s"
                                    )
                                }
                                .into(),
                            );
                            v.watch.torrent_stats = Some(TorrentStatsInfo {
                                seeds,
                                peers,
                                total_peers,
                                speed_bps,
                            });
                        }
                        crate::torrent::TorrentProgress::ReadyToPlay { name, size } => {
                            v.watch.torrent_status = None;
                            v.watch.torrent_choice = None;
                            if let Some(path) = v.watch.local.file.clone() {
                                let stream_url = v.watch.torrent_stream_url.clone();
                                v.share_own_torrent(&path, Some(&name), Some(size), stream_url);
                            }
                            v.watch_cmd(WatchCommand::PlayFile { name, size });
                        }
                        crate::torrent::TorrentProgress::LiveStats {
                            seeds,
                            peers,
                            total_peers,
                            speed_bps,
                        } => {
                            v.watch.torrent_stats = Some(TorrentStatsInfo {
                                seeds,
                                peers,
                                total_peers,
                                speed_bps,
                            });
                        }
                        crate::torrent::TorrentProgress::Error(err) => {
                            v.watch.torrent_status = None;
                            v.watch.torrent_choice = None;
                            v.watch.torrent_stats = None;
                            v.watch.link_error = Some(err.into());
                        }
                    }
                    cx.notify();
                }) else {
                    break;
                };
            }
        })
        .detach();
    }

    fn play_pick(&mut self, v: &Video, cx: &mut Context<'_, Self>) {
        if self.room.as_ref().is_some_and(locked_for_me) {
            self.queue_pick(v);
            return;
        }
        self.watch.link_error = None;
        self.watch_cmd(WatchCommand::PlayYouTube {
            id: v.id.clone(),
            title: v.title.clone(),
        });
        cx.notify();
    }

    fn queue_pick(&self, v: &Video) {
        self.watch_cmd(WatchCommand::QueueAdd {
            id: new_id(),
            video_id: Some(v.id.clone()),
            media: None,
            title: v.title.clone(),
            autoplay: false,
        });
    }

    /// Hides the web view while a dialog or activity covers the stage (5.9 item 1).
    pub(crate) fn player_visible(&self) -> bool {
        self.dialog.is_none() && !self.watch.region_open && !self.screen.showing() && !self.activity_covers()
    }

    /// A shared screen covers the stage: the player's window hides (it would draw over it).
    pub(crate) fn hide_player(&self) {
        if self.watch.shown.get() {
            self.watch.shown.set(false);
            if let Some(p) = self.watch.player.borrow().as_ref() {
                p.set_visible(false);
            }
        }
    }
}

// ---- the stage while something plays ------------------------------------------------------------

/// The player's rectangle: black, with the web view laid over it.
pub(crate) fn player_area(
    view: &mut RoomView,
    window: &mut Window,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    // someone else's file that isn't here yet: the offer instead of a player
    if let Some(Showing::Local {
        name,
        size,
        from,
        have: false,
    }) = view.room.as_ref().and_then(|r| r.watch.showing.as_ref())
    {
        let (name, size, from) = (name.clone(), *size, from.clone());
        return crate::local_video::offer(view, &name, size, from.as_deref(), cx);
    }
    let visible = view.player_visible();
    let locked = view.room.as_ref().is_some_and(locked_for_me);
    if view.watch.lock_applied.get() != Some(locked)
        && let Some(Live::Web(p)) = view.watch.player.borrow().as_ref()
    {
        p.set_locked(locked);
        view.watch.lock_applied.set(Some(locked));
    }
    let ui = &mut view.watch;
    // open a waiting player once the stage has a size (outside drawing)
    if ui.pending.is_some() && !ui.opening && ui.stage.get().is_some() {
        ui.opening = true;
        cx.defer_in(window, |v, window, cx| {
            v.watch.opening = false;
            let (Some(open), Some(bounds)) = (v.watch.pending.take(), v.watch.stage.get()) else {
                return;
            };
            let source = match open.what {
                What::Web(source) => source,
                What::File(path) => {
                    v.share_own_file(&path);
                    crate::local_video::open_player(
                        v,
                        window,
                        bounds,
                        rtc_platform_win::VideoSource::File(path),
                        open.start,
                        open.playing,
                    );
                    cx.notify();
                    return;
                }
                What::Torrent { url, path, size } => {
                    // keep the stream url: without it the engine stops the stream viewers are on
                    // and serves the half-downloaded file from disk (missing pieces read as zeros)
                    v.share_own_torrent(&path, None, size, Some(url.clone()));
                    crate::local_video::open_player(
                        v,
                        window,
                        bounds,
                        rtc_platform_win::VideoSource::Url(url),
                        open.start,
                        open.playing,
                    );
                    cx.notify();
                    return;
                }
                What::Stream(reader) => {
                    crate::local_video::open_player(
                        v,
                        window,
                        bounds,
                        rtc_platform_win::VideoSource::Stream(std::sync::Arc::new(crate::local_video::Streamed(reader))),
                        open.start,
                        open.playing,
                    );
                    cx.notify();
                    return;
                }
            };
            let tx = v.watch.events.clone();
            match rtc_webview::Player::open(
                &*window,
                rect(bounds),
                &source,
                open.start,
                open.playing,
                web_data_dir(),
                move |e| {
                    let _ = tx.send(e);
                },
            ) {
                Ok(p) => {
                    p.set_visible(v.player_visible());
                    *v.watch.player.borrow_mut() = Some(Live::Web(p));
                    v.watch.lock_applied.set(None);
                }
                Err(e) => {
                    v.watch.error = Some(
                        if cfg!(windows) {
                            format!("The player couldn't start: {e}. Microsoft Edge WebView2 is needed (it comes with Windows 11).")
                        } else {
                            e.0
                        }
                        .into(),
                    );
                }
            }
            cx.notify();
        });
    }
    if ui.shown.get() != visible {
        ui.shown.set(visible);
        if let Some(p) = ui.player.borrow().as_ref() {
            p.set_visible(visible);
        }
    }
    let player = Rc::clone(&ui.player);
    let stage = Rc::clone(&ui.stage);
    let scale = Rc::clone(&ui.scale);
    let error = ui.error.clone();
    let hidden_note = !visible && ui.player.borrow().is_some();
    let showing = view.room.as_ref().and_then(|r| r.watch.showing.clone());
    let local = matches!(showing, Some(Showing::Local { have: true, .. }));
    let fullscreen = ui.local.fullscreen;
    if let Some(p) = ui.player.borrow().as_ref() {
        let clip = if fullscreen && ui.local.fullscreen_controls {
            (crate::local_video::FULLSCREEN_BOTTOM_ZONE * ui.scale.get()).round() as i32
        } else {
            0
        };
        p.set_bottom_clip(clip);
    }
    let video = div()
        .relative()
        .when(fullscreen, gpui_kit::Styled::size_full)
        .when(!fullscreen, |el| el.flex_1().min_h_0())
        .flex()
        .items_center()
        .justify_center()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|v, e: &MouseDownEvent, window, cx| {
                if v.pop.is_some() {
                    v.pop = None;
                    cx.notify();
                    return;
                }
                // the same as on the video itself: a double click never pauses
                if e.click_count == 2 {
                    v.video_double_click(window, cx);
                } else if e.click_count == 1 {
                    v.video_click(cx);
                }
            }),
        )
        .on_mouse_down(
            MouseButton::Navigate(NavigationDirection::Back),
            cx.listener(|v, _, _, cx| {
                if v.settings.player_mouse_nav_seek {
                    v.video_backward_5(cx);
                }
            }),
        )
        .on_mouse_down(
            MouseButton::Navigate(NavigationDirection::Forward),
            cx.listener(|v, _, _, cx| {
                if v.settings.player_mouse_nav_seek {
                    v.video_forward_5(cx);
                }
            }),
        )
        .on_scroll(cx.listener(|v, e: &ScrollEvent, _, cx| {
            if !v.settings.player_scroll_volume {
                return;
            }
            let dy = match e.delta {
                ScrollDelta::Lines(p) => p.y,
                ScrollDelta::Pixels(p) => f32::from(p.y),
            };
            if dy.abs() > 0.01 {
                let delta = if dy > 0.0 { 5.0 } else { -5.0 };
                let new_vol = (v.watch.local.volume + delta).clamp(0.0, 100.0);
                v.video_volume(new_vol, cx);
            }
        }))
        .child(
            canvas(
                move |bounds, window, _| {
                    let s = window.scale_factor();
                    if stage.get() != Some(bounds) || scale.get() != s {
                        if stage.get().is_none() {
                            // the first size: draw again so a waiting player opens
                            window.refresh();
                        }
                        stage.set(Some(bounds));
                        scale.set(s);
                        if let Some(p) = player.borrow().as_ref() {
                            p.place(bounds, s);
                        }
                    }
                },
                |_, (), _, _| {},
            )
            .absolute()
            .size_full(),
        )
        .when_some(error, |el, e| {
            el.child(
                div()
                    .max_w(px(520.))
                    .px(px(24.))
                    .text_center()
                    .text_size(px(15.))
                    .text_color(tokens::text_2())
                    .child(e),
            )
        })
        .when(hidden_note, |el| {
            el.child(
                div()
                    .text_size(px(14.))
                    .text_color(tokens::text_3())
                    .child("The video is still playing"),
            )
        });
    let show_controls = local && (!fullscreen || ui.local.fullscreen_controls);
    let controls = show_controls.then(|| {
        div()
            .id("lv-controls-bar")
            // over the video in full screen: a click on the bar (Exit full screen, play, the
            // seek bar) must not also count as a click on the video under it
            .when(fullscreen, |el| {
                el.absolute().bottom_0().left_0().right_0().occlude()
            })
            .on_hover(cx.listener(|v, hovered: &bool, _, cx| {
                if v.watch.local.fullscreen {
                    v.local_video_controls_hover(*hovered, cx);
                }
            }))
            .child(crate::local_video::controls(view, cx))
    });
    div()
        .absolute()
        .top_0()
        .left_0()
        .bottom(px(0.))
        .right(px(0.))
        .bg(tokens::black(1.0))
        .overflow_hidden()
        .when(!fullscreen, |el| el.flex().flex_col())
        .on_mouse_down(
            MouseButton::Navigate(NavigationDirection::Back),
            cx.listener(|v, _, _, cx| {
                if v.settings.player_mouse_nav_seek {
                    v.video_backward_5(cx);
                }
            }),
        )
        .on_mouse_down(
            MouseButton::Navigate(NavigationDirection::Forward),
            cx.listener(|v, _, _, cx| {
                if v.settings.player_mouse_nav_seek {
                    v.video_forward_5(cx);
                }
            }),
        )
        .on_scroll(cx.listener(|v, e: &ScrollEvent, _, cx| {
            if !v.settings.player_scroll_volume {
                return;
            }
            let dy = match e.delta {
                ScrollDelta::Lines(p) => p.y,
                ScrollDelta::Pixels(p) => f32::from(p.y),
            };
            if dy.abs() > 0.01 {
                let delta = if dy > 0.0 { 5.0 } else { -5.0 };
                let new_vol = (v.watch.local.volume + delta).clamp(0.0, 100.0);
                v.video_volume(new_vol, cx);
            }
        }))
        .child(video)
        .children(controls)
        .when(fullscreen && !local, |el| {
            el.child(
                div().absolute().top(px(16.)).right(px(20.)).child(
                    Button::new("exit-video-fullscreen", "Exit full screen")
                        .variant(Variant::Secondary)
                        .min_height(px(32.))
                        .on_click(cx.listener(|v, _, window, cx| v.toggle_video_fullscreen(window, cx))),
                ),
            )
        })
        .into_any_element()
}

// ---- quick picks --------------------------------------------------------------------------------

fn chip(
    id: impl Into<gpui_kit::ElementId>,
    label: impl Into<SharedString>,
    on: bool,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .h(px(32.))
        .px(px(12.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded_full()
        .border_1()
        .border_color(if on { tokens::text() } else { tokens::line() })
        .bg(if on { tokens::text() } else { tokens::surface() })
        .text_color(if on { tokens::bg() } else { tokens::text_2() })
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer()
        .hover(|s| s.border_color(tokens::line_strong()))
        .child(label.into())
}

fn strip_leading_symbols(name: &str) -> String {
    name.trim_start_matches(|c: char| !c.is_alphanumeric()).to_owned()
}

/// The quick picks under the paste box (`QuickPicksBrowser.tsx`).
pub(crate) fn browser(view: &mut RoomView, room: &Snapshot, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let groups = quick_picks::groups(&view.watch.picks);
    let Some(gi) = groups
        .iter()
        .position(|(g, _)| Some(g) == view.watch.group.as_ref())
        .or_else(|| (!groups.is_empty()).then_some(0))
    else {
        return div().into_any_element();
    };
    let (group, cats) = groups[gi].clone();
    let ci = cats
        .iter()
        .copied()
        .find(|i| Some(&view.watch.picks.categories[*i].id) == view.watch.category.as_ref())
        .unwrap_or(cats[0]);
    let category = view.watch.picks.categories[ci].clone();
    let videos: Vec<Video> = category
        .videos
        .iter()
        .filter(|v| !view.watch.unavailable.contains(&v.id))
        .cloned()
        .collect();
    let queued: HashSet<String> = room
        .watch
        .queue
        .iter()
        .filter_map(|q| q.video_id.clone())
        .collect();
    let queue_count = room.watch.queue.len();
    let region = view.watch.picks.region.clone();
    let cards: Vec<AnyElement> = videos
        .iter()
        .enumerate()
        .map(|(n, v)| {
            let thumb = view.thumb(&v.id, cx);
            let is_queued = queued.contains(&v.id);
            let (pv, qv) = (v.clone(), v.clone());
            div()
                .id(("qp-card", n))
                .w(px(220.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .id(("qp-play", n))
                        .relative()
                        .w(px(220.))
                        .h(px(124.))
                        .rounded(px(12.))
                        .overflow_hidden()
                        .bg(tokens::raised())
                        .cursor_pointer()
                        .on_click(cx.listener(move |v, _, _, cx| v.play_pick(&pv, cx)))
                        .when_some(thumb, |el, t| {
                            el.child(img(t).size_full().object_fit(ObjectFit::Cover))
                        })
                        .when(v.live || v.seconds > 0, |el| {
                            el.child(
                                div()
                                    .absolute()
                                    .right(px(6.))
                                    .bottom(px(6.))
                                    .px(px(6.))
                                    .py(px(2.))
                                    .rounded(px(6.))
                                    .bg(if v.live {
                                        tokens::accent()
                                    } else {
                                        tokens::black(0.8)
                                    })
                                    .text_size(px(11.))
                                    .font_weight(FontWeight::BOLD)
                                    .child(if v.live {
                                        "LIVE".to_owned()
                                    } else {
                                        quick_picks::length(v.seconds)
                                    }),
                            )
                        }),
                )
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(2.))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .line_clamp(2)
                                        .child(v.title.clone()),
                                )
                                .when(!v.channel.is_empty(), |el| {
                                    el.child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(tokens::text_3())
                                            .truncate()
                                            .child(v.channel.clone()),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .id(("qp-queue", n))
                                .size(px(30.))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .border_1()
                                .border_color(tokens::line())
                                .cursor_pointer()
                                .when(!is_queued, |el| {
                                    el.hover(|s| s.border_color(tokens::line_strong()))
                                        .on_click(cx.listener(move |v, _, _, _| v.queue_pick(&qv)))
                                })
                                .child(icon(
                                    if is_queued { Icon::Check } else { Icon::Plus },
                                    px(16.),
                                    if is_queued {
                                        tokens::live_text()
                                    } else {
                                        tokens::text_2()
                                    },
                                )),
                        ),
                )
                .into_any_element()
        })
        .collect();
    let shuffle = category.clone();
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .flex_1()
                        .text_size(px(18.))
                        .font_weight(FontWeight::BOLD)
                        .child("Quick picks"),
                )
                .when(queue_count > 0 && !locked_for_me(room), |el| {
                    el.child(
                        Button::new("qp-play-queue", format!("Play queue ({queue_count})"))
                            .variant(Variant::Secondary)
                            .icon(Icon::Play)
                            .on_click(cx.listener(|v, _, _, _| v.watch_cmd(WatchCommand::QueueNext))),
                    )
                })
                .when(group == "Trending" && region.is_some(), |el| {
                    let name =
                        quick_picks::region_name(region.as_deref().unwrap_or(quick_picks::GLOBAL)).to_owned();
                    el.child(
                        chip("qp-region", format!("Trending in {name} ▾"), false).on_click(cx.listener(
                            |v, _, _, cx| {
                                v.watch.region_open = !v.watch.region_open;
                                cx.notify();
                            },
                        )),
                    )
                })
                .when(groups.len() > 1, |el| {
                    el.children(groups.iter().enumerate().map(|(n, (g, _))| {
                        let name = g.clone();
                        chip(("qp-group", n), g.clone(), n == gi).on_click(cx.listener(move |v, _, _, cx| {
                            v.watch.group = Some(name.clone());
                            v.watch.category = None;
                            cx.notify();
                        }))
                    }))
                }),
        )
        .when(view.watch.region_open, |el| {
            let regions: Vec<String> = view.watch.picks.regions.clone();
            el.child(
                div().flex().flex_wrap().gap(px(6.)).children(
                    std::iter::once(quick_picks::GLOBAL.to_owned())
                        .chain(regions.into_iter().filter(|r| r != quick_picks::GLOBAL))
                        .enumerate()
                        .map(|(n, code)| {
                            let on = region.as_deref() == Some(code.as_str());
                            let c = code.clone();
                            chip(("qp-r", n), quick_picks::region_name(&code).to_owned(), on)
                                .on_click(cx.listener(move |v, _, _, cx| v.set_region(&c, cx)))
                        }),
                ),
            )
        })
        .when(cats.len() > 1 || videos.len() > 1, |el| {
            el.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.))
                    .when(cats.len() > 1, |el| {
                        el.children(cats.iter().map(|i| {
                            let c = &view.watch.picks.categories[*i];
                            let id = c.id.clone();
                            chip(("qp-cat", *i), strip_leading_symbols(&c.name), *i == ci).on_click(
                                cx.listener(move |v, _, _, cx| {
                                    v.watch.category = Some(id.clone());
                                    cx.notify();
                                }),
                            )
                        }))
                    })
                    .when(videos.len() > 1, |el| {
                        el.child(chip("qp-shuffle", "🔀 Shuffle", false).on_click(cx.listener(
                            move |v, _, _, cx| {
                                let pool: Vec<&Video> = shuffle
                                    .videos
                                    .iter()
                                    .filter(|x| !v.watch.unavailable.contains(&x.id))
                                    .collect();
                                let current = v.room.as_ref().and_then(|r| match &r.watch.showing {
                                    Some(Showing::YouTube { id, .. }) => Some(id.clone()),
                                    _ => None,
                                });
                                let others: Vec<&Video> = pool
                                    .iter()
                                    .copied()
                                    .filter(|x| Some(&x.id) != current.as_ref())
                                    .collect();
                                let list = if others.is_empty() { pool } else { others };
                                if !list.is_empty() {
                                    let pick = list[rand::random_range(0..list.len())].clone();
                                    v.play_pick(&pick, cx);
                                }
                            },
                        )))
                    }),
            )
        })
        .child(div().flex().flex_wrap().gap(px(16.)).children(cards))
        .into_any_element()
}

/// Under the paste box: a multi-file torrent's file picker, live torrent status or why a link
/// can't be played.
pub(crate) fn link_error(view: &RoomView, cx: &mut Context<'_, RoomView>) -> Option<AnyElement> {
    if let Some(torrent) = torrent_box(view, cx) {
        return Some(torrent);
    }
    let e = view.watch.link_error.clone()?;
    Some(
        div()
            .text_size(px(14.))
            .text_color(tokens::danger_text())
            .child(e)
            .into_any_element(),
    )
}

/// A torrent being opened: its file picker, or its live status (with Cancel). Under the paste
/// box, and in the Queue tab (a magnet pasted there while a video plays).
pub(crate) fn torrent_box(view: &RoomView, cx: &mut Context<'_, RoomView>) -> Option<AnyElement> {
    if let Some(choice) = &view.watch.torrent_choice {
        return Some(torrent_picker(choice, view.settings.keep_torrents, cx));
    }
    if let Some(status) = view.watch.torrent_status.clone() {
        return Some(
            div()
                .flex()
                .items_center()
                .justify_between()
                .w_full()
                .max_w(px(640.))
                .px(px(14.))
                .py(px(8.))
                .rounded(px(10.))
                .bg(tokens::surface())
                .border_1()
                .border_color(tokens::line())
                .child(
                    div()
                        .text_size(px(13.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(tokens::accent())
                        .child(status),
                )
                .child(
                    div()
                        .id("cancel-torrent-btn")
                        .px(px(10.))
                        .py(px(3.))
                        .rounded(px(6.))
                        .bg(tokens::raised())
                        .border_1()
                        .border_color(tokens::line_strong())
                        .hover(|s| s.bg(tokens::danger_line()).text_color(tokens::danger_text()))
                        .cursor_pointer()
                        .text_size(px(12.))
                        .font_weight(FontWeight::BOLD)
                        .child("Cancel")
                        .on_click(cx.listener(|v, _, _, cx| v.cancel_torrent(cx))),
                )
                .into_any_element(),
        );
    }
    None
}

/// How far a tree row of the torrent picker is indented, `depth` folders deep.
#[allow(clippy::cast_precision_loss)]
fn tree_indent(depth: usize) -> f32 {
    depth.min(12) as f32 * 16.
}

/// "Pick a file to stream": the torrent's files as a tree of its folders, every depth (each
/// folder starts folded shut and opens on a click, `torrent::tree_rows`), each row with name and size, videos first and tagged. A click selects the file Play starts; subtitle files
/// get a box to tick (those matching the selected file are ticked). The list scrolls.
fn torrent_picker(choice: &TorrentChoice, keep: bool, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let rows = crate::torrent::tree_rows(&choice.files, &choice.expanded);
    let mut items: Vec<AnyElement> = Vec::new();
    for (n, row) in rows.into_iter().enumerate() {
        let (f, depth) = match row {
            crate::torrent::TreeRow::Folder {
                path,
                name,
                depth,
                files: count,
                size: total,
                open,
            } => {
                items.push(
                    div()
                        .id(("torrent-folder", n))
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .ml(px(tree_indent(depth)))
                        .px(px(8.))
                        .py(px(6.))
                        .rounded(px(6.))
                        .hover(|s| s.bg(tokens::raised()))
                        .cursor_pointer()
                        .child(
                            div()
                                .flex_none()
                                .w(px(12.))
                                .text_size(px(11.))
                                .text_color(tokens::text_3())
                                .child(if open { "▾" } else { "▸" }),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(13.))
                                .font_weight(FontWeight::BOLD)
                                .child(format!("📁 {name}")),
                        )
                        .child(
                            div()
                                .flex_none()
                                .text_size(px(12.))
                                .text_color(tokens::text_3())
                                .child(format!(
                                    "{count} file{} · {}",
                                    if count == 1 { "" } else { "s" },
                                    rtc_protocol::image::format_size(total)
                                )),
                        )
                        .on_click(cx.listener(move |v, _, _, cx| v.toggle_torrent_folder(path.clone(), cx)))
                        .into_any_element(),
                );
                continue;
            }
            crate::torrent::TreeRow::File { file, depth } => (file, depth),
        };
        let indent = tree_indent(depth);
        let id = f.id;
        let suggested = id == choice.suggested;
        let selected = id == choice.selected;
        let ticked = f.subtitle && choice.subs.contains(&id);
        // pictures, .txt and the like: nothing to play (unless the torrent has no video)
        let pickable = f.subtitle || crate::torrent::can_play_pick(&choice.files, id);
        let size = rtc_protocol::image::format_size(f.size);
        let (tag, tag_color) = if f.playable {
            ("VIDEO", tokens::live_text())
        } else if f.subtitle {
            ("SUB", tokens::warn())
        } else {
            ("FILE", tokens::text_3())
        };
        items.push(
            div()
                .id(("torrent-file", id))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(10.))
                .ml(px(indent))
                .px(px(12.))
                .py(px(8.))
                .rounded(px(8.))
                .border_1()
                .border_color(if selected {
                    tokens::accent()
                } else {
                    tokens::line()
                })
                .bg(if selected {
                    tokens::panel()
                } else {
                    tokens::raised()
                })
                .when(pickable, |el| {
                    el.hover(|s| s.border_color(tokens::line_strong()).bg(tokens::panel()))
                        .cursor_pointer()
                })
                // subtitles: a box to tick (loaded with the video)
                .children(f.subtitle.then(|| {
                    div()
                        .flex_none()
                        .size(px(16.))
                        .rounded(px(4.))
                        .border_1()
                        .border_color(if ticked {
                            tokens::accent()
                        } else {
                            tokens::line_strong()
                        })
                        .bg(if ticked { tokens::accent() } else { tokens::bg() })
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(11.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(tokens::white())
                        .child(if ticked { "✓" } else { "" })
                }))
                .child(
                    div()
                        .flex_none()
                        .text_size(px(11.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(tag_color)
                        .child(tag),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(if f.playable || ticked {
                            tokens::text()
                        } else {
                            tokens::text_2()
                        })
                        .child(f.name),
                )
                .children(suggested.then(|| {
                    div()
                        .flex_none()
                        .text_size(px(11.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(tokens::accent())
                        .child("Suggested")
                }))
                .child(
                    div()
                        .flex_none()
                        .text_size(px(12.5))
                        .text_color(tokens::text_2())
                        .child(size),
                )
                .on_click(cx.listener(move |v, _, _, cx| {
                    if f.subtitle {
                        v.toggle_torrent_subtitle(id, cx);
                    } else if pickable {
                        v.select_torrent_file(id, cx);
                    }
                }))
                .into_any_element(),
        );
    }
    // what Play starts: the selected file and the ticked subtitles
    let selected_name = choice
        .files
        .iter()
        .find(|f| f.id == choice.selected)
        .map(|f| f.name.clone())
        .unwrap_or_default();
    let sub_count = choice.subs.len();
    let sub_total = crate::torrent::subtitle_ids(&choice.files).len();
    let pill = |id: &'static str, label: &'static str, on: bool, cx: &mut Context<'_, RoomView>| {
        div()
            .id(id)
            .flex_none()
            .px(px(10.))
            .py(px(3.))
            .rounded(px(6.))
            .bg(tokens::raised())
            .border_1()
            .border_color(tokens::line_strong())
            .hover(|s| s.bg(tokens::panel()))
            .cursor_pointer()
            .text_size(px(12.))
            .font_weight(FontWeight::BOLD)
            .child(label)
            .on_click(cx.listener(move |v, _, _, cx| v.set_all_torrent_subtitles(on, cx)))
    };
    // subtitles (often dozens of languages): tick all or none at once
    let subs_bar = (sub_total > 0).then(|| {
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.5))
                    .text_color(tokens::text_2())
                    .child(format!("Subtitles: {sub_count} of {sub_total} ticked")),
            )
            .child(pill("torrent-subs-all", "Select all", true, cx))
            .child(pill("torrent-subs-none", "Deselect all", false, cx))
    });
    div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .w_full()
        .max_w(px(640.))
        .p(px(14.))
        .rounded(px(10.))
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(14.))
                                .font_weight(FontWeight::BOLD)
                                .child("Pick a file to stream"),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(px(12.))
                                .text_color(tokens::text_3())
                                .child(format!("{} · only this file is downloaded", choice.title)),
                        ),
                )
                .child(
                    div()
                        .id("cancel-torrent-pick")
                        .flex_none()
                        .px(px(10.))
                        .py(px(3.))
                        .rounded(px(6.))
                        .bg(tokens::raised())
                        .border_1()
                        .border_color(tokens::line_strong())
                        .hover(|s| s.bg(tokens::danger_line()).text_color(tokens::danger_text()))
                        .cursor_pointer()
                        .text_size(px(12.))
                        .font_weight(FontWeight::BOLD)
                        .child("Cancel")
                        .on_click(cx.listener(|v, _, _, cx| v.cancel_torrent(cx))),
                ),
        )
        .children(subs_bar)
        .child(
            // rows are `flex_none`: shrinking to fit, they never overflowed, so nothing scrolled
            div()
                .id("torrent-files")
                .flex_none()
                .max_h(px(360.))
                .overflow_y_scroll()
                // gpui scrolls every scrollable box under the pointer: only the list moves, the
                // page behind it stays put
                .on_scroll(|_, _, cx| cx.stop_propagation())
                .flex()
                .flex_col()
                .gap(px(6.))
                .children(items),
        )
        .child(
            div()
                .id("torrent-play")
                .flex()
                .items_center()
                .justify_center()
                .gap(px(8.))
                .w_full()
                .px(px(14.))
                .py(px(10.))
                .rounded(px(8.))
                .bg(tokens::accent())
                .hover(|s| s.bg(tokens::accent_press()))
                .cursor_pointer()
                .text_color(tokens::white())
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(14.))
                        .font_weight(FontWeight::BOLD)
                        .child(format!("▶ Play {selected_name}")),
                )
                .children((sub_count > 0).then(|| {
                    div()
                        .flex_none()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(format!(
                            "+ {sub_count} subtitle{}",
                            if sub_count == 1 { "" } else { "s" }
                        ))
                }))
                .on_click(cx.listener(|v, _, _, cx| v.play_torrent_choice(cx))),
        )
        .child(
            // "Keep torrent downloads", here where it's decided (it counts for this torrent)
            div()
                .id("torrent-keep")
                .flex()
                .items_center()
                .gap(px(10.))
                .cursor_pointer()
                .child(
                    div()
                        .flex_none()
                        .w(px(34.))
                        .h(px(20.))
                        .p(px(2.))
                        .rounded_full()
                        .flex()
                        .when(keep, gpui_kit::Styled::justify_end)
                        .bg(if keep {
                            tokens::accent()
                        } else {
                            tokens::line_strong()
                        })
                        .child(div().size(px(16.)).rounded_full().bg(tokens::white())),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Keep after watching"),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(tokens::text_3())
                                .child(if keep {
                                    "Saved in Downloads\\3RTC\\Torrents (qBittorrent can finish it)"
                                } else {
                                    "Deleted when you stop watching"
                                }),
                        ),
                )
                .on_click(cx.listener(move |v, _, _, cx| v.set_keep_torrents(!keep, cx))),
        )
        .into_any_element()
}

// ---- header -------------------------------------------------------------------------------------

/// "In sync · …" and "Now playing · …" (the header's middle, while something plays).
pub(crate) fn header_middle(room: &Snapshot) -> AnyElement {
    let Some(showing) = &room.watch.showing else {
        return div().flex_1().into_any_element();
    };
    let host = room
        .host
        .as_ref()
        .filter(|h| **h != room.me)
        .and_then(|h| room.members.iter().find(|(p, _)| p == h))
        .and_then(|(_, m)| m.username.clone());
    let pill = if room.host.as_ref() == Some(&room.me) {
        "In sync · You are host".to_owned()
    } else if let Some(h) = host {
        format!("In sync · {h}")
    } else {
        "In sync".to_owned()
    };
    div()
        .flex_1()
        .min_w_0()
        .flex()
        .items_center()
        .gap(px(12.))
        .child(
            div()
                .flex_none()
                .h(px(32.))
                .px(px(12.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded_full()
                .bg(Hsla {
                    a: 0.12,
                    ..tokens::live()
                })
                .text_color(tokens::live_text())
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(div().size(px(8.)).rounded_full().bg(tokens::live()))
                .child(pill),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(14.))
                .text_color(tokens::text_2())
                .child(format!("Now playing · {}", showing.title())),
        )
        .into_any_element()
}

/// Skip (n/m) and Exit, while something plays.
pub(crate) fn header_actions(room: &Snapshot, cx: &mut Context<'_, RoomView>) -> Option<AnyElement> {
    room.watch.showing.as_ref()?;
    // host control: what everyone watches is the host's to change
    if locked_for_me(room) {
        return None;
    }
    let voted = room.watch.skip_votes.contains(&room.username);
    let others = !room.members.is_empty();
    Some(
        div()
            .flex()
            .gap(px(8.))
            .when(others, |el| {
                el.child(
                    Button::new(
                        "rh-skip",
                        format!(
                            "Skip ({}/{})",
                            room.watch.skip_votes.len(),
                            room.watch.votes_needed
                        ),
                    )
                    .variant(if voted {
                        Variant::Primary
                    } else {
                        Variant::Secondary
                    })
                    .icon(Icon::SkipForward)
                    .on_click(cx.listener(|v, _, _, _| v.watch_cmd(WatchCommand::VoteSkip))),
                )
            })
            .child(
                Button::new("rh-exit", "Exit")
                    .variant(Variant::Secondary)
                    .icon(Icon::Close)
                    .on_click(cx.listener(|v, _, _, _| v.watch_cmd(WatchCommand::Exit))),
            )
            .into_any_element(),
    )
}

// ---- the Queue tab ------------------------------------------------------------------------------

fn provider_emoji(m: Option<&Media>) -> &'static str {
    match m.map(|m| m.provider) {
        Some(Provider::Twitch) => "📺",
        Some(Provider::Vimeo) => "🎞️",
        _ => "🔗",
    }
}

fn small_btn(
    id: impl Into<gpui_kit::ElementId>,
    label: &'static str,
    enabled: bool,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .size(px(26.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .bg(tokens::raised())
        .text_size(px(11.))
        .text_color(if enabled {
            tokens::text_2()
        } else {
            tokens::text_3()
        })
        .when(enabled, |el| el.cursor_pointer().hover(|s| s.bg(tokens::line())))
        .child(label)
}

pub(crate) fn queue_tab(
    view: &mut RoomView,
    room: &Snapshot,
    window: &Window,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let w = &room.watch;
    let voted = w.skip_votes.contains(&room.username);
    let needed = w.votes_needed;
    // host control: guests can add to the queue, the host plays, skips, orders and clears it
    let locked = locked_for_me(room);
    let now = w.showing.clone().map(|s| {
        let thumb = match &s {
            Showing::YouTube { id, .. } => view.thumb(id, cx),
            Showing::Link(_) | Showing::Local { .. } => None,
        };
        (s, thumb)
    });
    let next_title = w.queue.first().map(|q| q.title.clone());
    let items: Vec<AnyElement> = w
        .queue
        .iter()
        .enumerate()
        .map(|(n, item)| {
            let thumb = item.video_id.as_deref().and_then(|id| view.thumb(id, cx));
            let (play, up, down, rm) = (item.id.clone(), item.id.clone(), item.id.clone(), item.id.clone());
            let last = n + 1 == w.queue.len();
            div()
                .id(("queue-item", n))
                .flex()
                .items_center()
                .gap(px(10.))
                .p(px(8.))
                .rounded(px(12.))
                .bg(tokens::surface())
                .child(
                    div()
                        .w(px(22.))
                        .text_size(px(12.))
                        .text_color(tokens::text_3())
                        .child(format!("#{}", n + 1)),
                )
                .child(match thumb {
                    Some(t) => img(t)
                        .w(px(64.))
                        .h(px(36.))
                        .rounded(px(6.))
                        .object_fit(ObjectFit::Cover)
                        .into_any_element(),
                    None => div()
                        .w(px(64.))
                        .h(px(36.))
                        .rounded(px(6.))
                        .bg(tokens::raised())
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(if item.video_id.is_some() {
                            ""
                        } else {
                            provider_emoji(item.media.as_ref())
                        })
                        .into_any_element(),
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .truncate()
                                .child(item.title.clone()),
                        )
                        .child(
                            div()
                                .flex()
                                .gap(px(4.))
                                .text_size(px(12.))
                                .text_color(tokens::text_3())
                                .child("Added by")
                                .child(div().font_weight(FontWeight::BOLD).child(item.added_by.clone())),
                        ),
                )
                .when(!locked, |el| {
                    el.child(small_btn(("q-play", n), "▶", true).on_click(
                        cx.listener(move |v, _, _, _| v.watch_cmd(WatchCommand::QueuePlay(play.clone()))),
                    ))
                    .child(small_btn(("q-up", n), "▲", n > 0).when(n > 0, |el| {
                        el.on_click(cx.listener(move |v, _, _, _| {
                            v.watch_cmd(WatchCommand::QueueMove {
                                id: up.clone(),
                                to: n - 1,
                            });
                        }))
                    }))
                    .child(small_btn(("q-down", n), "▼", !last).when(!last, |el| {
                        el.on_click(cx.listener(move |v, _, _, _| {
                            v.watch_cmd(WatchCommand::QueueMove {
                                id: down.clone(),
                                to: n + 1,
                            });
                        }))
                    }))
                    .child(small_btn(("q-rm", n), "✕", true).on_click(
                        cx.listener(move |v, _, _, _| v.watch_cmd(WatchCommand::QueueRemove(rm.clone()))),
                    ))
                })
                .into_any_element()
        })
        .collect();
    let focused = gpui_kit::Focusable::focus_handle(view.watch.queue_link.read(cx), cx).is_focused(window);
    div()
        .id("queue-panel")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .p(px(14.))
        .flex()
        .flex_col()
        .gap(px(12.))
        // now playing
        .child(
            div()
                .p(px(12.))
                .rounded(px(14.))
                .bg(tokens::surface())
                .border_1()
                .border_color(tokens::line())
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(11.))
                                .font_weight(FontWeight::BOLD)
                                .text_color(tokens::live_text())
                                .child("NOW PLAYING"),
                        )
                        .when(now.is_some() && !locked, |el| {
                            el.child(
                                div()
                                    .id("q-skip")
                                    .px(px(10.))
                                    .py(px(4.))
                                    .rounded_full()
                                    .bg(if voted { tokens::accent() } else { tokens::raised() })
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .cursor_pointer()
                                    .on_click(cx.listener(|v, _, _, _| v.watch_cmd(WatchCommand::VoteSkip)))
                                    .child(format!(
                                        "⏭ {} ({}/{needed})",
                                        if voted { "Voted" } else { "Skip" },
                                        w.skip_votes.len()
                                    )),
                            )
                        }),
                )
                .child(match &now {
                    Some((s, thumb)) => div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(match thumb {
                            Some(t) => img(t.clone()).w(px(80.)).h(px(45.)).rounded(px(6.)).object_fit(ObjectFit::Cover).into_any_element(),
                            None => div()
                                .w(px(80.))
                                .h(px(45.))
                                .rounded(px(6.))
                                .bg(tokens::raised())
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(match s {
                                    Showing::Link(m) => provider_emoji(Some(m)),
                                    Showing::Local { .. } => "📁",
                                    Showing::YouTube { .. } => "",
                                })
                                .into_any_element(),
                        })
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).line_clamp(2).child(s.title()))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .text_size(px(12.))
                                        .text_color(tokens::text_3())
                                        .child(div().size(px(6.)).rounded_full().bg(tokens::live()))
                                        .child("Synced P2P")
                                        .when_some(next_title.clone().filter(|_| !locked), |el, t| {
                                            el.child(
                                                div()
                                                    .id("q-next")
                                                    .ml(px(6.))
                                                    .text_color(tokens::text())
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .cursor_pointer()
                                                    .tooltip(move |window, cx| {
                                                        gpui_kit::component::tooltip::Tooltip::new(format!(
                                                            "Skip immediately to: \"{t}\""
                                                        ))
                                                        .build(window, cx)
                                                    })
                                                    .on_click(cx.listener(|v, _, _, _| v.watch_cmd(WatchCommand::QueueNext)))
                                                    .child("Next ⏭"),
                                            )
                                        }),
                                ),
                        )
                        .into_any_element(),
                    None => div()
                        .text_size(px(13.))
                        .text_color(tokens::text_3())
                        .child("No video is currently playing")
                        .into_any_element(),
                })
                .when(now.is_some() && needed > 0, |el| {
                    #[allow(clippy::cast_precision_loss)]
                    let frac = (w.skip_votes.len() as f32 / needed as f32).min(1.0);
                    el.child(
                        div().h(px(4.)).rounded_full().bg(tokens::raised()).child(
                            div().h_full().w(gpui_kit::relative(frac)).rounded_full().bg(tokens::accent()),
                        ),
                    )
                }),
        )
        // add a link
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .h(px(40.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .rounded(px(10.))
                        .border_1()
                        .border_color(if focused { tokens::focus() } else { tokens::line_strong() })
                        .bg(tokens::bg())
                        .child(Input::new(&view.watch.queue_link).appearance(false).small()),
                )
                .child(
                    Button::new("queue-add", if view.watch.resolving { "..." } else { "+ Add" })
                        .variant(Variant::Primary)
                        .min_height(px(40.))
                        .on_click(cx.listener(|v, _, window, cx| v.submit_link(true, window, cx))),
                ),
        )
        .when_some(view.watch.queue_error.clone(), |el, e| {
            el.child(div().text_size(px(13.)).text_color(tokens::danger_text()).child(e))
        })
        // a magnet pasted here: its file list and status show here too (the stage may be playing)
        .children(torrent_box(view, cx))
        // up next
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(div().text_size(px(14.)).font_weight(FontWeight::BOLD).child("Up Next"))
                .child(
                    div()
                        .px(px(8.))
                        .rounded_full()
                        .bg(tokens::raised())
                        .text_size(px(12.))
                        .child(w.queue.len().to_string()),
                )
                .child(div().flex_1())
                .when(!w.queue.is_empty() && !locked, |el| {
                    el.child(
                        div()
                            .id("q-clear")
                            .text_size(px(12.))
                            .text_color(tokens::text_3())
                            .cursor_pointer()
                            .hover(|s| s.text_color(tokens::text()))
                            .on_click(cx.listener(|v, _, _, _| v.watch_cmd(WatchCommand::QueueClear)))
                            .child("Clear All"),
                    )
                }),
        )
        .child(if items.is_empty() {
            div()
                .py(px(24.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .text_center()
                .child(div().text_size(px(28.)).child("📑"))
                .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child("Queue is empty"))
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(gpui_kit::relative(1.5))
                        .text_color(tokens::text_3())
                        .child("Paste a YouTube, Vimeo, Twitch or video link, or click \"+ Queue\" on presets to add videos to the shared queue."),
                )
                .into_any_element()
        } else {
            div().flex().flex_col().gap(px(8.)).children(items).into_any_element()
        })
        .into_any_element()
}
