//! A video file from this computer (`LocalVideoSyncPlayer.tsx`): mpv plays it natively in a
//! child window over the stage (`rtc_platform_win::VideoPlayer`, like VLC or PotPlayer), with
//! GPUI controls under it. Everyone plays their own copy; the room keeps the copies in sync by
//! the file's name and size (the rules are in `rtc_core`, `WatchCommand::PlayFile`).

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::{
    AnyElement, Bounds, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, ParentElement as _, PathPromptOptions, Pixels, SharedString,
    StatefulInteractiveElement as _, Styled as _, Task, Window, canvas, div, prelude::FluentBuilder as _, px,
    relative,
};
use rtc_core::{PlayerReport, Showing, UserAction, WatchCommand};
use rtc_engine::{StreamProgress, StreamReader};
use rtc_platform_win::{
    ParentWindow, StreamSource, Track, TrackKind, VideoAction, VideoEvent, VideoPlayer, VideoSource,
};
use rtc_ui::button::{Button, Variant};
use rtc_ui::{Icon, icon, tokens};

use crate::view::RoomView;
use crate::watch::Live;

/// Files the player is offered (what mpv plays well); anything else gets a note.
const VIDEO_EXT: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "ts", "m2ts", "mts", "mpg", "mpeg", "ogv",
    "3gp", "vob", "divx", "rmvb",
];
/// Subtitle files (added to the video playing here).
const SUB_EXT: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "sup"];
/// The control bar under the video.
const BAR_H: f32 = 52.;
/// In full screen, height of the bottom trigger region to reveal controls.
pub(crate) const FULLSCREEN_BOTTOM_ZONE: f32 = BAR_H;
/// In full screen, the pointer hides after the mouse was still this long.
const FULLSCREEN_HIDE_DELAY: Duration = Duration::from_millis(2000);
/// In full screen, the controls bar stays this long after the pointer left the bottom edge.
const FULLSCREEN_LEAVE_DELAY: Duration = Duration::from_millis(800);
/// How long a click on the video waits to see whether it's the start of a double click.
const CLICK_WAIT: Duration = Duration::from_millis(250);

fn has_ext(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| list.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

fn is_video(path: &Path) -> bool {
    has_ext(path, VIDEO_EXT)
}

fn is_torrent(path: &Path) -> bool {
    has_ext(path, &["torrent"])
}

fn is_subtitle(path: &Path) -> bool {
    has_ext(path, SUB_EXT)
}

/// "1:05", "1:02:09".
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub(crate) fn clock(secs: f64) -> String {
    let s = if secs.is_finite() { secs.max(0.0) as u64 } else { 0 };
    let (h, m, s) = (s / 3600, (s / 60) % 60, s % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// "700 MB", "1.4 GB".
#[allow(clippy::cast_precision_loss)]
pub(crate) fn size_text(bytes: u64) -> String {
    let b = bytes as f64;
    if b >= 1e9 {
        format!("{:.1} GB", b / 1e9)
    } else if b >= 1e6 {
        format!("{:.0} MB", b / 1e6)
    } else if b >= 1e3 {
        format!("{:.0} KB", b / 1e3)
    } else {
        format!("{bytes} bytes")
    }
}

/// How a track is named in the menus.
fn track_label(t: &Track) -> String {
    let parts: Vec<&str> = [t.title.as_str(), t.lang.as_str()]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        format!("Track {}", t.id)
    } else {
        parts.join(" · ")
    }
}

type Events = (u64, VideoEvent);

/// The local video's state on screen.
pub(crate) struct LocalUi {
    /// The file chosen here (played when the room opens it).
    pub(crate) file: Option<PathBuf>,
    /// Which player the events are from (an old one's late events are dropped).
    generation: u64,
    pub(crate) time: f64,
    pub(crate) duration: f64,
    pub(crate) playing: bool,
    pub(crate) buffering: bool,
    /// mpv's volume (100: the file's own level).
    pub(crate) volume: f64,
    pub(crate) muted: bool,
    pub(crate) tracks: Vec<Track>,
    /// The open track menu.
    pub(crate) menu: Option<TrackKind>,
    pub(crate) fullscreen: bool,
    /// Whether the OS window was put into full screen for this video.
    pub(crate) video_fullscreen_window: bool,
    /// The window's HWND handle for cursor tracking.
    pub(crate) hwnd: isize,
    /// The window scale factor for DPI-aware mouse hit testing.
    pub(crate) scale: f32,
    /// In full screen, whether the bottom controls panel is currently shown.
    pub(crate) fullscreen_controls: bool,
    /// When the cursor moved out of the panel in full screen.
    pub(crate) controls_left_at: Option<Instant>,
    /// Last time play/pause was toggled, for debouncing multiple events.
    pub(crate) last_play_toggle: Option<Instant>,
    /// Task that auto-hides controls or shows them when cursor reaches bottom in full screen.
    pub(crate) fullscreen_task: Option<Task<()>>,
    /// A click's play / pause, waiting to see whether a second click makes it a double click
    /// (dropping it cancels it).
    pending_click: Option<Task<()>>,
    /// When a click's play / pause last happened (a double click right after undoes it).
    click_toggled_at: Option<Instant>,
    /// The offer card's note (the wrong file was chosen).
    pub(crate) offer_error: Option<SharedString>,
    /// The file we offer to viewers (the engine serves it).
    sharing: bool,
    /// A stream of the room's file (its name and reader), once it started.
    stream: Option<(String, StreamReader)>,
    /// "Stream from …" was pressed: waiting for the owner.
    pub(crate) asking: Option<String>,
    /// How the stream is doing.
    pub(crate) progress: Option<StreamProgress>,
    /// What's in the file someone shares (its name, one line).
    pub(crate) remote_format: Option<(String, String)>,
    /// Viewers who can't play our file properly.
    pub(crate) problems: Vec<String>,
    /// Subtitles the room shared, waiting for the player to open.
    room_subtitles: Option<PathBuf>,
    tx: tokio::sync::mpsc::UnboundedSender<Events>,
    rx: Option<tokio::sync::mpsc::UnboundedReceiver<Events>>,
    scrub: Rc<Cell<Option<Bounds<Pixels>>>>,
    volume_bar: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl LocalUi {
    pub(crate) fn new() -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            file: None,
            generation: 0,
            time: 0.0,
            duration: 0.0,
            playing: false,
            buffering: false,
            volume: 100.0,
            muted: false,
            tracks: Vec::new(),
            menu: None,
            fullscreen: false,
            video_fullscreen_window: false,
            hwnd: 0,
            scale: 1.0,
            fullscreen_controls: false,
            controls_left_at: None,
            last_play_toggle: None,
            fullscreen_task: None,
            pending_click: None,
            click_toggled_at: None,
            offer_error: None,
            sharing: false,
            stream: None,
            asking: None,
            progress: None,
            remote_format: None,
            problems: Vec::new(),
            room_subtitles: None,
            tx,
            rx: Some(rx),
            scrub: Rc::new(Cell::new(None)),
            volume_bar: Rc::new(Cell::new(None)),
        }
    }

    /// The chosen file, if it's the one called `name`.
    pub(crate) fn path_for(&self, name: &str) -> Option<PathBuf> {
        self.file
            .as_ref()
            .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy() == name))
            .cloned()
    }

    /// The stream of the room's file, if it's the one called `name`.
    pub(crate) fn stream_for(&self, name: &str) -> Option<StreamReader> {
        self.stream
            .as_ref()
            .filter(|(n, _)| n == name)
            .map(|(_, r)| r.clone())
    }

    /// Streamed (not our own copy).
    pub(crate) const fn streaming(&self) -> bool {
        self.stream.is_some()
    }

    /// A new video (or none): the position and tracks start over.
    pub(crate) fn reset(&mut self) {
        self.generation += 1;
        self.time = 0.0;
        self.duration = 0.0;
        self.playing = false;
        self.buffering = false;
        self.tracks.clear();
        self.menu = None;
        self.fullscreen_controls = false;
        self.controls_left_at = None;
        self.pending_click = None;
        self.offer_error = None;
    }
}

