//! The room state machine. Mirrors the web app's rules (`client-ts/src/webrtc/signalingMessages.ts`)
//! so desktop and web peers agree on who offers, who hosts and what everyone sees.

use std::collections::BTreeMap;

use rtc_protocol::peer::{Envelope, PeerMessage};
use rtc_protocol::sdp::{IceCandidate, SessionDescription};
use rtc_protocol::signaling::{ClientMessage, ErrorCode, ServerMessage};
use rtc_protocol::{ClientId, PROTOCOL_VERSION, PeerId, RoomId};

/// Who this app is: fixed for a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// This connection's peer id (fresh per launch).
    pub peer_id: PeerId,
    /// This install's stable id.
    pub client_id: ClientId,
    /// The display name.
    pub username: String,
    /// The app build, `YYMMDD.HHMM`.
    pub build: String,
}

/// Where the app is with the room.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    /// Not in a room.
    Idle,
    /// Asked the server for a new room.
    Creating,
    /// Asked to join this room.
    Joining(RoomId),
    /// In this room.
    InRoom(RoomId),
}

/// Someone else in the room.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Member {
    /// Their name, once their identity arrives.
    pub username: Option<String>,
    /// Their mic is muted.
    pub muted: bool,
    /// The direct channel to them is open.
    pub connected: bool,
    /// They're on the desktop app.
    pub desktop: bool,
}

/// One chat line.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatLine {
    /// Message id (dedupes repeats).
    pub id: String,
    /// Sender's peer id; `None` for a system line.
    pub from: Option<PeerId>,
    /// Sender's name as shown.
    pub name: String,
    /// Sent by the host.
    pub is_host: bool,
    /// The text.
    pub text: String,
}

/// Something the user did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Set the display name (only between rooms: a name doesn't change mid-room).
    SetName(String),
    /// Make a new room.
    CreateRoom,
    /// Join a room by code.
    Join(RoomId),
    /// Leave the room.
    Leave,
    /// Send a chat message (the shell makes the id).
    SendChat {
        /// Unique id.
        id: String,
        /// The text.
        text: String,
    },
    /// Mute or unmute the mic.
    SetMuted(bool),
    /// Host only: hand hosting to someone.
    TransferHost(PeerId),
}

/// Signaling the peer-connection layer must apply.
#[derive(Debug, Clone, PartialEq)]
pub enum RemoteSignal {
    /// Their offer (answer it).
    Offer {
        /// The SDP.
        offer: SessionDescription,
        /// They rebuilt their side: start a fresh connection.
        fresh: bool,
    },
    /// Their answer to our offer.
    Answer(SessionDescription),
    /// A network candidate of theirs.
    Candidate(IceCandidate),
}

/// One thing that happened.
#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    /// The user did something.
    Command(Command),
    /// The signaling server said something.
    Server(ServerMessage),
    /// The signaling socket connected (or reconnected).
    SignalingUp,
    /// The signaling socket dropped (the shell reconnects).
    SignalingDown,
    /// A peer's direct channel opened.
    ChannelOpen(PeerId),
    /// A peer's direct channel closed.
    ChannelClosed(PeerId),
    /// A peer sent a message on the direct channel.
    Peer {
        /// Who (from the channel, not the message: names can lie).
        from: PeerId,
        /// What.
        envelope: Envelope,
    },
}

/// What the UI should know.
#[derive(Debug, Clone, PartialEq)]
pub enum UiEvent {
    /// The room, peers, host or mute state changed: redraw.
    Changed,
    /// A chat line was added.
    Chat(ChatLine),
    /// A short notice ("Room is full").
    Notice(String),
}

