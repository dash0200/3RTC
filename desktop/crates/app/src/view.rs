//! The one window: a home screen (name, create or join) and the room (people, chat).

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, h_flex, v_flex};
use gpui_kit::{
    Context, Entity, FontWeight, IntoElement, ParentElement as _, Render, SharedString, Styled as _,
    Subscription, Window, div, prelude::*, px,
};
use rtc_core::Command;
use rtc_engine::{ChatLine, Config, Handle, Phase, Snapshot, Update};
use rtc_protocol::{ClientId, RoomId};

use crate::settings::Settings;

/// Build number shown to peers: `YYMMDD.HHMM` of the build (set by CI; `dev` locally).
const BUILD: &str = match option_env!("RTC_BUILD") {
    Some(b) => b,
    None => "dev",
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
    code: Entity<InputState>,
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
                .placeholder("Your name")
                .default_value(settings.username.clone())
        });
        let code = cx.new(|cx| InputState::new(window, cx).placeholder("Room code"));
        let message = cx.new(|cx| InputState::new(window, cx).placeholder("Message the room"));
        let subscriptions = vec![
            cx.subscribe_in(&code, window, |this, _, e: &InputEvent, _, cx| {
                if matches!(e, InputEvent::PressEnter { .. }) {
                    this.join(cx);
                }
            }),
            cx.subscribe_in(&message, window, |this, _, e: &InputEvent, window, cx| {
                if matches!(e, InputEvent::PressEnter { .. }) {
                    this.send_chat(window, cx);
                }
            }),
        ];
        Self {
            settings,
            signaling_url,
            runtime: runtime.clone(),
            engine: None,
            room: None,
            chat: Vec::new(),
            notice: None,
            name,
            code,
            message,
            _subscriptions: subscriptions,
        }
    }

    /// Starts the engine (once a name is set) and pumps its updates into this view.
    fn engine(&mut self, cx: &mut Context<'_, Self>) -> Option<Handle> {
        if let Some(e) = &self.engine {
            return Some(e.clone());
        }
        let username = self.name.read(cx).value().trim().to_owned();
        if username.is_empty() {
            self.notice = Some("Type your name first.".into());
            cx.notify();
            return None;
        }
        self.settings.username.clone_from(&username);
        self.settings.save();
        let client_id = ClientId::new(self.settings.client_id.clone()).ok()?;
        let config = Config {
            signaling_url: self.signaling_url.clone(),
            username,
            client_id,
            build: BUILD.to_owned(),
            ice: rtc_webrtc_defaults(),
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
        self.engine = Some(handle.clone());
        Some(handle)
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
            Update::Notice(n) => self.notice = Some(n.into()),
        }
        cx.notify();
    }

    fn create(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(e) = self.engine(cx) {
            e.command(Command::CreateRoom);
        }
    }

    fn join(&mut self, cx: &mut Context<'_, Self>) {
        let text = self.code.read(cx).value();
        let Ok(room) = RoomId::parse(text.trim()) else {
            self.notice = Some("Room codes are 5 digits.".into());
            cx.notify();
            return;
        };
        if let Some(e) = self.engine(cx) {
            e.command(Command::Join(room));
        }
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

    fn render_home(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let busy = matches!(
            self.room.as_ref().map(|r| &r.phase),
            Some(Phase::Creating | Phase::Joining(_))
        );
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_4()
            .child(div().text_3xl().font_weight(FontWeight::BOLD).child("3RTC"))
            .child(
                div()
                    .text_color(cx.theme().muted_foreground)
                    .child("Talk, chat and play with friends."),
            )
            .child(
                v_flex().w(px(320.)).gap_3().child(Input::new(&self.name)).child(
                    Button::new("create")
                        .primary()
                        .label("Create a room")
                        .disabled(busy)
                        .on_click(cx.listener(|this, _, _, cx| this.create(cx))),
                ),
            )
            .child(
                h_flex()
                    .w(px(320.))
                    .gap_2()
                    .child(div().flex_1().child(Input::new(&self.code)))
                    .child(
                        Button::new("join")
                            .label("Join")
                            .disabled(busy)
                            .on_click(cx.listener(|this, _, _, cx| this.join(cx))),
                    ),
            )
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

fn rtc_webrtc_defaults() -> Vec<rtc_engine::IceServerConfig> {
    rtc_engine::IceServerConfig::defaults()
}

impl Render for RoomView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let body = match self.room.clone() {
            Some(room) => match room.phase {
                Phase::InRoom(id) => self.render_room(&room, id, cx).into_any_element(),
                _ => self.render_home(cx).into_any_element(),
            },
            None => self.render_home(cx).into_any_element(),
        };
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(div().flex_1().min_h_0().child(body))
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
    }
}