/// A shared video as mpv reads it (the engine's block cache).
pub(crate) struct Streamed(pub(crate) StreamReader);

impl StreamSource for Streamed {
    fn size(&self) -> u64 {
        self.0.size()
    }

    fn read_at(&self, pos: u64, buf: &mut [u8]) -> Result<usize, String> {
        self.0.read_at(pos, buf)
    }

    fn close(&self) {
        self.0.close();
    }

    fn name(&self) -> &str {
        self.0.name()
    }
}

/// Opens the waiting file in mpv over the stage (called once the stage has a size).
pub(crate) fn open_player(
    v: &mut RoomView,
    window: &Window,
    bounds: Bounds<Pixels>,
    source: VideoSource,
    start: f64,
    playing: bool,
) {
    let Some(parent) = ParentWindow::of(window) else {
        v.watch.error = Some("Video files play in the Windows app.".into());
        return;
    };
    let generation = v.watch.local.generation;
    let tx = v.watch.local.tx.clone();
    match VideoPlayer::open(
        parent,
        crate::watch::physical(bounds, window.scale_factor()),
        v.player_visible(),
        source,
        start,
        playing,
        move |e| {
            let _ = tx.send((generation, e));
        },
    ) {
        Ok(p) => {
            // the volume carries over from the last video
            if (v.watch.local.volume - 100.0).abs() > f64::EPSILON {
                p.set_volume(v.watch.local.volume);
            }
            if v.watch.local.muted {
                p.set_mute(true);
            }
            if let Some(subs) = v.watch.local.room_subtitles.take() {
                p.add_subtitle(&subs);
            }
            v.watch.local.playing = playing;
            v.watch.local.time = start;
            *v.watch.player.borrow_mut() = Some(Live::Video(p));
        }
        Err(e) => v.watch.error = Some(e.into()),
    }
}

impl RoomView {
    /// Our own file plays: offer it to viewers who don't have it.
    pub(crate) fn share_own_file(&mut self, path: &Path) {
        self.share_own_torrent(path, None, None, None);
    }

