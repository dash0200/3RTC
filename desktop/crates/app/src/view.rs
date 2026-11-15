//! The window's state and logic: the engine connection, what's open (panel tab, popover,
//! dialog), toasts, logs and keyboard shortcuts. Drawing is in `home.rs`, `room.rs`, `dialogs.rs`.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::slider::{SliderEvent, SliderState};
use gpui_kit::{
    AppContext as _, ClipboardItem, Context, Entity, FocusHandle, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString, Styled as _, Subscription, Task,
    Window, div, prelude::FluentBuilder as _, px,
};
use rtc_core::Command;
use rtc_engine::{ChatLine, Config, Devices, Handle, MicSource, Phase, Snapshot, Update};
use rtc_platform_win::TrayEvent;
use rtc_platform_win::keys::{Binding, Key};
use rtc_protocol::{ClientId, PeerId, RoomId};
use rtc_ui::code_input::{CodeEvent, CodeInput};
use rtc_ui::overlay::toast;
use rtc_ui::tokens;

use crate::desktop::{self, Desktop, DesktopEvent};
use crate::home::Home;
use crate::settings::{LastRoom, Settings, VoiceMode};

/// Build number shown to peers and in the home footer (`YYMMDD.HHMM` from CI).
pub(crate) const BUILD: &str = match option_env!("RTC_BUILD") {
    Some(b) => b,
    None => "Development build",
};

/// Lines kept in the Logs tab (the web app keeps 200).
const LOGS_KEEP: usize = 200;
/// How long a toast stays.
const TOAST_FOR: Duration = Duration::from_millis(2600);

/// The side panel's tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tab {
    Invite,
    Chat,
    Queue,
    People,
    Logs,
}

/// A popover above the dock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Pop {
    Devices,
    More,
    /// A person's volume (who: `RoomView::volume_for`).
    Volume,
    /// Your reactions.
    Reactions,
    /// The soundboard.
    Sounds,
    /// "Play together": the games.
    Games,
}

/// A dialog over everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dialog {
    Leave,
    Qr,
    Voice,
    Server,
    /// Desktop settings: start with Windows, the tray, notifications, links.
    Desktop,
    /// A link asks to join this room: ask first.
    Link(RoomId),
    /// "Your quick reactions".
    Reactions,
    /// A chat picture, big (which: `RoomView::lightbox`).
    Image,
    /// Connection details.
    Network,
    /// Share one app's sound.
    AppSound,
    /// Pick a screen or window to share.
    Screen,
    /// Player shortcuts and controls settings.
    Player,
}

/// Which key is being recorded in the settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyTarget {
    Ptt,
    Mute,
    Deafen,
    PlayerPlayPause,
    PlayerFullscreen,
    PlayerSeekBackward,
    PlayerSeekForward,
    PlayerVolumeUp,
    PlayerVolumeDown,
    PlayerSubtitles,
}

/// One line in the Logs tab.
#[derive(Debug, Clone)]
pub(crate) struct LogLine {
    pub(crate) time: String,
    pub(crate) text: SharedString,
}

pub(crate) struct RoomView {
    pub(crate) settings: Settings,
    runtime: tokio::runtime::Handle,
    pub(crate) engine: Option<Handle>,
    pub(crate) room: Option<Snapshot>,
    pub(crate) chat: Vec<ChatLine>,
    pub(crate) logs: Vec<LogLine>,
    pub(crate) unread: usize,
    pub(crate) logs_unseen: usize,
    pub(crate) devices: Devices,
    pub(crate) name: Entity<InputState>,
    pub(crate) code: Entity<CodeInput>,
    pub(crate) message: Entity<InputState>,
    pub(crate) link: Entity<InputState>,
    pub(crate) server_url: Entity<InputState>,
    pub(crate) join_error: Option<SharedString>,
    pub(crate) toast: Option<SharedString>,
    toast_task: Option<Task<()>>,
    pub(crate) panel_open: bool,
    pub(crate) tab: Tab,
    pub(crate) pop: Option<Pop>,
    pub(crate) dialog: Option<Dialog>,
    pub(crate) copied: Option<&'static str>,
    copied_task: Option<Task<()>>,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
    /// Keys, tray, notifications.
    pub(crate) desktop: Desktop,
    /// The window is in front (notifications only when it isn't).
    pub(crate) active: bool,
    /// Push-to-talk has the mic open.
    pub(crate) ptt_talking: bool,
    ptt_release: Option<Task<()>>,
    /// A key is being recorded for this setting (keys held so far, in the order pressed).
    pub(crate) recording: Option<KeyTarget>,
    record_seen: Vec<Key>,
    record_task: Option<Task<()>>,
    /// The program in front runs as administrator, so push-to-talk can't see keys.
    pub(crate) admin_app: Option<String>,
    _admin_watch: Task<()>,
    /// People already said hello to (notifications), this room.
    announced: HashSet<PeerId>,
    /// Starts with Windows (read when the Desktop settings open).
    pub(crate) autostart: bool,
    /// When the last room was last saved (ms since 1970).
    last_room_saved: u64,
    /// Whose volume popover is open, and its slider.
    pub(crate) volume_for: Option<PeerId>,
    pub(crate) volume_slider: Option<Entity<SliderState>>,
    #[allow(dead_code, reason = "kept alive, never read")]
    volume_sub: Option<Subscription>,
    /// The volume last given to the engine for each person this room.
    volumes_sent: HashMap<PeerId, f32>,
    /// The voice settings' mic meter (0..1, falls back slowly) and what keeps it moving.
    pub(crate) mic_meter: f32,
    meter_task: Option<Task<()>>,
    /// Floating reactions, the clip banner, the reactions editor.
    pub(crate) fun: crate::fun::FunState,
    /// The reactions editor's "type or paste any emoji" box.
    pub(crate) reaction_input: Entity<InputState>,
    /// The emoji picker: open, its tab and search box.
    pub(crate) emoji_open: bool,
    pub(crate) emoji_tab: usize,
    pub(crate) emoji_search: Entity<InputState>,
    /// Chat pictures by transfer id, and the one attached to the next message.
    pub(crate) pictures: HashMap<String, crate::chat::Picture>,
    pub(crate) pending: Option<crate::chat::Pending>,
    /// The picture the lightbox shows.
    pub(crate) lightbox: Option<String>,
    /// Connection details.
    pub(crate) net: crate::net::NetState,
    /// Updates: where they are, and the task checking for them.
    pub(crate) update: crate::update::Status,
    /// The graphics card: what Windows offers, what the app started with, what's chosen.
    pub(crate) gpu: GpuState,
    update_task: Option<Task<()>>,
    /// The watch party on screen: the player, quick picks, the queue's link box.
    pub(crate) watch: crate::watch::WatchUi,
    /// The in-game overlay and a shared app's sound.
    pub(crate) extras: crate::extras::Extras,
    /// Screen sharing.
    pub(crate) screen: crate::screen::ScreenUi,
    /// The open game on this device.
    pub(crate) activity: crate::activity::ActivityUi,
}

/// Milliseconds since 1970.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// How often the app in front is checked for running as administrator (push-to-talk mode).
const ADMIN_CHECK: Duration = Duration::from_secs(2);
/// How often held keys are read while recording one.
const RECORD_POLL: Duration = Duration::from_millis(25);
/// Chat lines kept on screen (older ones go, with their pictures) (`MAX_MESSAGES`).
const CHAT_KEEP: usize = 300;
/// How often the voice settings' mic meter moves.
const METER_TICK: Duration = Duration::from_millis(50);

