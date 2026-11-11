//! The room state machine. Mirrors the web app's rules (`client-ts/src/webrtc/signalingMessages.ts`)
//! so desktop and web peers agree on who offers, who hosts and what everyone sees.

use std::collections::BTreeMap;

use rtc_protocol::peer::{Envelope, PeerMessage};
use rtc_protocol::sdp::{IceCandidate, SessionDescription};
use rtc_protocol::signaling::{ClientMessage, ErrorCode, ServerMessage};
use rtc_protocol::{ClientId, PROTOCOL_VERSION, PeerId, RoomId};

use crate::recovery::{Action, Health};

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
    /// Their voice is coming through right now.
    pub speaking: bool,
}

/// One chat line.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatLine {
    /// Message id (dedupes repeats).
    pub id: String,
    /// Sender's peer id.
    pub from: PeerId,
    /// Sender's name as shown.
    pub name: String,
    /// Sent by the host.
    pub is_host: bool,
    /// The text.
    pub text: String,
    /// When it arrived, ms since 1970.
    pub at: f64,
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
    /// Stop or start hearing everyone ("deafen"); deafening also mutes the mic.
    SetDeafened(bool),
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

/// A peer connection's state, as libwebrtc reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    /// Up.
    Connected,
    /// Lost for now; may come back by itself.
    Disconnected,
    /// Failed.
    Failed,
}

/// One thing that happened.
#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    /// The user did something.
    Command(Command),
    /// The signaling server said something.
    Server(ServerMessage),
    /// The signaling socket connected (or reconnected).
    SignalingUp {
        /// The server's name for people ("Oracle Cloud").
        label: String,
        /// It's a backup server (the first one couldn't be reached).
        backup: bool,
    },
    /// Answer to [`Effect::FindRoomElsewhere`]: the server that has the room, if any.
    RoomFound {
        /// The room looked for.
        room: RoomId,
        /// The server that has it.
        url: Option<String>,
    },
    /// The signaling socket dropped (the shell reconnects).
    SignalingDown,
    /// A peer connection changed state.
    Link {
        /// Whose.
        peer: PeerId,
        /// New state.
        state: LinkState,
    },
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
    /// Someone started or stopped talking (`None`: us).
    Speaking {
        /// Who.
        peer: Option<PeerId>,
        /// Talking now.
        speaking: bool,
    },
    /// Time passed (the shell ticks about twice a second).
    Tick,
}

/// What the UI should know.
#[derive(Debug, Clone, PartialEq)]
pub enum UiEvent {
    /// The room, peers, host or mute state changed: redraw.
    Changed,
    /// A chat message was added.
    Chat(ChatLine),
    /// A line for the Logs tab.
    Log(String),
    /// A short toast, or (before a room exists) why a join failed.
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
    /// The room wasn't on this server: ask the other servers whether they have it.
    FindRoomElsewhere(RoomId),
    /// Move the signaling connection to this server (it has our room).
    SwitchServer(String),
    /// Send an offer with an ICE restart on this connection.
    IceRestart(PeerId),
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
    /// Send our voice (true) or silence (false).
    SetMic(bool),
    /// Stop (true) or start playing everyone's voice.
    SetDeafened(bool),
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
    health: BTreeMap<PeerId, Health>,
    muted: bool,
    deafened: bool,
    speaking: bool,
    signaling_up: bool,
    chat: Vec<ChatLine>,
    seat_token: Option<String>,
    host_token: Option<String>,
    /// While another server is asked for the room: what to say if none has it.
    not_found: Option<String>,
}

