//! The watch party: what the room is watching, play / pause / seek / load / close each way, the
//! late joiner's catch-up, the auto re-sync, the host controls lock and the shared queue with
//! vote to skip. Mirrors `features/playback/usePlayback.ts`, `useMediaSync.ts`,
//! `useDriftSync.ts` + `drift.ts`, `useHostControls.ts` and `features/queue/useQueue.ts`.
//!
//! The player itself (a web view in the app) is told what to do with [`PlayerCmd`]s and reports
//! back with [`PlayerReport`]s; it only reports what a *person* did with its own controls (the
//! page drops the events our own commands cause). Without reports (the test example) the
//! position is estimated from the last command.

use rtc_protocol::PeerId;
use rtc_protocol::media::{Media, QueueItem};
use rtc_protocol::peer::PeerMessage;
use serde_json::Value;

use super::{Effect, Room, UiEvent};

/// The reference app says where it is this often (ms).
pub const HEARTBEAT_MS: f64 = 4000.0;
/// Further off than this (s), a viewer jumps to the reference.
const DRIFT_LIMIT_S: f64 = 1.5;
const SETTLE_MS: f64 = 5000.0;
const LEAD_S: f64 = 0.3;
const BACKOFF_COUNT: usize = 3;
const BACKOFF_WINDOW_MS: f64 = 60_000.0;
const BACKOFF_MS: f64 = 120_000.0;
const BLOCKED_TOAST_GAP_MS: f64 = 3000.0;

/// What the room is watching.
#[derive(Debug, Clone, PartialEq)]
pub enum Showing {
    /// A YouTube video.
    YouTube {
        /// Its id.
        id: String,
        /// Its title (may be empty until known).
        title: String,
    },
    /// A link source.
    Link(Media),
    /// A video file from someone's computer (`LocalVideoSyncPlayer.tsx`).
    Local {
        /// The file's name.
        name: String,
        /// Its size in bytes.
        size: u64,
        /// Who loaded it (`None`: we did).
        from: Option<String>,
        /// We have it here (ours, or our own copy of theirs): the player can show it.
        have: bool,
    },
}

impl Showing {
    /// "What is playing": the same key on two apps means the same video (`playingKey`).
    #[must_use]
    pub fn key(&self) -> String {
        match self {
            Self::YouTube { id, .. } => format!("yt:{id}"),
            Self::Link(m) => format!("link:{}", m.key()),
            Self::Local { name, size, .. } => format!("local:{name}:{size}"),
        }
    }

    /// Its title for people.
    #[must_use]
    pub fn title(&self) -> String {
        match self {
            Self::YouTube { id, title } if title.is_empty() => format!("YouTube Video ({id})"),
            Self::YouTube { title, .. } => title.clone(),
            Self::Link(m) => m.display_title(),
            Self::Local { name, .. } => name.clone(),
        }
    }

    /// A live stream (no position, no seeking).
    #[must_use]
    pub fn is_live(&self) -> bool {
        matches!(self, Self::Link(m) if m.is_live())
    }
}

/// What the player should do.
#[derive(Debug, Clone, PartialEq)]
pub enum PlayerCmd {
    /// Show this (a new player), from `start` seconds, playing or paused.
    Open {
        /// What.
        showing: Showing,
        /// From where, seconds.
        start: f64,
        /// Start playing.
        playing: bool,
    },
    /// Play (first going to `at` if it's more than 1.2 s away).
    Play {
        /// Where the room is.
        at: Option<f64>,
        /// Who did it ("Auto-sync", a name).
        who: String,
    },
    /// Pause (at `at`).
    Pause {
        /// Where the room is.
        at: Option<f64>,
        /// Who did it.
        who: String,
    },
    /// Go to `to` seconds.
    Seek {
        /// Where.
        to: f64,
        /// Who did it.
        who: String,
        /// The auto re-sync (not a person).
        drift: bool,
    },
    /// Close the player.
    Close,
    /// Show these subtitles (WebVTT) over the video file.
    Subtitles {
        /// Their name.
        name: String,
        /// The WebVTT text.
        vtt: String,
    },
}

/// What a person did with the player's own controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserAction {
    /// Played.
    Play,
    /// Paused.
    Pause,
    /// Jumped.
    Seek,
}

/// What the player says.
#[derive(Debug, Clone, PartialEq)]
pub enum PlayerReport {
    /// Where it is (twice a second).
    State {
        /// Position, seconds.
        time: f64,
        /// Playing.
        playing: bool,
        /// Waiting for data.
        buffering: bool,
        /// Length (0 or infinite: live).
        duration: f64,
    },
    /// A person used the player.
    User {
        /// What.
        action: UserAction,
        /// Where, seconds.
        time: f64,
    },
    /// It played to the end.
    Ended,
    /// The provider refused the video (removed, private, not allowed elsewhere): next in queue.
    Unavailable,
    /// The video's real title.
    Title(String),
}

/// Watch party commands from the app.
#[derive(Debug, Clone, PartialEq)]
pub enum WatchCommand {
    /// Play a YouTube video for everyone (paste box, quick picks).
    PlayYouTube {
        /// The id.
        id: String,
        /// Its title.
        title: String,
    },
    /// Open a link source for everyone.
    PlayLink(Media),
    /// Play a video file from this computer (its name and size; the app has the path).
    PlayFile {
        /// The file's name.
        name: String,
        /// Its size in bytes.
        size: u64,
    },
    /// The room's file now streams to us from its owner: play it where the room is.
    Streaming {
        /// The file's name.
        name: String,
    },
    /// The stream of the room's file stopped (its owner stopped sharing it): no player here.
    StreamLost {
        /// The file's name.
        name: String,
    },
    /// Share subtitles (WebVTT) with everyone watching the file (`subtitle-share`).
    ShareSubtitles {
        /// Their name.
        name: String,
        /// The WebVTT text.
        vtt: String,
    },
    /// Close what's playing for everyone.
    Exit,
    /// Jump everyone to `secs` (a timestamp clicked in chat).
    SeekEveryone(f64),
    /// From the player.
    Player(PlayerReport),
    /// Add to the queue (`autoplay`: with nothing playing, start it now).
    QueueAdd {
        /// A new unique id.
        id: String,
        /// A YouTube video…
        video_id: Option<String>,
        /// …or a link source.
        media: Option<Media>,
        /// Its title.
        title: String,
        /// Start it if nothing is playing.
        autoplay: bool,
    },
    /// Remove an item.
    QueueRemove(String),
    /// Move an item to a new place.
    QueueMove {
        /// Which.
        id: String,
        /// Its new index.
        to: usize,
    },
    /// Empty the queue.
    QueueClear,
    /// Play this item now.
    QueuePlay(String),
    /// Play the next item.
    QueueNext,
    /// Vote to skip (again: take the vote back).
    VoteSkip,
}