    /// Offers our own file or torrent stream to the room.
    pub(crate) fn share_own_torrent(
        &mut self,
        path: &Path,
        name: Option<&str>,
        size: Option<u64>,
        stream_url: Option<String>,
    ) {
        let name = name.map(ToOwned::to_owned).unwrap_or_else(|| {
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        let file_size = size
            .or_else(|| std::fs::metadata(path).ok().map(|m| m.len()))
            .unwrap_or(0);
        if let Some(e) = &self.engine {
            e.share_file(Some(rtc_engine::ShareFileSpec {
                path: path.to_path_buf(),
                name,
                size: file_size,
                stream_url,
            }));
            self.watch.local.sharing = true;
        }
    }

    /// Subtitles someone shared: shown over the video file here.
    pub(crate) fn room_subtitles(&mut self, name: &str, vtt: &str, cx: &mut Context<'_, Self>) {
        let dir = std::env::temp_dir().join("3RTC").join("subtitles");
        let _ = std::fs::create_dir_all(&dir);
        let safe: String = name
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || " .-_()".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .take(80)
            .collect();
        let stem = safe.trim_end_matches(".vtt");
        let path = dir.join(format!("{stem}.vtt"));
        if std::fs::write(&path, vtt).is_err() {
            return;
        }
        let mut added = false;
        self.with_video(|p| {
            p.add_subtitle(&path);
            added = true;
        });
        if !added {
            self.watch.local.room_subtitles = Some(path);
        }
        cx.notify();
    }

    /// The video closed: stop offering our file, or stop the stream we watched.
    pub(crate) fn end_local_sharing(&mut self) {
        let l = &mut self.watch.local;
        if l.sharing {
            l.sharing = false;
            if let Some(e) = &self.engine {
                e.share_file(None);
            }
        }
        if let Some((_, reader)) = self.watch.local.stream.take() {
            reader.close();
            if let Some(e) = &self.engine {
                e.stop_stream();
            }
        }
        self.watch.local.progress = None;
        self.watch.local.asking = None;
        self.watch.local.problems.clear();
        self.watch.local.room_subtitles = None;
    }

    /// "Stream from …": ask the room for its file.
    fn ask_stream(&mut self, name: String, cx: &mut Context<'_, Self>) {
        crate::torrent::TorrentService::cancel_stream(&self.runtime);
        self.watch.torrent_stream_url = None;
        self.watch.torrent_stats = None;
        self.watch.torrent_status = None;
        self.watch.torrent_choice = None;
        self.watch.torrent_subs.clear();
        if let Some(e) = &self.engine {
            e.stream_from(name.clone());
            self.watch.local.asking = Some(name);
            self.watch.local.offer_error = None;
            cx.notify();
        }
    }

    /// The owner started streaming to us: play it where the room is.
    pub(crate) fn stream_ready(
        &mut self,
        name: String,
        _size: u64,
        reader: StreamReader,
        cx: &mut Context<'_, Self>,
    ) {
        crate::torrent::TorrentService::cancel_stream(&self.runtime);
        self.watch.torrent_stream_url = None;
        self.watch.torrent_stats = None;
        self.watch.torrent_status = None;
        self.watch.torrent_choice = None;
        self.watch.torrent_subs.clear();
        if self.watch.local.asking.take().is_none() {
            reader.close();
            return;
        }
        if let Some((_, old)) = self.watch.local.stream.replace((name.clone(), reader)) {
            old.close();
        }
        self.watch_cmd(WatchCommand::Streaming { name });
        cx.notify();
    }

    /// The stream stopped (its owner left or stopped sharing).
    pub(crate) fn stream_ended(&mut self, why: String, cx: &mut Context<'_, Self>) {
        self.watch.local.asking = None;
        if let Some((name, reader)) = self.watch.local.stream.take() {
            reader.close();
            self.watch_cmd(WatchCommand::StreamLost { name });
        }
        self.watch.local.progress = None;
        self.show_toast(why, cx);
    }

    pub(crate) fn stream_progress(&mut self, p: StreamProgress, cx: &mut Context<'_, Self>) {
        if self.watch.local.stream.is_some() {
            self.watch.local.progress = Some(p);
            cx.notify();
        }
    }

    /// Listens to the local video player (its events need the window: full screen).
    pub(crate) fn start_video_events(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(mut rx) = self.watch.local.rx.take() else {
            return;
        };
        cx.spawn_in(window, async move |this, cx| {
            while let Some((generation, e)) = rx.recv().await {
                if this
                    .update_in(cx, |v, window, cx| v.on_video_event(generation, e, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn with_video(&self, f: impl FnOnce(&VideoPlayer)) {
        if let Some(p) = self.watch.player.borrow().as_ref().and_then(Live::video) {
            f(p);
        }
    }

    fn on_video_event(
        &mut self,
        generation: u64,
        e: VideoEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if generation != self.watch.local.generation {
            return;
        }
        let l = &mut self.watch.local;
        let report = match e {
            VideoEvent::Ready { duration } => {
                l.duration = duration;
                // torrent subtitles that finished before the player was up
                for path in std::mem::take(&mut self.watch.torrent_subs) {
                    self.load_torrent_subtitle(&path, cx);
                }
                None
            }
            VideoEvent::State {
                time,
                playing,
                buffering,
                duration,
            } => {
                l.time = time;
                l.playing = playing;
                l.buffering = buffering;
                l.duration = duration;
                Some(PlayerReport::State {
                    time,
                    playing,
                    buffering,
                    duration,
                })
            }
            VideoEvent::User { action, time } => {
                l.time = time;
                let action = match action {
                    VideoAction::Play => UserAction::Play,
                    VideoAction::Pause => UserAction::Pause,
                    VideoAction::Seek => UserAction::Seek,
                };
                Some(PlayerReport::User { action, time })
            }
            VideoEvent::Tracks(t) => {
                l.tracks = t;
                None
            }
            VideoEvent::Volume { volume, muted } => {
                l.volume = volume;
                l.muted = muted;
                None
            }
            VideoEvent::Ended => Some(PlayerReport::Ended),
            VideoEvent::Fullscreen => {
                self.toggle_video_fullscreen(window, cx);
                None
            }
            VideoEvent::Escape => {
                if l.fullscreen {
                    self.toggle_video_fullscreen(window, cx);
                }
                None
            }
            VideoEvent::Click => {
                self.video_click(cx);
                None
            }
            VideoEvent::DblClick => {
                self.video_double_click(window, cx);
                None
            }
            VideoEvent::PlayPause => {
                if !self.room.as_ref().is_some_and(crate::watch::locked_for_me) {
                    self.video_toggle_play(cx);
                }
                None
            }
            VideoEvent::SeekBack => {
                if self.settings.player_arrow_keys {
                    self.video_backward_5(cx);
                }
                None
            }
            VideoEvent::SeekForward => {
                if self.settings.player_arrow_keys {
                    self.video_forward_5(cx);
                }
                None
            }
            VideoEvent::VolumeUp => {
                if self.settings.player_arrow_keys {
                    let v = (self.watch.local.volume + 5.0).clamp(0.0, 100.0);
                    self.video_volume(v, cx);
                }
                None
            }
            VideoEvent::VolumeDown => {
                if self.settings.player_arrow_keys {
                    let v = (self.watch.local.volume - 5.0).clamp(0.0, 100.0);
                    self.video_volume(v, cx);
                }
                None
            }
            VideoEvent::WheelUp => {
                if self.settings.player_scroll_volume {
                    let v = (self.watch.local.volume + 5.0).clamp(0.0, 100.0);
                    self.video_volume(v, cx);
                }
                None
            }
            VideoEvent::WheelDown => {
                if self.settings.player_scroll_volume {
                    let v = (self.watch.local.volume - 5.0).clamp(0.0, 100.0);
                    self.video_volume(v, cx);
                }
                None
            }
            VideoEvent::Mute => {
                self.video_mute(cx);
                None
            }
            VideoEvent::Subtitles => {
                self.cycle_subtitles(cx);
                None
            }
            VideoEvent::MouseBack => {
                if self.settings.player_mouse_nav_seek {
                    self.video_backward_5(cx);
                }
                None
            }
            VideoEvent::MouseForward => {
                if self.settings.player_mouse_nav_seek {
                    self.video_forward_5(cx);
                }
                None
            }
            VideoEvent::Error(message) => {
                tracing::warn!("video: {message}");
                // its window would cover the message
                self.watch.player.borrow_mut().take();
                self.watch.error = Some(message.into());
                None
            }
        };
        if let Some(r) = report {
            self.watch_cmd(WatchCommand::Player(r));
        }
        cx.notify();
    }

    /// "browse files", "I have this file": the system's file picker.
    pub(crate) fn choose_video_file(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        // host control: what plays is the host's to choose
        if self.room.as_ref().is_some_and(crate::watch::locked_for_me) {
            self.watch.link_error = Some("Host controls are on: only the host can start a video.".into());
            cx.notify();
            return;
        }
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Play".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            if let Some(path) = paths.into_iter().next() {
                let _ = this.update_in(cx, |v, _, cx| v.play_path(path, cx));
            }
        })
        .detach();
    }

    /// Files dropped on the stage: a video plays, a subtitle file joins the video playing here.
    pub(crate) fn dropped_paths(&mut self, paths: &[PathBuf], cx: &mut Context<'_, Self>) {
        // host control: what plays is the host's to choose
        if self.room.as_ref().is_some_and(crate::watch::locked_for_me) {
            self.watch.link_error = Some("Host controls are on: only the host can start a video.".into());
            cx.notify();
            return;
        }
        if let Some(p) = paths.iter().find(|p| is_torrent(p)) {
            self.play_torrent(crate::torrent::TorrentInput::TorrentFile(p.clone()), cx);
            return;
        }
        if let Some(p) = paths.iter().find(|p| is_video(p)) {
            self.play_path(p.clone(), cx);
        } else if let Some(p) = paths.first() {
            if is_torrent(p) {
                self.play_torrent(crate::torrent::TorrentInput::TorrentFile(p.clone()), cx);
                return;
            }
            self.play_path(p.clone(), cx);
        }
    }

    fn play_path(&mut self, path: PathBuf, cx: &mut Context<'_, Self>) {
        if is_torrent(&path) {
            self.play_torrent(crate::torrent::TorrentInput::TorrentFile(path), cx);
            return;
        }
        if is_subtitle(&path) {
            self.add_subtitle(&path, cx);
            return;
        }
        if !is_video(&path) {
            self.show_toast(
                "That isn't a video or torrent file (MP4, MKV, WebM, MOV, .torrent…)",
                cx,
            );
            return;
        }
        crate::torrent::TorrentService::cancel_stream(&self.runtime);
        self.watch.torrent_status = None;
        self.watch.torrent_choice = None;
        self.watch.torrent_subs.clear();
        self.watch.torrent_stats = None;
        let size = match std::fs::metadata(&path) {
            Ok(m) if m.is_file() => m.len(),
            _ => {
                self.show_toast("Couldn't open that file", cx);
                return;
            }
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // the room plays someone's file: ours must be that one
        if let Some(Showing::Local {
            name: theirs,
            have: false,
            ..
        }) = self.room.as_ref().and_then(|r| r.watch.showing.as_ref())
            && *theirs != name
        {
            self.watch.local.offer_error =
                Some(format!("That's “{name}”. The room is playing “{theirs}”: choose that file.").into());
            cx.notify();
            return;
        }
        self.watch.local.offer_error = None;
        self.watch.local.file = Some(path);
        self.watch_cmd(WatchCommand::PlayFile { name, size });
        cx.notify();
    }

    /// A subtitle file picked with a torrent's video finished downloading: into the player
    /// (now, or once it's up). The first one is shared with the room too.
    pub(crate) fn torrent_subtitle(&mut self, path: PathBuf, cx: &mut Context<'_, Self>) {
        let playing = self
            .watch
            .player
            .borrow()
            .as_ref()
            .and_then(Live::video)
            .is_some();
        if playing {
            self.load_torrent_subtitle(&path, cx);
        } else {
            self.watch.torrent_subs.push(path);
        }
    }

    fn load_torrent_subtitle(&mut self, path: &Path, cx: &mut Context<'_, Self>) {
        if self.watch.torrent_sub_shared {
            self.with_video(|p| p.add_subtitle(path));
            cx.notify();
        } else {
            self.watch.torrent_sub_shared = true;
            self.add_subtitle(path, cx);
        }
    }

    fn add_subtitle(&mut self, path: &Path, cx: &mut Context<'_, Self>) {
        let mut added = false;
        self.with_video(|p| {
            p.add_subtitle(path);
            added = true;
        });
        if added {
            self.watch.local.menu = None;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // everyone watching gets them too (as WebVTT, like the web app's `subtitle-share`)
            let vtt = std::fs::read(path)
                .ok()
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .and_then(|t| rtc_core::files::to_vtt(&name, &t));
            if let Some(vtt) = vtt {
                self.watch_cmd(WatchCommand::ShareSubtitles {
                    name: name.clone(),
                    vtt,
                });
                self.show_toast(format!("Subtitles shared with the room: {name}"), cx);
            } else {
                self.show_toast(format!("Subtitles: {name}"), cx);
            }
        } else {
            self.show_toast("Play a video first, then add its subtitles", cx);
        }
    }

    fn choose_subtitle_file(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Add subtitles".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            if let Some(path) = paths.into_iter().next() {
                let _ = this.update_in(cx, |v, _, cx| v.add_subtitle(&path, cx));
            }
        })
        .detach();
    }

    /// A click on the video. With double click for full screen on, its play / pause waits a
    /// moment ([`CLICK_WAIT`], or the system's double-click time if shorter) and a double click
    /// cancels it (or undoes it, when the second click was slower than that), so going in or out
    /// of full screen never pauses the video, as in VLC. Otherwise it plays / pauses at once.
    pub(crate) fn video_click(&mut self, cx: &mut Context<'_, Self>) {
        if self.pop.is_some() {
            self.pop = None;
            cx.notify();
            return;
        }
        if !self.settings.player_click_play || self.room.as_ref().is_some_and(crate::watch::locked_for_me) {
            return;
        }
        if !self.settings.player_double_click_fullscreen {
            self.video_toggle_play(cx);
            return;
        }
        let wait = CLICK_WAIT.min(Duration::from_millis(rtc_platform_win::double_click_ms()));
        self.watch.local.pending_click = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            let _ = this.update(cx, |v, cx| {
                v.watch.local.pending_click = None;
                v.video_toggle_play(cx);
                v.watch.local.click_toggled_at = Some(Instant::now());
            });
        }));
    }

