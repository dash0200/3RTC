//! The window's state and logic: the engine connection, what's open (panel tab, popover,
//! dialog), toasts, logs and keyboard shortcuts. Drawing is in `home.rs`, `room.rs`, `dialogs.rs`.

use std::collections::HashSet;
use std::time::Duration;

use gpui_kit::component::input::{InputEvent, InputState};
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
}

/// Which key is being recorded in the settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyTarget {
    Ptt,
    Mute,
    Deafen,
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
    engine: Option<Handle>,
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
    desktop: Desktop,
    /// The window is in front (notifications only when it isn't).
    active: bool,
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
            cx.subscribe_in(&link, window, |this, _, e: &InputEvent, _, cx| {
                if matches!(e, InputEvent::PressEnter { .. }) {
                    this.play_link(cx);
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
        };
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
            _ => MicSource::Device,
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
        handle.list_devices();
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
                }
                let entered = was_in.is_none() && matches!(snapshot.phase, Phase::InRoom(_));
                let alone = snapshot.members.is_empty();
                self.room = Some(snapshot);
                if entered {
                    self.tab = if alone { Tab::Invite } else { Tab::Chat };
                    if let Some(id) = self.in_room() {
                        self.show_toast(format!("Created room {id}"), cx);
                    }
                } else if was_alone && !alone && self.tab == Tab::Invite {
                    self.tab = Tab::Chat;
                }
                self.desktop.show_room(self.room.as_ref());
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
                self.chat.push(line);
            }
            Update::Log(text) => self.log(text),
            Update::Notice(n) => {
                if self.in_room().is_some() {
                    self.show_toast(n, cx);
                } else {
                    self.join_error = Some(n.into());
                }
            }
            Update::Devices(d) => self.devices = d,
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
    pub(crate) fn play_link(&mut self, cx: &mut Context<'_, Self>) {
        self.show_toast("Watching together comes in the next desktop update", cx);
    }

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
        self.dialog = None;
        self.command(Command::Leave);
        cx.notify();
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
        }
        cx.notify();
    }

    /// Shows the window and brings it to the front (from the tray or another launch).
    fn show(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        rtc_platform_win::show_window(window);
        window.activate_window();
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
                self.ptt_talking = false;
                self.ptt_release = None;
            }
            return;
        };
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
        [&self.name, &self.message, &self.link, &self.server_url]
            .iter()
            .any(|i| i.read(cx).focus_handle(cx).is_focused(window))
            || self.code.read(cx).focus_handle(cx).is_focused(window)
    }

    /// Shortcuts (`hooks/useKeyboardShortcuts.ts`): M mutes (open mic), Q shows the QR code,
    /// Esc closes the top-most thing open. Never while typing.
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<'_, Self>) {
        let ks = &event.keystroke;
        if ks.key == "escape" {
            if self.dialog.is_some() {
                self.dialog = None;
            } else if self.pop.is_some() {
                self.pop = None;
            }
            cx.notify();
            return;
        }
        let plain = !(ks.modifiers.control || ks.modifiers.alt || ks.modifiers.platform);
        if !plain || self.typing(window, cx) || self.in_room().is_none() || self.dialog.is_some() {
            return;
        }
        match ks.key.as_str() {
            "m" => self.toggle_mic(),
            "q" => self.open_dialog(Dialog::Qr, cx),
            _ => {}
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
