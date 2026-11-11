//! The window's state and logic: the engine connection, what's open (panel tab, popover,
//! dialog), toasts, logs and keyboard shortcuts. Drawing is in `home.rs`, `room.rs`, `dialogs.rs`.

use std::time::Duration;

use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::{
    AppContext as _, ClipboardItem, Context, Entity, FocusHandle, Focusable as _, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString, Styled as _, Subscription, Task,
    Window, div, prelude::FluentBuilder as _, px,
};
use rtc_core::Command;
use rtc_engine::{ChatLine, Config, Devices, Handle, MicSource, Phase, Snapshot, Update};
use rtc_protocol::{ClientId, RoomId};
use rtc_ui::code_input::{CodeEvent, CodeInput};
use rtc_ui::overlay::toast;
use rtc_ui::tokens;

use crate::home::Home;
use crate::settings::Settings;

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
}

pub(crate) fn time_now() -> String {
    chrono::Local::now().format("%-I:%M %p").to_string()
}

impl RoomView {
    pub(crate) fn new(
        window: &mut Window,
        cx: &mut Context<'_, Self>,
        runtime: &tokio::runtime::Handle,
        settings: Settings,
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
        };
        this.log("Welcome to 3RTC! Create or join a room to chat and watch YouTube together.".to_owned());
        this.start_engine(cx);
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
            }
            Update::Chat(line) => {
                let mine = self.room.as_ref().is_some_and(|r| r.me == line.from);
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
        cx.notify();
    }

    pub(crate) fn close_dialog(&mut self, cx: &mut Context<'_, Self>) {
        self.dialog = None;
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
