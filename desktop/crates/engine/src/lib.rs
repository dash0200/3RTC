//! The imperative shell around [`rtc_core::Room`]: one task that owns the room, the signaling
//! socket, our voice and every peer connection.
//!
//! Everything that happens — a UI command, a server message, a libwebrtc callback, a timer tick —
//! becomes one message on one queue, handled in order. The room logic decides; this crate only
//! carries out its [`Effect`]s. Nothing here blocks the UI thread.

#![deny(missing_docs)]

mod images;
mod peers;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rtc_core::{Command, Effect, Identity, Input, Room};
use rtc_protocol::peer::{Envelope, PeerMessage};
use rtc_protocol::{ClientId, PeerId, RoomId};
use rtc_signaling::Event as SignalingEvent;
use rtc_webrtc::factory::Factory;
use rtc_webrtc::stats::Speaking;
use rtc_webrtc::voice::Voice;
use tokio::sync::mpsc;

pub use rtc_core::{ChatImage, ChatLine, Member, Phase, Reaction, Sound, UiEvent};
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
    /// The server's proof that we host the room, to get it back after a restart.
    pub host_token: Option<String>,
    /// Only the host controls playback.
    pub playback_lock: bool,
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
    /// Show a floating reaction.
    Reaction(Reaction),
    /// Play a soundboard clip.
    Sound(Sound),
    /// A chat picture is this far along (either way), in percent.
    ImageProgress {
        /// Its transfer.
        transfer_id: String,
        /// 0–100.
        percent: u8,
    },
    /// The connection details for everyone (answer to [`Handle::net_stats`]).
    Net(Vec<NetPeer>),
    /// A chat picture arrived whole.
    ImageReady {
        /// Its transfer.
        transfer_id: String,
        /// The file's bytes.
        bytes: Arc<[u8]>,
    },
}

/// One connection, for the connection details.
#[derive(Debug, Clone, PartialEq)]
pub struct NetPeer {
    /// Whose.
    pub peer: PeerId,
    /// What libwebrtc says about it.
    pub net: rtc_webrtc::stats::Net,
    /// Received since the last report, KB/s.
    pub down_kbps: f64,
    /// Sent since the last report, KB/s.
    pub up_kbps: f64,
}

/// A chat picture to send (see [`Handle::send_image`]).
#[derive(Debug, Clone)]
pub struct OutgoingImage {
    /// The chat message's id.
    pub id: String,
    /// The transfer's id.
    pub transfer_id: String,
    /// The file name shown.
    pub file_name: String,
    /// `image/png`, …
    pub mime: String,
    /// The file.
    pub bytes: Arc<[u8]>,
    /// Text sent with it.
    pub caption: String,
}

/// What the UI can ask.
#[derive(Debug)]
enum Request {
    Room(Command),
    Devices,
    Input(String),
    Output(String),
    RestartAudio,
    /// Keep the sound card open outside a room (voice settings: meter and test sound).
    AudioOpen(bool),
    Volume(PeerId, f32),
    TestSound,
    Isolation(bool),
    SendImage(OutgoingImage),
    NetStats,
    /// A sound of our own (`replace`: stop the last one with the same flag first).
    PlaySamples {
        samples: Arc<[f32]>,
        gain: f32,
        replace: bool,
    },
}

/// Sends commands to the engine. Dropping every clone stops it.
#[derive(Debug, Clone)]
pub struct Handle {
    tx: mpsc::UnboundedSender<Request>,
    /// Reads the microphone's level (our own audio path).
    meter: Option<rtc_webrtc::rtc_audio::Meter>,
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

    /// Starts the microphone and speakers again, on the chosen or the default devices.
    pub fn restart_audio(&self) {
        let _ = self.tx.send(Request::RestartAudio);
    }

    /// Keeps the microphone and speakers open outside a room (voice settings) or not.
    pub fn audio_open(&self, on: bool) {
        let _ = self.tx.send(Request::AudioOpen(on));
    }

    /// This person's volume for you (0 = muted for you, 1 = as sent, up to 2).
    pub fn set_volume(&self, peer: PeerId, gain: f32) {
        let _ = self.tx.send(Request::Volume(peer, gain));
    }

    /// Plays the test sound.
    pub fn test_sound(&self) {
        let _ = self.tx.send(Request::TestSound);
    }

    /// Noise removal (RNNoise) on the microphone on or off.
    pub fn set_isolation(&self, on: bool) {
        let _ = self.tx.send(Request::Isolation(on));
    }

