//! The imperative shell around [`rtc_core::Room`]: one task that owns the room, the signaling
//! socket, our voice and every peer connection.
//!
//! Everything that happens — a UI command, a server message, a libwebrtc callback, a timer tick —
//! becomes one message on one queue, handled in order. The room logic decides; this crate only
//! carries out its [`Effect`]s. Nothing here blocks the UI thread.

#![deny(missing_docs)]

mod peers;

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rtc_core::{Command, Effect, Identity, Input, Room};
use rtc_protocol::peer::Envelope;
use rtc_protocol::{ClientId, PeerId, RoomId};
use rtc_signaling::Event as SignalingEvent;
use rtc_webrtc::factory::Factory;
use rtc_webrtc::stats::Speaking;
use rtc_webrtc::voice::Voice;
use tokio::sync::mpsc;

pub use rtc_core::{ChatLine, Member, Phase, UiEvent};
pub use rtc_webrtc::factory::IceServerConfig;
pub use rtc_webrtc::voice::{Device, Devices, MicSource};

use crate::peers::{PeerEvent, Peers};

/// How often the room logic's timers (connection recovery) run.
const TICK: Duration = Duration::from_millis(500);
/// How long to wait for other servers when looking for a room.
const FIND_ROOM_WAIT: Duration = Duration::from_secs(5);

/// What the engine needs to start.
#[derive(Debug, Clone)]
pub struct Config {
    /// Signaling servers: the first, then fallbacks in order.
    pub signaling_urls: Vec<String>,
    /// The display name.
    pub username: String,
    /// This install's stable id.
    pub client_id: ClientId,
    /// The app's build, `YYMMDD.HHMM`.
    pub build: String,
    /// STUN/TURN servers.
    pub ice: Vec<IceServerConfig>,
    /// Where our voice comes from.
    pub mic: MicSource,
}

/// What the UI draws from: a copy of the room after each change.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// Where we are.
    pub phase: Phase,
    /// Our peer id.
    pub me: PeerId,
    /// Our name.
    pub username: String,
    /// Who hosts.
    pub host: Option<PeerId>,
    /// Everyone else.
    pub members: Vec<(PeerId, Member)>,
    /// Our mic is muted.
    pub muted: bool,
    /// We hear nobody.
    pub deafened: bool,
    /// We're talking.
    pub speaking: bool,
    /// The signaling server is reachable.
    pub online: bool,
    /// Which server ("Oracle Cloud").
    pub server: &'static str,
    /// Our voice is the real microphone (not a test tone or silence).
    pub real_audio: bool,
}

/// What the engine tells the UI.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    /// The room changed: redraw from this.
    Room(Snapshot),
    /// A chat message arrived (or was sent).
    Chat(ChatLine),
    /// A line for the Logs tab.
    Log(String),
    /// A toast; before a room exists, why a join failed.
    Notice(String),
    /// The microphones and speakers on this PC.
    Devices(Devices),
}

/// What the UI can ask.
#[derive(Debug)]
enum Request {
    Room(Command),
    Devices,
    Input(String),
    Output(String),
}

/// Sends commands to the engine. Dropping every clone stops it.
#[derive(Debug, Clone)]
pub struct Handle {
    tx: mpsc::UnboundedSender<Request>,
}

impl Handle {
    /// Asks the room to do something.
    pub fn command(&self, c: Command) {
        let _ = self.tx.send(Request::Room(c));
    }

    /// Asks for the list of microphones and speakers (answered with [`Update::Devices`]).
    pub fn list_devices(&self) {
        let _ = self.tx.send(Request::Devices);
    }

    /// Uses this microphone (`""`: the system default).
    pub fn set_input(&self, id: String) {
        let _ = self.tx.send(Request::Input(id));
    }

    /// Plays through this speaker (`""`: the system default).
    pub fn set_output(&self, id: String) {
        let _ = self.tx.send(Request::Output(id));
    }

    /// A new unique id for a chat message.
    #[must_use]
    pub fn new_message_id() -> String {
        format!("d{:016x}", rand::random::<u64>())
    }
}

/// Everything the engine reacts to, on one queue.
#[derive(Debug)]
enum Msg {
    Ui(Request),
    Signaling(SignalingEvent),
    Peer(PeerEvent),
    RoomFound(RoomId, Option<String>),
}