impl Room {
    /// Not in a room yet. The mic starts off, as on the web ("Turn my mic on when I join" is off).
    #[must_use]
    pub const fn new(me: Identity) -> Self {
        Self {
            me,
            phase: Phase::Idle,
            host: None,
            members: BTreeMap::new(),
            health: BTreeMap::new(),
            muted: true,
            deafened: false,
            speaking: false,
            signaling_up: false,
            chat: Vec::new(),
            seat_token: None,
            host_token: None,
            not_found: None,
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

    /// We hear nobody.
    #[must_use]
    pub const fn deafened(&self) -> bool {
        self.deafened
    }

    /// Our voice is going out right now.
    #[must_use]
    pub const fn speaking(&self) -> bool {
        self.speaking
    }

    /// The signaling server is reachable.
    #[must_use]
    pub const fn signaling_up(&self) -> bool {
        self.signaling_up
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
            Input::SignalingUp { label, backup } => {
                self.signaling_up = true;
                self.log(
                    if backup {
                        format!("🔄 Connected to backup signaling server ({label}).")
                    } else {
                        format!("Connected to {label} signaling")
                    },
                    &mut fx,
                );
                self.reclaim_seat(&mut fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            Input::RoomFound { room, url } => {
                if self.phase != Phase::Joining(room) {
                    return fx;
                }
                let message = self.not_found.take().unwrap_or_default();
                if let Some(url) = url {
                    self.log(
                        format!("🔄 Room {room} is on another 3RTC server. Connecting there..."),
                        &mut fx,
                    );
                    // the join goes again once connected there (`reclaim_seat`)
                    fx.push(Effect::SwitchServer(url));
                } else {
                    self.phase = Phase::Idle;
                    fx.push(Effect::Ui(UiEvent::Changed));
                    fx.push(Effect::Ui(UiEvent::Notice(message)));
                }
            }
            Input::SignalingDown => {
                self.signaling_up = false;
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            Input::Link { peer, state } => {
                let Some(h) = self.health.get_mut(&peer) else {
                    return fx;
                };
                let actions = match state {
                    LinkState::Connected => h.on_connected(),
                    LinkState::Disconnected => h.on_broken(false, now_ms),
                    LinkState::Failed => h.on_broken(true, now_ms),
                };
                self.recovery(&peer, actions, now_ms, &mut fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            Input::ChannelOpen(peer) => self.channel_open(peer, now_ms, &mut fx),
            Input::ChannelClosed(peer) => self.channel_closed(&peer, now_ms, &mut fx),
            Input::Peer { from, envelope } => self.peer(from, envelope, &mut fx),
            Input::Speaking { peer: None, speaking } => {
                if self.speaking != speaking {
                    self.speaking = speaking;
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
            }
            Input::Speaking {
                peer: Some(peer),
                speaking,
            } => {
                if let Some(m) = self.members.get_mut(&peer)
                    && m.speaking != speaking
                {
                    m.speaking = speaking;
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
            }
            Input::Tick => {
                let up = self.signaling_up;
                let due: Vec<(PeerId, Vec<Action>)> = self
                    .health
                    .iter_mut()
                    .map(|(p, h)| (p.clone(), h.tick(now_ms, up)))
                    .filter(|(_, a)| !a.is_empty())
                    .collect();
                for (peer, actions) in due {
                    self.recovery(&peer, actions, now_ms, &mut fx);
                }
            }
        }
        fx
    }

    fn recovery(&mut self, peer: &PeerId, actions: Vec<Action>, now_ms: f64, fx: &mut Vec<Effect>) {
        for action in actions {
            match action {
                Action::IceRestart => fx.push(Effect::IceRestart(peer.clone())),
                Action::Rebuild => {
                    if let Some(h) = self.health.get(peer) {
                        let fresh = h.rebuilt(now_ms);
                        self.health.insert(peer.clone(), fresh);
                    }
                    if let Some(m) = self.members.get_mut(peer) {
                        m.connected = false;
                    }
                    fx.push(Effect::ClosePeer(peer.clone()));
                    fx.push(Effect::OpenPeer {
                        peer: peer.clone(),
                        initiator: true,
                    });
                }
                Action::Drop => self.drop_member(peer, fx),
                Action::Blocked => {
                    self.log(BLOCKED_MESSAGE, fx);
                    fx.push(Effect::Ui(UiEvent::Notice(BLOCKED_TOAST.to_owned())));
                }
                Action::System(text) => self.log(text, fx),
                Action::Toast(text) => fx.push(Effect::Ui(UiEvent::Notice(text.to_owned()))),
            }
        }
    }

    fn drop_member(&mut self, peer: &PeerId, fx: &mut Vec<Effect>) {
        self.health.remove(peer);
        if self.members.remove(peer).is_some() {
            fx.push(Effect::ClosePeer(peer.clone()));
            fx.push(Effect::Ui(UiEvent::Changed));
        }
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

    #[allow(clippy::unused_self)]
    fn log(&self, text: impl Into<String>, fx: &mut Vec<Effect>) {
        fx.push(Effect::Ui(UiEvent::Log(text.into())));
    }

    fn push_chat(&mut self, line: ChatLine, fx: &mut Vec<Effect>) {
        if self.chat.iter().any(|l| l.id == line.id && l.from == line.from) {
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
                self.log("You left the room.", fx);
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
                    from: self.me.peer_id.clone(),
                    name: self.me.username.clone(),
                    is_host,
                    text,
                    at: now_ms,
                };
                self.push_chat(line, fx);
            }
            Command::SetMuted(muted) => {
                if self.muted == muted {
                    return;
                }
                if !muted && self.deafened {
                    // talking again means hearing again (as Discord and the web app do)
                    self.set_deafened(false, fx);
                }
                self.set_muted(muted, now_ms, fx);
            }
            Command::SetDeafened(deafened) => {
                if self.deafened == deafened {
                    return;
                }
                self.set_deafened(deafened, fx);
                if deafened && !self.muted {
                    self.set_muted(true, now_ms, fx);
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

    fn set_muted(&mut self, muted: bool, now_ms: f64, fx: &mut Vec<Effect>) {
        self.muted = muted;
        fx.push(Effect::SetMic(!muted));
        if muted {
            self.speaking = false;
        }
        if matches!(self.phase, Phase::InRoom(_)) {
            let msg = PeerMessage::PeerVoiceStatus {
                peer_id: Some(self.me.peer_id.clone()),
                is_muted: muted,
            };
            fx.push(Effect::Broadcast(self.envelope(msg, now_ms)));
            self.log(
                if muted {
                    "🔇 You muted your microphone."
                } else {
                    "🎙️ You unmuted your microphone (Voice Chat Active)."
                },
                fx,
            );
            let toast = if muted {
                "🔇 Microphone muted"
            } else {
                "🎙️ Microphone unmuted (Live)"
            };
            fx.push(Effect::Ui(UiEvent::Notice(toast.to_owned())));
        }
        fx.push(Effect::Ui(UiEvent::Changed));
    }

    fn set_deafened(&mut self, deafened: bool, fx: &mut Vec<Effect>) {
        self.deafened = deafened;
        fx.push(Effect::SetDeafened(deafened));
        self.log(
            if deafened {
                "🔇 Audio & microphone blocked (Text Chat only mode)."
            } else {
                "🔊 You unblocked incoming audio."
            },
            fx,
        );
        fx.push(Effect::Ui(UiEvent::Changed));
    }

    fn reset(&mut self, fx: &mut Vec<Effect>) {
        for peer in std::mem::take(&mut self.members).into_keys() {
            fx.push(Effect::ClosePeer(peer));
        }
        self.health.clear();
        self.phase = Phase::Idle;
        self.host = None;
        self.seat_token = None;
        self.host_token = None;
        self.chat.clear();
        fx.push(Effect::Ui(UiEvent::Changed));
    }

    /// The socket came back: claim our seat again (the server keeps it for a while).
    fn reclaim_seat(&self, fx: &mut Vec<Effect>) {
        if let Phase::Joining(room) = self.phase {
            // moved servers to find the room (or the socket dropped mid-join): ask again
            fx.push(Effect::Send(ClientMessage::Join {
                room_id: room,
                peer_id: self.me.peer_id.clone(),
                rejoin: false,
                seat_token: None,
            }));
            return;
        }
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
        self.log(
            format!("🔄 Reconnected to signaling. Resuming room {room}..."),
            fx,
        );
    }

    /// Peers we don't know yet: open a connection and wait for their offer (they were here first).
    fn adopt_existing(&mut self, peers: Vec<PeerId>, now_ms: f64, fx: &mut Vec<Effect>) {
        for peer in peers {
            if peer == self.me.peer_id || self.members.contains_key(&peer) {
                continue;
            }
            self.members.insert(peer.clone(), Member::default());
            self.health.insert(peer.clone(), Health::new(false, now_ms));
            fx.push(Effect::OpenPeer {
                peer,
                initiator: false,
            });
        }
    }

    #[allow(clippy::too_many_lines)]
    fn server(&mut self, m: ServerMessage, now_ms: f64, fx: &mut Vec<Effect>) {
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
                self.log(
                    format!("You created room {room_id} as \"{}\".", self.me.username),
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
                self.adopt_existing(peers, now_ms, fx);
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
                    self.log(
                        format!("You joined room {room_id} as \"{}\".", self.me.username),
                        fx,
                    );
                }
                self.adopt_existing(peers, now_ms, fx);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            ServerMessage::Host { host_peer_id, from } => {
                if self.host.as_ref() == Some(&host_peer_id) {
                    return;
                }
                if let Some(from) = from {
                    let me = &self.me.peer_id;
                    let text = if &host_peer_id == me {
                        format!("👑 {} made you the host", self.name_of(&from))
                    } else if &from == me {
                        format!("👑 {} is now the host", self.name_of(&host_peer_id))
                    } else {
                        format!(
                            "👑 {} made {} the host",
                            self.name_of(&from),
                            self.name_of(&host_peer_id)
                        )
                    };
                    self.log(text.clone(), fx);
                    fx.push(Effect::Ui(UiEvent::Notice(text)));
                }
                self.host = Some(host_peer_id);
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            ServerMessage::HostToken { host_token, .. } => self.host_token = Some(host_token),
            ServerMessage::PeerJoined { peer_id } => {
                let Phase::InRoom(room) = self.phase else { return };
                if peer_id == self.me.peer_id {
                    return;
                }
                // We were here first: we offer (as the web app does). A known peer is rebuilt.
                if self.members.contains_key(&peer_id) {
                    fx.push(Effect::ClosePeer(peer_id.clone()));
                } else {
                    self.log(
                        format!("A peer entered room {room}. Establishing P2P connection..."),
                        fx,
                    );
                }
                self.members.insert(peer_id.clone(), Member::default());
                self.health.insert(peer_id.clone(), Health::new(true, now_ms));
                fx.push(Effect::OpenPeer {
                    peer: peer_id,
                    initiator: true,
                });
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            ServerMessage::PeerLeft { peer_id } => {
                // Signaling lost them, but a live direct link means they're still with us
                let live = self.members.get(&peer_id).is_some_and(|m| m.connected)
                    && self.health.get(&peer_id).is_some_and(Health::is_connected);
                if live {
                    if let Some(h) = self.health.get_mut(&peer_id) {
                        h.signaling_gone = true;
                    }
                    return;
                }
                if self.members.contains_key(&peer_id) {
                    self.drop_member(&peer_id, fx);
                    self.log("A peer disconnected from the room.", fx);
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
                if !self.members.contains_key(&from) {
                    self.members.insert(from.clone(), Member::default());
                }
                if fresh || !self.health.contains_key(&from) {
                    // they rebuilt their side: a fresh connection here too, remembering it worked before
                    let h = match self.health.get(&from) {
                        Some(prev) if prev.ever_connected() => prev.rebuilt(now_ms).answering(),
                        _ => Health::new(false, now_ms),
                    };
                    self.health.insert(from.clone(), h);
                }
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
            ServerMessage::Error {
                message,
                code,
                room_id,
            } => {
                if code == Some(ErrorCode::ResumeDenied)
                    && let Some(room) = room_id
                {
                    // couldn't get the room back as host: come back as a guest
                    fx.push(Effect::Send(ClientMessage::Join {
                        room_id: room,
                        peer_id: self.me.peer_id.clone(),
                        rejoin: true,
                        seat_token: self.seat_token.clone(),
                    }));
                    return;
                }
                let text = if message.is_empty() {
                    "Signaling error".to_owned()
                } else {
                    message
                };
                // the room may be on another 3RTC server: look there before saying it doesn't exist
                if code == Some(ErrorCode::NotFound)
                    && let Phase::Joining(room) = self.phase
                    && self.not_found.is_none()
                {
                    self.not_found = Some(text);
                    fx.push(Effect::FindRoomElsewhere(room));
                    return;
                }
                if matches!(self.phase, Phase::Creating | Phase::Joining(_)) {
                    self.phase = Phase::Idle;
                    self.not_found = None;
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
                fx.push(Effect::Ui(UiEvent::Notice(text)));
            }
            ServerMessage::Pong | ServerMessage::RoomFound { .. } | ServerMessage::Unknown => {}
        }
    }

    fn name_of(&self, peer: &PeerId) -> String {
        if peer == &self.me.peer_id {
            return self.me.username.clone();
        }
        self.members
            .get(peer)
            .and_then(|m| m.username.clone())
            .unwrap_or_else(|| "Someone".to_owned())
    }

    fn channel_open(&mut self, peer: PeerId, now_ms: f64, fx: &mut Vec<Effect>) {
        let Some(m) = self.members.get_mut(&peer) else {
            return;
        };
        let first = !m.connected;
        m.connected = true;
        let envelope = self.envelope(self.identity_message(false), now_ms);
        fx.push(Effect::SendToPeer { peer, envelope });
        if first {
            self.log(
                "Direct Peer-to-Peer DataChannel established. Chat & YouTube Sync is live!",
                fx,
            );
        }
        fx.push(Effect::Ui(UiEvent::Changed));
    }

    fn channel_closed(&mut self, peer: &PeerId, now_ms: f64, fx: &mut Vec<Effect>) {
        let Some(m) = self.members.get_mut(peer) else {
            return;
        };
        m.connected = false;
        m.speaking = false;
        let gone = self.health.get(peer).is_none_or(|h| h.signaling_gone);
        if gone {
            self.drop_member(peer, fx);
        } else if let Some(h) = self.health.get_mut(peer) {
            h.on_channel_closed(now_ms);
        }
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
                if let Some(m) = self.members.get_mut(&from) {
                    m.username = Some(clean_name(&username));
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
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            PeerMessage::PeerVoiceStatus { is_muted, .. } => {
                if let Some(m) = self.members.get_mut(&from) {
                    m.muted = is_muted;
                    if is_muted {
                        m.speaking = false;
                    }
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
            }
            PeerMessage::PeerBye => self.drop_member(&from, fx),
            PeerMessage::NetPing { ping_id, send_time } => {
                let pong = self.envelope(PeerMessage::NetPong { ping_id, send_time }, ts);
                fx.push(Effect::SendToPeer {
                    peer: from,
                    envelope: pong,
                });
            }
            PeerMessage::Chat { id, text, .. } => {
                // the name comes from the connection, the host flag from who hosts: messages can lie
                let name = self.name_of(&from);
                let is_host = self.host.as_ref() == Some(&from);
                let text: String = text.chars().take(MAX_CHAT_CHARS).collect();
                let line = ChatLine {
                    id,
                    from,
                    name,
                    is_host,
                    text,
                    at: if ts > 0.0 { ts } else { 0.0 },
                };
                self.push_chat(line, fx);
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

/// Longest chat message kept (the web app's input allows 1000).
pub const MAX_CHAT_CHARS: usize = 1000;

/// The "couldn't connect" log line (`webrtc/networkHint.ts`, either side).
pub const BLOCKED_MESSAGE: &str = "⚠️ Couldn't connect to someone in the room: your network or theirs blocks direct \
     connections (common on work, school and some mobile networks, and with a VPN). Try switching one of you \
     between Wi-Fi and mobile data, or turning off a VPN, then rejoin the room.";
/// Its toast.
pub const BLOCKED_TOAST: &str = "Can't connect: a network is blocking direct connections";

/// Longest display name (`NAME_MAX` in `client-ts/src/utils/names.ts`).
pub const NAME_MAX: usize = 24;

/// Unicode "format" characters (zero-width, bidi controls, …) and line/paragraph separators.
const fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{00ad}' | '\u{0600}'..='\u{0605}' | '\u{061c}' | '\u{06dd}' | '\u{070f}' | '\u{0890}'..='\u{0891}'
        | '\u{08e2}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{206f}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}' | '\u{110bd}' | '\u{110cd}'
        | '\u{13430}'..='\u{1343f}' | '\u{1bca0}'..='\u{1bca3}' | '\u{1d173}'..='\u{1d17a}' | '\u{e0001}'
        | '\u{e0020}'..='\u{e007f}')
}

/// A display name from a peer, cleaned as `cleanName` in `client-ts/src/utils/names.ts`: no
/// control or invisible characters, single spaces, at most 24 characters; "Guest" if nothing's left.
#[must_use]
pub fn clean_name(raw: &str) -> String {
    let visible: String = raw
        .chars()
        .filter(|c| !c.is_control() && !is_invisible(*c))
        .collect();
    let spaced = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = spaced.chars().take(NAME_MAX).collect();
    let cut = cut.trim();
    if cut.is_empty() {
        "Guest".to_owned()
    } else {
        cut.to_owned()
    }
}