pub(crate) fn time_now() -> String {
    chrono::Local::now().format("%-I:%M %p").to_string()
}

impl RoomView {
    pub(crate) fn new(
        window: &mut Window,
        cx: &mut Context<'_, Self>,
        runtime: &tokio::runtime::Handle,
        settings: Settings,
        launches: Option<tokio::sync::mpsc::UnboundedReceiver<String>>,
        open_room: Option<RoomId>,
    ) -> Self {
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("So your friends know it’s you")
                .default_value(settings.username.clone())
        });
        let code = cx.new(CodeInput::new);
        let message = cx.new(|cx| InputState::new(window, cx).placeholder("Message the room"));
        let link = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Paste a YouTube, Vimeo, Twitch or video link")
        });
        let reaction_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Or type / paste any emoji"));
        let emoji_search = cx.new(|cx| InputState::new(window, cx).placeholder("Search emojis..."));
        let server_url = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("wss://your-server")
                .default_value(settings.signal_url.clone())
        });
        let subscriptions = vec![
            cx.subscribe(&code, |this, _, e: &CodeEvent, cx| match e {
                CodeEvent::Submit(_) => this.join(cx),
                CodeEvent::Changed => {
                    this.join_error = None;
                    cx.notify();
                }
            }),
            cx.subscribe_in(&message, window, |this, _, e: &InputEvent, window, cx| {
                if matches!(e, InputEvent::PressEnter { .. }) {
                    this.send_chat(window, cx);
                }
            }),
            cx.subscribe_in(&name, window, |this, _, e: &InputEvent, _, cx| {
                if matches!(e, InputEvent::PressEnter { .. }) {
                    this.create(cx);
                }
            }),
            cx.subscribe_in(&link, window, |this, _, e: &InputEvent, window, cx| {
                if matches!(e, InputEvent::PressEnter { .. }) {
                    this.submit_link(false, window, cx);
                } else if matches!(e, InputEvent::Change) && this.watch.link_error.is_some() {
                    this.watch.link_error = None;
                    cx.notify();
                }
            }),
        ];
        let panel_open = settings.panel_open;
        let (desktop, mut events) = Desktop::start();
        // events from the keys, the tray and other launches arrive here, on the window's thread
        cx.spawn_in(window, async move |this, cx| {
            while let Some(e) = events.recv().await {
                if this
                    .update_in(cx, |v, window, cx| v.on_desktop(e, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        if let Some(mut launches) = launches {
            let tx = desktop.sender();
            cx.spawn(async move |_, _| {
                while let Some(m) = launches.recv().await {
                    if tx.send(DesktopEvent::Launch(m)).is_err() {
                        break;
                    }
                }
            })
            .detach();
        }
        let mut subscriptions = subscriptions;
        subscriptions.push(cx.observe_window_activation(window, |this, window, _| {
            this.active = window.is_window_active();
            if !this.active {
                if this.screen.ctl_game_mode {
                    this.screen.ctl_game_mode = false;
                    this.screen.ctl_last_pos = None;
                    this.screen.ctl_delta = (0, 0);
                    rtc_platform_win::unlock_pointer();
                } else {
                    rtc_platform_win::set_cursor_visible(true);
                }
            }
        }));
        let admin_watch = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(ADMIN_CHECK).await;
                let Ok(()) = this.update(cx, Self::check_admin_app) else {
                    break;
                };
            }
        });
        rtc_platform_win::set_window_icon(window);
        let (player_tx, player_rx) = tokio::sync::mpsc::unbounded_channel();
        let watch = crate::watch::WatchUi::new(window, cx, player_tx);
        subscriptions.push(cx.subscribe_in(
            &watch.queue_link,
            window,
            |this, _, e: &InputEvent, window, cx| {
                if matches!(e, InputEvent::PressEnter { .. }) {
                    this.submit_link(true, window, cx);
                }
            },
        ));
        let mut this = Self {
            settings,
            runtime: runtime.clone(),
            engine: None,
            room: None,
            chat: Vec::new(),
            logs: Vec::new(),
            unread: 0,
            logs_unseen: 0,
            devices: Devices::default(),
            name,
            code,
            message,
            link,
            server_url,
            join_error: None,
            toast: None,
            toast_task: None,
            panel_open,
            tab: Tab::Invite,
            pop: None,
            dialog: None,
            copied: None,
            copied_task: None,
            focus: cx.focus_handle(),
            _subscriptions: subscriptions,
            desktop,
            active: true,
            ptt_talking: false,
            ptt_release: None,
            recording: None,
            record_seen: Vec::new(),
            record_task: None,
            admin_app: None,
            _admin_watch: admin_watch,
            announced: HashSet::new(),
            autostart: false,
            last_room_saved: 0,
            volume_for: None,
            volume_slider: None,
            volume_sub: None,
            volumes_sent: HashMap::new(),
            mic_meter: 0.0,
            meter_task: None,
            fun: crate::fun::FunState::default(),
            reaction_input,
            emoji_open: false,
            emoji_tab: 0,
            emoji_search,
            pictures: HashMap::new(),
            pending: None,
            lightbox: None,
            net: crate::net::NetState::default(),
            update: crate::update::Status::Idle,
            gpu: GpuState::read(),
            update_task: None,
            watch,
            extras: crate::extras::Extras::default(),
            screen: crate::screen::ScreenUi::default(),
            activity: crate::activity::ActivityUi::default(),
        };
        this.start_updates(cx);
        this.start_watch(player_rx, cx);
        this.start_video_events(window, cx);
        this.log("Welcome to 3RTC! Create or join a room to chat and watch YouTube together.".to_owned());
        this.start_engine(cx);
        if let Some(room) = open_room {
            this.dialog = Some(Dialog::Link(room));
        }
        this
    }

    /// Starts (or restarts) the engine and pumps its updates into this view.
    fn start_engine(&mut self, cx: &mut Context<'_, Self>) {
        let Ok(client_id) = ClientId::new(self.settings.client_id.clone()) else {
            return;
        };
        // RTC_FAKE_MIC=tone runs without a sound card (tests): a 440 Hz tone instead of the mic
        let mic = match std::env::var("RTC_FAKE_MIC").as_deref() {
            Ok("tone") => MicSource::Tone(440.0),
            Ok("silence") => MicSource::Silence,
            _ if self.settings.classic_audio => MicSource::Device,
            _ => MicSource::Pipeline,
        };
        let config = Config {
            signaling_urls: self.settings.signaling_urls(),
            username: self.settings.username.clone(),
            client_id,
            build: BUILD.to_owned(),
            ice: rtc_engine::IceServerConfig::defaults(),
            mic,
        };
        let _guard = self.runtime.enter();
        let (handle, mut updates) = rtc_engine::start(config);
        cx.spawn(async move |this, cx| {
            while let Some(update) = updates.recv().await {
                if this.update(cx, |view, cx| view.apply(update, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        if !self.settings.input_device_id.is_empty() {
            handle.set_input(self.settings.input_device_id.clone());
        }
        if !self.settings.output_device_id.is_empty() {
            handle.set_output(self.settings.output_device_id.clone());
        }
        handle.set_isolation(self.settings.voice_isolation && !self.settings.low_power);
        handle.set_low_power(self.settings.low_power);
        handle.screen_options(self.screen_options());
        handle.screen_volume(self.settings.screen_volume);
        handle.screen_quality(self.settings.screen_quality);
        handle.list_devices();
        self.volumes_sent.clear();
        self.engine = Some(handle);
    }

    /// Server settings changed: reconnect to the new server (only between rooms).
    pub(crate) fn restart_engine(&mut self, cx: &mut Context<'_, Self>) {
        self.engine = None;
        self.room = None;
        self.start_engine(cx);
        cx.notify();
    }

    pub(crate) fn in_room(&self) -> Option<RoomId> {
        match self.room.as_ref().map(|r| &r.phase) {
            Some(Phase::InRoom(id)) => Some(*id),
            _ => None,
        }
    }

    fn log(&mut self, text: String) {
        if self.logs.len() >= LOGS_KEEP {
            self.logs.remove(0);
        }
        self.logs.push(LogLine {
            time: chrono::Local::now().format("%-I:%M:%S %p").to_string(),
            text: text.into(),
        });
        if self.tab != Tab::Logs || !self.panel_open {
            self.logs_unseen += 1;
        }
    }

    pub(crate) fn show_toast(&mut self, text: impl Into<SharedString>, cx: &mut Context<'_, Self>) {
        self.toast = Some(text.into());
        self.toast_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TOAST_FOR).await;
            let _ = this.update(cx, |v, cx| {
                v.toast = None;
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn apply(&mut self, update: Update, cx: &mut Context<'_, Self>) {
        match update {
            Update::Room(snapshot) => {
                self.room_changed(&snapshot, cx);
                let was_in = self.in_room();
                let was_alone = self.room.as_ref().is_none_or(|r| r.members.is_empty());
                if was_in.is_some() && !matches!(snapshot.phase, Phase::InRoom(_)) {
                    // left: back to the home screen, fresh
                    self.chat.clear();
                    self.unread = 0;
                    self.pop = None;
                    self.dialog = None;
                    self.fun.clear();
                    self.pictures.clear();
                    self.pending = None;
                    self.lightbox = None;
                    self.emoji_open = false;
                    self.stop_app_sound(cx);
                }
                let entered = was_in.is_none() && matches!(snapshot.phase, Phase::InRoom(_));
                let alone = snapshot.members.is_empty();
                self.room = Some(snapshot);
                self.activity_changed();
                self.chess_after(cx);
                self.ludo_after(cx);
                self.games_after(cx);
                self.tycoon_after(cx);
                self.whiteboard_after(cx);
                if entered {
                    self.tab = if alone { Tab::Invite } else { Tab::Chat };
                    if let Some(id) = self.in_room() {
                        self.show_toast(format!("Created room {id}"), cx);
                    }
                } else if was_alone && !alone && self.tab == Tab::Invite {
                    self.tab = Tab::Chat;
                }
                self.desktop.show_room(self.room.as_ref());
                self.sync_overlay();
                if entered || was_in.is_some() != self.in_room().is_some() {
                    self.watch_keys();
                }
            }
            Update::Chat(line) => {
                let mine = self.room.as_ref().is_some_and(|r| r.me == line.from);
                if !mine
                    && !self.active
                    && self.settings.notifications
                    && desktop::mentions(&line.text, &self.settings.username)
                {
                    self.desktop
                        .notify(&format!("{} mentioned you", line.name), &line.text);
                }
                if !mine && (self.tab != Tab::Chat || !self.panel_open) {
                    self.unread += 1;
                }
                self.chat_line_sounds(&line);
                self.chat.push(line);
                if self.chat.len() > CHAT_KEEP {
                    let gone = self.chat.remove(0);
                    if let Some(i) = gone.image {
                        self.pictures.remove(&i.transfer_id);
                    }
                }
            }
            Update::Reaction(r) => self.on_reaction(r, cx),
            Update::Sound(s) => self.on_sound(s, cx),
            Update::Board { from, live, body } => self.on_board(from.as_str(), live, &body, cx),
            Update::ImageProgress { transfer_id, percent } => self.picture_progress(transfer_id, percent),
            Update::ImageReady { transfer_id, bytes } => self.picture_ready(&transfer_id, bytes),
            Update::Net(peers) => self.on_net(peers),
            Update::Log(text) => self.log(text),
            Update::Notice(n) => {
                if self.in_room().is_some() {
                    self.show_toast(n, cx);
                } else {
                    self.join_error = Some(n.into());
                }
            }
            Update::Devices(d) => self.devices = d,
            Update::Player(c) => self.on_player_cmd(c, cx),
            Update::StreamReady { name, size, reader } => self.stream_ready(name, size, reader, cx),
            Update::StreamEnded(why) => self.stream_ended(why, cx),
            Update::StreamProgress(p) => self.stream_progress(p, cx),
            Update::FileFormat { name, description } => {
                self.watch.local.remote_format = Some((name, description));
            }
            Update::FileProblems(list) => self.watch.local.problems = list,
            Update::Screen { sharer, mine, feed } => self.on_screen(sharer, mine, feed, cx),
            Update::ScreenPointer {
                peer,
                name,
                x,
                y,
                active,
            } => self.on_screen_pointer(peer, name, x, y, active),
            Update::ScreenPing { name, x, y } => self.on_screen_ping(name, x, y),
            Update::Control(c) => self.on_control(c, cx),
            Update::ScreenSending { encoder, viewers } => {
                self.screen.sending = Some((encoder, viewers));
            }
            Update::ScreenError(e) => {
                self.screen.error = Some(e.clone());
                self.show_toast(format!("Couldn't share the screen: {e}"), cx);
            }
            Update::Pop => self.ui_sound(&crate::sounds::POP, crate::sounds::POP_WAV.as_slice()),
        }
        cx.notify();
    }

    pub(crate) fn command(&self, c: Command) {
        if let Some(e) = &self.engine {
            e.command(c);
        }
    }

    /// The name to go by: what's typed, else the saved one, else "Guest" (as the web app).
    fn use_name(&mut self, cx: &mut Context<'_, Self>) {
        let typed = self.name.read(cx).value().trim().to_owned();
        let name = if !typed.is_empty() {
            rtc_core::clean_name(&typed)
        } else if !self.settings.username.is_empty() {
            self.settings.username.clone()
        } else {
            "Guest".to_owned()
        };
        if name != self.settings.username {
            self.settings.username.clone_from(&name);
            self.settings.save();
        }
        self.command(Command::SetName(name));
    }

    pub(crate) fn create(&mut self, cx: &mut Context<'_, Self>) {
        self.join_error = None;
        self.use_name(cx);
        self.command(Command::CreateRoom);
    }

    pub(crate) fn join(&mut self, cx: &mut Context<'_, Self>) {
        let Ok(room) = RoomId::parse(&self.code.read(cx).code()) else {
            return;
        };
        self.join_error = None;
        self.use_name(cx);
        self.command(Command::Join(room));
    }

    fn send_chat(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let text = self.message.read(cx).value().to_string();
        if self.pending.is_some() {
            self.send_picture(text.trim().to_owned(), cx);
            self.message.update(cx, |m, cx| m.set_value("", window, cx));
            return;
        }
        if text.trim().is_empty() {
            return;
        }
        self.command(Command::SendChat {
            id: Handle::new_message_id(),
            text,
        });
        self.message.update(cx, |m, cx| m.set_value("", window, cx));
    }

    pub(crate) fn send_chat_clicked(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.send_chat(window, cx);
    }

    /// "Play for everyone": watching together arrives with the watch party (M4).
    pub(crate) fn toggle_mic(&mut self) {
        if self.settings.voice_mode == VoiceMode::Ptt {
            return;
        }
        let muted = self.room.as_ref().is_none_or(|r| r.muted);
        self.command(Command::SetMuted(!muted));
    }

    pub(crate) fn toggle_deafen(&mut self) {
        let deafened = self.room.as_ref().is_some_and(|r| r.deafened);
        self.command(Command::SetDeafened(!deafened));
    }

    pub(crate) fn set_tab(&mut self, tab: Tab, cx: &mut Context<'_, Self>) {
        self.tab = tab;
        self.panel_open = true;
        match tab {
            Tab::Chat => self.unread = 0,
            Tab::Logs => self.logs_unseen = 0,
            _ => {}
        }
        cx.notify();
    }

    pub(crate) fn toggle_panel(&mut self, cx: &mut Context<'_, Self>) {
        self.panel_open = !self.panel_open;
        self.settings.panel_open = self.panel_open;
        self.settings.save();
        if self.panel_open && self.tab == Tab::Chat {
            self.unread = 0;
        }
        cx.notify();
    }

    pub(crate) fn toggle_pop(&mut self, pop: Pop, cx: &mut Context<'_, Self>) {
        self.pop = if self.pop == Some(pop) { None } else { Some(pop) };
        if self.pop == Some(Pop::Devices)
            && let Some(e) = &self.engine
        {
            e.list_devices();
        }
        cx.notify();
    }

    pub(crate) fn open_dialog(&mut self, d: Dialog, cx: &mut Context<'_, Self>) {
        self.pop = None;
        self.dialog = Some(d);
        if d == Dialog::Voice
            && let Some(e) = &self.engine
        {
            e.list_devices();
            // the mic and speakers run while the settings are open, for the meter and the test
            e.audio_open(true);
            self.meter_task = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(METER_TICK).await;
                    let Ok(true) = this.update(cx, Self::meter_tick) else {
                        break;
                    };
                }
            }));
        }
        if d == Dialog::Desktop {
            self.autostart = rtc_platform_win::autostart::enabled();
        }
        cx.notify();
    }

    pub(crate) fn close_dialog(&mut self, cx: &mut Context<'_, Self>) {
        self.dialog = None;
        if self.recording.is_some() {
            self.stop_recording(cx);
        }
        cx.notify();
    }

    pub(crate) fn leave(&mut self, cx: &mut Context<'_, Self>) {
        if self.screen.ctl_game_mode {
            self.screen.ctl_game_mode = false;
            self.screen.ctl_last_pos = None;
            self.screen.ctl_delta = (0, 0);
            rtc_platform_win::unlock_pointer();
        } else {
            rtc_platform_win::set_cursor_visible(true);
        }
        self.dialog = None;
        self.extras.share_hud = None;
        self.command(Command::Leave);
        cx.notify();
    }

    /// Moves the voice settings' meter; false once the settings are closed (and lets the mic go).
    fn meter_tick(&mut self, cx: &mut Context<'_, Self>) -> bool {
        if self.dialog != Some(Dialog::Voice) {
            if let Some(e) = &self.engine {
                e.audio_open(false);
            }
            self.mic_meter = 0.0;
            self.meter_task = None;
            return false;
        }
        let level = self.engine.as_ref().and_then(Handle::mic_level).unwrap_or(0.0);
        self.mic_meter = level.max(self.mic_meter * 0.85);
        cx.notify();
        true
    }

    /// Our own audio path is running (per-person volume, Voice Isolation, the meter).
    pub(crate) fn has_pipeline(&self) -> bool {
        self.engine.as_ref().is_some_and(|e| e.mic_level().is_some())
    }

    pub(crate) fn set_isolation(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.voice_isolation = on;
        self.settings.save();
        if let Some(e) = &self.engine {
            e.set_isolation(on && !self.settings.low_power);
        }
        cx.notify();
    }

    /// Low-power mode: calmer reactions, no Voice Isolation, connections checked less often.
    pub(crate) fn set_low_power(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.low_power = on;
        self.settings.save();
        if let Some(e) = &self.engine {
            e.set_low_power(on);
            e.set_isolation(self.settings.voice_isolation && !on);
        }
        cx.notify();
    }

    pub(crate) fn set_seek_step(&mut self, secs: f64, cx: &mut Context<'_, Self>) {
        self.settings.seek_step_secs = secs.clamp(1.0, 120.0);
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_player_click_play(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.player_click_play = on;
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_player_double_click_fullscreen(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.player_double_click_fullscreen = on;
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_player_scroll_volume(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.player_scroll_volume = on;
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_player_mouse_nav_seek(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.player_mouse_nav_seek = on;
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_player_arrow_keys(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.player_arrow_keys = on;
        self.settings.save();
        cx.notify();
    }

    /// Switches between our own audio path and libwebrtc's (restarts the engine: not in a room).
    pub(crate) fn set_classic_audio(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        if self.in_room().is_some() {
            return;
        }
        self.settings.classic_audio = on;
        self.settings.save();
        let open = self.dialog;
        self.restart_engine(cx);
        // the voice settings are where this was flipped: keep their meter going
        if open == Some(Dialog::Voice) {
            self.open_dialog(Dialog::Voice, cx);
        }
    }

    pub(crate) fn play_test_sound(&mut self) {
        if let Some(e) = &self.engine {
            e.test_sound();
        }
    }

    /// A person's volume for you and whether you muted them, as saved.
    pub(crate) fn peer_volume(&self, m: &rtc_engine::Member) -> (f32, bool) {
        let Some(id) = &m.client_id else {
            return (1.0, false);
        };
        let v = self.settings.volumes.get(id).copied().unwrap_or(1.0);
        (v.abs(), v.is_sign_negative())
    }

    /// Sets a person's volume (0..2) and mute-for-me, saved under their install id.
    pub(crate) fn set_peer_volume(
        &mut self,
        peer: &PeerId,
        volume: f32,
        muted: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let volume = ((volume * 20.0).round() / 20.0).clamp(0.0, 2.0);
        let client_id = self
            .room
            .as_ref()
            .and_then(|r| r.members.iter().find(|(p, _)| p == peer))
            .and_then(|(_, m)| m.client_id.clone());
        if let Some(id) = client_id {
            // saved as one number: the volume, negative when muted for you
            if muted {
                self.settings.volumes.insert(id, -volume.max(0.05));
            } else if (volume - 1.0).abs() < 0.001 {
                self.settings.volumes.remove(&id);
            } else {
                self.settings.volumes.insert(id, volume);
            }
            self.settings.save();
        }
        let gain = if muted { 0.0 } else { volume };
        if let Some(e) = &self.engine {
            e.set_volume(peer.clone(), gain);
        }
        if let Some(slider) = &self.volume_slider
            && self.volume_for.as_ref() == Some(peer)
        {
            // a preset or mute moved it: the slider shows the new value
            let shown = if muted { 0.0 } else { volume };
            if (slider.read(cx).value().start() - shown).abs() > 0.001 {
                self.make_volume_slider(shown, cx);
            }
        }
        self.volumes_sent.insert(peer.clone(), gain);
        cx.notify();
    }

    /// Gives the engine the saved volume of everyone whose identity has arrived.
    fn send_saved_volumes(&mut self, snapshot: &Snapshot) {
        let Some(e) = &self.engine else { return };
        for (peer, m) in &snapshot.members {
            let (volume, muted) = self.peer_volume(m);
            let gain = if muted { 0.0 } else { volume };
            let sent = self.volumes_sent.get(peer).copied().unwrap_or(1.0);
            if (gain - sent).abs() > 0.001 {
                e.set_volume(peer.clone(), gain);
                self.volumes_sent.insert(peer.clone(), gain);
            }
        }
    }

    pub(crate) fn open_volume(&mut self, peer: PeerId, cx: &mut Context<'_, Self>) {
        if self.pop == Some(Pop::Volume) && self.volume_for.as_ref() == Some(&peer) {
            self.pop = None;
        } else {
            let (volume, muted) = self
                .room
                .as_ref()
                .and_then(|r| r.members.iter().find(|(p, _)| *p == peer))
                .map_or((1.0, false), |(_, m)| self.peer_volume(m));
            self.pop = Some(Pop::Volume);
            self.volume_for = Some(peer);
            self.make_volume_slider(if muted { 0.0 } else { volume }, cx);
        }
        cx.notify();
    }

    fn make_volume_slider(&mut self, value: f32, cx: &mut Context<'_, Self>) {
        let state = cx.new(|_| {
            SliderState::new()
                .min(0.0)
                .max(2.0)
                .step(0.05)
                .default_value(value)
        });
        self.volume_sub = Some(cx.subscribe(&state, |this, _, e: &SliderEvent, cx| {
            if let SliderEvent::Change(v) = e
                && let Some(peer) = this.volume_for.clone()
            {
                // dragging the slider unmutes, as on the web
                this.set_peer_volume(&peer, v.start(), false, cx);
            }
        }));
        self.volume_slider = Some(state);
    }

    pub(crate) fn make_host(&self, peer: rtc_protocol::PeerId) {
        self.command(Command::TransferHost(peer));
    }

    pub(crate) fn pick_input(&mut self, id: String, label: String, cx: &mut Context<'_, Self>) {
        if let Some(e) = &self.engine {
            e.set_input(id.clone());
        }
        self.settings.input_device_id = id;
        self.settings.input_device_label = label;
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn pick_output(&mut self, id: String, label: String, cx: &mut Context<'_, Self>) {
        if let Some(e) = &self.engine {
            e.set_output(id.clone());
        }
        self.settings.output_device_id = id;
        self.settings.output_device_label = label;
        self.settings.save();
        cx.notify();
    }

    /// Copies `text`; `what` says which button shows "Copied" for a moment.
    pub(crate) fn copy(&mut self, text: String, what: &'static str, cx: &mut Context<'_, Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.copied = Some(what);
        self.copied_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            let _ = this.update(cx, |v, cx| {
                v.copied = None;
                cx.notify();
            });
        }));
        cx.notify();
    }

    // ---- desktop extras (M2) -----------------------------------------------------------------

    fn on_desktop(&mut self, event: DesktopEvent, window: &mut Window, cx: &mut Context<'_, Self>) {
        match event {
            DesktopEvent::Key(k) if self.recording.is_some() => {
                let _ = k; // setting a key: the old ones do nothing meanwhile
            }
            DesktopEvent::Key(k) => match k.id {
                desktop::KEY_PTT => self.ptt_key(k.down, window, cx),
                desktop::KEY_MUTE if k.down => self.toggle_mic(),
                desktop::KEY_DEAFEN if k.down => self.toggle_deafen(),
                _ => {}
            },
            DesktopEvent::Tray(TrayEvent::Open) => self.show(window, cx),
            DesktopEvent::Tray(TrayEvent::Menu(id)) => match id {
                desktop::MENU_OPEN => self.show(window, cx),
                desktop::MENU_MUTE => {
                    let muted = self.room.as_ref().is_none_or(|r| r.muted || r.deafened);
                    if self.room.as_ref().is_some_and(|r| r.deafened) {
                        self.command(Command::SetDeafened(false));
                    } else {
                        self.command(Command::SetMuted(!muted));
                    }
                }
                desktop::MENU_DEAFEN => self.toggle_deafen(),
                desktop::MENU_LEAVE => self.leave(cx),
                desktop::MENU_QUIT => cx.quit(),
                _ => {}
            },
            DesktopEvent::Launch(message) => {
                self.show(window, cx);
                if let Some(room) = message.strip_prefix("link ").and_then(|r| RoomId::parse(r).ok()) {
                    if self.in_room() == Some(room) {
                        self.show_toast(format!("You're already in room {room}"), cx);
                    } else {
                        self.open_dialog(Dialog::Link(room), cx);
                    }
                }
            }
            DesktopEvent::ShareHud(action) => match action {
                rtc_platform_win::ShareHudAction::StopSharing => {
                    if let Some(e) = &self.engine {
                        e.share_screen(None);
                    }
                    self.sync_share_hud();
                }
                rtc_platform_win::ShareHudAction::AllowControl(peer_str) => {
                    if let Ok(peer) = rtc_protocol::PeerId::new(peer_str) {
                        self.control(rtc_engine::ControlCmd::Allow(peer));
                    }
                    self.sync_share_hud();
                }
                rtc_platform_win::ShareHudAction::DenyControl(peer_str) => {
                    if let Ok(peer) = rtc_protocol::PeerId::new(peer_str) {
                        self.control(rtc_engine::ControlCmd::Deny(peer));
                    }
                    self.sync_share_hud();
                }
                rtc_platform_win::ShareHudAction::TakeBackControl => {
                    self.control(rtc_engine::ControlCmd::Revoke);
                    self.sync_share_hud();
                }
            },
        }
        cx.notify();
    }

    /// Shows the window and brings it to the front (from the tray or another launch).
    fn show(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        rtc_platform_win::show_window(window);
        cx.notify();
    }

    /// The window's close button: keep running in the tray (once saying so), or quit.
    pub(crate) fn should_close(&mut self, window: &mut Window, _cx: &mut Context<'_, Self>) -> bool {
        if !(self.settings.close_to_tray && self.desktop.has_tray()) {
            return true;
        }
        rtc_platform_win::hide_window(window);
        if !self.settings.told_about_tray {
            self.desktop.notify(
                "3RTC is still running",
                "It's in the tray by the clock, so calls keep going. Right-click it to quit.",
            );
            self.settings.told_about_tray = true;
            self.settings.save();
        }
        false
    }

    /// Keys to watch now (after the room or the settings changed).
    pub(crate) fn watch_keys(&self) {
        if self.recording.is_none() {
            self.desktop.watch(&self.settings, self.in_room().is_some());
        }
    }

    fn ptt_key(&mut self, down: bool, window: &Window, cx: &mut Context<'_, Self>) {
        if self.settings.voice_mode != VoiceMode::Ptt || self.in_room().is_none() {
            return;
        }
        if down {
            // typing in our own chat box isn't talking
            if !self.ptt_talking && window.is_window_active() && self.typing(window, cx) {
                return;
            }
            self.ptt_release = None;
            if !self.ptt_talking {
                self.ptt_talking = true;
                if self.settings.ptt_chime {
                    desktop::chirp(true);
                }
                self.command(Command::PushToTalk(true));
            }
        } else if self.ptt_talking {
            let delay = Duration::from_millis(u64::from(self.settings.ptt_release_ms));
            self.ptt_release = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(delay).await;
                let _ = this.update(cx, Self::ptt_stop);
            }));
        }
        cx.notify();
    }

    fn ptt_stop(&mut self, cx: &mut Context<'_, Self>) {
        self.ptt_release = None;
        if self.ptt_talking {
            self.ptt_talking = false;
            if self.settings.ptt_chime {
                desktop::chirp(false);
            }
            self.command(Command::PushToTalk(false));
        }
        cx.notify();
    }

    /// The mic button held down in push-to-talk mode.
    pub(crate) fn ptt_button(&mut self, down: bool, window: &Window, cx: &mut Context<'_, Self>) {
        self.ptt_key(down, window, cx);
    }

    pub(crate) fn set_voice_mode(&mut self, mode: VoiceMode, cx: &mut Context<'_, Self>) {
        if self.settings.voice_mode == mode {
            return;
        }
        self.settings.voice_mode = mode;
        self.settings.save();
        if mode == VoiceMode::Ptt {
            // push-to-talk starts with the mic off (the web app does the same)
            if self.room.as_ref().is_some_and(|r| !r.muted) {
                self.command(Command::SetMuted(true));
            }
        } else {
            self.ptt_talking = false;
            self.ptt_release = None;
        }
        self.admin_app = None;
        self.watch_keys();
        cx.notify();
    }

    pub(crate) fn set_ptt_release(&mut self, ms: u32, cx: &mut Context<'_, Self>) {
        self.settings.ptt_release_ms = ms;
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_ptt_chime(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.ptt_chime = on;
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_binding(&mut self, target: KeyTarget, binding: Binding, cx: &mut Context<'_, Self>) {
        match target {
            KeyTarget::Ptt => self.settings.ptt_keys = binding,
            KeyTarget::Mute => self.settings.mute_keys = binding,
            KeyTarget::Deafen => self.settings.deafen_keys = binding,
            KeyTarget::PlayerPlayPause => self.settings.key_player_play_pause = binding,
            KeyTarget::PlayerFullscreen => self.settings.key_player_fullscreen = binding,
            KeyTarget::PlayerSeekBackward => self.settings.key_player_seek_backward = binding,
            KeyTarget::PlayerSeekForward => self.settings.key_player_seek_forward = binding,
            KeyTarget::PlayerVolumeUp => self.settings.key_player_volume_up = binding,
            KeyTarget::PlayerVolumeDown => self.settings.key_player_volume_down = binding,
            KeyTarget::PlayerSubtitles => self.settings.key_player_subtitles = binding,
        }
        self.settings.save();
        self.watch_keys();
        cx.notify();
    }

    /// Records the next key (or combination, or mouse button) held and let go for `target`.
    pub(crate) fn record_key(&mut self, target: KeyTarget, cx: &mut Context<'_, Self>) {
        if self.recording == Some(target) {
            self.stop_recording(cx);
            return;
        }
        self.recording = Some(target);
        self.record_seen.clear();
        self.desktop.watch(&self.settings, false);
        self.record_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(RECORD_POLL).await;
                let held = rtc_platform_win::keys_down();
                let Ok(done) = this.update(cx, |v, cx| v.record_poll(&held, cx)) else {
                    break;
                };
                if done {
                    break;
                }
            }
        }));
        cx.notify();
    }

    /// One look at the held keys while recording; true when done.
    fn record_poll(&mut self, held: &[Key], cx: &mut Context<'_, Self>) -> bool {
        let Some(target) = self.recording else { return true };
        for k in held {
            if !self.record_seen.contains(k) {
                self.record_seen.push(*k);
            }
        }
        if !held.is_empty() || self.record_seen.is_empty() {
            return false;
        }
        // everything let go: that was the combination (Esc alone cancels)
        let seen = std::mem::take(&mut self.record_seen);
        self.recording = None;
        self.record_task = None;
        if seen != [Key(0x1B)]
            && let Some(binding) = Binding::from_held(&seen)
        {
            self.set_binding(target, binding, cx);
        } else {
            self.watch_keys();
        }
        cx.notify();
        true
    }

    pub(crate) fn stop_recording(&mut self, cx: &mut Context<'_, Self>) {
        self.recording = None;
        self.record_task = None;
        self.record_seen.clear();
        self.watch_keys();
        cx.notify();
    }

    /// Push-to-talk can't see keys while an app running as administrator is in front.
    fn check_admin_app(&mut self, cx: &mut Context<'_, Self>) {
        if self.settings.voice_mode != VoiceMode::Ptt || self.in_room().is_none() {
            return;
        }
        let app = rtc_platform_win::foreground_admin_app();
        if app != self.admin_app {
            if let Some(name) = &app {
                self.show_toast(
                    format!("⚠️ Push-to-talk can't hear keys while {name} runs as administrator"),
                    cx,
                );
                self.log(format!(
                    "⚠️ Windows keeps keys pressed in {name} (running as administrator) from other apps, so push-to-talk can't see them. Run 3RTC as administrator too, or hold the mic button."
                ));
            }
            self.admin_app = app;
            cx.notify();
        }
    }

    /// Every room update: hello notifications and the last room for the rejoin card.
    fn room_changed(&mut self, snapshot: &Snapshot, _cx: &mut Context<'_, Self>) {
        let Phase::InRoom(id) = snapshot.phase else {
            if self.in_room().is_some() {
                // just left: remember the room for the rejoin card from now
                if let Some(last) = &mut self.settings.last_room {
                    last.at = now_ms();
                    self.settings.save();
                }
                self.announced.clear();
                self.volumes_sent.clear();
                self.ptt_talking = false;
                self.ptt_release = None;
            }
            return;
        };
        self.send_saved_volumes(snapshot);
        let fresh_entry = self.in_room() != Some(id);
        for (peer, m) in &snapshot.members {
            if fresh_entry {
                // they were there before us: no "joined" for them
                self.announced.insert(peer.clone());
            } else if let Some(name) = &m.username
                && self.announced.insert(peer.clone())
                && !self.active
                && self.settings.notifications
            {
                self.desktop
                    .notify(&format!("{name} joined"), &format!("Room {id}"));
            }
        }
        let was_host = snapshot.host.as_ref() == Some(&snapshot.me);
        let previous = self.settings.last_room.clone();
        let host_token = snapshot.host_token.clone().or_else(|| {
            previous
                .as_ref()
                .filter(|p| p.room_id == id.to_string() && was_host)
                .and_then(|p| p.host_token.clone())
        });
        let now = now_ms();
        let record = LastRoom {
            room_id: id.to_string(),
            was_host,
            host_token: if was_host { host_token } else { None },
            at: now,
        };
        let changed = previous.as_ref().is_none_or(|p| {
            p.room_id != record.room_id || p.was_host != record.was_host || p.host_token != record.host_token
        });
        if changed || now.saturating_sub(self.last_room_saved) > 60_000 {
            self.settings.last_room = Some(record);
            self.settings.save();
            self.last_room_saved = now;
        }
    }

    /// The rejoin card: back into the last room (as host with its token, if we hosted it).
    pub(crate) fn rejoin(&mut self, cx: &mut Context<'_, Self>) {
        let Some(last) = self.settings.last_room.clone() else {
            return;
        };
        let Ok(room) = RoomId::parse(&last.room_id) else {
            return;
        };
        self.join_error = None;
        self.use_name(cx);
        match last.host_token {
            Some(host_token) if last.was_host => self.command(Command::Resume { room, host_token }),
            _ => self.command(Command::Join(room)),
        }
    }

    pub(crate) fn dismiss_rejoin(&mut self, cx: &mut Context<'_, Self>) {
        self.settings.last_room = None;
        self.settings.save();
        cx.notify();
    }

    /// The last room, if it's still worth offering.
    pub(crate) fn rejoin_offer(&self) -> Option<&LastRoom> {
        self.settings.last_room.as_ref().filter(|r| r.fresh(now_ms()))
    }

    /// "Join room 12345?" answered yes: leave the current room first if needed.
    pub(crate) fn join_from_link(&mut self, room: RoomId, cx: &mut Context<'_, Self>) {
        self.dialog = None;
        if self.in_room() == Some(room) {
            self.show_toast(format!("You're already in room {room}"), cx);
            return;
        }
        if self.in_room().is_some() {
            self.command(Command::Leave);
        }
        self.join_error = None;
        self.use_name(cx);
        self.command(Command::Join(room));
        cx.notify();
    }

    pub(crate) fn set_autostart(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        let command = std::env::current_exe()
            .map(|exe| format!("\"{}\" --tray", exe.display()))
            .unwrap_or_default();
        match rtc_platform_win::autostart::set(on, &command) {
            Ok(()) => self.autostart = on,
            Err(e) => self.show_toast(format!("Couldn't change starting with Windows: {e}"), cx),
        }
        cx.notify();
    }

    pub(crate) fn set_close_to_tray(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.close_to_tray = on;
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_notifications(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.notifications = on;
        self.settings.save();
        cx.notify();
    }

    pub(crate) fn set_open_links(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.open_links = on;
        self.settings.save();
        let done = if on {
            crate::register_links()
        } else {
            rtc_platform_win::links::unregister()
        };
        if let Err(e) = done {
            self.show_toast(format!("Couldn't change 3rtc:// links: {e}"), cx);
        }
        cx.notify();
    }

    /// Whether the desktop extras work here (Windows), for the settings to say so.
    pub(crate) const fn desktop_supported() -> bool {
        rtc_platform_win::SUPPORTED
    }

    pub(crate) fn has_tray(&self) -> bool {
        self.desktop.has_tray()
    }

    /// The invite link for a room (the web app's: opens 3rtc.me with the code filled in).
    pub(crate) fn invite_link(room: RoomId) -> String {
        format!("https://3rtc.me/?room={room}")
    }

    fn typing(&self, window: &Window, cx: &Context<'_, Self>) -> bool {
        [
            &self.name,
            &self.message,
            &self.link,
            &self.server_url,
            &self.reaction_input,
            &self.emoji_search,
        ]
        .iter()
        .any(|i| i.read(cx).focus_handle(cx).is_focused(window))
            || self.code.read(cx).focus_handle(cx).is_focused(window)
    }

    /// Shortcuts (`hooks/useKeyboardShortcuts.ts`): M mutes (open mic), Q shows the QR code,
    /// Esc closes the top-most thing open. Never while typing.
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<'_, Self>) {
        let ks = &event.keystroke;
        if ks.key == "escape" {
            if self.watch.local.fullscreen {
                self.end_video_fullscreen(window);
            } else if self.screen.fullscreen {
                self.end_screen_fullscreen(window);
            } else if self.dialog.is_some() {
                self.dialog = None;
            } else if self.pop.is_some() {
                self.pop = None;
            } else if window.is_fullscreen() {
                window.toggle_fullscreen();
            }
            cx.notify();
            return;
        }
        if self.typing(window, cx) {
            return;
        }
        if ks.key == "f11" {
            self.toggle_app_fullscreen(window, cx);
            return;
        }
        if self.in_room().is_none() || self.dialog.is_some() {
            return;
        }
        let watching = self.room.as_ref().is_some_and(|r| r.watch.showing.is_some());
        if watching {
            if matches_binding(&self.settings.key_player_fullscreen, ks) {
                self.toggle_video_fullscreen(window, cx);
                return;
            }
            if matches_binding(&self.settings.key_player_play_pause, ks) {
                if !self.room.as_ref().is_some_and(crate::watch::locked_for_me) {
                    self.video_toggle_play(cx);
                }
                return;
            }
            if matches_binding(&self.settings.key_player_seek_backward, ks) {
                self.video_backward_5(cx);
                return;
            }
            if matches_binding(&self.settings.key_player_seek_forward, ks) {
                self.video_forward_5(cx);
                return;
            }
            if matches_binding(&self.settings.key_player_volume_up, ks) {
                let v = (self.watch.local.volume + 5.0).clamp(0.0, 100.0);
                self.video_volume(v, cx);
                return;
            }
            if matches_binding(&self.settings.key_player_volume_down, ks) {
                let v = (self.watch.local.volume - 5.0).clamp(0.0, 100.0);
                self.video_volume(v, cx);
                return;
            }
            if matches_binding(&self.settings.key_player_subtitles, ks) {
                self.cycle_subtitles(cx);
                return;
            }
        }
        let plain = !(ks.modifiers.control || ks.modifiers.alt || ks.modifiers.platform);
        if !plain {
            return;
        }
        match ks.key.as_str() {
            "m" => self.toggle_mic(),
            "q" => self.open_dialog(Dialog::Qr, cx),
            k => {
                self.reaction_key(k);
            }
        }
    }

    fn title(&self) -> String {
        match self.in_room() {
            Some(id) => {
                let n = self.room.as_ref().map_or(0, |r| r.members.len()) + 1;
                format!(
                    "Room {id} · {n} {} · 3RTC",
                    if n == 1 { "person" } else { "people" }
                )
            }
            None => "3RTC — Watch together".to_owned(),
        }
    }
}

impl Render for RoomView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        window.set_window_title(&self.title());
        let body = if let (Some(room), Some(id)) = (self.room.clone(), self.in_room()) {
            crate::room::render(self, &room, id, window, cx)
        } else {
            let room = self.room.as_ref();
            Home {
                name: &self.name.clone(),
                code: &self.code.clone(),
                online: room.is_some_and(|r| r.online),
                busy: matches!(room.map(|r| &r.phase), Some(Phase::Creating | Phase::Joining(_))),
                join_error: self.join_error.clone(),
                build: BUILD,
                rejoin: self.rejoin_offer().map(|r| (r.room_id.clone(), r.was_host)),
            }
            .render(window, cx)
        };
        let dialog = self.dialog.map(|d| crate::dialogs::render(self, d, window, cx));
        div()
            .id("root")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key))
            .on_drop(cx.listener(|v, paths: &gpui_kit::ExternalPaths, _, cx| v.dropped(paths, cx)))
            .relative()
            .size_full()
            .bg(tokens::bg())
            .text_color(tokens::text())
            .font_family(tokens::FONT_MAIN)
            .child(body)
            .when_some(self.toast.clone(), |el, t| {
                el.child(
                    div()
                        .absolute()
                        .bottom(px(104.))
                        .left_0()
                        .right(if self.panel_open && self.in_room().is_some() {
                            px(360.)
                        } else {
                            px(0.)
                        })
                        .flex()
                        .justify_center()
                        .child(toast(t)),
                )
            })
            .children(dialog)
    }
}