/// The watch party, for the UI.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct WatchView {
    /// What's playing.
    pub showing: Option<Showing>,
    /// The queue.
    pub queue: Vec<QueueItem>,
    /// Who voted to skip.
    pub skip_votes: Vec<String>,
    /// Votes needed, as the player shows it (`requiredVotes` in `YouTubeSyncPlayer.tsx`).
    pub votes_needed: usize,
}

#[derive(Debug, Clone, Default)]
struct Pos {
    time: f64,
    at: f64,
    playing: bool,
    buffering: bool,
    /// The player has reported (we know where it is, not just where we told it to go).
    reported: bool,
}

impl Pos {
    fn now(&self, now_ms: f64) -> f64 {
        if self.playing && !self.buffering {
            self.time + (now_ms - self.at).max(0.0) / 1000.0
        } else {
            self.time
        }
    }
}

/// The watch party's state (kept in [`Room`]).
#[derive(Debug, Clone, Default)]
pub(crate) struct Watch {
    showing: Option<Showing>,
    queue: Vec<QueueItem>,
    skip_votes: Vec<String>,
    pos: Pos,
    last_change: f64,
    corrections: Vec<f64>,
    backoff_until: f64,
    lock_revert_pending: bool,
    last_blocked_toast: f64,
    last_heartbeat: f64,
    /// Subtitles shared for the file showing (name, WebVTT).
    subtitles: Option<(String, String)>,
}

impl Watch {
    pub(crate) const fn new() -> Self {
        Self {
            showing: None,
            queue: Vec::new(),
            skip_votes: Vec::new(),
            pos: Pos {
                time: 0.0,
                at: 0.0,
                playing: false,
                buffering: false,
                reported: false,
            },
            last_change: 0.0,
            corrections: Vec::new(),
            backoff_until: 0.0,
            lock_revert_pending: false,
            last_blocked_toast: f64::NEG_INFINITY,
            subtitles: None,
            last_heartbeat: 0.0,
        }
    }
}

fn clock(secs: f64) -> String {
    let s = secs.max(0.0);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let t = s as u64;
    format!("{}:{:02}", t / 60, t % 60)
}

const fn locked_action(action: &str) -> bool {
    matches!(
        action.as_bytes(),
        b"play" | b"pause" | b"seek" | b"load" | b"close" | b"unload"
    )
}