    /// The microphone's level after cleaning (0..1), for the meter; `None` without our own
    /// audio path.
    #[must_use]
    pub fn mic_level(&self) -> Option<f32> {
        self.meter.as_ref().map(rtc_webrtc::rtc_audio::Meter::level)
    }

    /// Sends a chat picture to everyone (on the bulk channels, as the web app does). The chat
    /// line comes back as [`Update::Chat`], progress as [`Update::ImageProgress`].
    pub fn send_image(&self, image: OutgoingImage) {
        let _ = self.tx.send(Request::SendImage(image));
    }

    /// Plays 48 kHz mono samples through our mixer (our own audio path only) at `gain`; with
    /// `replace`, the last sound played with `replace` stops first (the soundboard's behaviour).
    pub fn play_samples(&self, samples: Arc<[f32]>, gain: f32, replace: bool) {
        let _ = self.tx.send(Request::PlaySamples {
            samples,
            gain,
            replace,
        });
    }

    /// Low-power mode: connections are checked half as often.
    pub fn set_low_power(&self, on: bool) {
        peers::LOW_POWER.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /// Asks for the connection details (answered with [`Update::Net`]).
    pub fn net_stats(&self) {
        let _ = self.tx.send(Request::NetStats);
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
    /// A picture we send is this far along.
    ImageSending(String, u8),
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
    let meter = voice.meter();
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
        audio_wanted: false,
        mixer_ticks: 0,
        audio_open: false,
        audio_restarted_at: 0.0,
        images: images::Receiver::default(),
        net_before: HashMap::new(),
        outgoing: HashMap::new(),
        sending: Vec::new(),
    };
    if config.mic == MicSource::Device && !engine.voice.is_device() {
        let _ = engine.updates.send(Update::Notice(NO_SOUND_CARD.to_owned()));
    }
    tokio::spawn(engine.run(queue, ui_rx));
    (Handle { tx: ui_tx, meter }, updates)
}

/// Shown when the audio device changed under us and voice was restarted on the new one.
const DEVICE_CHANGED: &str = "🎧 Audio device changed: voice moved to the new one";
/// Least time between two audio restarts (ms).
const AUDIO_RESTART_GAP_MS: f64 = 2000.0;

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
    /// Voice settings want the sound card open outside a room.
    audio_wanted: bool,
    /// Ticks in a room (the mixer line goes to the log every 10).
    mixer_ticks: u32,
    /// The sound card is open now.
    audio_open: bool,
    /// When the sound card was last restarted after a device change (ms since epoch).
    audio_restarted_at: f64,
    /// Chat pictures on their way in.
    images: images::Receiver,
    /// Our pictures waiting for their announcement to go out, by transfer id.
    outgoing: HashMap<String, Arc<[u8]>>,
    /// Our pictures being sent.
    sending: Vec<tokio::task::JoinHandle<()>>,
    /// Each connection's last details and when (for the data rates).
    net_before: HashMap<PeerId, (rtc_webrtc::stats::Net, f64)>,
}