    /// A double click on the video: full screen in or out, and the first click's play / pause
    /// never happens.
    pub(crate) fn video_double_click(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if !self.settings.player_double_click_fullscreen {
            return;
        }
        let waiting = self.watch.local.pending_click.take().is_some();
        let double_click = Duration::from_millis(rtc_platform_win::double_click_ms());
        let toggled = self
            .watch
            .local
            .click_toggled_at
            .take()
            .is_some_and(|t| t.elapsed() < double_click);
        if !waiting && toggled {
            // the first click already played / paused: put it back
            self.watch.local.last_play_toggle = None;
            self.video_toggle_play(cx);
        }
        self.toggle_video_fullscreen(window, cx);
    }

    /// Clips the video window to show the controls bar in full screen, or not. Done as soon as
    /// the bar shows or hides, not on the next frame: the bar must never linger over the video.
    pub(crate) fn sync_fullscreen_clip(&self) {
        let l = &self.watch.local;
        #[allow(clippy::cast_possible_truncation)]
        let clip = if l.fullscreen && l.fullscreen_controls {
            (FULLSCREEN_BOTTOM_ZONE * self.watch.scale.get()).round() as i32
        } else {
            0
        };
        if let Some(p) = self.watch.player.borrow().as_ref() {
            p.set_bottom_clip(clip);
        }
    }