/// One thing for the shell to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Send to the signaling server.
    Send(ClientMessage),
    /// Start a peer connection; the initiator creates the channels and the offer.
    OpenPeer {
        /// To whom.
        peer: PeerId,
        /// We make the offer.
        initiator: bool,
    },
    /// Hand signaling from the server to a peer connection (opening it if needed).
    Signal {
        /// Which connection.
        peer: PeerId,
        /// What arrived.
        signal: RemoteSignal,
    },
    /// Close a peer connection.
    ClosePeer(PeerId),
    /// Send to one peer.
    SendToPeer {
        /// To whom.
        peer: PeerId,
        /// What.
        envelope: Envelope,
    },
    /// Send to every connected peer.
    Broadcast(Envelope),
    /// Tell the UI.
    Ui(UiEvent),
}

/// Chat lines kept in memory (older ones drop off).
const CHAT_KEEP: usize = 500;

/// The room as this app sees it.
#[derive(Debug, Clone)]
pub struct Room {
    me: Identity,
    phase: Phase,
    host: Option<PeerId>,
    members: BTreeMap<PeerId, Member>,
    muted: bool,
    chat: Vec<ChatLine>,
    seat_token: Option<String>,
    host_token: Option<String>,
}

impl Room {
    /// Not in a room yet.
    #[must_use]
    pub const fn new(me: Identity) -> Self {
        Self {
            me,
            phase: Phase::Idle,
            host: None,
            members: BTreeMap::new(),
            muted: false,
            chat: Vec::new(),
            seat_token: None,
            host_token: None,
        }
    }

    /// Where we are.
    #[must_use]
    pub const fn phase(&self) -> &Phase {
        &self.phase
    }

    /// The host's peer id.
    #[must_use]
    pub const fn host(&self) -> Option<&PeerId> {
        self.host.as_ref()
    }

    /// We host the room.
    #[must_use]
    pub fn is_host(&self) -> bool {
        self.host.as_ref() == Some(&self.me.peer_id)
    }

    /// Everyone else, by peer id.
    #[must_use]
    pub const fn members(&self) -> &BTreeMap<PeerId, Member> {
        &self.members
    }

    /// Our mic is muted.
    #[must_use]
    pub const fn muted(&self) -> bool {
        self.muted
    }

    /// The chat so far.
    #[must_use]
    pub fn chat(&self) -> &[ChatLine] {
        &self.chat
    }

    /// Who we are.
    #[must_use]
    pub const fn identity(&self) -> &Identity {
        &self.me
    }