/// Pause sending picture frames while a channel holds more than this (as the web app).
const BULK_HIGH_WATER: u64 = 256 * 1024;

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
                    self.recover_audio();
                    self.log_mixer();
                    let now = now_ms();
                    self.images.clean(now);
                    self.sending.retain(|t| !t.is_finished());
                    let fx = self.room.update(Input::Tick, now);
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

    /// Every 5 s in a room with our own audio path: how loud each person is in our mixer (the
    /// step before the speakers), and the microphone after cleaning.
    fn log_mixer(&mut self) {
        if !self.voice.is_pipeline() || !matches!(self.room.phase(), Phase::InRoom(_)) {
            return;
        }
        self.mixer_ticks += 1;
        if self.mixer_ticks % 10 != 6 {
            return;
        }
        let people: Vec<String> = self
            .room
            .members()
            .keys()
            .map(|p| {
                self.voice
                    .level(p.as_str())
                    .map_or_else(|| format!("{p}: not playing"), |l| format!("{p}: level {l:.3}"))
            })
            .collect();
        tracing::info!(
            "audio: mixing {}; microphone after cleaning: level {:.3}",
            people.join(", "),
            self.voice.mic_level()
        );
    }

    /// The sound card stopped (headset plugged in or out, default device changed): start it
    /// again on the new device. At most every 2 s, in case the device is still settling.
    fn recover_audio(&mut self) {
        let now = now_ms();
        if now - self.audio_restarted_at < AUDIO_RESTART_GAP_MS || !rtc_webrtc::native_log::take_device_lost()
        {
            return;
        }
        self.audio_restarted_at = now;
        self.voice.restart();
        let _ = self.updates.send(Update::Notice(DEVICE_CHANGED.to_owned()));
        let _ = self.updates.send(Update::Devices(self.voice.devices()));
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
            Msg::Ui(Request::RestartAudio) => {
                self.voice.restart();
                return;
            }
            Msg::Ui(Request::AudioOpen(on)) => {
                self.audio_wanted = on;
                self.update_audio_open();
                return;
            }
            Msg::Ui(Request::Volume(peer, gain)) => {
                self.voice.set_volume(peer.as_str(), gain);
                return;
            }
            Msg::Ui(Request::TestSound) => {
                self.voice.play_test_sound();
                return;
            }
            Msg::Ui(Request::Isolation(on)) => {
                self.voice.set_isolation(on);
                return;
            }
            Msg::Ui(Request::PlaySamples {
                samples,
                gain,
                replace,
            }) => {
                self.voice.play_samples(samples, gain, replace);
                return;
            }
            Msg::Ui(Request::NetStats) => {
                self.net_stats(now).await;
                return;
            }
            Msg::Ui(Request::SendImage(image)) => {
                self.send_image(image).await;
                return;
            }
            Msg::ImageSending(transfer_id, percent) => {
                let _ = self.updates.send(Update::ImageProgress { transfer_id, percent });
                return;
            }
            Msg::Peer(PeerEvent::Binary {
                peer,
                generation,
                data,
            }) => {
                if !self.peers.is_current(&peer, generation) || !self.room.members().contains_key(&peer) {
                    return;
                }
                match self.images.frame(&data) {
                    Some(images::Got::Progress { transfer_id, percent }) => {
                        let _ = self.updates.send(Update::ImageProgress { transfer_id, percent });
                    }
                    Some(images::Got::Done { transfer_id, bytes }) => {
                        let _ = self.updates.send(Update::ImageReady {
                            transfer_id,
                            bytes: bytes.into(),
                        });
                    }
                    None => {}
                }
                return;
            }
            Msg::Peer(PeerEvent::RemoteAudio {
                peer,
                generation,
                track,
            }) => {
                if self.peers.is_current(&peer, generation) {
                    self.voice.add_remote(peer.as_str(), track);
                }
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
        if let Input::Peer {
            from,
            envelope:
                Envelope {
                    message:
                        PeerMessage::P2pImageStart {
                            transfer_id,
                            total_chunks,
                            ..
                        },
                    ..
                },
        } = &input
            && self.room.members().contains_key(from)
        {
            self.images.start(transfer_id, *total_chunks, now);
        }
        let fx = self.room.update(input, now);
        self.apply(fx).await;
    }

    /// Everyone's connection details, with data rates since the last time.
    async fn net_stats(&mut self, now: f64) {
        let peers: Vec<PeerId> = self.room.members().keys().cloned().collect();
        let mut out = Vec::new();
        for peer in peers {
            let Some(report) = self.peers.stats(&peer).await else {
                continue;
            };
            let net = rtc_webrtc::stats::net(&report);
            let (down_kbps, up_kbps) = match self.net_before.get(&peer) {
                Some((before, at)) => {
                    let secs = ((now - at) / 1000.0).max(0.1);
                    #[allow(clippy::cast_precision_loss)]
                    let rate =
                        |a: u64, b: u64| ((a.saturating_sub(b) as f64 / 1024.0 / secs) * 10.0).round() / 10.0;
                    (
                        rate(net.bytes_received, before.bytes_received),
                        rate(net.bytes_sent, before.bytes_sent),
                    )
                }
                None => (0.0, 0.0),
            };
            self.net_before.insert(peer.clone(), (net.clone(), now));
            out.push(NetPeer {
                peer,
                net,
                down_kbps,
                up_kbps,
            });
        }
        self.net_before.retain(|p, _| self.room.members().contains_key(p));
        let _ = self.updates.send(Update::Net(out));
    }

    /// Starts sending one of our pictures: the room logic adds the chat line and announces it;
    /// the frames follow from [`Effect::BroadcastBulk`].
    async fn send_image(&mut self, image: OutgoingImage) {
        if image.bytes.len() > rtc_protocol::image::MAX_SEND_BYTES {
            let _ = self.updates.send(Update::Notice(
                "Image exceeds 15 MB limit. Please select a smaller file.".to_owned(),
            ));
            return;
        }
        if self.peers.bulk_channels(self.room.members().keys()).is_empty() {
            let _ = self.updates.send(Update::Notice(
                "Waiting for peer to connect before sending image".to_owned(),
            ));
            return;
        }
        self.outgoing
            .insert(image.transfer_id.clone(), Arc::clone(&image.bytes));
        let command = Command::ImageSent {
            id: image.id,
            image: ChatImage {
                transfer_id: image.transfer_id.clone(),
                file_name: image.file_name,
                file_size: image.bytes.len() as u64,
                mime: rtc_protocol::image::clean_mime(&image.mime).to_owned(),
            },
            caption: image.caption,
        };
        let fx = self.room.update(Input::Command(command), now_ms());
        self.apply(fx).await;
        // not sent (not in a room): nothing to keep
        self.outgoing.remove(&image.transfer_id);
    }

    /// Sends a picture's announcement, then its frames, on every open bulk channel, waiting
    /// whenever a channel is backed up.
    fn send_frames(&mut self, envelope: &Envelope) {
        let PeerMessage::P2pImageStart { transfer_id, .. } = &envelope.message else {
            return;
        };
        let Some(bytes) = self.outgoing.remove(transfer_id) else {
            return;
        };
        let channels = self.peers.bulk_channels(self.room.members().keys());
        let Ok(start) = envelope.to_json() else { return };
        for dc in &channels {
            if let Err(e) = dc.send(start.as_bytes(), false) {
                tracing::debug!("picture announcement: {e:?}");
            }
        }
        let transfer_id = transfer_id.clone();
        let progress = self.queue_tx.clone();
        self.sending.push(tokio::spawn(async move {
            use rtc_protocol::image::{CHUNK, pack};
            use rtc_webrtc::libwebrtc::data_channel::DataChannelState;
            let pieces: Vec<&[u8]> = if bytes.is_empty() {
                vec![&[]]
            } else {
                bytes.chunks(CHUNK).collect()
            };
            let total = u32::try_from(pieces.len()).unwrap_or(u32::MAX);
            let mut last = 0u8;
            for (i, piece) in pieces.iter().enumerate() {
                loop {
                    let open: Vec<_> = channels
                        .iter()
                        .filter(|dc| dc.state() == DataChannelState::Open)
                        .collect();
                    if open.is_empty() {
                        tracing::info!(
                            "❌ Image transfer failed: All peer connections dropped during image transfer"
                        );
                        return;
                    }
                    if open.iter().all(|dc| dc.buffered_amount() <= BULK_HIGH_WATER) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                let index = u32::try_from(i).unwrap_or(u32::MAX);
                let frame = pack(&transfer_id, index, total, piece);
                for dc in &channels {
                    if dc.state() == DataChannelState::Open {
                        let _ = dc.send(&frame, true);
                    }
                }
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    clippy::cast_precision_loss
                )]
                let percent = ((f64::from(index + 1) / f64::from(total)) * 100.0)
                    .round()
                    .min(100.0) as u8;
                if percent != last {
                    last = percent;
                    let _ = progress.send(Msg::ImageSending(transfer_id.clone(), percent));
                }
                tokio::task::yield_now().await;
            }
        }));
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
                    self.voice.remove_remote(peer.as_str());
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
                Effect::Ui(UiEvent::Changed) => {
                    if *self.room.phase() == Phase::Idle {
                        // left: pictures half-way in or out are dropped
                        self.images.reset();
                        self.outgoing.clear();
                        for t in self.sending.drain(..) {
                            t.abort();
                        }
                    }
                    self.update_audio_open();
                    self.publish_room();
                }
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
                Effect::Ui(UiEvent::Reaction(r)) => {
                    let _ = self.updates.send(Update::Reaction(r));
                }
                Effect::Ui(UiEvent::Sound(s)) => {
                    let _ = self.updates.send(Update::Sound(s));
                }
                Effect::BroadcastBulk(envelope) => self.send_frames(&envelope),
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

    /// The sound card is open in a room, and while voice settings want it.
    fn update_audio_open(&mut self) {
        let open = self.audio_wanted || matches!(self.room.phase(), Phase::InRoom(_));
        if open != self.audio_open {
            self.audio_open = open;
            self.voice.set_active(open);
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
            host_token: self.room.host_token().map(str::to_owned),
            playback_lock: self.room.playback_lock(),
        };
        let _ = self.updates.send(Update::Room(snapshot));
    }
}