    /// The bar's play/pause: like a click on the video (the room follows).
    pub(crate) fn video_toggle_play(&mut self, cx: &mut Context<'_, Self>) {
        if self.room.as_ref().is_some_and(crate::watch::locked_for_me) {
            return;
        }
        if let Some(t) = self.watch.local.last_play_toggle
            && t.elapsed() < Duration::from_millis(300)
        {
            return;
        }
        self.watch.local.last_play_toggle = Some(Instant::now());
        let playing = self.watch.local.playing;
        let mut done = false;
        if let Some(p) = self.watch.player.borrow().as_ref() {
            if playing {
                p.pause(None);
            } else {
                p.play(None);
            }
            done = true;
        } else {
            self.with_video(|p| {
                if playing {
                    p.pause(None);
                } else {
                    p.play(None);
                }
                done = true;
            });
        }
        if !done {
            return;
        }
        let l = &mut self.watch.local;
        l.playing = !playing;
        let action = if playing {
            UserAction::Pause
        } else {
            UserAction::Play
        };
        let time = l.time;
        self.watch_cmd(WatchCommand::Player(PlayerReport::User { action, time }));
        cx.notify();
    }

    pub(crate) fn video_seek(&mut self, to: f64, cx: &mut Context<'_, Self>) {
        let mut done = false;
        if let Some(p) = self.watch.player.borrow().as_ref() {
            p.seek(to);
            done = true;
        } else {
            self.with_video(|p| {
                p.seek(to);
                done = true;
            });
        }
        if done {
            self.watch.local.time = to;
            self.watch_cmd(WatchCommand::Player(PlayerReport::User {
                action: UserAction::Seek,
                time: to,
            }));
            cx.notify();
        }
    }

    pub(crate) fn video_forward_5(&mut self, cx: &mut Context<'_, Self>) {
        if self.room.as_ref().is_some_and(crate::watch::locked_for_me) {
            return;
        }
        let cur = self.watch.local.time;
        let dur = if self.watch.local.duration > 0.0 {
            self.watch.local.duration
        } else {
            cur + 100.0
        };
        let step = self.settings.seek_step_secs.max(1.0);
        let to = (cur + step).min(dur);
        self.video_seek(to, cx);
    }

    pub(crate) fn video_backward_5(&mut self, cx: &mut Context<'_, Self>) {
        if self.room.as_ref().is_some_and(crate::watch::locked_for_me) {
            return;
        }
        let cur = self.watch.local.time;
        let step = self.settings.seek_step_secs.max(1.0);
        let to = (cur - step).max(0.0);
        self.video_seek(to, cx);
    }

    pub(crate) fn video_volume(&mut self, volume: f64, cx: &mut Context<'_, Self>) {
        let muted = self.watch.local.muted;
        self.with_video(|p| {
            p.set_volume(volume);
            if muted && volume > 0.0 {
                p.set_mute(false);
            }
        });
        self.watch.local.volume = volume;
        if volume > 0.0 {
            self.watch.local.muted = false;
        }
        cx.notify();
    }

    fn video_mute(&mut self, cx: &mut Context<'_, Self>) {
        let muted = !self.watch.local.muted;
        self.with_video(|p| p.set_mute(muted));
        self.watch.local.muted = muted;
        cx.notify();
    }

    fn video_track(&mut self, kind: TrackKind, id: Option<i64>, cx: &mut Context<'_, Self>) {
        self.with_video(|p| match (kind, id) {
            (TrackKind::Subtitle, id) => p.set_subtitle(id),
            (TrackKind::Audio, Some(id)) => p.set_audio(id),
            _ => {}
        });
        for t in &mut self.watch.local.tracks {
            if t.kind == kind {
                t.selected = Some(t.id) == id;
            }
        }
        self.watch.local.menu = None;
        cx.notify();
    }

