//! The one window: a home screen (name, create or join) and the room (people, chat).

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::{
    Context, Entity, FontWeight, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, Window, div, prelude::*, px,
};
use rtc_core::Command;
use rtc_engine::{ChatLine, Config, Handle, Phase, Snapshot, Update};
use rtc_protocol::{ClientId, RoomId};

use rtc_ui::code_input::{CodeEvent, CodeInput};

use crate::home::Home;
use crate::settings::Settings;

/// Build number shown to peers: `YYMMDD.HHMM` of the build (set by CI; `dev` locally).
const BUILD: &str = match option_env!("RTC_BUILD") {
    Some(b) => b,
    None => "Development build",
};

pub(crate) struct RoomView {
    settings: Settings,
    signaling_url: String,
    runtime: tokio::runtime::Handle,
    engine: Option<Handle>,
    room: Option<Snapshot>,
    chat: Vec<ChatLine>,
    notice: Option<SharedString>,
    name: Entity<InputState>,
    code: Entity<CodeInput>,
    join_error: Option<SharedString>,
    message: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

impl RoomView {
    pub(crate) fn new(
        window: &mut Window,
        cx: &mut Context<'_, Self>,
        runtime: &tokio::runtime::Handle,
        settings: Settings,
        signaling_url: String,
    ) -> Self {
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("So your friends know it’s you")
                .default_value(settings.username.clone())
        });
        let code = cx.new(CodeInput::new);
        let message = cx.new(|cx| InputState::new(window, cx).placeholder("Message the room"));
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
        ];
        let mut this = Self {
            settings,
            signaling_url,
            runtime: runtime.clone(),
            engine: None,
            room: None,
            chat: Vec::new(),
            notice: None,
            join_error: None,
            name,
            code,
            message,
            _subscriptions: subscriptions,
        };
        this.start_engine(cx);
        this
    }

    /// Starts the engine and pumps its updates into this view.
    fn start_engine(&mut self, cx: &mut Context<'_, Self>) {
        let Ok(client_id) = ClientId::new(self.settings.client_id.clone()) else {
            return;
        };
        let config = Config {
            signaling_url: self.signaling_url.clone(),
            username: self.settings.username.clone(),
            client_id,
            build: BUILD.to_owned(),
            ice: rtc_engine::IceServerConfig::defaults(),
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
        self.engine = Some(handle);
    }

    /// The name to go by: what's typed, else the saved one, else "Guest" (as the web app).
    fn use_name(&mut self, cx: &mut Context<'_, Self>) {
        let typed = self.name.read(cx).value().trim().to_owned();
        let name = if !typed.is_empty() {
            typed
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

    fn apply(&mut self, update: Update, cx: &mut Context<'_, Self>) {
        match update {
            Update::Room(snapshot) => {
                if snapshot.phase == Phase::Idle
                    && !matches!(self.room.as_ref().map(|r| &r.phase), Some(Phase::Idle) | None)
                {
                    self.chat.clear();
                }
                self.room = Some(snapshot);
            }
            Update::Chat(line) => self.chat.push(line),
            Update::Notice(n) => {
                // before a room exists a notice is why the join failed: shown in the join card
                if matches!(self.room.as_ref().map(|r| &r.phase), Some(Phase::InRoom(_))) {
                    self.notice = Some(n.into());
                } else {
                    self.join_error = Some(n.into());
                }
            }
        }
        cx.notify();
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
        if let Some(e) = &self.engine {
            e.command(Command::SendChat {
                id: Handle::new_message_id(),
                text,
            });
        }
        self.message.update(cx, |m, cx| m.set_value("", window, cx));
    }

    fn command(&self, c: Command) {
        if let Some(e) = &self.engine {
            e.command(c);
        }
    }

    fn render_room(&self, room: &Snapshot, id: RoomId, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let me_host = room.host.as_ref() == Some(&room.me);
        let you = format!(
            "{} (you){}",
            self.settings.username,
            if me_host { " · host" } else { "" }
        );
        let people = v_flex()
            .w(px(240.))
            .h_full()
            .p_3()
            .gap_2()
            .border_r_1()
            .border_color(cx.theme().border)
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!("People · {}", room.members.len() + 1)),
            )
            .child(div().child(you))
            .children(room.members.iter().map(|(peer, m)| {
                let name = m.username.clone().unwrap_or_else(|| "Connecting…".to_owned());
                let mut tags = Vec::new();
                if room.host.as_ref() == Some(peer) {
                    tags.push("host");
                }
                if m.muted {
                    tags.push("muted");
                }
                if m.desktop {
                    tags.push("desktop");
                }
                let dot = if m.connected {
                    cx.theme().success
                } else {
                    cx.theme().warning
                };
                h_flex()
                    .gap_2()
                    .child(div().size(px(8.)).rounded_full().bg(dot))
                    .child(name)
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(tags.join(" · ")),
                    )
            }));
        let chat = v_flex()
            .id("chat")
            .flex_1()
            .p_3()
            .gap_1()
            .overflow_y_scroll()
            .children(self.chat.iter().map(|line| {
                if line.from.is_none() {
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(line.text.clone())
                } else {
                    let mine = line.from.as_ref() == Some(&room.me);
                    let who = if mine { "You".to_owned() } else { line.name.clone() };
                    div().child(
                        h_flex()
                            .gap_2()
                            .child(div().font_weight(FontWeight::SEMIBOLD).child(who))
                            .child(line.text.clone()),
                    )
                }
            }));
        v_flex()
            .size_full()
            .child(
                h_flex()
                    .p_3()
                    .gap_3()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(div().font_weight(FontWeight::BOLD).child(format!("Room {id}")))
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(if room.online {
                                "Connected"
                            } else {
                                "Reconnecting…"
                            }),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("mute")
                            .label(if room.muted { "Unmute" } else { "Mute" })
                            .on_click(cx.listener({
                                let muted = room.muted;
                                move |this, _, _, _| this.command(Command::SetMuted(!muted))
                            })),
                    )
                    .child(Button::new("leave").danger().label("Leave").on_click(cx.listener(
                        |this, _, _, _| {
                            this.command(Command::Leave);
                        },
                    ))),
            )
            .child(
                h_flex().flex_1().min_h_0().child(people).child(
                    v_flex().flex_1().h_full().child(chat).child(
                        div()
                            .p_3()
                            .border_t_1()
                            .border_color(cx.theme().border)
                            .child(Input::new(&self.message)),
                    ),
                ),
            )
    }
}

impl Render for RoomView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let room = self.room.clone();
        if let Some(room) = &room
            && let Phase::InRoom(id) = room.phase
        {
            return v_flex()
                .size_full()
                .bg(cx.theme().background)
                .text_color(cx.theme().foreground)
                .child(div().flex_1().min_h_0().child(self.render_room(room, id, cx)))
                .children(self.notice.clone().map(|n| {
                    h_flex()
                        .p_2()
                        .px_3()
                        .bg(cx.theme().secondary)
                        .child(div().flex_1().child(n))
                        .child(Button::new("dismiss").ghost().label("OK").on_click(cx.listener(
                            |this, _, _, cx| {
                                this.notice = None;
                                cx.notify();
                            },
                        )))
                }))
                .into_any_element();
        }
        Home {
            name: &self.name.clone(),
            code: &self.code.clone(),
            online: room.as_ref().is_some_and(|r| r.online),
            busy: matches!(
                room.as_ref().map(|r| &r.phase),
                Some(Phase::Creating | Phase::Joining(_))
            ),
            join_error: self.join_error.clone(),
            build: BUILD,
        }
        .render(window, cx)
    }
}
