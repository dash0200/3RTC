//! The watch party on screen: the player (a WebView2 over the stage, `rtc_webview`), the paste
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
    InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _, Pixels, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Window, canvas, div, img,
    prelude::FluentBuilder as _, px,
};
use rtc_core::{Command, PlayerCmd, PlayerReport, Showing, UserAction, WatchCommand};
use rtc_engine::Snapshot;
use rtc_protocol::media::{Link, Media, Provider, detect_link};
use rtc_ui::button::{Button, Variant};
use rtc_ui::{Icon, icon, tokens};

use crate::quick_picks::{self, Picks, Video};
use crate::view::RoomView;

/// Room left beside the player for floating reactions (5.9 item 1).
pub(crate) const REACTION_STRIP: f32 = 112.;

/// What the player should open once the stage has a size.
#[derive(Debug, Clone)]
struct Open {
    source: rtc_webview::Source,
    start: f64,
    playing: bool,
}

pub(crate) struct WatchUi {
    player: Rc<RefCell<Option<rtc_webview::Player>>>,
    pending: Option<Open>,
    opening: bool,
    /// Why the player couldn't open (shown on the stage).
    pub(crate) error: Option<SharedString>,
    /// The stage's player rectangle (window coordinates, logical pixels).
    stage: Rc<Cell<Option<Bounds<Pixels>>>>,
    shown: Rc<Cell<bool>>,
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
            shown: Rc::new(Cell::new(true)),
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
                InputState::new(window, cx).placeholder("Paste a link (YouTube, Vimeo, Twitch, .mp4…)")
            }),
            region_open: false,
        }
    }
}

fn source(s: &Showing) -> rtc_webview::Source {
    match s {
        Showing::YouTube { id, .. } => rtc_webview::Source::YouTube(id.clone()),
        Showing::Link(m) => match m.provider {
            Provider::Vimeo => rtc_webview::Source::Vimeo(m.url.clone()),
            Provider::Twitch => {
                rtc_webview::Source::Twitch(m.video.clone().or_else(|| m.channel.clone()).unwrap_or_default())
            }
            Provider::File => rtc_webview::Source::File(m.url.clone()),
            Provider::Hls => rtc_webview::Source::Hls(m.url.clone()),
        },
    }
}

fn web_data_dir() -> std::path::PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map_or_else(std::env::temp_dir, std::path::PathBuf::from)
        .join("3RTC")
        .join("WebView2")
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
}

/// The paste box: from text to something to play (`resolvePastedLink`), off the UI thread.
fn resolve(text: &str, picks: &Picks) -> Result<Resolved, String> {
    match detect_link(text)? {
        Link::YouTube(id) => {
            let title = youtube_title(&id, picks);
            Ok(Resolved::YouTube(id, title))
        }
        Link::Media { mut media, guessed } => {
            if guessed && !probe(&media.url) {
                return Err("That link isn't a video this browser can play. Paste a YouTube, Vimeo or Twitch link, or a direct video link (.mp4, .webm, .m3u8).".to_owned());
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

    fn watch_cmd(&self, c: WatchCommand) {
        self.command(Command::Watch(c));
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
                // the old web view goes first (one at a time)
                player.borrow_mut().take();
                self.watch.error = None;
                self.watch.pending = Some(Open {
                    source: source(&showing),
                    start,
                    playing,
                });
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
            }
        }
        cx.notify();
    }

    fn on_player_event(&mut self, e: rtc_webview::Event, cx: &mut Context<'_, Self>) {
        use rtc_webview::Event as E;
        let report = match e {
            E::Ready { title } => (!title.is_empty()).then_some(PlayerReport::Title(title)),
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
        if let Err(e) = detect_link(&text) {
            if to_queue {
                self.watch.queue_error = Some(e.into());
            } else {
                self.watch.link_error = Some(e.into());
            }
            cx.notify();
            return;
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
                        let c = match (r, to_queue) {
                            (Resolved::YouTube(id, title), false) => WatchCommand::PlayYouTube { id, title },
                            (Resolved::Media(m), false) => WatchCommand::PlayLink(m),
                            (Resolved::YouTube(id, title), true) => WatchCommand::QueueAdd {
                                id: new_id(),
                                video_id: Some(id),
                                media: None,
                                title,
                                autoplay: true,
                            },
                            (Resolved::Media(m), true) => WatchCommand::QueueAdd {
                                id: new_id(),
                                video_id: None,
                                title: m.display_title(),
                                media: Some(m),
                                autoplay: true,
                            },
                        };
                        v.watch_cmd(c);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn play_pick(&mut self, v: &Video, cx: &mut Context<'_, Self>) {
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

    /// Hides the web view while something must show over the stage (5.9 item 1).
    fn player_visible(&self) -> bool {
        self.pop.is_none() && self.dialog.is_none() && !self.emoji_open && !self.watch.region_open
    }
}

// ---- the stage while something plays ------------------------------------------------------------

/// The player's rectangle: black, with the web view laid over it.
pub(crate) fn player_area(
    view: &mut RoomView,
    window: &mut Window,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let visible = view.player_visible();
    let ui = &mut view.watch;
    // open a waiting player once the stage has a size (outside drawing)
    if ui.pending.is_some() && !ui.opening && ui.stage.get().is_some() {
        ui.opening = true;
        cx.defer_in(window, |v, window, cx| {
            v.watch.opening = false;
            let (Some(open), Some(bounds)) = (v.watch.pending.take(), v.watch.stage.get()) else {
                return;
            };
            let tx = v.watch.events.clone();
            match rtc_webview::Player::open(
                &*window,
                rect(bounds),
                &open.source,
                open.start,
                open.playing,
                web_data_dir(),
                move |e| {
                    let _ = tx.send(e);
                },
            ) {
                Ok(p) => {
                    p.set_visible(v.player_visible());
                    *v.watch.player.borrow_mut() = Some(p);
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
    let error = ui.error.clone();
    let hidden_note = !visible && ui.player.borrow().is_some();
    div()
        .absolute()
        .top_0()
        .left_0()
        .bottom(px(0.))
        .right(px(REACTION_STRIP))
        .bg(tokens::black(1.0))
        .rounded(tokens::RADIUS_VIDEO)
        .overflow_hidden()
        .flex()
        .items_center()
        .justify_center()
        .child(
            canvas(
                move |bounds, window, _| {
                    if stage.get() != Some(bounds) {
                        if stage.get().is_none() {
                            // the first size: draw again so a waiting player opens
                            window.refresh();
                        }
                        stage.set(Some(bounds));
                        if let Some(p) = player.borrow().as_ref() {
                            p.set_bounds(rect(bounds));
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
                .when(queue_count > 0, |el| {
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

/// Under the paste box: why a link can't be played.
pub(crate) fn link_error(view: &RoomView) -> Option<AnyElement> {
    let e = view.watch.link_error.clone()?;
    Some(
        div()
            .text_size(px(14.))
            .text_color(tokens::danger_text())
            .child(e)
            .into_any_element(),
    )
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
    let now = w.showing.clone().map(|s| {
        let thumb = match &s {
            Showing::YouTube { id, .. } => view.thumb(id, cx),
            Showing::Link(_) => None,
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
                .child(small_btn(("q-play", n), "▶", true).on_click(
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
                        .when(now.is_some(), |el| {
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
                                        .when_some(next_title.clone(), |el, t| {
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
                .when(!w.queue.is_empty(), |el| {
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