/// A fresh peer id for this launch (the server ties seats to it).
fn new_peer_id() -> PeerId {
    // 16 hex digits always pass the id rules
    PeerId::new(format!("dk{:016x}", rand::random::<u64>())).unwrap_or_else(|_| unreachable!())
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// Starts the engine on the current tokio runtime.
#[must_use]
pub fn start(config: Config) -> (Handle, mpsc::UnboundedReceiver<Update>) {
    let (queue_tx, queue) = mpsc::unbounded_channel();
    let (updates_tx, updates) = mpsc::unbounded_channel();
    let me = Identity {
        peer_id: new_peer_id(),
        client_id: config.client_id,
        username: config.username,
        build: config.build,
    };
    let (signaling, mut signaling_events) = rtc_signaling::spawn(rtc_signaling::Config::with_fallbacks(
        config.signaling_urls.clone(),
    ));
    let forward = queue_tx.clone();
    tokio::spawn(async move {
        while let Some(e) = signaling_events.recv().await {
            if forward.send(Msg::Signaling(e)).is_err() {
                break;
            }
        }
    });
    let factory = Factory::new(config.ice);
    let voice = Voice::new(&factory, config.mic);
    let peer_tx = queue_tx.clone();
    let peers = Peers::new(factory, voice.track(), signaling.clone(), move |e| {
        let _ = peer_tx.send(Msg::Peer(e));
    });
    // The UI's requests come through their own channel: when every UI handle is gone the engine
    // stops, even though libwebrtc's callbacks still hold senders to the queue.
    let (ui_tx, ui_rx) = mpsc::unbounded_channel();
    let engine = Engine {
        room: Room::new(me),
        signaling,
        urls: config.signaling_urls,
        current_url: None,
        voice,
        peers,
        updates: updates_tx,
        queue_tx,
        online: false,
        server: "Cloud",
        speaking: HashMap::new(),
        local: Speaking::default(),
    };
    if config.mic == MicSource::Device && !engine.voice.is_device() {
        let _ = engine.updates.send(Update::Notice(NO_SOUND_CARD.to_owned()));
    }
    tokio::spawn(engine.run(queue, ui_rx));
    (Handle { tx: ui_tx }, updates)
}

/// Shown when the microphone and speakers couldn't be opened.
const NO_SOUND_CARD: &str = "🔇 Couldn't open your microphone and speakers: voice won't work";

struct Engine {
    room: Room,
    signaling: rtc_signaling::Handle,
    urls: Vec<String>,
    current_url: Option<String>,
    voice: Voice,
    peers: Peers,
    updates: mpsc::UnboundedSender<Update>,
    queue_tx: mpsc::UnboundedSender<Msg>,
    online: bool,
    server: &'static str,
    speaking: HashMap<PeerId, Speaking>,
    local: Speaking,
}

impl Engine {
    async fn run(
        mut self,
        mut queue: mpsc::UnboundedReceiver<Msg>,
        mut ui: mpsc::UnboundedReceiver<Request>,
    ) {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        self.publish_room();
        loop {
            let msg = tokio::select! {
                m = queue.recv() => m,
                r = ui.recv() => r.map(Msg::Ui),
                _ = tick.tick() => {
                    let fx = self.room.update(Input::Tick, now_ms());
                    self.apply(fx).await;
                    continue;
                }
            };
            let Some(msg) = msg else { break };
            self.handle(msg).await;
        }
        let fx = self.room.update(Input::Command(Command::Leave), now_ms());
        self.apply(fx).await;
        self.peers.close_all();
    }

    async fn handle(&mut self, msg: Msg) {
        let now = now_ms();
        let input = match msg {
            Msg::Ui(Request::Room(c)) => Input::Command(c),
            Msg::Ui(Request::Devices) => {
                let _ = self.updates.send(Update::Devices(self.voice.devices()));
                return;
            }
            Msg::Ui(Request::Input(id)) => {
                self.voice.set_input(&id);
                return;
            }
            Msg::Ui(Request::Output(id)) => {
                self.voice.set_output(&id);
                return;
            }
            Msg::Signaling(SignalingEvent::Up { url, label, backup }) => {
                self.online = true;
                self.server = label;
                self.current_url = Some(url);
                Input::SignalingUp {
                    label: label.to_owned(),
                    backup,
                }
            }
            Msg::Signaling(SignalingEvent::Down) => {
                self.online = false;
                Input::SignalingDown
            }
            Msg::Signaling(SignalingEvent::Message(m)) => Input::Server(m),
            Msg::RoomFound(room, url) => Input::RoomFound { room, url },
            Msg::Peer(PeerEvent::Levels {
                peer,
                generation,
                levels,
            }) => {
                if !self.peers.is_current(&peer, generation) {
                    return;
                }
                let mut inputs = Vec::new();
                if let Some(level) = levels.remote
                    && let Some(change) = self.speaking.entry(peer.clone()).or_default().feed(level, now)
                {
                    inputs.push(Input::Speaking {
                        peer: Some(peer),
                        speaking: change,
                    });
                }
                if let Some(level) = levels.local {
                    let level = if self.room.muted() { 0.0 } else { level };
                    if let Some(change) = self.local.feed(level, now) {
                        inputs.push(Input::Speaking {
                            peer: None,
                            speaking: change,
                        });
                    }
                }
                for input in inputs {
                    let fx = self.room.update(input, now);
                    self.apply(fx).await;
                }
                return;
            }
            Msg::Peer(e) => match self.peers.on_event(e) {
                Some(input) => input,
                None => return,
            },
        };
        let fx = self.room.update(input, now);
        self.apply(fx).await;
    }

    async fn apply(&mut self, fx: Vec<Effect>) {
        for effect in fx {
            match effect {
                Effect::Send(m) => {
                    self.signaling.send(m);
                }
                Effect::OpenPeer { peer, initiator } => self.peers.open(peer, initiator).await,
                Effect::Signal { peer, signal } => self.peers.signal(peer, signal).await,
                Effect::IceRestart(peer) => self.peers.offer(&peer, true).await,
                Effect::ClosePeer(peer) => {
                    self.speaking.remove(&peer);
                    self.peers.close(&peer);
                }
                Effect::SendToPeer { peer, envelope } => self.peers.send(&peer, &envelope),
                Effect::Broadcast(envelope) => self.broadcast(&envelope),
                Effect::SetMic(on) => self.voice.set_sending(on),
                Effect::SetDeafened(d) => self.voice.set_deafened(d),
                Effect::FindRoomElsewhere(room) => self.find_room(room),
                Effect::SwitchServer(url) => {
                    self.current_url = Some(url.clone());
                    self.signaling.switch_server(url);
                }
                Effect::Ui(UiEvent::Changed) => self.publish_room(),
                Effect::Ui(UiEvent::Chat(line)) => {
                    let _ = self.updates.send(Update::Chat(line));
                }
                Effect::Ui(UiEvent::Log(text)) => {
                    tracing::info!("{text}");
                    let _ = self.updates.send(Update::Log(text));
                }
                Effect::Ui(UiEvent::Notice(n)) => {
                    let _ = self.updates.send(Update::Notice(n));
                }
            }
        }
    }

    /// Asks the other servers for `room`; the answer comes back on the queue.
    fn find_room(&self, room: RoomId) {
        let others: Vec<String> = self
            .urls
            .iter()
            .filter(|u| Some(*u) != self.current_url.as_ref())
            .cloned()
            .collect();
        let tx = self.queue_tx.clone();
        tokio::spawn(async move {
            let found = if others.is_empty() {
                None
            } else {
                rtc_signaling::find_room(others, room, FIND_ROOM_WAIT).await
            };
            let _ = tx.send(Msg::RoomFound(room, found));
        });
    }

    fn broadcast(&self, envelope: &Envelope) {
        for peer in self.room.members().keys() {
            self.peers.send(peer, envelope);
        }
    }

    fn publish_room(&self) {
        let snapshot = Snapshot {
            phase: self.room.phase().clone(),
            me: self.room.identity().peer_id.clone(),
            username: self.room.identity().username.clone(),
            host: self.room.host().cloned(),
            members: self
                .room
                .members()
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            muted: self.room.muted(),
            deafened: self.room.deafened(),
            speaking: self.room.speaking(),
            online: self.online,
            server: self.server,
            real_audio: self.voice.is_device(),
        };
        let _ = self.updates.send(Update::Room(snapshot));
    }
}
