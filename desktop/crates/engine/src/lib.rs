//! The imperative shell around [`rtc_core::Room`]: one task that owns the room, the signaling
//! socket and every peer connection.
//!
//! Everything that happens — a UI command, a server message, a libwebrtc callback — becomes
//! one message on one queue, handled in order. The room logic decides; this crate only carries
//! out its [`Effect`]s. Nothing here blocks the UI thread.

#![deny(missing_docs)]

mod peers;

use std::time::{SystemTime, UNIX_EPOCH};

use rtc_core::{Command, Effect, Identity, Input, Room};
use rtc_protocol::peer::Envelope;
use rtc_protocol::{ClientId, PeerId};
use rtc_signaling::Event as SignalingEvent;
use rtc_webrtc::factory::Factory;
use tokio::sync::mpsc;

pub use rtc_core::{ChatLine, Member, Phase, UiEvent};
pub use rtc_webrtc::factory::IceServerConfig;

use crate::peers::{PeerEvent, Peers};

/// What the engine needs to start.
#[derive(Debug, Clone)]
pub struct Config {
    /// The signaling server, `wss://…`.
    pub signaling_url: String,
    /// The display name.
    pub username: String,
    /// This install's stable id.
    pub client_id: ClientId,
    /// The app's build, `YYMMDD.HHMM`.
    pub build: String,
    /// STUN/TURN servers.
    pub ice: Vec<IceServerConfig>,
}

/// What the UI draws from: a copy of the room after each change.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// Where we are.
    pub phase: Phase,
    /// Our peer id.
    pub me: PeerId,
    /// Who hosts.
    pub host: Option<PeerId>,
    /// Everyone else.
    pub members: Vec<(PeerId, Member)>,
    /// Our mic is muted.
    pub muted: bool,
    /// The signaling server is reachable.
    pub online: bool,
}

/// What the engine tells the UI.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    /// The room changed: redraw from this.
    Room(Snapshot),
    /// A chat line arrived (or was sent).
    Chat(ChatLine),
    /// A short notice to show.
    Notice(String),
}

/// Sends commands to the engine. Dropping it stops the engine.
#[derive(Debug, Clone)]
pub struct Handle {
    tx: mpsc::UnboundedSender<Msg>,
}

impl Handle {
    /// Asks the engine to do something.
    pub fn command(&self, c: Command) {
        let _ = self.tx.send(Msg::Command(c));
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
    Command(Command),
    Signaling(SignalingEvent),
    Peer(PeerEvent),
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
    let (tx, rx) = mpsc::unbounded_channel();
    let (updates_tx, updates) = mpsc::unbounded_channel();
    let me = Identity {
        peer_id: new_peer_id(),
        client_id: config.client_id,
        username: config.username,
        build: config.build,
    };
    let (signaling, mut signaling_events) =
        rtc_signaling::spawn(rtc_signaling::Config::new(config.signaling_url));
    // forward the socket's events onto the one queue
    let forward = tx.clone();
    tokio::spawn(async move {
        while let Some(e) = signaling_events.recv().await {
            if forward.send(Msg::Signaling(e)).is_err() {
                break;
            }
        }
    });
    let peer_tx = tx.clone();
    let peers = Peers::new(Factory::new(config.ice), signaling.clone(), move |e| {
        let _ = peer_tx.send(Msg::Peer(e));
    });
    let engine = Engine {
        room: Room::new(me),
        signaling,
        peers,
        updates: updates_tx,
        online: false,
    };
    // the queue's own sender is kept by the peer callbacks; stop when the UI's handle goes
    let (ui_tx, ui_rx) = mpsc::unbounded_channel();
    tokio::spawn(engine.run(rx, ui_rx));
    (
        Handle {
            tx: ui_tx_bridge(ui_tx, tx),
        },
        updates,
    )
}

/// The UI's sender: commands go straight onto the queue. A separate channel tells the engine
/// when the UI has gone (every UI handle dropped), since the peer callbacks hold queue senders too.
fn ui_tx_bridge(
    ui_alive: mpsc::UnboundedSender<()>,
    queue: mpsc::UnboundedSender<Msg>,
) -> mpsc::UnboundedSender<Msg> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
    tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if queue.send(m).is_err() {
                break;
            }
        }
        drop(ui_alive);
    });
    tx
}

struct Engine {
    room: Room,
    signaling: rtc_signaling::Handle,
    peers: Peers,
    updates: mpsc::UnboundedSender<Update>,
    online: bool,
}

impl Engine {
    async fn run(
        mut self,
        mut queue: mpsc::UnboundedReceiver<Msg>,
        mut ui_alive: mpsc::UnboundedReceiver<()>,
    ) {
        loop {
            let msg = tokio::select! {
                m = queue.recv() => m,
                _ = ui_alive.recv() => None,
            };
            let Some(msg) = msg else { break };
            self.handle(msg).await;
        }
        let fx = self.room.update(Input::Command(Command::Leave), now_ms());
        self.apply(fx).await;
        self.peers.close_all();
    }

    async fn handle(&mut self, msg: Msg) {
        let input = match msg {
            Msg::Command(c) => Input::Command(c),
            Msg::Signaling(SignalingEvent::Up) => {
                self.online = true;
                self.publish_room();
                Input::SignalingUp
            }
            Msg::Signaling(SignalingEvent::Down) => {
                self.online = false;
                self.publish_room();
                Input::SignalingDown
            }
            Msg::Signaling(SignalingEvent::Message(m)) => Input::Server(m),
            Msg::Peer(e) => match self.peers.on_event(e) {
                Some(input) => input,
                None => return,
            },
        };
        let fx = self.room.update(input, now_ms());
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
                Effect::ClosePeer(peer) => self.peers.close(&peer),
                Effect::SendToPeer { peer, envelope } => self.peers.send(&peer, &envelope),
                Effect::Broadcast(envelope) => self.broadcast(&envelope),
                Effect::Ui(UiEvent::Changed) => self.publish_room(),
                Effect::Ui(UiEvent::Chat(line)) => {
                    let _ = self.updates.send(Update::Chat(line));
                }
                Effect::Ui(UiEvent::Notice(n)) => {
                    let _ = self.updates.send(Update::Notice(n));
                }
            }
        }
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
            host: self.room.host().cloned(),
            members: self
                .room
                .members()
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            muted: self.room.muted(),
            online: self.online,
        };
        let _ = self.updates.send(Update::Room(snapshot));
    }
}