fn votes(list: &[Value]) -> Vec<String> {
    list.iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

impl Room {
    /// The watch party, for the UI.
    #[must_use]
    pub fn watch(&self) -> WatchView {
        let total = self.peer_count() + 1;
        WatchView {
            showing: self.watch.showing.clone(),
            queue: self.watch.queue.clone(),
            skip_votes: self.watch.skip_votes.clone(),
            votes_needed: if total <= 2 { total } else { total.div_ceil(2) },
        }
    }

    /// Where the player is (estimated between reports), seconds.
    #[must_use]
    pub fn watch_position(&self, now_ms: f64) -> f64 {
        self.watch.pos.now(now_ms)
    }

    fn peer_count(&self) -> usize {
        self.members.values().filter(|m| m.connected).count()
    }

    /// Votes needed to skip (`useQueue.ts`).
    fn votes_required(&self) -> usize {
        self.peer_count().max(1).div_ceil(2).max(1)
    }

    /// The room's reference for the auto re-sync: the host, else the smallest peer id.
    fn authority(&self) -> Option<PeerId> {
        if self.is_host() {
            return Some(self.me.peer_id.clone());
        }
        let connected: Vec<&PeerId> = self
            .members
            .iter()
            .filter(|(_, m)| m.connected)
            .map(|(p, _)| p)
            .collect();
        if let Some(h) = &self.host
            && connected.contains(&h)
        {
            return Some(h.clone());
        }
        connected
            .into_iter()
            .chain(std::iter::once(&self.me.peer_id))
            .min()
            .cloned()
    }

    fn who(&self, from: &PeerId, sender: Option<&str>) -> String {
        self.members
            .get(from)
            .and_then(|m| m.username.clone())
            .or_else(|| sender.map(super::clean_name))
            .unwrap_or_else(|| "Peer".to_owned())
    }

    fn notice(fx: &mut Vec<Effect>, text: impl Into<String>) {
        fx.push(Effect::Ui(UiEvent::Notice(text.into())));
    }

    fn locked_for_me(&self) -> bool {
        self.playback_lock && !self.is_host()
    }

    /// A guest tried to change playback under the lock: say so, and put us back to the host's state.
    fn blocked(&mut self, now_ms: f64, fx: &mut Vec<Effect>) {
        if now_ms - self.watch.last_blocked_toast > BLOCKED_TOAST_GAP_MS {
            self.watch.last_blocked_toast = now_ms;
            Self::notice(fx, "🔒 Only the host can control playback right now");
        }
        if let Some(host) = self.host.clone()
            && self.members.get(&host).is_some_and(|m| m.connected)
        {
            let envelope = self.envelope(PeerMessage::YtRequestSync, now_ms);
            fx.push(Effect::SendToPeer { peer: host, envelope });
            self.watch.lock_revert_pending = true;
        }
    }

    fn consume_lock_revert(&mut self) -> bool {
        std::mem::take(&mut self.watch.lock_revert_pending)
    }

    fn player(&mut self, cmd: PlayerCmd, now_ms: f64, fx: &mut Vec<Effect>) {
        let p = &mut self.watch.pos;
        let cur = p.now(now_ms);
        match &cmd {
            PlayerCmd::Open { start, playing, .. } => {
                *p = Pos {
                    time: *start,
                    at: now_ms,
                    playing: *playing,
                    buffering: false,
                    reported: false,
                };
            }
            PlayerCmd::Play { at, .. } => {
                *p = Pos {
                    time: at.unwrap_or(cur),
                    at: now_ms,
                    playing: true,
                    ..p.clone()
                };
            }
            PlayerCmd::Pause { at, .. } => {
                *p = Pos {
                    time: at.unwrap_or(cur),
                    at: now_ms,
                    playing: false,
                    ..p.clone()
                };
            }
            PlayerCmd::Seek { to, .. } => {
                *p = Pos {
                    time: *to,
                    at: now_ms,
                    ..p.clone()
                };
            }
            PlayerCmd::Close => *p = Pos::default(),
            PlayerCmd::Subtitles { .. } => {}
        }
        let opens_file = matches!(
            &cmd,
            PlayerCmd::Open {
                showing: Showing::Local { .. },
                ..
            }
        );
        fx.push(Effect::Ui(UiEvent::Player(cmd)));
        // subtitles shared before the file opened here
        if opens_file && let Some((name, vtt)) = self.watch.subtitles.clone() {
            fx.push(Effect::Ui(UiEvent::Player(PlayerCmd::Subtitles { name, vtt })));
        }
    }

    /// Something new is showing (or nothing): skip votes start over (`media-changed`).
    fn show(&mut self, showing: Option<Showing>, fx: &mut Vec<Effect>) {
        self.watch.showing = showing;
        self.watch.subtitles = None;
        self.watch.skip_votes.clear();
        fx.push(Effect::Ui(UiEvent::Changed));
    }

    /// Sends a playback change (stopped by the lock when it applies).
    fn broadcast_action(&mut self, msg: PeerMessage, now_ms: f64, fx: &mut Vec<Effect>) -> bool {
        let action = match &msg {
            PeerMessage::YtAction { action, .. } | PeerMessage::MediaAction { action, .. } => action.clone(),
            _ => String::new(),
        };
        if locked_action(&action) && self.locked_for_me() {
            self.blocked(now_ms, fx);
            return false;
        }
        self.watch.last_change = now_ms;
        let envelope = self.envelope(msg, now_ms);
        fx.push(Effect::Broadcast(envelope));
        true
    }

    fn yt(&self, action: &str, time: Option<f64>) -> PeerMessage {
        PeerMessage::YtAction {
            action: action.to_owned(),
            new_video_id: None,
            video_id: None,
            title: None,
            current_time: time,
            from_host: self.is_host(),
            by_vote: None,
        }
    }

    fn media_msg(&self, action: &str, time: Option<f64>) -> PeerMessage {
        PeerMessage::MediaAction {
            action: action.to_owned(),
            media: None,
            current_time: time,
            from_host: self.is_host(),
            by_vote: None,
        }
    }

    /// A change of ours of the kind of what's showing (`yt-action` or `media-action`).
    fn action_for_showing(&self, action: &str, time: Option<f64>) -> Option<PeerMessage> {
        match self.watch.showing.as_ref()? {
            Showing::YouTube { .. } => Some(self.yt(action, time)),
            Showing::Link(_) => Some(self.media_msg(action, time)),
            Showing::Local { .. } => Some(Self::local_msg(action, time, self.is_host())),
        }
    }

    fn local_msg(action: &str, time: Option<f64>, from_host: bool) -> PeerMessage {
        PeerMessage::LocalVideoAction {
            action: action.to_owned(),
            file_name: None,
            file_size: None,
            current_time: time,
            from_host,
            vtt_string: None,
            subtitle_info: None,
        }
    }

    /// Plays a video file from this computer (`selectLocalFile`). With the room already
    /// watching a file of that name (someone else's), this is our own copy of it: it starts
    /// where the room is.
    fn play_file(&mut self, name: &str, size: u64, now_ms: f64, fx: &mut Vec<Effect>) {
        let theirs = matches!(&self.watch.showing,
            Some(Showing::Local { name: n, have: false, .. }) if *n == name);
        if theirs {
            let from = match &self.watch.showing {
                Some(Showing::Local { from, .. }) => from.clone(),
                _ => None,
            };
            let showing = Showing::Local {
                name: name.to_owned(),
                size,
                from,
                have: true,
            };
            self.watch.showing = Some(showing.clone());
            let start = self.watch.pos.now(now_ms);
            let playing = self.watch.pos.playing;
            self.player(
                PlayerCmd::Open {
                    showing,
                    start,
                    playing,
                },
                now_ms,
                fx,
            );
            fx.push(Effect::Ui(UiEvent::Changed));
            self.log(format!("📁 You loaded local video: \"{name}\""), fx);
            Self::notice(fx, format!("Loaded \"{name}\""));
            if !self.locked_for_me() {
                self.broadcast_load(name, size, now_ms, fx);
            }
            return;
        }
        if self.locked_for_me() {
            self.blocked(now_ms, fx);
            return;
        }
        let showing = Showing::Local {
            name: name.to_owned(),
            size,
            from: None,
            have: true,
        };
        self.show(Some(showing.clone()), fx);
        self.player(
            PlayerCmd::Open {
                showing,
                start: 0.0,
                playing: false,
            },
            now_ms,
            fx,
        );
        self.log(format!("📁 You loaded local video: \"{name}\""), fx);
        Self::notice(fx, format!("Loaded \"{name}\""));
        self.broadcast_load(name, size, now_ms, fx);
    }

    fn broadcast_load(&mut self, name: &str, size: u64, now_ms: f64, fx: &mut Vec<Effect>) {
        #[allow(clippy::cast_precision_loss)]
        let msg = PeerMessage::LocalVideoAction {
            action: "load".to_owned(),
            file_name: Some(name.to_owned()),
            file_size: Some(size as f64),
            current_time: None,
            from_host: self.is_host(),
            vtt_string: None,
            subtitle_info: None,
        };
        self.broadcast_action(msg, now_ms, fx);
    }

    /// Plays a YouTube video here and tells the room.
    fn play_youtube(
        &mut self,
        id: String,
        title: String,
        by_vote: bool,
        now_ms: f64,
        fx: &mut Vec<Effect>,
    ) -> bool {
        if self.locked_for_me() {
            self.blocked(now_ms, fx);
            return false;
        }
        let msg = PeerMessage::YtAction {
            action: "load".to_owned(),
            new_video_id: Some(id.clone()),
            video_id: None,
            title: Some(title.clone()),
            current_time: None,
            from_host: self.is_host(),
            by_vote: by_vote.then_some(true),
        };
        let showing = Showing::YouTube { id, title };
        self.show(Some(showing.clone()), fx);
        self.player(
            PlayerCmd::Open {
                showing,
                start: 0.0,
                playing: true,
            },
            now_ms,
            fx,
        );
        self.broadcast_action(msg, now_ms, fx);
        true
    }

    /// Opens a link source here and tells the room.
    fn play_link(&mut self, media: &Media, by_vote: bool, now_ms: f64, fx: &mut Vec<Effect>) -> bool {
        let Some(clean) = rtc_protocol::media::normalize(&serde_json::to_value(media).unwrap_or(Value::Null))
        else {
            return false;
        };
        if self.locked_for_me() {
            self.blocked(now_ms, fx);
            return false;
        }
        let msg = PeerMessage::MediaAction {
            action: "load".to_owned(),
            media: serde_json::to_value(&clean).ok(),
            current_time: None,
            from_host: self.is_host(),
            by_vote: by_vote.then_some(true),
        };
        let showing = Showing::Link(clean);
        self.show(Some(showing.clone()), fx);
        // link players start from what the room does: play from the start
        self.player(
            PlayerCmd::Open {
                showing,
                start: 0.0,
                playing: true,
            },
            now_ms,
            fx,
        );
        self.broadcast_action(msg, now_ms, fx);
        true
    }

    fn close_here(&mut self, now_ms: f64, fx: &mut Vec<Effect>) {
        if self.watch.showing.is_some() {
            self.show(None, fx);
            self.player(PlayerCmd::Close, now_ms, fx);
        }
    }

    fn send_queue(&self, msg: PeerMessage, now_ms: f64, fx: &mut Vec<Effect>) {
        fx.push(Effect::Broadcast(self.envelope(msg, now_ms)));
    }

    fn queue_msg(action: &str) -> PeerMessage {
        PeerMessage::QueueAction {
            action: action.to_owned(),
            item: None,
            item_id: None,
            queue: None,
            next_video_id: None,
            next_title: None,
            remaining_queue: None,
            skip_votes: None,
        }
    }

    fn queue_values(list: &[QueueItem]) -> Vec<Value> {
        list.iter().map(QueueItem::to_value).collect()
    }

    /// The next queued item (`playNextInQueue`).
    fn play_next(&mut self, by_vote: bool, auto: bool, now_ms: f64, fx: &mut Vec<Effect>) {
        if self.locked_for_me() {
            if !auto {
                self.blocked(now_ms, fx);
            }
            return;
        }
        if self.watch.queue.is_empty() {
            Self::notice(fx, "Queue is empty");
            return;
        }
        let next = self.watch.queue.remove(0);
        let remaining = self.watch.queue.clone();
        if let Some(m) = next.media.clone() {
            self.play_link(&m, by_vote, now_ms, fx);
        } else if let Some(id) = next.video_id.clone() {
            self.play_youtube(id, next.title.clone(), by_vote, now_ms, fx);
        }
        let mut msg = Self::queue_msg("next");
        if let PeerMessage::QueueAction {
            next_video_id,
            next_title,
            remaining_queue,
            ..
        } = &mut msg
        {
            *next_video_id = Some(next.video_id.clone().map_or(Value::Null, Value::String));
            *next_title = Some(next.title.clone());
            *remaining_queue = Some(Self::queue_values(&remaining));
        }
        self.send_queue(msg, now_ms, fx);
        fx.push(Effect::Ui(UiEvent::Pop));
        Self::notice(fx, format!("▶️ Next Up: \"{}\"", next.title));
        self.log(format!("⏭️ Autoplaying next in queue: \"{}\"", next.title), fx);
        fx.push(Effect::Ui(UiEvent::Changed));
    }

    /// A watch party command from the app.
    pub(super) fn watch_command(&mut self, c: WatchCommand, now_ms: f64, fx: &mut Vec<Effect>) {
        match c {
            WatchCommand::PlayYouTube { id, title } => {
                if self.play_youtube(id, title.clone(), false, now_ms, fx) {
                    self.log(format!("🎬 You loaded: \"{title}\""), fx);
                }
            }
            WatchCommand::PlayLink(media) => {
                let title = media.display_title();
                if self.play_link(&media, false, now_ms, fx) {
                    self.log(format!("🎬 You opened: \"{title}\""), fx);
                }
            }
            WatchCommand::PlayFile { name, size } => self.play_file(&name, size, now_ms, fx),
            WatchCommand::Streaming { name } => {
                let Some(Showing::Local {
                    name: n,
                    size,
                    from,
                    have: false,
                }) = &self.watch.showing
                else {
                    return;
                };
                if *n != name {
                    return;
                }
                let showing = Showing::Local {
                    name,
                    size: *size,
                    from: from.clone(),
                    have: true,
                };
                self.watch.showing = Some(showing.clone());
                let start = self.watch.pos.now(now_ms);
                let playing = self.watch.pos.playing;
                self.player(
                    PlayerCmd::Open {
                        showing,
                        start,
                        playing,
                    },
                    now_ms,
                    fx,
                );
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            WatchCommand::ShareSubtitles { name, vtt } => {
                if !matches!(self.watch.showing, Some(Showing::Local { .. })) {
                    return;
                }
                self.watch.subtitles = Some((name.clone(), vtt.clone()));
                let msg = PeerMessage::LocalVideoAction {
                    action: "subtitle-share".to_owned(),
                    file_name: Some(name.clone()),
                    file_size: None,
                    current_time: None,
                    from_host: self.is_host(),
                    vtt_string: Some(vtt),
                    subtitle_info: None,
                };
                fx.push(Effect::Broadcast(self.envelope(msg, now_ms)));
                self.log(format!("💬 You shared subtitles: \"{name}\""), fx);
            }
            WatchCommand::StreamLost { name } => {
                let Some(Showing::Local { name: n, have, .. }) = &mut self.watch.showing else {
                    return;
                };
                if *n != name || !*have {
                    return;
                }
                *have = false;
                self.player(PlayerCmd::Close, now_ms, fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            WatchCommand::Exit => {
                let Some(msg) = self.action_for_showing("close", None) else {
                    return;
                };
                let local = matches!(self.watch.showing, Some(Showing::Local { .. }));
                if self.broadcast_action(msg, now_ms, fx) {
                    self.close_here(now_ms, fx);
                    self.log(
                        if local {
                            "📁 You exited the local video"
                        } else {
                            "🎬 You exited the video"
                        },
                        fx,
                    );
                }
            }
            WatchCommand::SeekEveryone(secs) => {
                let Some(msg) = self.action_for_showing("seek", Some(secs)) else {
                    return;
                };
                if self.broadcast_action(msg, now_ms, fx) {
                    let who = self.me.username.clone();
                    self.player(
                        PlayerCmd::Seek {
                            to: secs,
                            who,
                            drift: false,
                        },
                        now_ms,
                        fx,
                    );
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    let m = (secs.max(0.0) / 60.0) as u64;
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    let s = (secs.max(0.0) % 60.0) as u64;
                    let mm = if m >= 60 {
                        format!("{}:{:02}", m / 60, m % 60)
                    } else {
                        m.to_string()
                    };
                    Self::notice(fx, format!("⏩ Jumped to {mm}:{s:02}"));
                }
            }
            WatchCommand::Player(report) => self.player_report(report, now_ms, fx),
            WatchCommand::QueueAdd {
                id,
                video_id,
                media,
                title,
                autoplay,
            } => {
                let media = media.and_then(|m| {
                    let mut v = serde_json::to_value(&m).unwrap_or(Value::Null);
                    if !title.is_empty()
                        && let Some(o) = v.as_object_mut()
                    {
                        o.insert("title".into(), Value::String(title.clone()));
                    }
                    rtc_protocol::media::normalize(&v)
                });
                if video_id.is_none() && media.is_none() {
                    return;
                }
                let final_title = match (&media, &video_id) {
                    (Some(m), _) => m.display_title(),
                    (None, Some(v)) if title.is_empty() => format!("YouTube Video ({v})"),
                    _ => title,
                };
                if autoplay && self.watch.showing.is_none() {
                    let started = match (media, video_id) {
                        (Some(m), _) => self.play_link(&m, false, now_ms, fx),
                        (None, Some(v)) => self.play_youtube(v, final_title.clone(), false, now_ms, fx),
                        (None, None) => false,
                    };
                    if started {
                        Self::notice(fx, format!("▶️ Now playing: \"{final_title}\""));
                        self.log(format!("🎬 Now playing: \"{final_title}\""), fx);
                    }
                    return;
                }
                let item = QueueItem {
                    id,
                    video_id: if media.is_some() { None } else { video_id },
                    media,
                    title: final_title.clone(),
                    added_by: self.me.username.clone(),
                    timestamp: now_ms,
                };
                let mut msg = Self::queue_msg("add");
                if let PeerMessage::QueueAction { item: i, .. } = &mut msg {
                    *i = Some(item.to_value());
                }
                self.watch.queue.push(item);
                self.send_queue(msg, now_ms, fx);
                Self::notice(fx, format!("📑 Added to queue: \"{final_title}\""));
                self.log(format!("📑 You added \"{final_title}\" to the watch queue"), fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            WatchCommand::QueueRemove(id) => {
                let at = self.watch.queue.iter().position(|q| q.id == id);
                if let Some(at) = at {
                    let removed = self.watch.queue.remove(at);
                    self.log(format!("🗑️ You removed \"{}\" from queue", removed.title), fx);
                    Self::notice(fx, "Removed from queue");
                }
                let mut msg = Self::queue_msg("remove");
                if let PeerMessage::QueueAction { item_id, .. } = &mut msg {
                    *item_id = Some(id);
                }
                self.send_queue(msg, now_ms, fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            WatchCommand::QueueMove { id, to } => {
                let Some(at) = self.watch.queue.iter().position(|q| q.id == id) else {
                    return;
                };
                let item = self.watch.queue.remove(at);
                let to = to.min(self.watch.queue.len());
                self.watch.queue.insert(to, item);
                let mut msg = Self::queue_msg("reorder");
                if let PeerMessage::QueueAction { queue, .. } = &mut msg {
                    *queue = Some(Self::queue_values(&self.watch.queue));
                }
                self.send_queue(msg, now_ms, fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            WatchCommand::QueueClear => {
                self.watch.queue.clear();
                self.send_queue(Self::queue_msg("clear"), now_ms, fx);
                Self::notice(fx, "Queue cleared");
                self.log("🗑️ You cleared the queue", fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            WatchCommand::QueuePlay(id) => {
                let Some(at) = self.watch.queue.iter().position(|q| q.id == id) else {
                    return;
                };
                if self.locked_for_me() {
                    self.blocked(now_ms, fx);
                    return;
                }
                let item = self.watch.queue.remove(at);
                if let Some(m) = item.media.clone() {
                    self.play_link(&m, false, now_ms, fx);
                } else if let Some(v) = item.video_id.clone() {
                    self.play_youtube(v, item.title.clone(), false, now_ms, fx);
                }
                let mut msg = Self::queue_msg("play-item");
                if let PeerMessage::QueueAction { item_id, .. } = &mut msg {
                    *item_id = Some(id);
                }
                self.send_queue(msg, now_ms, fx);
                Self::notice(fx, format!("▶️ Now playing from queue: \"{}\"", item.title));
                self.log(format!("🎬 Playing queued video: \"{}\"", item.title), fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            WatchCommand::QueueNext => self.play_next(false, false, now_ms, fx),
            WatchCommand::VoteSkip => self.vote_skip(now_ms, fx),
        }
    }

    fn vote_skip(&mut self, now_ms: f64, fx: &mut Vec<Effect>) {
        if self.watch.showing.is_none() {
            return;
        }
        if self.locked_for_me() {
            self.blocked(now_ms, fx);
            return;
        }
        let me = self.me.username.clone();
        let already = self.watch.skip_votes.contains(&me);
        if already {
            self.watch.skip_votes.retain(|u| u != &me);
        } else {
            self.watch.skip_votes.push(me);
        }
        let updated = self.watch.skip_votes.clone();
        let required = self.votes_required();
        let mut msg = Self::queue_msg("vote-skip");
        if let PeerMessage::QueueAction { skip_votes, .. } = &mut msg {
            *skip_votes = Some(updated.iter().cloned().map(Value::String).collect());
        }
        self.send_queue(msg, now_ms, fx);
        fx.push(Effect::Ui(UiEvent::Changed));
        if updated.len() < required {
            Self::notice(
                fx,
                if already {
                    "Removed skip vote".to_owned()
                } else {
                    format!("Voted to skip ({}/{required})", updated.len())
                },
            );
            return;
        }
        Self::notice(fx, format!("⏭️ Vote skip passed ({}/{required})!", updated.len()));
        self.log(
            format!(
                "⏭️ Vote skip passed ({}/{required} votes). Skipping video...",
                updated.len()
            ),
            fx,
        );
        self.watch.skip_votes.clear();
        self.send_queue(Self::queue_msg("vote-skip-passed"), now_ms, fx);
        if self.watch.queue.is_empty() {
            // nothing queued: close what's playing for everyone
            let msg = match self.watch.showing {
                Some(Showing::Link(_)) => PeerMessage::MediaAction {
                    action: "close".into(),
                    media: None,
                    current_time: None,
                    from_host: self.is_host(),
                    by_vote: Some(true),
                },
                _ => PeerMessage::YtAction {
                    action: "close".into(),
                    new_video_id: None,
                    video_id: None,
                    title: None,
                    current_time: None,
                    from_host: self.is_host(),
                    by_vote: Some(true),
                },
            };
            self.close_here(now_ms, fx);
            self.broadcast_action(msg, now_ms, fx);
            self.log("🎬 Queue ended. Exited video player.", fx);
        } else {
            self.play_next(true, false, now_ms, fx);
        }
    }

    fn player_report(&mut self, report: PlayerReport, now_ms: f64, fx: &mut Vec<Effect>) {
        match report {
            PlayerReport::State {
                time,
                playing,
                buffering,
                ..
            } => {
                if time.is_finite() {
                    self.watch.pos = Pos {
                        time,
                        at: now_ms,
                        playing,
                        buffering,
                        reported: true,
                    };
                }
            }
            PlayerReport::User { action, time } => {
                let (name, at) = match action {
                    UserAction::Play => ("play", time),
                    UserAction::Pause => ("pause", time),
                    UserAction::Seek => ("seek", time),
                };
                let Some(msg) = self.action_for_showing(name, Some(at)) else {
                    return;
                };
                let p = &mut self.watch.pos;
                p.time = at;
                p.at = now_ms;
                match action {
                    UserAction::Play => p.playing = true,
                    UserAction::Pause => p.playing = false,
                    UserAction::Seek => {}
                }
                self.broadcast_action(msg, now_ms, fx);
            }
            PlayerReport::Ended => {
                self.watch.pos.playing = false;
                self.play_next(false, true, now_ms, fx);
            }
            PlayerReport::Unavailable => {
                if !self.watch.queue.is_empty() {
                    self.play_next(false, true, now_ms, fx);
                }
            }
            PlayerReport::Title(t) => {
                if let Some(Showing::YouTube { title, .. }) = &mut self.watch.showing
                    && title.is_empty()
                    && !t.is_empty()
                {
                    *title = t;
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
            }
        }
    }

    /// Every tick: the reference says where it is.
    pub(super) fn watch_tick(&mut self, now_ms: f64, fx: &mut Vec<Effect>) {
        if now_ms - self.watch.last_heartbeat < HEARTBEAT_MS {
            return;
        }
        let Some(showing) = &self.watch.showing else {
            return;
        };
        if showing.is_live() || self.authority().as_ref() != Some(&self.me.peer_id) || self.peer_count() == 0
        {
            return;
        }
        self.watch.last_heartbeat = now_ms;
        let p = &self.watch.pos;
        let msg = PeerMessage::MediaHeartbeat {
            key: showing.key(),
            current_time: p.now(now_ms),
            is_playing: p.playing && !p.buffering,
        };
        fx.push(Effect::Broadcast(self.envelope(msg, now_ms)));
    }

    /// A channel opened: ask what they're watching.
    pub(super) fn watch_channel_open(&self, peer: PeerId, now_ms: f64, fx: &mut Vec<Effect>) {
        let envelope = self.envelope(PeerMessage::YtRequestSync, now_ms);
        fx.push(Effect::SendToPeer { peer, envelope });
    }

    /// Left the room.
    pub(super) fn watch_reset(&mut self, fx: &mut Vec<Effect>) {
        if self.watch.showing.is_some() {
            fx.push(Effect::Ui(UiEvent::Player(PlayerCmd::Close)));
        }
        self.watch = Watch::new();
    }

    /// A watch party message from a peer.
    #[allow(clippy::too_many_lines)]
    pub(super) fn watch_message(
        &mut self,
        from: &PeerId,
        sender: Option<&str>,
        msg: PeerMessage,
        now_ms: f64,
        fx: &mut Vec<Effect>,
    ) {
        let lock = self.playback_lock;
        match msg {
            PeerMessage::YtAction {
                action,
                new_video_id,
                video_id,
                title,
                current_time,
                from_host,
                ..
            } => {
                if lock && !from_host && locked_action(&action) {
                    return;
                }
                self.watch.last_change = now_ms;
                let who = self.who(from, sender);
                let is_yt = matches!(self.watch.showing, Some(Showing::YouTube { .. }));
                match action.as_str() {
                    "close" | "unload" => {
                        if is_yt {
                            self.close_here(now_ms, fx);
                        }
                        self.log(format!("🎬 {who} exited the video"), fx);
                        Self::notice(fx, format!("{who} exited the video"));
                    }
                    "load" => {
                        let id = new_video_id.or(video_id).unwrap_or_default();
                        if id.is_empty() {
                            return;
                        }
                        let title = title.unwrap_or_default();
                        let showing = Showing::YouTube {
                            id,
                            title: title.clone(),
                        };
                        self.show(Some(showing.clone()), fx);
                        self.player(
                            PlayerCmd::Open {
                                showing,
                                start: 0.0,
                                playing: true,
                            },
                            now_ms,
                            fx,
                        );
                        let suffix = if title.is_empty() {
                            String::new()
                        } else {
                            format!(": \"{title}\"")
                        };
                        self.log(format!("🎬 {who} loaded a YouTube video{suffix}"), fx);
                        Self::notice(
                            fx,
                            format!("{who} loaded {}", if title.is_empty() { "video" } else { &title }),
                        );
                    }
                    _ if is_yt => self.remote_playback(&action, current_time, who, now_ms, fx),
                    _ => {}
                }
            }
            PeerMessage::MediaAction {
                action,
                media,
                current_time,
                from_host,
                ..
            } => {
                if lock && !from_host && locked_action(&action) {
                    return;
                }
                self.watch.last_change = now_ms;
                let who = self.who(from, sender);
                let is_link = matches!(self.watch.showing, Some(Showing::Link(_)));
                match action.as_str() {
                    "load" => {
                        let Some(m) = media.as_ref().and_then(rtc_protocol::media::normalize) else {
                            return;
                        };
                        let title = m.display_title();
                        let showing = Showing::Link(m);
                        self.show(Some(showing.clone()), fx);
                        self.player(
                            PlayerCmd::Open {
                                showing,
                                start: 0.0,
                                playing: true,
                            },
                            now_ms,
                            fx,
                        );
                        self.log(format!("🎬 {who} opened: \"{title}\""), fx);
                        Self::notice(fx, format!("{who} opened {title}"));
                    }
                    "close" | "unload" => {
                        if !is_link {
                            return;
                        }
                        self.close_here(now_ms, fx);
                        self.log(format!("🎬 {who} exited the video"), fx);
                        Self::notice(fx, format!("{who} exited the video"));
                    }
                    _ if is_link => self.remote_playback(&action, current_time, who, now_ms, fx),
                    _ => {}
                }
            }
            PeerMessage::LocalVideoAction {
                action,
                file_name,
                file_size,
                current_time,
                from_host,
                vtt_string,
                ..
            } => {
                if lock && !from_host && locked_action(&action) {
                    return;
                }
                self.watch.last_change = now_ms;
                let who = self.who(from, sender);
                let local = matches!(self.watch.showing, Some(Showing::Local { .. }));
                match action.as_str() {
                    "load" => {
                        let name = file_name.unwrap_or_default();
                        // ours already (the same file): keep playing it
                        if matches!(&self.watch.showing, Some(Showing::Local { name: n, have: true, .. }) if *n == name)
                        {
                            return;
                        }
                        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                        let size = file_size
                            .filter(|s| s.is_finite() && *s >= 0.0)
                            .map_or(0, |s| s as u64);
                        let showing = Showing::Local {
                            name: name.clone(),
                            size,
                            from: Some(who.clone()),
                            have: false,
                        };
                        if self.watch.showing.is_some() {
                            self.player(PlayerCmd::Close, now_ms, fx);
                        }
                        self.show(Some(showing), fx);
                        self.watch.pos = Pos {
                            time: 0.0,
                            at: now_ms,
                            playing: false,
                            buffering: false,
                            reported: false,
                        };
                        self.log(format!("📁 {who} loaded local video: \"{name}\""), fx);
                        Self::notice(fx, format!("{who} loaded: {name}"));
                    }
                    "close" | "unload" => {
                        if local {
                            self.close_here(now_ms, fx);
                        }
                        self.log(format!("📁 {who} exited the local video"), fx);
                        Self::notice(fx, format!("{who} exited local video"));
                    }
                    "subtitle-share" => {
                        let name = file_name.unwrap_or_else(|| "captions".to_owned());
                        self.log(format!("💬 {who} shared subtitles: \"{name}\""), fx);
                        Self::notice(fx, format!("Subtitles loaded from {who}"));
                        if let Some(vtt) = vtt_string.filter(|v| !v.is_empty() && v.len() < 4_000_000) {
                            self.watch.subtitles = Some((name.clone(), vtt.clone()));
                            if matches!(self.watch.showing, Some(Showing::Local { have: true, .. })) {
                                fx.push(Effect::Ui(UiEvent::Player(PlayerCmd::Subtitles { name, vtt })));
                            }
                        }
                    }
                    _ if local => self.remote_local(&action, current_time, who, now_ms, fx),
                    _ => {}
                }
            }
            PeerMessage::LocalVideoSyncState {
                file_name,
                file_size,
                current_time,
                is_playing,
                subtitle_info,
                ..
            } => {
                let revert = self.consume_lock_revert();
                if file_name.is_empty() {
                    return;
                }
                let shared_subs = subtitle_info.as_ref().and_then(|v| {
                    let vtt = v.get("vttString")?.as_str()?.to_owned();
                    let name = v
                        .get("fileName")
                        .and_then(Value::as_str)
                        .unwrap_or("captions")
                        .to_owned();
                    (!vtt.is_empty()).then_some((name, vtt))
                });
                let have_any = matches!(self.watch.showing, Some(Showing::Local { have: true, .. }));
                let here =
                    matches!(&self.watch.showing, Some(Showing::Local { name, .. }) if *name == file_name);
                if (have_any && !revert) || (here && !revert) {
                    return;
                }
                let who = self.who(from, sender);
                let at = Some(current_time).filter(|t| t.is_finite());
                if here {
                    // the host's answer under the lock: back to where they are
                    let cmd = if is_playing {
                        PlayerCmd::Play { at, who }
                    } else {
                        PlayerCmd::Pause { at, who }
                    };
                    self.player(cmd, now_ms, fx);
                    return;
                }
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let size = Some(file_size)
                    .filter(|s| s.is_finite() && *s >= 0.0)
                    .map_or(0, |s| s as u64);
                if self.watch.showing.is_some() {
                    self.player(PlayerCmd::Close, now_ms, fx);
                }
                self.show(
                    Some(Showing::Local {
                        name: file_name.clone(),
                        size,
                        from: Some(who),
                        have: false,
                    }),
                    fx,
                );
                self.watch.pos = Pos {
                    time: at.unwrap_or(0.0),
                    at: now_ms,
                    playing: is_playing,
                    buffering: false,
                    reported: false,
                };
                self.log(
                    format!("🔄 Synced with room's local video session: \"{file_name}\""),
                    fx,
                );
                if shared_subs.is_some() {
                    self.watch.subtitles = shared_subs;
                }
            }
            PeerMessage::YtRequestSync => self.answer_sync(from, now_ms, fx),
            PeerMessage::YtSyncState {
                video_id,
                nothing_playing,
                current_time,
                is_playing,
                queue,
                skip_votes,
                active_video_title,
            } => {
                let revert = self.consume_lock_revert();
                if nothing_playing == Some(true) {
                    if revert {
                        self.close_here(now_ms, fx);
                    }
                    return;
                }
                let Some(id) = video_id.filter(|v| !v.is_empty()) else {
                    return;
                };
                let here = matches!(&self.watch.showing, Some(Showing::YouTube { id: h, .. }) if *h == id);
                if let Some(q) = &queue
                    && !here
                {
                    self.watch.queue = QueueItem::list(q);
                }
                if let Some(v) = skip_votes {
                    self.watch.skip_votes = v;
                }
                fx.push(Effect::Ui(UiEvent::Changed));
                if here && !revert {
                    return;
                }
                let t = current_time.unwrap_or(0.0);
                let playing = is_playing.unwrap_or(false);
                if here {
                    let who = self.who(from, sender);
                    let cmd = if playing {
                        PlayerCmd::Play { at: Some(t), who }
                    } else {
                        PlayerCmd::Pause { at: Some(t), who }
                    };
                    self.player(cmd, now_ms, fx);
                } else {
                    let title = active_video_title.unwrap_or_default();
                    let showing = Showing::YouTube { id, title };
                    self.watch.showing = Some(showing.clone());
                    self.player(
                        PlayerCmd::Open {
                            showing,
                            start: t,
                            playing,
                        },
                        now_ms,
                        fx,
                    );
                }
                self.log("🔄 Synced YouTube playback & queue with room", fx);
            }
            PeerMessage::MediaSyncState {
                media,
                queue,
                skip_votes,
                current_time,
                is_playing,
            } => {
                let revert = self.consume_lock_revert();
                let Some(m) = media.as_ref().and_then(rtc_protocol::media::normalize) else {
                    return;
                };
                let here = matches!(&self.watch.showing, Some(Showing::Link(h)) if h.url == m.url);
                if here && !revert {
                    return;
                }
                self.watch.queue = QueueItem::list(&queue);
                self.watch.skip_votes = skip_votes;
                fx.push(Effect::Ui(UiEvent::Changed));
                let title = m.title.clone().unwrap_or_else(|| m.url.clone());
                let Some(t) = current_time else {
                    if !here {
                        // they don't know where yet: open it, paused at the start until they do
                        let showing = Showing::Link(m);
                        self.watch.showing = Some(showing.clone());
                        self.player(
                            PlayerCmd::Open {
                                showing,
                                start: 0.0,
                                playing: true,
                            },
                            now_ms,
                            fx,
                        );
                    }
                    return;
                };
                let playing = is_playing.unwrap_or(false);
                if here {
                    let who = self.who(from, sender);
                    let cmd = if playing {
                        PlayerCmd::Play { at: Some(t), who }
                    } else {
                        PlayerCmd::Pause { at: Some(t), who }
                    };
                    self.player(cmd, now_ms, fx);
                } else {
                    let showing = Showing::Link(m);
                    self.watch.showing = Some(showing.clone());
                    self.player(
                        PlayerCmd::Open {
                            showing,
                            start: t,
                            playing,
                        },
                        now_ms,
                        fx,
                    );
                }
                self.log(format!("🔄 Synced with the room's video: \"{title}\""), fx);
            }
            PeerMessage::MediaHeartbeat {
                key,
                current_time,
                is_playing,
            } => {
                self.heartbeat(from, &key, current_time, is_playing, now_ms, fx);
            }
            PeerMessage::QueueAction {
                action,
                item,
                item_id,
                queue,
                next_video_id,
                next_title,
                remaining_queue,
                skip_votes,
            } => {
                let who = self.who(from, sender);
                let from_host = self.host.as_ref() == Some(from);
                if lock
                    && !from_host
                    && matches!(
                        action.as_str(),
                        "next" | "play-item" | "clear" | "reorder" | "vote-skip" | "vote-skip-passed"
                    )
                {
                    return;
                }
                match action.as_str() {
                    "add" => {
                        let Some(item) = item.as_ref().and_then(QueueItem::from_value) else {
                            return;
                        };
                        if !self.watch.queue.iter().any(|q| q.id == item.id) {
                            self.log(format!("📑 {who} queued: \"{}\"", item.title), fx);
                            self.watch.queue.push(item);
                            Self::notice(fx, format!("📑 {who} added to queue"));
                        }
                    }
                    "remove" => {
                        let Some(id) = item_id else {
                            return;
                        };
                        if let Some(at) = self.watch.queue.iter().position(|q| q.id == id) {
                            let removed = self.watch.queue.remove(at);
                            self.log(format!("🗑️ {who} removed \"{}\" from queue", removed.title), fx);
                        }
                    }
                    "reorder" => {
                        if let Some(q) = queue {
                            self.watch.queue = QueueItem::list(&q);
                        }
                    }
                    "clear" => {
                        self.watch.queue.clear();
                        self.log(format!("🗑️ {who} cleared the queue"), fx);
                    }
                    "play-item" => {
                        if let Some(id) = item_id {
                            self.watch.queue.retain(|q| q.id != id);
                            self.watch.skip_votes.clear();
                        }
                    }
                    "next" => {
                        if let Some(r) = remaining_queue {
                            self.watch.queue = QueueItem::list(&r);
                        } else if let Some(Value::String(v)) = next_video_id {
                            self.watch
                                .queue
                                .retain(|q| q.video_id.as_deref() != Some(v.as_str()));
                        }
                        self.watch.skip_votes.clear();
                        if let Some(t) = next_title.filter(|t| !t.is_empty()) {
                            if let Some(Showing::YouTube { title, .. }) = &mut self.watch.showing {
                                title.clone_from(&t);
                            }
                            self.log(format!("⏭️ Now playing next queued: \"{t}\""), fx);
                        }
                    }
                    "vote-skip" => {
                        if let Some(v) = skip_votes {
                            self.watch.skip_votes = votes(&v);
                        }
                    }
                    "vote-skip-passed" => {
                        let required = self.votes_required();
                        let current = skip_votes.map_or_else(|| self.watch.skip_votes.len(), |v| v.len());
                        if !from_host && current < required {
                            return;
                        }
                        self.watch.skip_votes.clear();
                        self.log("⏭️ Skip vote passed by consensus", fx);
                    }
                    _ => return,
                }
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            _ => {}
        }
    }

    fn remote_playback(
        &mut self,
        action: &str,
        t: Option<f64>,
        who: String,
        now_ms: f64,
        fx: &mut Vec<Effect>,
    ) {
        match action {
            "play" => {
                self.log(format!("▶️ {who} played the video"), fx);
                self.player(PlayerCmd::Play { at: t, who }, now_ms, fx);
            }
            "pause" => {
                self.log(format!("⏸️ {who} paused the video"), fx);
                self.player(PlayerCmd::Pause { at: t, who }, now_ms, fx);
            }
            "seek" => {
                let Some(to) = t.filter(|t| t.is_finite()) else {
                    return;
                };
                self.log(format!("⏩ {who} seeked to {}", clock(to)), fx);
                self.player(
                    PlayerCmd::Seek {
                        to,
                        who,
                        drift: false,
                    },
                    now_ms,
                    fx,
                );
            }
            _ => {}
        }
    }

    /// Play, pause or seek of a video file: kept as the room's spot even when we don't have the
    /// file (picking our own copy starts there).
    fn remote_local(&mut self, action: &str, t: Option<f64>, who: String, now_ms: f64, fx: &mut Vec<Effect>) {
        match action {
            "play" => {
                self.log(format!("▶️ {who} played local video"), fx);
                self.player(PlayerCmd::Play { at: t, who }, now_ms, fx);
            }
            "pause" => {
                self.log(format!("⏸️ {who} paused local video"), fx);
                self.player(PlayerCmd::Pause { at: t, who }, now_ms, fx);
            }
            "seek" => {
                let Some(to) = t.filter(|t| t.is_finite()) else {
                    return;
                };
                self.log(format!("⏩ {who} seeked to {}", clock(to)), fx);
                self.player(
                    PlayerCmd::Seek {
                        to,
                        who,
                        drift: false,
                    },
                    now_ms,
                    fx,
                );
            }
            _ => {}
        }
    }

    fn answer_sync(&self, to: &PeerId, now_ms: f64, fx: &mut Vec<Effect>) {
        let queue = Self::queue_values(&self.watch.queue);
        let votes = self.watch.skip_votes.clone();
        let p = &self.watch.pos;
        let msg = match &self.watch.showing {
            Some(Showing::Link(m)) => {
                let known = p.reported || p.at > 0.0;
                PeerMessage::MediaSyncState {
                    media: serde_json::to_value(m).ok(),
                    queue,
                    skip_votes: votes,
                    current_time: known.then(|| p.now(now_ms)),
                    is_playing: known.then_some(p.playing),
                }
            }
            Some(Showing::Local { name, size, have, .. }) => {
                #[allow(clippy::cast_precision_loss)]
                let file_size = *size as f64;
                PeerMessage::LocalVideoSyncState {
                    media_type: "local".to_owned(),
                    file_name: name.clone(),
                    file_size,
                    current_time: if *have { p.now(now_ms) } else { 0.0 },
                    is_playing: *have && p.playing && !p.buffering,
                    subtitle_info: self
                        .watch
                        .subtitles
                        .as_ref()
                        .map(|(n, v)| serde_json::json!({ "fileName": n, "vttString": v })),
                }
            }
            Some(Showing::YouTube { id, title }) => PeerMessage::YtSyncState {
                video_id: Some(id.clone()),
                nothing_playing: None,
                current_time: Some(p.now(now_ms)),
                is_playing: Some(p.playing && !p.buffering),
                queue: Some(queue),
                skip_votes: Some(votes),
                active_video_title: Some(title.clone()),
            },
            None => PeerMessage::YtSyncState {
                video_id: None,
                nothing_playing: Some(true),
                current_time: None,
                is_playing: None,
                queue: None,
                skip_votes: None,
                active_video_title: None,
            },
        };
        fx.push(Effect::SendToPeer {
            peer: to.clone(),
            envelope: self.envelope(msg, now_ms),
        });
    }

    /// The reference's position: jump there if we're more than 1.5 s off (`driftCorrection`).
    fn heartbeat(
        &mut self,
        from: &PeerId,
        key: &str,
        there: f64,
        playing: bool,
        now_ms: f64,
        fx: &mut Vec<Effect>,
    ) {
        if self.authority().as_ref() != Some(from) {
            return;
        }
        let Some(showing) = &self.watch.showing else {
            return;
        };
        let w = &self.watch;
        let p = &w.pos;
        if now_ms < w.backoff_until || now_ms - w.last_change < SETTLE_MS {
            return;
        }
        if !playing || !p.playing || p.buffering || showing.is_live() || showing.key() != key {
            return;
        }
        let here = p.now(now_ms);
        if !there.is_finite() || (here - there).abs() <= DRIFT_LIMIT_S {
            return;
        }
        let target = there + LEAD_S;
        self.watch.corrections.retain(|t| now_ms - t < BACKOFF_WINDOW_MS);
        self.watch.corrections.push(now_ms);
        if self.watch.corrections.len() >= BACKOFF_COUNT {
            self.watch.corrections.clear();
            self.watch.backoff_until = now_ms + BACKOFF_MS;
            self.log(
                "🔄 This device keeps falling behind the room (slow connection?). Auto re-sync paused for 2 minutes.",
                fx,
            );
        }
        self.player(
            PlayerCmd::Seek {
                to: target,
                who: "Auto-sync".to_owned(),
                drift: true,
            },
            now_ms,
            fx,
        );
        self.log(
            format!("🔄 Re-synced with the room (was {:.1} s off)", here - there),
            fx,
        );
    }
}