    /// Applies one input; returns what to do about it. `now_ms` is wall-clock ms since 1970.
    pub fn update(&mut self, input: Input, now_ms: f64) -> Vec<Effect> {
        let mut fx = Vec::new();
        match input {
            Input::Command(c) => self.command(c, now_ms, &mut fx),
            Input::Server(m) => self.server(m, now_ms, &mut fx),
            Input::SignalingUp => self.signaling_up(&mut fx),
            Input::SignalingDown => {}
            Input::ChannelOpen(peer) => self.channel_open(peer, now_ms, &mut fx),
            Input::ChannelClosed(peer) => {
                if let Some(m) = self.members.get_mut(&peer) {
                    m.connected = false;
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
            }
            Input::Peer { from, envelope } => self.peer(from, envelope, &mut fx),
        }
        fx
    }

    fn envelope(&self, message: PeerMessage, now_ms: f64) -> Envelope {
        Envelope {
            sender: Some(self.me.username.clone()),
            timestamp: Some(now_ms),
            message,
        }
    }

    fn identity_message(&self, is_reply: bool) -> PeerMessage {
        PeerMessage::PeerIdentity {
            peer_id: self.me.peer_id.clone(),
            username: self.me.username.clone(),
            is_host: self.is_host(),
            is_muted: self.muted,
            proto: PROTOCOL_VERSION,
            build: Some(self.me.build.clone()),
            client_id: self.me.client_id.clone(),
            is_reply,
            playback_lock: None,
            client: Some(rtc_protocol::peer::CLIENT_DESKTOP.to_owned()),
        }
    }

    fn system(&mut self, text: impl Into<String>, fx: &mut Vec<Effect>) {
        let id = format!("sys-{}", self.chat.len());
        self.push_chat(
            ChatLine {
                id,
                from: None,
                name: String::new(),
                is_host: false,
                text: text.into(),
            },
            fx,
        );
    }

    fn push_chat(&mut self, line: ChatLine, fx: &mut Vec<Effect>) {
        if line.from.is_some() && self.chat.iter().any(|l| l.id == line.id) {
            return;
        }
        if self.chat.len() >= CHAT_KEEP {
            self.chat.remove(0);
        }
        self.chat.push(line.clone());
        fx.push(Effect::Ui(UiEvent::Chat(line)));
    }

    fn command(&mut self, c: Command, now_ms: f64, fx: &mut Vec<Effect>) {
        match c {
            Command::SetName(name) => {
                if self.phase == Phase::Idle {
                    self.me.username = name;
                }
            }
            Command::CreateRoom if self.phase == Phase::Idle => {
                self.phase = Phase::Creating;
                fx.push(Effect::Send(ClientMessage::CreateRoom {
                    peer_id: self.me.peer_id.clone(),
                    room_id: None,
                    host_token: None,
                    seat_token: None,
                }));
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            Command::Join(room) if self.phase == Phase::Idle => {
                self.phase = Phase::Joining(room);
                fx.push(Effect::Send(ClientMessage::Join {
                    room_id: room,
                    peer_id: self.me.peer_id.clone(),
                    rejoin: false,
                    seat_token: None,
                }));
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            Command::CreateRoom | Command::Join(_) => {}
            Command::Leave => {
                if self.phase == Phase::Idle {
                    return;
                }
                fx.push(Effect::Broadcast(self.envelope(PeerMessage::PeerBye, now_ms)));
                fx.push(Effect::Send(ClientMessage::Leave));
                self.reset(fx);
            }
            Command::SendChat { id, text } => {
                let text = text.trim().to_owned();
                if text.is_empty() || !matches!(self.phase, Phase::InRoom(_)) {
                    return;
                }
                let is_host = self.is_host();
                fx.push(Effect::Broadcast(self.envelope(
                    PeerMessage::Chat {
                        id: id.clone(),
                        is_host,
                        text: text.clone(),
                    },
                    now_ms,
                )));
                let line = ChatLine {
                    id,
                    from: Some(self.me.peer_id.clone()),
                    name: self.me.username.clone(),
                    is_host,
                    text,
                };
                self.push_chat(line, fx);
            }
            Command::SetMuted(muted) => {
                if self.muted == muted {
                    return;
                }
                self.muted = muted;
                if matches!(self.phase, Phase::InRoom(_)) {
                    let msg = PeerMessage::PeerVoiceStatus {
                        peer_id: self.me.peer_id.clone(),
                        is_muted: muted,
                    };
                    fx.push(Effect::Broadcast(self.envelope(msg, now_ms)));
                }
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            Command::TransferHost(to) => {
                if self.is_host() && self.members.contains_key(&to) {
                    fx.push(Effect::Send(ClientMessage::TransferHost { target_peer_id: to }));
                }
            }
        }
    }

    fn reset(&mut self, fx: &mut Vec<Effect>) {
        for peer in std::mem::take(&mut self.members).into_keys() {
            fx.push(Effect::ClosePeer(peer));
        }
        self.phase = Phase::Idle;
        self.host = None;
        self.seat_token = None;
        self.host_token = None;
        fx.push(Effect::Ui(UiEvent::Changed));
    }

    /// The socket came back: claim our seat again (the server keeps it for a while).
    fn signaling_up(&mut self, fx: &mut Vec<Effect>) {
        let Phase::InRoom(room) = self.phase else { return };
        let msg = if self.is_host() {
            ClientMessage::CreateRoom {
                peer_id: self.me.peer_id.clone(),
                room_id: Some(room),
                host_token: self.host_token.clone(),
                seat_token: self.seat_token.clone(),
            }
        } else {
            ClientMessage::Join {
                room_id: room,
                peer_id: self.me.peer_id.clone(),
                rejoin: true,
                seat_token: self.seat_token.clone(),
            }
        };
        fx.push(Effect::Send(msg));
    }

    /// Peers we don't know yet: open a connection and wait for their offer (they were here first).
    fn adopt_existing(&mut self, peers: Vec<PeerId>, fx: &mut Vec<Effect>) {
        for peer in peers {
            if peer == self.me.peer_id || self.members.contains_key(&peer) {
                continue;
            }
            self.members.insert(peer.clone(), Member::default());
            fx.push(Effect::OpenPeer {
                peer,
                initiator: false,
            });
        }
    }

    fn server(&mut self, m: ServerMessage, now_ms: f64, fx: &mut Vec<Effect>) {
        let _ = now_ms;
        match m {
            ServerMessage::RoomCreated {
                room_id,
                host_peer_id,
                seat_token,
                host_token,
                ..
            } => {
                self.phase = Phase::InRoom(room_id);
                self.host = Some(host_peer_id);
                self.seat_token = Some(seat_token);
                self.host_token = Some(host_token);
                self.system(
                    format!("Room {room_id} created. Share the code to invite friends."),
                    fx,
                );
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            ServerMessage::RoomResumed {
                room_id,
                peers,
                host_peer_id,
                seat_token,
                host_token,
                ..
            } => {
                self.phase = Phase::InRoom(room_id);
                self.host = Some(host_peer_id);
                self.seat_token = Some(seat_token);
                self.host_token = Some(host_token);
                self.adopt_existing(peers, fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            ServerMessage::Joined {
                room_id,
                peers,
                host_peer_id,
                seat_token,
                host_token,
                ..
            } => {
                let first = !matches!(self.phase, Phase::InRoom(_));
                self.phase = Phase::InRoom(room_id);
                self.host = Some(host_peer_id);
                self.seat_token = Some(seat_token);
                if host_token.is_some() {
                    self.host_token = host_token;
                }
                if first {
                    self.system(
                        format!("You joined room {room_id} as \"{}\".", self.me.username),
                        fx,
                    );
                }
                self.adopt_existing(peers, fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            ServerMessage::Host { host_peer_id, .. } => {
                if self.host.as_ref() != Some(&host_peer_id) {
                    let text = if host_peer_id == self.me.peer_id {
                        "You are the host now.".to_owned()
                    } else {
                        format!("{} is the host now.", self.name_of(&host_peer_id))
                    };
                    self.host = Some(host_peer_id);
                    self.system(text, fx);
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
            }
            ServerMessage::HostToken { host_token, .. } => self.host_token = Some(host_token),
            ServerMessage::PeerJoined { peer_id } => {
                if peer_id == self.me.peer_id || !matches!(self.phase, Phase::InRoom(_)) {
                    return;
                }
                // We were here first: we offer (as the web app does). A known peer is rebuilt.
                if self.members.contains_key(&peer_id) {
                    fx.push(Effect::ClosePeer(peer_id.clone()));
                }
                self.members.insert(peer_id.clone(), Member::default());
                fx.push(Effect::OpenPeer {
                    peer: peer_id,
                    initiator: true,
                });
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            ServerMessage::PeerLeft { peer_id } => {
                // Signaling lost them, but a live direct channel means they're still with us.
                if self.members.get(&peer_id).is_some_and(|m| m.connected) {
                    return;
                }
                if let Some(m) = self.members.remove(&peer_id) {
                    fx.push(Effect::ClosePeer(peer_id));
                    let name = m.username.unwrap_or_else(|| "A friend".to_owned());
                    self.system(format!("{name} left."), fx);
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
            }
            ServerMessage::Left => {
                if self.phase != Phase::Idle {
                    self.reset(fx);
                }
            }
            ServerMessage::Offer {
                from, offer, fresh, ..
            } => {
                self.members.entry(from.clone()).or_default();
                fx.push(Effect::Signal {
                    peer: from,
                    signal: RemoteSignal::Offer { offer, fresh },
                });
            }
            ServerMessage::Answer { from, answer } => {
                fx.push(Effect::Signal {
                    peer: from,
                    signal: RemoteSignal::Answer(answer),
                });
            }
            ServerMessage::IceCandidate { from, candidate } => {
                fx.push(Effect::Signal {
                    peer: from,
                    signal: RemoteSignal::Candidate(candidate),
                });
            }
            ServerMessage::Error { message, code, .. } => {
                let text = match code {
                    Some(ErrorCode::RoomFull) => "That room is full.".to_owned(),
                    Some(ErrorCode::NotFound) => "No room with that code.".to_owned(),
                    Some(ErrorCode::SeatTaken) => "You're already in this room in another window.".to_owned(),
                    _ => message,
                };
                if matches!(self.phase, Phase::Creating | Phase::Joining(_)) {
                    self.phase = Phase::Idle;
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
                fx.push(Effect::Ui(UiEvent::Notice(text)));
            }
            ServerMessage::Pong | ServerMessage::RoomFound { .. } | ServerMessage::Unknown => {}
        }
    }

    fn name_of(&self, peer: &PeerId) -> String {
        self.members
            .get(peer)
            .and_then(|m| m.username.clone())
            .unwrap_or_else(|| "A friend".to_owned())
    }

    fn channel_open(&mut self, peer: PeerId, now_ms: f64, fx: &mut Vec<Effect>) {
        let Some(m) = self.members.get_mut(&peer) else {
            return;
        };
        m.connected = true;
        let envelope = self.envelope(self.identity_message(false), now_ms);
        fx.push(Effect::SendToPeer { peer, envelope });
        fx.push(Effect::Ui(UiEvent::Changed));
    }

    fn peer(&mut self, from: PeerId, envelope: Envelope, fx: &mut Vec<Effect>) {
        if !self.members.contains_key(&from) {
            return;
        }
        let ts = envelope.timestamp.unwrap_or_default();
        match envelope.message {
            PeerMessage::PeerIdentity {
                username,
                is_muted,
                is_reply,
                client,
                ..
            } => {
                let first = self.members.get(&from).is_some_and(|m| m.username.is_none());
                if let Some(m) = self.members.get_mut(&from) {
                    m.username = Some(username.clone());
                    m.muted = is_muted;
                    m.desktop = client.as_deref() == Some(rtc_protocol::peer::CLIENT_DESKTOP);
                }
                if !is_reply {
                    let reply = self.envelope(self.identity_message(true), ts);
                    fx.push(Effect::SendToPeer {
                        peer: from,
                        envelope: reply,
                    });
                }
                if first {
                    self.system(format!("{username} joined."), fx);
                }
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            PeerMessage::PeerVoiceStatus { is_muted, .. } => {
                if let Some(m) = self.members.get_mut(&from) {
                    m.muted = is_muted;
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
            }
            PeerMessage::PeerBye => {
                self.members.remove(&from);
                fx.push(Effect::ClosePeer(from));
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            PeerMessage::NetPing { ping_id, send_time } => {
                let pong = self.envelope(PeerMessage::NetPong { ping_id, send_time }, ts);
                fx.push(Effect::SendToPeer {
                    peer: from,
                    envelope: pong,
                });
            }
            PeerMessage::Chat { id, text, .. } => {
                let name = envelope.sender.unwrap_or_else(|| self.name_of(&from));
                // the host flag comes from who hosts, not from what the message claims
                let is_host = self.host.as_ref() == Some(&from);
                self.push_chat(
                    ChatLine {
                        id,
                        from: Some(from),
                        name,
                        is_host,
                        text,
                    },
                    fx,
                );
            }
            PeerMessage::NetPong { .. }
            | PeerMessage::Reaction { .. }
            | PeerMessage::RoomState { .. }
            | PeerMessage::RoomStateAction { .. }
            | PeerMessage::RoomStateRequest { .. }
            | PeerMessage::RoomStateGone { .. }
            | PeerMessage::Unknown => {}
        }
    }
}