// ---- updates ------------------------------------------------------------------------------------

impl RoomView {
    /// Checks for a new version a little after starting and then every few hours (release
    /// builds only).
    fn start_updates(&mut self, cx: &mut Context<'_, Self>) {
        if !crate::update::is_release(BUILD) {
            self.update = crate::update::Status::Dev;
            return;
        }
        self.update_task = Some(cx.spawn(async move |this, cx| {
            let mut wait = crate::update::FIRST;
            loop {
                cx.background_executor().timer(wait).await;
                wait = crate::update::EVERY;
                let Ok(auto) = this.update(cx, |v, _| v.settings.auto_update) else {
                    break;
                };
                if auto && this.update(cx, |v, cx| v.check_updates(false, cx)).is_err() {
                    break;
                }
            }
        }));
    }

    /// Looks for a new version and, if there is one, puts it in place (`manual`: the button,
    /// which also says when there's nothing new).
    pub(crate) fn check_updates(&mut self, manual: bool, cx: &mut Context<'_, Self>) {
        use crate::update::Status;
        if matches!(
            self.update,
            Status::Checking | Status::Downloading(..) | Status::Dev
        ) {
            return;
        }
        if let Status::Ready(_) = self.update {
            return;
        }
        self.update = Status::Checking;
        cx.notify();
        let progress = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(0));
        let seen = std::sync::Arc::clone(&progress);
        cx.spawn(async move |this, cx| {
            let found = cx
                .background_executor()
                .spawn(async { crate::update::check() })
                .await;
            // the video player, if this install doesn't have it yet
            if let Ok(m) = &found {
                let m = m.clone();
                let got = cx
                    .background_executor()
                    .spawn(async move { crate::update::ensure_player(&m) })
                    .await;
                match got {
                    Ok(true) => tracing::info!("update: video player installed"),
                    Ok(false) => {}
                    Err(e) => tracing::warn!("update: video player: {e}"),
                }
            }
            let manifest = match found {
                Ok(m) if crate::update::newer(&m.build, BUILD) => m,
                Ok(_) => {
                    let _ = this.update(cx, |v, cx| {
                        v.update = Status::UpToDate;
                        if manual {
                            v.show_toast("You have the latest 3RTC", cx);
                        }
                        cx.notify();
                    });
                    return;
                }
                Err(e) => {
                    tracing::info!("update check: {e}");
                    let _ = this.update(cx, |v, cx| {
                        v.update = Status::Failed(e);
                        cx.notify();
                    });
                    return;
                }
            };
            let build = manifest.build.clone();
            let notes = manifest.notes.trim().to_owned();
            let _ = this.update(cx, |v, cx| {
                v.update = Status::Downloading(build.clone(), 0);
                cx.notify();
            });
            let asset = manifest.exe.clone();
            let job = cx.background_executor().spawn(async move {
                crate::update::install(&asset, &|p| seen.store(p, std::sync::atomic::Ordering::Relaxed))
            });
            // show the download's progress while it runs
            let shown = this.clone();
            let ticker = cx.spawn(async move |cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(300)).await;
                    let pct = progress.load(std::sync::atomic::Ordering::Relaxed);
                    let Ok(true) = shown.update(cx, |v, cx| {
                        let Status::Downloading(b, _) = &v.update else {
                            return false;
                        };
                        v.update = Status::Downloading(b.clone(), pct);
                        cx.notify();
                        true
                    }) else {
                        break;
                    };
                }
            });
            let result = job.await;
            drop(ticker);
            let _ = this.update(cx, |v, cx| {
                match result {
                    Ok(()) => {
                        tracing::info!("update {build} is in place");
                        v.update = Status::Ready(build.clone());
                        v.log(format!(
                            "✨ 3RTC {build} is ready: it starts the next time you open 3RTC."
                        ));
                        if !notes.is_empty() {
                            v.log(format!("What's new in {build}: {notes}"));
                        }
                        v.show_toast(format!("✨ 3RTC {build} is ready: it starts next time"), cx);
                    }
                    Err(e) => {
                        tracing::warn!("update {build}: {e}");
                        v.update = Status::Failed(e);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Picks the graphics card for the next start (Settings → Graphics card).
    pub(crate) fn set_gpu_choice(&mut self, choice: rtc_platform_win::GpuChoice, cx: &mut Context<'_, Self>) {
        let Some(exe) = GpuState::exe() else { return };
        match rtc_platform_win::set_gpu_choice(&exe, choice) {
            Ok(()) => self.gpu.chosen = choice,
            Err(e) => self.show_toast(format!("Couldn't save the graphics card: {e}"), cx),
        }
        cx.notify();
    }

    /// "Restart now": start the new version and close this one.
    pub(crate) fn restart_for_update(&mut self, cx: &mut Context<'_, Self>) {
        match crate::update::restart() {
            Ok(()) => {
                self.command(Command::Leave);
                cx.quit();
            }
            Err(e) => self.show_toast(e, cx),
        }
    }

    pub(crate) fn set_auto_update(&mut self, on: bool, cx: &mut Context<'_, Self>) {
        self.settings.auto_update = on;
        self.settings.save();
        cx.notify();
    }
}

/// The graphics card (Settings): the cards Windows would pick, the choice the app started with
/// (Windows applies a choice when a program starts) and the one saved now.
#[derive(Debug, Clone)]
pub(crate) struct GpuState {
    pub(crate) gpus: rtc_platform_win::Gpus,
    pub(crate) started: rtc_platform_win::GpuChoice,
    pub(crate) chosen: rtc_platform_win::GpuChoice,
}

impl GpuState {
    fn exe() -> Option<String> {
        std::env::current_exe().ok().map(|p| p.display().to_string())
    }

    fn read() -> Self {
        let choice = Self::exe().map_or_else(Default::default, |e| rtc_platform_win::gpu_choice(&e));
        Self {
            gpus: rtc_platform_win::gpus(),
            started: choice,
            chosen: choice,
        }
    }
}

impl Drop for RoomView {
    fn drop(&mut self) {
        rtc_platform_win::unlock_pointer();
    }
}

fn matches_binding(binding: &Binding, ks: &gpui_kit::Keystroke) -> bool {
    if binding.is_empty() {
        return false;
    }
    let keys = binding.keys();
    let has_ctrl = keys.contains(&Key::CTRL);
    let has_alt = keys.contains(&Key::ALT);
    let has_shift = keys.contains(&Key::SHIFT);
    let has_win = keys.contains(&Key::WIN);
    if ks.modifiers.control != has_ctrl
        || ks.modifiers.alt != has_alt
        || ks.modifiers.shift != has_shift
        || ks.modifiers.platform != has_win
    {
        return false;
    }
    let Some(main) = keys.iter().find(|k| !k.is_modifier()) else {
        return false;
    };
    match ks.key.to_ascii_lowercase().as_str() {
        "space" => *main == Key::SPACE,
        "left" | "arrowleft" => *main == Key(0x25),
        "up" | "arrowup" => *main == Key(0x26),
        "right" | "arrowright" => *main == Key(0x27),
        "down" | "arrowdown" => *main == Key(0x28),
        "enter" | "return" => *main == Key(0x0D),
        "escape" => *main == Key(0x1B),
        "tab" => *main == Key(0x09),
        "backspace" => *main == Key(0x08),
        "pageup" => *main == Key(0x21),
        "pagedown" => *main == Key(0x22),
        "end" => *main == Key(0x23),
        "home" => *main == Key(0x24),
        "insert" => *main == Key(0x2D),
        "delete" => *main == Key(0x2E),
        s if s.len() == 1 => {
            let Some(ch) = s.chars().next() else { return false };
            match ch {
                'a'..='z' => {
                    let Ok(b) = u8::try_from(ch) else { return false };
                    *main == Key(b - b'a' + 0x41)
                }
                '0'..='9' => {
                    let Ok(b) = u8::try_from(ch) else { return false };
                    *main == Key(b)
                }
                ';' => *main == Key(0xBA),
                '=' => *main == Key(0xBB),
                ',' => *main == Key(0xBC),
                '-' => *main == Key(0xBD),
                '.' => *main == Key(0xBE),
                '/' => *main == Key(0xBF),
                '`' | '~' => *main == Key(0xC0),
                '[' => *main == Key(0xDB),
                '\\' => *main == Key(0xDC),
                ']' => *main == Key(0xDD),
                '\'' => *main == Key(0xDE),
                _ => false,
            }
        }
        s if s.starts_with('f') && s.len() >= 2 => s[1..]
            .parse::<u8>()
            .ok()
            .filter(|&n| (1..=24).contains(&n))
            .is_some_and(|n| *main == Key(0x70 + n - 1)),
        _ => false,
    }
}