    pub(crate) fn cycle_subtitles(&mut self, cx: &mut Context<'_, Self>) {
        let subs: Vec<i64> = self
            .watch
            .local
            .tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Subtitle)
            .map(|t| t.id)
            .collect();
        if subs.is_empty() {
            return;
        }
        let cur = self
            .watch
            .local
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Subtitle && t.selected)
            .map(|t| t.id);
        let next = match cur {
            None => Some(subs[0]),
            Some(id) => {
                let idx = subs.iter().position(|&x| x == id).unwrap_or(0);
                if idx + 1 < subs.len() {
                    Some(subs[idx + 1])
                } else {
                    None
                }
            }
        };
        self.video_track(TrackKind::Subtitle, next, cx);
    }

    fn toggle_track_menu(&mut self, kind: TrackKind, cx: &mut Context<'_, Self>) {
        self.watch.local.menu = if self.watch.local.menu == Some(kind) {
            None
        } else {
            Some(kind)
        };
        cx.notify();
    }

    /// Full screen: only the video and its bar, the window over the whole screen.
    pub(crate) fn toggle_video_fullscreen(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let on = !self.watch.local.fullscreen;
        self.watch.local.fullscreen = on;
        if on {
            self.watch.local.hwnd = rtc_platform_win::raw_hwnd(window);
            self.watch.local.scale = window.scale_factor();
            // the bar shows when the pointer goes to the bottom edge
            self.watch.local.fullscreen_controls = false;
            self.watch.local.controls_left_at = None;
            rtc_platform_win::set_cursor_visible(true);
            if !window.is_fullscreen() {
                self.watch.local.video_fullscreen_window = true;
                window.toggle_fullscreen();
            }
            self.ensure_fullscreen_watch(cx);
        } else {
            rtc_platform_win::set_cursor_visible(true);
            self.watch.local.fullscreen_controls = false;
            self.watch.local.controls_left_at = None;
            self.watch.local.fullscreen_task = None;
            if self.watch.local.video_fullscreen_window {
                self.watch.local.video_fullscreen_window = false;
                if window.is_fullscreen() {
                    window.toggle_fullscreen();
                }
            } else if window.is_fullscreen() {
                window.toggle_fullscreen();
            }
        }
        self.set_web_player_fullscreen(on);
        self.sync_fullscreen_clip();
        cx.notify();
    }

    /// Leaves full screen when the video is gone (drawing found it so).
    pub(crate) fn end_video_fullscreen(&mut self, window: &mut Window) {
        rtc_platform_win::set_cursor_visible(true);
        self.watch.local.fullscreen = false;
        self.watch.local.fullscreen_controls = false;
        self.watch.local.controls_left_at = None;
        self.watch.local.fullscreen_task = None;
        self.set_web_player_fullscreen(false);
        if self.watch.local.video_fullscreen_window || window.is_fullscreen() {
            self.watch.local.video_fullscreen_window = false;
            if window.is_fullscreen() {
                window.toggle_fullscreen();
            }
        }
    }

    /// Toggles full screen for the entire desktop application window.
    pub(crate) fn toggle_app_fullscreen(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        window.toggle_fullscreen();
        cx.notify();
    }

    /// Full screen: the controls bar shows only while the pointer is at the bottom edge (and
    /// [`FULLSCREEN_LEAVE_DELAY`] after it left), or while a menu or dialog is open. Moving the
    /// mouse shows the pointer; [`FULLSCREEN_HIDE_DELAY`] still, off the bar, hides it.
    pub(crate) fn ensure_fullscreen_watch(&mut self, cx: &mut Context<'_, Self>) {
        if !self.watch.local.fullscreen || self.watch.local.fullscreen_task.is_some() {
            return;
        }
        self.watch.local.fullscreen_task = Some(cx.spawn(async move |this, cx| {
            let mut last_pos: Option<(i32, i32)> = None;
            let mut last_activity = Instant::now();
            let mut cursor_hidden = false;
            loop {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                let done = this
                    .update(cx, |view, cx| {
                        if !view.watch.local.fullscreen {
                            view.watch.local.fullscreen_task = None;
                            if cursor_hidden {
                                rtc_platform_win::set_cursor_visible(true);
                            }
                            return true;
                        }
                        #[allow(clippy::cast_possible_truncation)]
                        let threshold_px =
                            (FULLSCREEN_BOTTOM_ZONE * view.watch.local.scale.max(1.0)).round() as i32;
                        let Some((x, y, at_bottom)) =
                            rtc_platform_win::cursor_window_state(view.watch.local.hwnd, threshold_px)
                        else {
                            return false;
                        };
                        if last_pos != Some((x, y)) {
                            last_pos = Some((x, y));
                            last_activity = Instant::now();
                        }
                        let keep = view.watch.local.menu.is_some() || view.dialog.is_some();
                        let l = &mut view.watch.local;
                        let show = if keep || at_bottom {
                            l.controls_left_at = None;
                            true
                        } else if l.fullscreen_controls {
                            // just left the bottom edge: a moment before it goes
                            let left = *l.controls_left_at.get_or_insert_with(Instant::now);
                            left.elapsed() < FULLSCREEN_LEAVE_DELAY
                        } else {
                            false
                        };
                        if show != l.fullscreen_controls {
                            l.fullscreen_controls = show;
                            if !show {
                                l.controls_left_at = None;
                            }
                            view.sync_fullscreen_clip();
                            cx.notify();
                        }
                        let hide_cursor =
                            !keep && !at_bottom && last_activity.elapsed() >= FULLSCREEN_HIDE_DELAY;
                        if hide_cursor != cursor_hidden {
                            cursor_hidden = hide_cursor;
                            rtc_platform_win::set_cursor_visible(!hide_cursor);
                        }
                        false
                    })
                    .unwrap_or(true);
                if done {
                    break;
                }
            }
        }));
    }

    /// Cursor entered or left the controls panel in full screen.
    pub(crate) fn local_video_controls_hover(&mut self, hovered: bool, cx: &mut Context<'_, Self>) {
        if !self.watch.local.fullscreen {
            return;
        }
        if hovered {
            let change = !self.watch.local.fullscreen_controls;
            self.watch.local.fullscreen_controls = true;
            self.watch.local.controls_left_at = None;
            if change {
                self.sync_fullscreen_clip();
                cx.notify();
            }
        } else if self.watch.local.fullscreen_controls && self.watch.local.controls_left_at.is_none() {
            self.watch.local.controls_left_at = Some(Instant::now());
        }
    }
}

// ---- on screen ----------------------------------------------------------------------------------

fn bar_btn(id: &'static str) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .h(px(34.))
        .min_w(px(34.))
        .px(px(8.))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .rounded(px(8.))
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(tokens::text())
        .cursor_pointer()
        .hover(|s| s.bg(tokens::raised()))
}

/// A thin bar with a filled part (`frac` 0–1), its bounds kept in `cell` for clicks.
fn level(cell: &Rc<Cell<Option<Bounds<Pixels>>>>, frac: f32, fill: gpui_kit::Hsla) -> AnyElement {
    let cell = Rc::clone(cell);
    div()
        .relative()
        .size_full()
        .flex()
        .items_center()
        .child(
            canvas(move |b, _, _| cell.set(Some(b)), |_, (), _, _| {})
                .absolute()
                .size_full(),
        )
        .child(
            div()
                .relative()
                .w_full()
                .h(px(4.))
                .rounded_full()
                .bg(tokens::line_strong())
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .h_full()
                        .w(relative(frac.clamp(0.0, 1.0)))
                        .rounded_full()
                        .bg(fill),
                ),
        )
        .into_any_element()
}

/// Where along `cell`'s bar `x` is (0–1).
fn along(cell: &Rc<Cell<Option<Bounds<Pixels>>>>, x: Pixels) -> Option<f64> {
    let b = cell.get()?;
    let w = f32::from(b.size.width);
    (w > 0.0).then(|| f64::from(((f32::from(x) - f32::from(b.origin.x)) / w).clamp(0.0, 1.0)))
}

/// The bar under the video: play, time, scrubber, sound, tracks, full screen.
#[allow(clippy::cast_possible_truncation)]
pub(crate) fn controls(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let l = &view.watch.local;
    // host control: guests see where the video is, but play, pause and seek are the host's
    let locked = view.room.as_ref().is_some_and(crate::watch::locked_for_me);
    let frac = if l.duration > 0.0 {
        (l.time / l.duration) as f32
    } else {
        0.0
    };
    let vol = if l.muted { 0.0 } else { (l.volume / 100.0) as f32 };
    let audio: Vec<Track> = l
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio)
        .cloned()
        .collect();
    let subs: Vec<Track> = l
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Subtitle)
        .cloned()
        .collect();
    let menu = l.menu;
    let scrub = Rc::clone(&l.scrub);
    let volume_bar = Rc::clone(&l.volume_bar);
    let duration = l.duration;
    let time_text = if l.duration > 0.0 {
        format!("{} / {}", clock(l.time), clock(l.duration))
    } else {
        clock(l.time)
    };
    let bar = div()
        .h(px(BAR_H))
        .flex_none()
        .px(px(10.))
        .flex()
        .items_center()
        .gap(px(8.))
        .when(!locked, |el| {
            el.child(
                bar_btn("lv-play")
                    .child(icon(
                        if l.playing { Icon::Pause } else { Icon::Play },
                        px(18.),
                        tokens::text(),
                    ))
                    .on_click(cx.listener(|v, _, _, cx| v.video_toggle_play(cx))),
            )
        })
        .when(locked, |el| el.child(icon(Icon::Lock, px(16.), tokens::text_3())))
        .child(
            div()
                .flex_none()
                .text_size(px(13.))
                .text_color(tokens::text_2())
                .font_family(tokens::FONT_MONO)
                .child(time_text),
        )
        .children(l.progress.as_ref().filter(|_| l.streaming()).map(|p| {
            #[allow(clippy::cast_precision_loss)]
            let pct = if p.size > 0 {
                (p.cached as f64 / p.size as f64 * 100.0).round()
            } else {
                0.0
            };
            let peer_name = view
                .room
                .as_ref()
                .and_then(|r| {
                    if r.me == p.from {
                        Some(r.username.clone())
                    } else {
                        r.members
                            .iter()
                            .find(|(id, _)| *id == p.from)
                            .and_then(|(_, m)| m.username.clone())
                    }
                })
                .unwrap_or_else(|| {
                    let id = p.from.as_str();
                    format!("Peer {}", &id[..4.min(id.len())])
                });
            div()
                .flex_none()
                .text_size(px(12.))
                .text_color(tokens::text_3())
                .child(format!(
                    "Streaming from {peer_name}{} · {pct:.0}% here · {:.1} MB/s",
                    if p.relayed { " (relayed)" } else { "" },
                    p.speed
                ))
        }))
        .children(view.watch.torrent_stats.map(|ts| {
            let sp_mb = ts.speed_bps as f64 / (1024.0 * 1024.0);
            div()
                .flex_none()
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(tokens::accent())
                .child(format!(
                    "🧲 s:{} p:{}({}) · {:.1} MB/s",
                    ts.seeds, ts.peers, ts.total_peers, sp_mb
                ))
        }))
        // the torrent's file in Explorer (Downloads\3RTC\Torrents)
        .children(
            view.settings
                .keep_torrents
                .then_some(view.watch.torrent_stats)
                .flatten()
                .and(view.watch.local.file.clone())
                .map(|path| {
                    bar_btn("lv-torrent-folder")
                        .flex_none()
                        .text_size(px(12.))
                        .child("Show file")
                        .on_click(cx.listener(move |_, _, _, cx| cx.reveal_path(&path)))
                }),
        )
        .child({
            let down = Rc::clone(&scrub);
            let drag = Rc::clone(&scrub);
            div()
                .id("lv-scrub")
                .flex_1()
                .min_w(px(60.))
                .h(px(28.))
                .when(!locked, gpui_kit::Styled::cursor_pointer)
                .child(level(&scrub, frac, tokens::accent()))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |v, e: &MouseDownEvent, _, cx| {
                        if duration > 0.0
                            && !locked
                            && let Some(f) = along(&down, e.position.x)
                        {
                            v.video_seek(f * duration, cx);
                        }
                    }),
                )
                .on_mouse_move(cx.listener(move |v, e: &MouseMoveEvent, _, cx| {
                    if duration > 0.0
                        && !locked
                        && e.pressed_button == Some(MouseButton::Left)
                        && let Some(f) = along(&drag, e.position.x)
                    {
                        v.video_seek(f * duration, cx);
                    }
                }))
        })
        .child(
            bar_btn("lv-mute")
                .child(icon(
                    if l.muted || l.volume <= 0.0 {
                        Icon::SpeakerOff
                    } else {
                        Icon::Speaker
                    },
                    px(18.),
                    tokens::text(),
                ))
                .on_click(cx.listener(|v, _, _, cx| v.video_mute(cx))),
        )
        .child({
            let down = Rc::clone(&volume_bar);
            let drag = Rc::clone(&volume_bar);
            div()
                .id("lv-volume")
                .w(px(80.))
                .flex_none()
                .h(px(28.))
                .cursor_pointer()
                .child(level(&volume_bar, vol, tokens::text()))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |v, e: &MouseDownEvent, _, cx| {
                        if let Some(f) = along(&down, e.position.x) {
                            v.video_volume((f * 100.0).round(), cx);
                        }
                    }),
                )
                .on_mouse_move(cx.listener(move |v, e: &MouseMoveEvent, _, cx| {
                    if e.pressed_button == Some(MouseButton::Left)
                        && let Some(f) = along(&drag, e.position.x)
                    {
                        v.video_volume((f * 100.0).round(), cx);
                    }
                }))
        })
        .when(audio.len() > 1, |el| {
            el.child(
                bar_btn("lv-audio")
                    .when(menu == Some(TrackKind::Audio), |b| b.bg(tokens::raised()))
                    .child("Audio")
                    .on_click(cx.listener(|v, _, _, cx| v.toggle_track_menu(TrackKind::Audio, cx))),
            )
        })
        .child(
            bar_btn("lv-subs")
                .when(menu == Some(TrackKind::Subtitle), |b| b.bg(tokens::raised()))
                .child("Subtitles")
                .on_click(cx.listener(|v, _, _, cx| v.toggle_track_menu(TrackKind::Subtitle, cx))),
        )
        .child(
            bar_btn("lv-shortcuts")
                .child("Shortcuts")
                .on_click(cx.listener(|v, _, _, cx| v.open_dialog(crate::view::Dialog::Player, cx))),
        )
        .child(
            bar_btn("lv-full")
                .child(if l.fullscreen {
                    "Exit full screen"
                } else {
                    "Full screen"
                })
                .on_click(cx.listener(|v, _, window, cx| v.toggle_video_fullscreen(window, cx))),
        );
    let menu_row = menu.map(|kind| {
        let list = if kind == TrackKind::Audio { &audio } else { &subs };
        let none_on = kind == TrackKind::Subtitle && !subs.iter().any(|t| t.selected);
        div()
            .flex_none()
            .px(px(12.))
            .pb(px(10.))
            .flex()
            .flex_wrap()
            .gap(px(6.))
            .when(kind == TrackKind::Subtitle, |el| {
                el.child(
                    track_chip("lv-sub-off", "Off", none_on)
                        .on_click(cx.listener(|v, _, _, cx| v.video_track(TrackKind::Subtitle, None, cx))),
                )
            })
            .children(list.iter().map(|t| {
                let id = t.id;
                let mut label = track_label(t);
                if t.external {
                    label.push_str(" (file)");
                }
                track_chip(("lv-track", usize::try_from(id).unwrap_or(0)), label, t.selected)
                    .on_click(cx.listener(move |v, _, _, cx| v.video_track(kind, Some(id), cx)))
            }))
            .when(kind == TrackKind::Subtitle, |el| {
                el.child(
                    track_chip("lv-sub-add", "Add a subtitle file…", false)
                        .on_click(cx.listener(|v, _, window, cx| v.choose_subtitle_file(window, cx))),
                )
            })
    });
    let problems = l.problems.clone();
    div()
        .id("lv-controls")
        .flex_none()
        .flex()
        .flex_col()
        .bg(tokens::panel())
        .when(!problems.is_empty(), |el| {
            el.child(
                div()
                    .px(px(14.))
                    .pt(px(8.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .text_size(px(12.))
                    .text_color(tokens::warn())
                    .children(problems.into_iter().map(|p| div().child(format!("⚠ {p}")))),
            )
        })
        .border_t_1()
        .border_color(tokens::line())
        .children(menu_row)
        .child(bar)
        .on_hover(cx.listener(|v, hovered: &bool, _, cx| {
            if v.watch.local.fullscreen {
                v.local_video_controls_hover(*hovered, cx);
            }
        }))
        .on_mouse_move(cx.listener(|v, _, _, cx| {
            if v.watch.local.fullscreen {
                v.local_video_controls_hover(true, cx);
            }
        }))
        .into_any_element()
}

fn track_chip(
    id: impl Into<gpui_kit::ElementId>,
    label: impl Into<SharedString>,
    on: bool,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .h(px(30.))
        .px(px(12.))
        .flex()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(if on { tokens::text() } else { tokens::line() })
        .bg(if on { tokens::text() } else { tokens::surface() })
        .text_color(if on { tokens::bg() } else { tokens::text_2() })
        .text_size(px(13.))
        .cursor_pointer()
        .child(label.into())
}

/// Someone else's file plays and it isn't here: "I have this file" (`LocalVideoSyncPlayer.tsx`'s
/// prompt for viewers).
pub(crate) fn offer(
    view: &RoomView,
    name: &str,
    size: u64,
    from: Option<&str>,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let who = from.unwrap_or("Someone").to_owned();
    let asking = view.watch.local.asking.is_some();
    let file = name.to_owned();
    div()
        .absolute()
        .top_0()
        .left_0()
        .bottom(px(0.))
        .right(px(0.))
        .rounded(tokens::RADIUS_VIDEO)
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .max_w(px(520.))
                .px(px(28.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(12.))
                .text_center()
                .child(icon(Icon::Folder, px(36.), tokens::text_2()))
                .child(
                    div()
                        .text_size(px(15.))
                        .text_color(tokens::text_2())
                        .child(format!("{who} is playing a video file")),
                )
                .child(
                    div()
                        .text_size(px(20.))
                        .font_weight(FontWeight::BOLD)
                        .child(name.to_owned()),
                )
                .when(size > 0, |el| {
                    el.child(
                        div()
                            .text_size(px(13.))
                            .text_color(tokens::text_3())
                            .child(size_text(size)),
                    )
                })
                .children(
                    view.watch
                        .local
                        .remote_format
                        .as_ref()
                        .filter(|(n, d)| n == name && !d.is_empty())
                        .map(|(_, d)| div().text_size(px(13.)).text_color(tokens::text_3()).child(d.clone())),
                )
                .child(
                    div()
                        .text_size(px(14.))
                        .text_color(tokens::text_2())
                        .child(format!(
                            "Streaming sends the video from {who}’s computer to yours. Have the same file? Pick it and nothing needs to be sent."
                        )),
                )
                .children(view.watch.local.offer_error.clone().map(|e| {
                    div()
                        .text_size(px(13.))
                        .text_color(tokens::danger_text())
                        .child(e)
                }))
                .child(
                    div()
                        .pt(px(4.))
                        .flex()
                        .gap(px(8.))
                        .child(
                            Button::new(
                                "lv-stream",
                                if asking {
                                    format!("Asking {who}…")
                                } else {
                                    format!("Stream from {who}")
                                },
                            )
                            .variant(Variant::Primary)
                            .on_click(cx.listener(move |v, _, _, cx| v.ask_stream(file.clone(), cx))),
                        )
                        .child(
                            Button::new("lv-have", "I have this file")
                                .variant(Variant::Secondary)
                                .icon(Icon::Folder)
                                .on_click(cx.listener(|v, _, window, cx| v.choose_video_file(window, cx))),
                        ),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(tokens::text_3())
                        .child("or drop the file here"),
                ),
        )
        .into_any_element()
}
