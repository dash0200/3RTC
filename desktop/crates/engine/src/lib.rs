//! The imperative shell around [`rtc_core::Room`]: one task that owns the room, the signaling
//! socket, our voice and every peer connection.
//!
//! Everything that happens — a UI command, a server message, a libwebrtc callback, a timer tick —
//! becomes one message on one queue, handled in order. The room logic decides; this crate only
//! carries out its [`Effect`]s. Nothing here blocks the UI thread.

#![deny(missing_docs)]

mod camera;
mod control;
mod files;
mod images;
mod log_kind;
mod peers;
// QUIC file transfer between desktop apps (ADR 0009): the transport, and the chat's use of it
mod outgoing;
#[allow(dead_code)]
mod quic;
mod quic_flow;
mod screen;
mod stream;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rtc_core::{Command, Effect, Identity, Input, Room};
use rtc_protocol::peer::Envelope;
use rtc_protocol::{ClientId, PeerId, RoomId};
use rtc_signaling::Event as SignalingEvent;
use rtc_webrtc::factory::Factory;
use rtc_webrtc::stats::Speaking;
use rtc_webrtc::voice::Voice;
use tokio::sync::mpsc;

pub use camera::CameraChoice;
pub use control::{ControlCmd, ControlView};
pub use rtc_core::{ChatImage, ChatLine, Member, Phase, Reaction, Sound, UiEvent};
pub use rtc_platform_win::CameraInfo;
pub use rtc_protocol::stream::{InputKind, ScreenInput};
pub use rtc_webrtc::factory::IceServerConfig;
pub use rtc_webrtc::voice::{Device, Devices, MicSource};
pub use screen::{ScreenFeed, ScreenFrame, ScreenOptions, ScreenSource, ScreenStats, screen_sources};
pub use stream::{ShareFileSpec, StreamProgress, StreamReader};

use crate::peers::{PeerEvent, Peers};
use rtc_webrtc::libwebrtc::peer_connection_factory::native::PeerConnectionFactoryExt as _;
use rtc_webrtc::libwebrtc::rtp_sender::VideoEncoderBackend;

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
    /// Our lasting app id (games give a seat back by it).
    pub client_id: String,
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
    /// Room network topology ("mesh" or "hub").
    pub topology: String,
    /// Configured maximum room peer capacity.
    pub max_users: u32,
    /// The watch party: what's playing, the queue, skip votes.
    pub watch: rtc_core::WatchView,
    /// The open activity (a game), if any.
    pub activity: Option<rtc_core::ActivityView>,
    /// The shared states of the activity loaded here (`act:<id>`, …).
    pub stores: Vec<(String, rtc_core::StoreView)>,
    /// The development example games are listed.
    pub dev_activities: bool,
}

/// What the engine tells the UI.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // rare, and the room snapshot is the one that matters
pub enum Update {
    /// The room changed: redraw from this.
    Room(Snapshot),
    /// A chat message arrived (or was sent).
    Chat(ChatLine),
    /// A line for the Logs tab.
    Log(String),
    /// The full log of why a connection to someone failed (the Logs tab offers to copy it).
    ConnectionLog(String),
    /// A toast; before a room exists, why a join failed.
    Notice(String),
    /// The microphones and speakers on this PC.
    Devices(Devices),
    /// Show a floating reaction.
    Reaction(Reaction),
    /// Play a soundboard clip.
    Sound(Sound),
    /// A whiteboard message from someone (`wb-live` when `live`, else `wb-cursor`), as sent.
    Board {
        /// Who.
        from: rtc_protocol::PeerId,
        /// A stroke being drawn (else a pointer).
        live: bool,
        /// The message's fields.
        body: serde_json::Value,
    },
    /// A chat picture is this far along (either way), in percent.
    ImageProgress {
        /// Its transfer.
        transfer_id: String,
        /// 0–100.
        percent: u8,
    },
    /// The connection details for everyone (answer to [`Handle::net_stats`]).
    Net(Vec<NetPeer>),
    /// Tell the player (the web view) what to do.
    Player(rtc_core::PlayerCmd),
    /// The queue moved on: play the pop.
    Pop,
    /// A video stream we asked for started: open the player on `reader`.
    StreamReady {
        /// The file's name.
        name: String,
        /// Its size in bytes.
        size: u64,
        /// What the player reads.
        reader: StreamReader,
    },
    /// The video stream we watch stopped (why).
    StreamEnded(String),
    /// How the video stream we watch is doing (twice a second).
    StreamProgress(StreamProgress),
    /// What's in the video file someone shares ("MKV · HEVC (H.265) · AAC").
    FileFormat {
        /// The file.
        name: String,
        /// One line.
        description: String,
    },
    /// Viewers who can't play our file properly (empty: none).
    FileProblems(Vec<String>),
    /// A screen share started or stopped.
    Screen {
        /// Who shares (`None`: nobody).
        sharer: Option<String>,
        /// It's us.
        mine: bool,
        /// Its pictures (ours: the preview).
        feed: Option<ScreenFeed>,
    },
    /// A laser pointer over the shared screen (0–1), or gone (`active` false).
    ScreenPointer {
        /// Whose.
        peer: String,
        /// Their name.
        name: String,
        /// Across.
        x: f64,
        /// Down.
        y: f64,
        /// Still there.
        active: bool,
    },
    /// A click on the shared screen.
    ScreenPing {
        /// Whose name.
        name: String,
        /// Across.
        x: f64,
        /// Down.
        y: f64,
    },
    /// Sharing our screen failed (why).
    ScreenError(String),
    /// How our screen goes out: the GPU encoder (if it's used) and each viewer's picture.
    ScreenSending {
        /// "NVIDIA H.264 Encoder MFT", when at least one viewer is encoded by the GPU.
        encoder: Option<String>,
        /// Each viewer.
        viewers: Vec<ScreenViewer>,
    },
    /// Remote control of the shared screen changed (asked, offered, who controls).
    Control(ControlView),
    /// A chat file (or folder) was cancelled (by us, by its sender, or because nobody was
    /// receiving it): nothing more of it comes or goes.
    TransferCancelled {
        /// Its transfer (or folder).
        transfer_id: String,
    },
    /// Where our big file (or folder file) is with its receivers: waiting to accept, being
    /// sent, sent. Nobody waiting or being sent to: it's over.
    SendState {
        /// Its transfer.
        transfer_id: String,
        /// The counts.
        status: rtc_core::transfers::SendStatus,
    },
    /// Files of a folder offered to us that are already in Downloads (whole or in part).
    FolderHere {
        /// The folder.
        folder_id: String,
        /// Transfer id and what's there.
        files: Vec<(String, FileHere)>,
    },
    /// A chat picture arrived whole.
    ImageReady {
        /// Its transfer.
        transfer_id: String,
        /// The file's bytes.
        bytes: Arc<[u8]>,
    },
    /// Cameras (ADR 0010): ours and everyone's whose camera is on and whose picture is here.
    Cameras(CameraView),
    /// The cameras on this PC (answer to [`Handle::list_cameras`]).
    CameraDevices(Vec<CameraInfo>),
    /// A chat file arrived over QUIC and is saved here (ADR 0009).
    FileSaved {
        /// Its transfer.
        transfer_id: String,
        /// Where it is (in Downloads).
        path: std::path::PathBuf,
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
    /// Where it is on disk, when it was picked from a file: big files go to other desktop apps
    /// over QUIC from there (ADR 0009).
    pub path: Option<std::path::PathBuf>,
    /// Set (with `path`) when the file wasn't read into `bytes`: it's sent from disk, read as it
    /// goes (big files, folders). Its size.
    pub disk_size: Option<u64>,
    /// In a folder being sent: its path inside it (`Photos/2026/a.jpg`), so other desktop apps
    /// put it in the same place.
    pub relative_path: Option<String>,
}

/// A folder to offer in chat (see [`Handle::send_folder`]).
#[derive(Debug, Clone)]
pub struct OutgoingFolder {
    /// The chat message's id.
    pub id: String,
    /// The folder's id.
    pub folder_id: String,
    /// Its name.
    pub name: String,
    /// Text sent with it.
    pub caption: String,
    /// Its files (each with `path`, `disk_size` and `relative_path`, the folder's name first).
    pub files: Vec<OutgoingImage>,
}

/// A file of a folder offered to us that's already in Downloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileHere {
    /// All of it (same size), here.
    Whole(std::path::PathBuf),
    /// Part of it (an earlier download stopped): accepting resumes it.
    Partly,
}

/// The cameras to show (ADR 0010).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CameraView {
    /// Our camera is on (its pictures go out).
    pub on: bool,
    /// Our camera is being opened.
    pub starting: bool,
    /// Our own tile's pictures (already mirrored), while on.
    pub mine: Option<ScreenFeed>,
    /// Everyone else's, in the order they turned them on: (who, their pictures). Only once their
    /// status says on and their picture is here.
    pub remote: Vec<(PeerId, ScreenFeed)>,
}

/// One viewer of our screen share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenViewer {
    /// Their name.
    pub name: String,
    /// The picture's height they get.
    pub height: u32,
    /// Encoded by our GPU (else by libwebrtc in software).
    pub hardware: bool,
    /// On the web app.
    pub web: bool,
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
    /// Offer a folder: everyone picks the files they want.
    SendFolder(OutgoingFolder),
    /// Cancel a chat file or folder: ours (stop sending it) or one offered or coming in.
    CancelTransfer(String),
    /// Accept a big file (or a folder's file) offered to us.
    AcceptTransfer(String),
    NetStats,
    /// Offer this file to viewers who ask; `None`: stop.
    ShareFile(Option<ShareFileSpec>),
    /// Ask the room for the file playing (by name).
    StreamFrom(String),
    /// Stop watching a stream.
    StopStream,
    /// Share this screen or window (`None`: stop).
    ShareScreen(Option<ScreenSource>),
    /// How we share (now and from now on).
    ScreenOptions(ScreenOptions),
    /// The tallest picture we want of someone else's screen (0: as sent).
    ScreenQuality(u32),
    ScreenVolume(f32),
    /// Our laser pointer over the shared screen (0–1; `None`: it left).
    ScreenPointer(Option<(f64, f64)>),
    /// A click on the shared screen.
    ScreenPing(f64, f64),
    /// Remote control of the shared screen.
    Control(ControlCmd),
    /// Turn our camera on with this camera (or switch to it), or off (`None`).
    Camera(Option<CameraChoice>),
    /// List the cameras on this PC.
    CameraDevices,
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
    /// Feeds one program's sound into the call (our own audio path).
    app: Option<rtc_webrtc::rtc_audio::AppFeed>,
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

    /// Offers a folder in chat: each receiver picks the files they want (other desktop apps
    /// save them in the folder's layout under Downloads).
    pub fn send_folder(&self, folder: OutgoingFolder) {
        let _ = self.tx.send(Request::SendFolder(folder));
    }

    /// Accepts a big file (or a folder's file) offered to us: its sender starts sending it.
    pub fn accept_transfer(&self, transfer_id: String) {
        let _ = self.tx.send(Request::AcceptTransfer(transfer_id));
    }

    /// Cancels a chat file on its way: ours stops going to everyone (a folder id: all its
    /// files); one offered or coming in is declined or stops coming. [`Update::TransferCancelled`]
    /// follows.
    pub fn cancel_transfer(&self, transfer_id: String) {
        let _ = self.tx.send(Request::CancelTransfer(transfer_id));
    }

    /// Offers the video file playing here to viewers who don't have it (`None`: stops, and
    /// tells the ones watching).
    pub fn share_file(&self, file: Option<ShareFileSpec>) {
        let _ = self.tx.send(Request::ShareFile(file));
    }

    /// Asks whoever has the file `name` to stream it to us ([`Update::StreamReady`] follows).
    pub fn stream_from(&self, name: String) {
        let _ = self.tx.send(Request::StreamFrom(name));
    }

    /// Shares a screen or a window with the room (`None`: stops).
    pub fn share_screen(&self, what: Option<ScreenSource>) {
        let _ = self.tx.send(Request::ShareScreen(what));
    }

    /// How we share our screen: the tallest picture and frames a second (now, if sharing, and
    /// for the next share).
    pub fn screen_options(&self, options: ScreenOptions) {
        let _ = self.tx.send(Request::ScreenOptions(options));
    }

    /// The tallest picture we want of someone else's shared screen (0: as they send it). Desktop
    /// sharers send it that size; the web app ignores it.
    pub fn screen_quality(&self, max_height: u32) {
        let _ = self.tx.send(Request::ScreenQuality(max_height));
    }

    /// The volume of someone else's shared screen's sound (0 mutes it, 1 as sent, up to 2).
    pub fn screen_volume(&self, gain: f32) {
        let _ = self.tx.send(Request::ScreenVolume(gain));
    }

    /// Our laser pointer over the shared screen, 0–1 across and down (`None`: it left).
    pub fn screen_pointer(&self, at: Option<(f64, f64)>) {
        let _ = self.tx.send(Request::ScreenPointer(at));
    }

    /// Remote control of the shared screen: ask, answer, offer, take back, or (in control) an
    /// input (answered with [`Update::Control`]).
    pub fn control(&self, cmd: ControlCmd) {
        let _ = self.tx.send(Request::Control(cmd));
    }

    /// Turns our camera on with `choice` (or switches to it while on), or off (`None`). The
    /// result comes back as [`Update::Cameras`]; a camera that won't open, as a notice.
    pub fn camera(&self, choice: Option<CameraChoice>) {
        let _ = self.tx.send(Request::Camera(choice));
    }

    /// Asks for the cameras on this PC (answered with [`Update::CameraDevices`]).
    pub fn list_cameras(&self) {
        let _ = self.tx.send(Request::CameraDevices);
    }

    /// A click on the shared screen (everyone sees a ripple there).
    pub fn screen_ping(&self, x: f64, y: f64) {
        let _ = self.tx.send(Request::ScreenPing(x, y));
    }

    /// Stops watching the stream (tells its owner).
    pub fn stop_stream(&self) {
        let _ = self.tx.send(Request::StopStream);
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

    /// Where one program's sound goes to be sent with our voice (`None` without our own audio
    /// path).
    #[must_use]
    pub fn app_feed(&self) -> Option<rtc_webrtc::rtc_audio::AppFeed> {
        self.app.clone()
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
    /// A file we send is this far along (to one receiver, or to everyone: `None`).
    ImageSending(String, Option<PeerId>, u8),
    /// From the video-sharing module's other threads.
    Stream(stream::Back),
    /// The sharer took remote control back (from the control thread).
    TakeBack(rtc_platform_win::TakeBack),
    /// A QUIC file transfer's background task (ADR 0009).
    Quic(quic_flow::Event),
    /// A file's frames are all sent (or the sending stopped): who got it all, who didn't.
    FramesDone {
        transfer_id: String,
        ok: Vec<PeerId>,
        failed: Vec<PeerId>,
    },
    /// Files of a folder offered to us that are already in Downloads.
    FolderHere(String, Vec<(String, FileHere)>),
    /// Our camera's capture (which capture, by its number).
    Camera(u64, camera::Back),
}

/// A fresh peer id for this launch (the server ties seats to it).
fn new_peer_id() -> PeerId {
    // 16 hex digits always pass the id rules
    PeerId::new(format!("dk{:016x}", rand::random::<u64>())).unwrap_or_else(|_| unreachable!())
}

/// Whether a peer message's `type` passes `test` (checked on the parsed field, not the text: a
/// file name such as `screen-1.png` or a folder offer's paths must not decide where it goes).
fn type_is(text: &str, test: impl FnOnce(&str) -> bool) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("type").and_then(serde_json::Value::as_str).map(test))
        .unwrap_or(false)
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
    let screen_sound = rtc_webrtc::voice::ScreenSound::new(&factory);
    let screen_source = screen::new_source();
    let screen_track = rtc_webrtc::libwebrtc::media_stream_track::MediaStreamTrack::Video(
        factory
            .inner()
            .create_video_track("screen", screen_source.clone()),
    );
    let camera_source = camera::new_source();
    let camera_track = rtc_webrtc::libwebrtc::media_stream_track::MediaStreamTrack::Video(
        factory
            .inner()
            .create_video_track("camera", camera_source.clone()),
    );
    let meter = voice.meter();
    let app = voice.app_feed();
    let peer_tx = queue_tx.clone();
    let raw_track = screen_track.clone();
    let peers = Peers::new(
        factory,
        voice.track(),
        screen_track,
        camera_track,
        signaling.clone(),
        move |e| {
            let _ = peer_tx.send(Msg::Peer(e));
        },
    );
    // The UI's requests come through their own channel: when every UI handle is gone the engine
    // stops, even though libwebrtc's callbacks still hold senders to the queue.
    let (ui_tx, ui_rx) = mpsc::unbounded_channel();
    let want_tx = queue_tx.clone();
    let engine = Engine {
        room: {
            let mut r = Room::new(me);
            // the development example games, as the web app's development builds
            r.set_dev_activities(cfg!(debug_assertions) || std::env::var_os("RTC_DEV_ACTIVITIES").is_some());
            r
        },
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
        stream_ticks: 0,
        screen: ScreenState {
            source: screen_source,
            raw_track,
            options: ScreenOptions::default(),
            wanted: HashMap::new(),
            my_quality: 0,
            hw: HashMap::new(),
            applied: HashMap::new(),
            sending: None,
            sound: screen_sound,
            sound_on: None,
            shared: None,
            capture: None,
            tracks: HashMap::new(),
            sharer: None,
            watch: None,
        },
        camera: CameraState {
            source: camera_source,
            capture: None,
            number: 0,
            starting: false,
            size: None,
            preview: None,
            tracks: HashMap::new(),
            watches: HashMap::new(),
            applied: HashMap::new(),
            shown: None,
        },
        net_before: HashMap::new(),
        control: control::Control::default(),
        streams: stream::Streams::new(move |b| {
            let _ = want_tx.send(Msg::Stream(b));
        }),
        sending: Vec::new(),
        quic: quic_flow::QuicState::default(),
        files: files::Files::default(),
        transfers: rtc_core::transfers::Transfers::default(),
        stops: HashMap::new(),
    };
    if config.mic == MicSource::Device && !engine.voice.is_device() {
        let _ = engine.updates.send(Update::Notice(NO_SOUND_CARD.to_owned()));
    }
    tokio::spawn(engine.run(queue, ui_rx));
    (
        Handle {
            tx: ui_tx,
            meter,
            app,
        },
        updates,
    )
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
    /// Video files shared both ways.
    streams: stream::Streams,
    /// Ticks (stream progress goes to the UI on every other one).
    stream_ticks: u32,
    /// Screen sharing, both ways.
    screen: ScreenState,
    /// Cameras, both ways (ADR 0010).
    camera: CameraState,
    /// Chat files both ways (offers, accepts, folders).
    files: files::Files,
    /// Who still receives our files, and who sent the ones coming in (for cancels).
    transfers: rtc_core::transfers::Transfers,
    /// Our files on the bulk channels: what to stop sending, and to whom, by transfer id.
    stops: HashMap<String, Arc<outgoing::Stop>>,
    /// Our pictures being sent.
    sending: Vec<tokio::task::JoinHandle<()>>,
    /// Each connection's last details and when (for the data rates).
    net_before: HashMap<PeerId, (rtc_webrtc::stats::Net, f64)>,
    /// Remote control of the shared screen, both ways.
    control: control::Control,
    /// Chat files over QUIC with other desktop apps.
    quic: quic_flow::QuicState,
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
                    self.stream_ticks = self.stream_ticks.wrapping_add(1);
                    self.route_screen();
                    self.screen_sound_lines().await;
                    self.camera_lines().await;
                    self.route_camera();
                    let outs = self.streams.tick(true);
                    self.stream_out(outs);
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
            target: "rtc_engine::periodic",
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
            Msg::Ui(Request::SendFolder(folder)) => {
                self.send_folder(folder).await;
                return;
            }
            Msg::FramesDone {
                transfer_id,
                ok,
                failed,
            } => {
                self.frames_done(&transfer_id, &ok, &failed);
                return;
            }
            Msg::Ui(Request::CancelTransfer(transfer_id)) => {
                self.cancel_transfer(&transfer_id);
                return;
            }
            Msg::Ui(Request::AcceptTransfer(transfer_id)) => {
                self.accept_transfer(&transfer_id);
                return;
            }
            Msg::FolderHere(folder_id, files) => {
                let _ = self.updates.send(Update::FolderHere { folder_id, files });
                return;
            }
            Msg::Ui(Request::ShareFile(file)) => {
                let outs = self.streams.share(
                    file,
                    &EngineLinks {
                        peers: &self.peers,
                        room: &self.room,
                    },
                );
                self.stream_out(outs);
                return;
            }
            Msg::Ui(Request::StreamFrom(name)) => {
                let outs = self.streams.ask(
                    &name,
                    &EngineLinks {
                        peers: &self.peers,
                        room: &self.room,
                    },
                );
                self.stream_out(outs);
                return;
            }
            Msg::Ui(Request::ShareScreen(what)) => {
                self.share_screen(what);
                return;
            }
            Msg::Ui(Request::ScreenOptions(o)) => {
                self.screen.options = o;
                if let Some(c) = &self.screen.capture {
                    screen::lock_shared(&c.shared).options = o;
                }
                self.route_screen();
                return;
            }
            Msg::Ui(Request::ScreenVolume(g)) => {
                self.voice.set_screen_volume(g);
                return;
            }
            Msg::Ui(Request::ScreenQuality(h)) => {
                self.screen.my_quality = h;
                self.ask_quality();
                return;
            }
            Msg::Ui(Request::ScreenPointer(at)) => {
                let me = self.room.identity();
                let m = rtc_protocol::stream::ScreenMessage::Pointer {
                    peer_id: Some(me.peer_id.as_str().to_owned()),
                    x: at.map_or(0.0, |a| a.0),
                    y: at.map_or(0.0, |a| a.1),
                    username: Some(me.username.clone()),
                    active: at.is_some(),
                };
                self.screen_broadcast(&m);
                return;
            }
            Msg::Ui(Request::Control(cmd)) => {
                self.control_cmd(cmd);
                return;
            }
            Msg::TakeBack(why) => {
                self.take_back(why);
                return;
            }
            Msg::Ui(Request::Camera(choice)) => {
                self.camera_request(choice).await;
                return;
            }
            Msg::Ui(Request::CameraDevices) => {
                let tx = self.updates.clone();
                tokio::task::spawn_blocking(move || {
                    let _ = tx.send(Update::CameraDevices(rtc_platform_win::cameras()));
                });
                return;
            }
            Msg::Camera(number, back) => {
                self.camera_back(number, back).await;
                return;
            }
            Msg::Ui(Request::ScreenPing(x, y)) => {
                let me = self.room.identity();
                let m = rtc_protocol::stream::ScreenMessage::Ping {
                    id: format!("ping_{:x}", rand::random::<u64>()),
                    x,
                    y,
                    username: Some(me.username.clone()),
                    color: None,
                    peer_id: Some(me.peer_id.as_str().to_owned()),
                };
                self.screen_broadcast(&m);
                return;
            }
            Msg::Peer(PeerEvent::RemoteVideo {
                peer,
                generation,
                track,
                mid,
            }) => {
                if self.peers.is_current(&peer, generation)
                    && self.peers.is_camera_line(&peer, mid.as_deref())
                {
                    // their camera (the second video line), never the shared screen
                    self.camera.tracks.insert(peer.clone(), track);
                    self.camera.watches.remove(&peer);
                    self.publish_cameras();
                } else if self.peers.is_current(&peer, generation) {
                    self.screen.tracks.insert(peer.clone(), track);
                    if self.screen.sharer.as_ref().is_some_and(|(p, _)| *p == peer) {
                        self.watch_screen();
                    }
                }
                return;
            }
            Msg::Peer(PeerEvent::Message {
                peer,
                generation,
                text,
            }) if text.contains("\"screen-") && type_is(&text, |t| t.starts_with("screen-")) => {
                if !self.peers.is_current(&peer, generation) || !self.room.members().contains_key(&peer) {
                    return;
                }
                if let Some(m) = rtc_protocol::stream::ScreenMessage::from_json(&text) {
                    self.screen_message(&peer, m);
                }
                return;
            }
            Msg::Ui(Request::StopStream) => {
                let outs = self.streams.stop_view(&EngineLinks {
                    peers: &self.peers,
                    room: &self.room,
                });
                self.stream_out(outs);
                return;
            }
            Msg::Stream(stream::Back::Want(stream_no, block)) => {
                let outs = self.streams.want(stream_no, block);
                self.stream_out(outs);
                return;
            }
            Msg::Stream(stream::Back::Broadcast(m)) => {
                self.stream_out(vec![stream::Out::BroadcastFile(m)]);
                return;
            }
            Msg::Stream(stream::Back::Subtitles { name, vtt }) => {
                Input::Command(Command::Watch(rtc_core::WatchCommand::ShareSubtitles {
                    name,
                    vtt,
                }))
            }
            Msg::Peer(PeerEvent::Message {
                peer,
                generation,
                text,
            }) if (text.contains("\"file-format") || text.contains("\"file-subtitle-"))
                && type_is(&text, |t| {
                    t == "file-format" || t.starts_with("file-format-") || t.starts_with("file-subtitle-")
                }) =>
            {
                if !self.peers.is_current(&peer, generation) || !self.room.members().contains_key(&peer) {
                    return;
                }
                if let Some(m) = rtc_protocol::stream::FileMessage::from_json(&text) {
                    let outs = self.streams.file_message(
                        &peer,
                        m,
                        &EngineLinks {
                            peers: &self.peers,
                            room: &self.room,
                        },
                    );
                    self.stream_out(outs);
                }
                return;
            }
            Msg::Peer(PeerEvent::Message {
                peer,
                generation,
                text,
            }) if text.contains("\"p2p-")
                // the video stream's messages; chat files and folders go to the room logic
                && type_is(&text, |t| {
                    t.starts_with("p2p-")
                        && t != "p2p-image-start"
                        && t != "p2p-folder-offer"
                        && !t.starts_with("p2p-file-")
                }) =>
            {
                if !self.peers.is_current(&peer, generation) || !self.room.members().contains_key(&peer) {
                    return;
                }
                if let Some(m) = rtc_protocol::stream::StreamMessage::from_json(&text) {
                    let outs = self.streams.message(
                        &peer,
                        m,
                        &EngineLinks {
                            peers: &self.peers,
                            room: &self.room,
                        },
                    );
                    self.stream_out(outs);
                }
                return;
            }
            Msg::ImageSending(transfer_id, peer, percent) => {
                self.sending_progress(transfer_id, peer, percent);
                return;
            }
            Msg::Quic(event) => {
                self.quic_event(event);
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
                if rtc_protocol::stream::parse_range(&data).is_some() {
                    let outs = self.streams.binary(&peer, &data);
                    self.stream_out(outs);
                    return;
                }
                match self.images.frame(&data, now_ms()) {
                    Some(images::Got::Progress { transfer_id, percent }) => {
                        let _ = self.updates.send(Update::ImageProgress { transfer_id, percent });
                    }
                    Some(images::Got::Done { transfer_id, bytes }) => self.file_arrived(transfer_id, bytes),
                    None => {}
                }
                return;
            }
            Msg::Peer(PeerEvent::RemoteAudio {
                peer,
                generation,
                track,
                screen,
            }) => {
                if self.peers.is_current(&peer, generation) {
                    if screen {
                        self.voice.add_remote_screen(peer.as_str(), track);
                    } else {
                        self.voice.add_remote(peer.as_str(), track);
                    }
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
            Msg::Peer(e) => {
                let opened = match &e {
                    PeerEvent::MainState {
                        peer,
                        generation,
                        open: true,
                    } if self.peers.is_current(peer, *generation) => Some(peer.clone()),
                    _ => None,
                };
                let input = self.peers.on_event(e);
                if let Some(p) = opened {
                    // a newcomer learns what's in the file we share, and that we share our screen
                    let outs = self.streams.peer_open(&p);
                    self.stream_out(outs);
                    if self.screen.capture.is_some() {
                        let m = self.screen_status_for(true, &p);
                        self.screen_send(&p, &m);
                    }
                }
                match input {
                    Some(input) => input,
                    None => return,
                }
            }
        };
        if let Input::Peer { from, envelope } = &input
            && self.room.members().contains_key(from)
            && self.quic_message(from, &envelope.message)
        {
            return;
        }
        if let Input::Peer { from, envelope } = &input
            && self.room.members().contains_key(from)
        {
            // accept and cancel (the room logic still relays them in a hub room)
            self.file_control(from, &envelope.message);
            self.folder_offered(from, &envelope.message);
            // a folder's file isn't a chat line of its own
            if self.file_announced(from, &envelope.message, now) {
                return;
            }
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

    async fn apply(&mut self, fx: Vec<Effect>) {
        for effect in fx {
            match effect {
                Effect::Send(m) => {
                    self.signaling.send(m);
                }
                Effect::OpenPeer { peer, initiator } => self.peers.open(peer, initiator).await,
                Effect::Signal { peer, signal } => self.peers.signal(peer, signal).await,
                Effect::IceRestart(peer) => self.peers.offer(&peer, true).await,
                Effect::DiagnoseLink(peer) => {
                    // Before any ClosePeer that follows: the stats need the connection open
                    if let Some((d, log)) = self.peers.diagnose(&peer).await {
                        tracing::warn!("{log}");
                        let _ = self.updates.send(Update::Log(format!(
                            "🔎 Why: {} {}",
                            d.summary,
                            d.details.join(" ")
                        )));
                        let _ = self.updates.send(Update::ConnectionLog(log));
                    }
                }
                Effect::ClosePeer(peer) => {
                    let outs = self.streams.peer_gone(&peer);
                    self.stream_out(outs);
                    self.screen.tracks.remove(&peer);
                    self.screen.wanted.remove(&peer);
                    self.screen.hw.remove(&peer);
                    self.screen.applied.remove(&peer);
                    if self.screen.sharer.as_ref().is_some_and(|(p, _)| *p == peer) {
                        self.screen.sharer = None;
                        self.screen.watch = None;
                        self.publish_screen();
                        self.control_watch_reset();
                    }
                    self.control_peer_gone(&peer);
                    self.camera.tracks.remove(&peer);
                    self.camera.watches.remove(&peer);
                    self.camera.applied.remove(&peer);
                    self.speaking.remove(&peer);
                    // gone: they no longer receive our files (one nobody receives stops)
                    self.transfers_peer_gone(&peer);
                    self.voice.remove_remote(peer.as_str());
                    self.voice.remove_remote_screen(peer.as_str());
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
                        self.quic_reset();
                        self.files_reset();
                        self.stop_capture();
                        self.screen.sharer = None;
                        self.screen.watch = None;
                        self.screen.tracks.clear();
                        self.publish_screen();
                        // the camera closes with the room (`useCamera.ts`, `room-left`)
                        self.camera_off_here();
                        self.camera.tracks.clear();
                        self.camera.watches.clear();
                        self.camera.applied.clear();
                        self.control_watch_reset();
                        let mut outs = self.streams.share(
                            None,
                            &EngineLinks {
                                peers: &self.peers,
                                room: &self.room,
                            },
                        );
                        outs.extend(self.streams.stop_view(&EngineLinks {
                            peers: &self.peers,
                            room: &self.room,
                        }));
                        self.stream_out(outs);
                        for t in self.sending.drain(..) {
                            t.abort();
                        }
                    }
                    self.update_audio_open();
                    self.publish_room();
                    self.publish_control();
                    self.publish_cameras();
                }
                Effect::Ui(UiEvent::Chat(line)) => {
                    let _ = self.updates.send(Update::Chat(line));
                }
                Effect::Ui(UiEvent::Log(text)) => {
                    // the log file keeps connection events, not what people did with the player
                    if log_kind::is_activity(&text) {
                        tracing::info!(target: "rtc_engine::activity", "{text}");
                    } else {
                        tracing::info!(target: "rtc_engine::room", "{text}");
                    }
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
                Effect::Ui(UiEvent::Player(c)) => {
                    let _ = self.updates.send(Update::Player(c));
                }
                Effect::Ui(UiEvent::Pop) => {
                    let _ = self.updates.send(Update::Pop);
                }
                Effect::Ui(UiEvent::Board { from, live, body }) => {
                    let _ = self.updates.send(Update::Board { from, live, body });
                }
                Effect::BroadcastBulk(envelope) => self.announce(&envelope),
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

    /// Does what the video-sharing module asks.
    fn stream_out(&self, outs: Vec<stream::Out>) {
        let me = self.room.identity().username.clone();
        for o in outs {
            match o {
                stream::Out::To(peer, m) => {
                    let Ok(text) = m.to_json(&me, now_ms()) else {
                        continue;
                    };
                    if let Some(dc) = self.peers.bulk(&peer).or_else(|| self.peers.main(&peer)) {
                        let _ = dc.send(text.as_bytes(), false);
                    }
                }
                stream::Out::Broadcast(m) => {
                    let Ok(text) = m.to_json(&me, now_ms()) else {
                        continue;
                    };
                    for peer in self.room.members().keys() {
                        if let Some(dc) = self.peers.main(peer) {
                            let _ = dc.send(text.as_bytes(), false);
                        }
                    }
                }
                stream::Out::ToFile(peer, m) => {
                    let Ok(text) = m.to_json(&me, now_ms()) else {
                        continue;
                    };
                    if let Some(dc) = self.peers.main(&peer) {
                        let _ = dc.send(text.as_bytes(), false);
                    }
                }
                stream::Out::BroadcastFile(m) => {
                    let Ok(text) = m.to_json(&me, now_ms()) else {
                        continue;
                    };
                    for peer in self.room.members().keys() {
                        if let Some(dc) = self.peers.main(peer) {
                            let _ = dc.send(text.as_bytes(), false);
                        }
                    }
                }
                stream::Out::Format { name, description } => {
                    let _ = self.updates.send(Update::FileFormat { name, description });
                }
                stream::Out::Problems(list) => {
                    let _ = self.updates.send(Update::FileProblems(list));
                }
                stream::Out::Log(line) => {
                    let _ = self.updates.send(Update::Log(line));
                }
                stream::Out::Notice(text) => {
                    let _ = self.updates.send(Update::Notice(text));
                }
                stream::Out::Ready { name, size, reader } => {
                    let _ = self.updates.send(Update::StreamReady { name, size, reader });
                }
                stream::Out::Ended(why) => {
                    let _ = self.updates.send(Update::StreamEnded(why));
                }
                stream::Out::Progress(p) => {
                    let _ = self.updates.send(Update::StreamProgress(p));
                }
            }
        }
    }

    /// `screen-share-status` with `has_audio` reflecting whether audio capture is active.
    fn screen_status_for(&self, sharing: bool, _peer: &PeerId) -> rtc_protocol::stream::ScreenMessage {
        self.screen_status(sharing)
    }

    fn screen_status(&self, sharing: bool) -> rtc_protocol::stream::ScreenMessage {
        let me = self.room.identity();
        rtc_protocol::stream::ScreenMessage::Status {
            is_sharing: sharing,
            peer_id: Some(me.peer_id.as_str().to_owned()),
            username: sharing.then(|| me.username.clone()),
            has_audio: sharing && self.screen.sound_on.is_some(),
        }
    }

    fn screen_send(&self, peer: &PeerId, m: &rtc_protocol::stream::ScreenMessage) {
        let Ok(text) = m.to_json(&self.room.identity().username, now_ms()) else {
            return;
        };
        if let Some(dc) = self.peers.main(peer) {
            let _ = dc.send(text.as_bytes(), false);
        }
    }

    fn screen_broadcast(&self, m: &rtc_protocol::stream::ScreenMessage) {
        for peer in self.room.members().keys() {
            self.screen_send(peer, m);
        }
    }

    /// Tells the UI who shares now.
    fn publish_screen(&self) {
        let u = if let Some(c) = &self.screen.capture {
            Update::Screen {
                sharer: Some(self.room.identity().username.clone()),
                mine: true,
                feed: Some(c.preview.clone()),
            }
        } else if let Some((_, name)) = &self.screen.sharer {
            Update::Screen {
                sharer: Some(name.clone()),
                mine: false,
                feed: self.screen.watch.as_ref().map(|(_, f)| f.clone()),
            }
        } else {
            Update::Screen {
                sharer: None,
                mine: false,
                feed: None,
            }
        };
        let _ = self.updates.send(u);
    }

    /// Turns our camera on (or switches it), or off.
    async fn camera_request(&mut self, choice: Option<CameraChoice>) {
        let Some(choice) = choice else {
            self.camera_off_here();
            let fx = self
                .room
                .update(Input::Command(Command::SetCamera(false)), now_ms());
            self.apply(fx).await;
            self.publish_cameras();
            return;
        };
        if !matches!(self.room.phase(), Phase::InRoom(_)) {
            return;
        }
        // a switch keeps our tile (and everyone's view of us) while the new camera opens
        self.camera.capture = None;
        self.camera.number += 1;
        let number = self.camera.number;
        if !self.room.camera_on() {
            self.camera.starting = true;
        }
        let preview = self
            .camera
            .preview
            .get_or_insert_with(ScreenFeed::default)
            .clone();
        let tx = self.queue_tx.clone();
        self.camera.capture = Some(camera::start(
            &choice,
            self.camera.source.clone(),
            preview,
            move |b| {
                let _ = tx.send(Msg::Camera(number, b));
            },
        ));
        self.publish_cameras();
    }

    /// What our camera's capture says.
    async fn camera_back(&mut self, number: u64, back: camera::Back) {
        if number != self.camera.number || self.camera.capture.is_none() {
            return;
        }
        match back {
            camera::Back::Started { width, height, fps } => {
                tracing::info!("camera: {width}×{height} at {fps} fps");
                self.camera.starting = false;
                self.camera.size = Some((width, height, fps));
                self.camera.applied.clear();
                self.route_camera();
                let fx = self
                    .room
                    .update(Input::Command(Command::SetCamera(true)), now_ms());
                self.apply(fx).await;
            }
            camera::Back::Ended(err) => {
                if let Some(e) = &err {
                    tracing::warn!("camera: {e}");
                    let _ = self
                        .updates
                        .send(Update::Notice(camera::error_text(e).to_owned()));
                } else {
                    tracing::info!("camera: stopped");
                }
                self.camera_off_here();
                let fx = self
                    .room
                    .update(Input::Command(Command::SetCamera(false)), now_ms());
                self.apply(fx).await;
            }
        }
        self.publish_cameras();
    }

    /// Stops our camera here (the room logic is told separately).
    fn camera_off_here(&mut self) {
        self.camera.capture = None;
        self.camera.number += 1;
        self.camera.starting = false;
        self.camera.size = None;
        self.camera.preview = None;
        self.camera.applied.clear();
    }

    /// As the side that made each connection: the camera line, for apps that say they have it
    /// (tried again every tick until the connection is ready for a new offer).
    async fn camera_lines(&mut self) {
        let want: Vec<PeerId> = self
            .room
            .members()
            .iter()
            .filter(|(_, m)| m.camera && m.connected)
            .map(|(p, _)| p.clone())
            .collect();
        for peer in want {
            self.peers.add_camera_line(&peer).await;
        }
    }

    /// Sets each viewer's camera sender: desktop viewers get the whole picture (the rate cap
    /// grows with it), web viewers the web app's 640×360, 24 fps, 350 kbps.
    fn route_camera(&mut self) {
        let Some(size) = self.camera.size else { return };
        let (w, h, fps) = size;
        let viewers: Vec<(PeerId, bool)> = self
            .room
            .members()
            .iter()
            .map(|(p, m)| (p.clone(), m.desktop))
            .collect();
        for (peer, desktop) in viewers {
            if self.camera.applied.get(&peer) == Some(&(desktop, size)) {
                continue;
            }
            let Some(sender) = self.peers.camera_sender(&peer) else {
                continue;
            };
            let mut params = sender.parameters();
            let Some(enc) = params.encodings.first_mut() else {
                continue;
            };
            if desktop {
                enc.max_bitrate = Some(camera::desktop_bitrate(w, h, fps));
                enc.max_framerate = Some(f64::from(fps));
                enc.scale_resolution_down_by = Some(1.0);
            } else {
                enc.max_bitrate = Some(camera::WEB_BPS);
                enc.max_framerate = Some(camera::WEB_FPS);
                enc.scale_resolution_down_by = Some(camera::web_scale(h));
            }
            match sender.set_parameters(params) {
                Ok(()) => {
                    tracing::info!(
                        "camera: to {peer} ({}): {}",
                        if desktop { "desktop" } else { "web" },
                        if desktop {
                            format!("{w}×{h}")
                        } else {
                            "640×360 at most".to_owned()
                        }
                    );
                    self.camera.applied.insert(peer, (desktop, size));
                }
                Err(e) => tracing::debug!("camera sender to {peer}: {e:?}"),
            }
        }
    }

    /// Decodes the cameras that are on (and only those) and tells the UI what to show.
    fn publish_cameras(&mut self) {
        let on = self.room.cameras();
        self.camera.watches.retain(|p, _| on.contains(p));
        let mut remote = Vec::new();
        for peer in on {
            if !self.camera.watches.contains_key(&peer)
                && let Some(track) = self.camera.tracks.get(&peer).cloned()
            {
                let feed = ScreenFeed::default();
                self.camera
                    .watches
                    .insert(peer.clone(), (screen::Watch::start(track, feed.clone()), feed));
            }
            if let Some((_, feed)) = self.camera.watches.get(&peer) {
                remote.push((peer, feed.clone()));
            }
        }
        let view = CameraView {
            on: self.room.camera_on() && self.camera.capture.is_some(),
            starting: self.camera.starting,
            mine: if self.camera.capture.is_some() {
                self.camera.preview.clone()
            } else {
                None
            },
            remote,
        };
        if self.camera.shown.as_ref() != Some(&view) {
            self.camera.shown = Some(view.clone());
            let _ = self.updates.send(Update::Cameras(view));
        }
    }

    /// Starts decoding the sharer's pictures (once their track is here).
    fn watch_screen(&mut self) {
        let Some((peer, _)) = &self.screen.sharer else {
            return;
        };
        let Some(track) = self.screen.tracks.get(peer).cloned() else {
            return;
        };
        let feed = ScreenFeed::default();
        self.screen.watch = Some((screen::Watch::start(track, feed.clone()), feed));
        self.publish_screen();
    }

    /// Stops sharing our screen; every viewer's sender goes back to the shared track.
    fn stop_capture(&mut self) -> bool {
        for (peer, _) in std::mem::take(&mut self.screen.hw) {
            if let Some(sender) = self.peers.video_sender(&peer) {
                let _ = sender.set_track(Some(self.screen.raw_track.clone()));
                sender.set_video_encoder_backend(VideoEncoderBackend::Auto);
            }
        }
        self.screen.applied.clear();
        self.screen.sending = None;
        self.screen.sound_on = None;
        self.screen.shared = None;
        let was = self.screen.capture.take().is_some();
        if was {
            self.control_share_stopped();
        }
        was
    }

    /// While our screen's sound is captured: each viewer gets its audio line (once per
    /// connection; desktop, web and mobile all receive the screen sound track).
    async fn screen_sound_lines(&mut self) {
        if self.screen.capture.is_none() || self.screen.sound_on.is_none() {
            return;
        }
        let track = self.screen.sound.track();
        let viewers: Vec<PeerId> = self.room.members().keys().cloned().collect();
        for peer in viewers {
            self.peers.add_screen_sound(&peer, &track).await;
        }
    }

    /// Decides how each viewer gets our screen (hardware or software, size, data) and tells the
    /// capture thread. Called every tick while sharing, and when something changes.
    #[allow(clippy::too_many_lines)]
    fn route_screen(&mut self) {
        use rtc_webrtc::libwebrtc::rtp_parameters::DegradationPreference;
        let Some(c) = &self.screen.capture else { return };
        let (options, size, hardware, encoder, failed) = {
            let s = screen::lock_shared(&c.shared);
            (s.options, s.size, s.hardware, s.encoder.clone(), s.failed.clone())
        };
        let shared = Arc::clone(&c.shared);
        let mut routes = Vec::new();
        let mut viewers = Vec::new();
        let mut hw_count = 0;
        let members: Vec<(PeerId, bool, String)> = self
            .room
            .members()
            .iter()
            .map(|(p, m)| {
                (
                    p.clone(),
                    m.desktop,
                    m.username.clone().unwrap_or_else(|| "Peer".to_owned()),
                )
            })
            .collect();
        for (peer, desktop, name) in members {
            let Some(sender) = self.peers.video_sender(&peer) else {
                continue;
            };
            let wanted = if desktop {
                self.screen.wanted.get(&peer).copied().unwrap_or(0)
            } else {
                0
            };
            let max_h = screen::viewer_height(options.max_height, desktop, wanted);
            let (w, h) = if size.0 > 0 {
                screen::fit(size.0, size.1, 0, max_h)
            } else {
                (1920, 1080)
            };
            let mut bps = screen::bitrate_for(w, h, options.fps);
            if !desktop {
                bps = bps.min(screen::WEB_MAX_BPS);
            }
            let h264 = sender
                .parameters()
                .codecs
                .first()
                .is_some_and(|c| c.mime_type.eq_ignore_ascii_case("video/H264"));
            let hw = h264
                && hardware == Some(true)
                && !failed.contains(peer.as_str())
                && hw_count < screen::MAX_HW_VIEWERS;
            if hw {
                hw_count += 1;
            }
            let encoded = if hw {
                if !self.screen.hw.contains_key(&peer) {
                    let source = screen::new_encoded_source();
                    let track = rtc_webrtc::libwebrtc::media_stream_track::MediaStreamTrack::Video(
                        self.peers
                            .factory()
                            .inner()
                            .create_video_track(&format!("screen-{peer}"), source.clone()),
                    );
                    sender.set_video_encoder_backend(VideoEncoderBackend::PreEncoded);
                    if let Err(e) = sender.set_track(Some(track)) {
                        tracing::warn!("screen: hardware track to {peer}: {e:?}");
                        continue;
                    }
                    self.screen.hw.insert(peer.clone(), source);
                    self.screen.applied.remove(&peer);
                }
                self.screen.hw.get(&peer).cloned()
            } else {
                if self.screen.hw.remove(&peer).is_some() {
                    let _ = sender.set_track(Some(self.screen.raw_track.clone()));
                    sender.set_video_encoder_backend(VideoEncoderBackend::Auto);
                    self.screen.applied.remove(&peer);
                }
                None
            };
            #[allow(clippy::cast_precision_loss)]
            let scale = if !hw && h > 0 && size.1 > h {
                f64::from(size.1) / f64::from(h)
            } else {
                1.0
            };
            let want = (bps, options.fps, (scale * 1000.0).round() as u64);
            if self.screen.applied.get(&peer) != Some(&want) {
                let mut p = sender.parameters();
                p.set_degradation_preference(DegradationPreference::MaintainResolution);
                if let Some(e) = p.encodings.first_mut() {
                    e.max_bitrate = Some(u64::from(bps));
                    e.max_framerate = Some(f64::from(options.fps));
                    e.scale_resolution_down_by = Some(scale);
                }
                match sender.set_parameters(p) {
                    Ok(()) => {
                        self.screen.applied.insert(peer.clone(), want);
                    }
                    Err(e) => tracing::debug!("screen: sender settings for {peer}: {e:?}"),
                }
            }
            viewers.push(ScreenViewer {
                name,
                height: h,
                hardware: hw,
                web: !desktop,
            });
            routes.push(screen::Route {
                peer: peer.as_str().to_owned(),
                max_height: max_h,
                max_bps: bps,
                encoded,
            });
        }
        screen::lock_shared(&shared).routes = routes;
        let sending = ((hw_count > 0).then_some(encoder), viewers);
        if self.screen.sending.as_ref() != Some(&sending) {
            let _ = self.updates.send(Update::ScreenSending {
                encoder: sending.0.clone(),
                viewers: sending.1.clone(),
            });
            self.screen.sending = Some(sending);
        }
    }

    /// Tells the desktop sharing what size we want (the web app sends what it sends).
    fn ask_quality(&self) {
        let Some((peer, _)) = &self.screen.sharer else {
            return;
        };
        if !self.room.members().get(peer).is_some_and(|m| m.desktop) {
            return;
        }
        let m = rtc_protocol::stream::ScreenMessage::Quality {
            max_height: self.screen.my_quality,
        };
        self.screen_send(peer, &m);
    }

    fn share_screen(&mut self, what: Option<ScreenSource>) {
        let was = self.stop_capture();
        let Some(what) = what else {
            if was {
                let m = self.screen_status(false);
                self.screen_broadcast(&m);
                self.publish_screen();
            }
            return;
        };
        let source = self.screen.source.clone();
        let options = self.screen.options;
        let started = tokio::task::block_in_place(|| screen::Capture::start(&what, source, options));
        match started {
            Ok(c) => {
                self.screen.capture = Some(c);
                self.screen.shared = Some(what.clone());
                if options.sound {
                    // the computer's sound, without the call (desktop viewers get it)
                    let feed = self.screen.sound.feeder();
                    match tokio::task::block_in_place(|| rtc_platform_win::AppSound::everything_but_us(feed))
                    {
                        Ok(capture) => self.screen.sound_on = Some(capture),
                        Err(e) => {
                            tracing::warn!("screen: no sound ({e})");
                            let _ = self.updates.send(Update::Notice(format!(
                                "Your screen is shared without its sound: {e}."
                            )));
                        }
                    }
                }
                // one screen at a time: ours replaces theirs here
                self.screen.watch = None;
                self.screen.sharer = None;
                for peer in self.room.members().keys() {
                    let m = self.screen_status_for(true, peer);
                    self.screen_send(peer, &m);
                }
                let _ = self
                    .updates
                    .send(Update::Log(format!("🖥️ You started sharing \"{}\"", what.title)));
                self.route_screen();
            }
            Err(e) => {
                tracing::warn!("screen: {e}");
                let _ = self.updates.send(Update::ScreenError(e));
            }
        }
        self.publish_screen();
        self.publish_control();
    }

    fn screen_message(&mut self, from: &PeerId, m: rtc_protocol::stream::ScreenMessage) {
        use rtc_protocol::stream::ScreenMessage as S;
        let name_of = |p: &PeerId, given: Option<String>| {
            given
                .filter(|n| !n.is_empty())
                .or_else(|| self.room.members().get(p).and_then(|m| m.username.clone()))
                .unwrap_or_else(|| "Peer".to_owned())
        };
        match m {
            S::Status {
                is_sharing: true,
                username,
                ..
            } => {
                let name = name_of(from, username);
                if self.stop_capture() {
                    let _ = self
                        .updates
                        .send(Update::Notice(format!("{name} is sharing their screen now")));
                }
                self.screen.sharer = Some((from.clone(), name.clone()));
                self.screen.watch = None;
                self.control_watch_reset();
                if self.screen.my_quality > 0 {
                    self.ask_quality();
                }
                let _ = self
                    .updates
                    .send(Update::Log(format!("🖥️ {name} is sharing their screen")));
                self.watch_screen();
                self.publish_screen();
            }
            S::Status {
                is_sharing: false, ..
            } => {
                if self.screen.sharer.as_ref().is_some_and(|(p, _)| p == from) {
                    self.screen.sharer = None;
                    self.screen.watch = None;
                    self.publish_screen();
                    self.control_watch_reset();
                }
            }
            S::Control {
                action,
                peer_id,
                username,
            } => self.control_message(from, action, peer_id.as_deref(), username),
            S::Input(i) => self.control_input(from, &i),
            S::Pointer {
                x,
                y,
                username,
                active,
                peer_id,
            } => {
                let _ = self.updates.send(Update::ScreenPointer {
                    peer: peer_id.unwrap_or_else(|| from.as_str().to_owned()),
                    name: name_of(from, username),
                    x,
                    y,
                    active,
                });
            }
            S::Quality { max_height } => {
                self.screen.wanted.insert(from.clone(), max_height);
                self.screen.applied.remove(from);
                self.route_screen();
            }
            S::Ping { x, y, username, .. } => {
                let _ = self.updates.send(Update::ScreenPing {
                    name: name_of(from, username),
                    x,
                    y,
                });
            }
        }
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
            client_id: self.room.identity().client_id.as_str().to_owned(),
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
            topology: self.room.topology().to_owned(),
            max_users: self.room.max_users(),
            watch: self.room.watch(),
            activity: self.room.activity(),
            stores: self
                .room
                .store_keys()
                .into_iter()
                .filter(|k| k.starts_with("act:"))
                .filter_map(|k| self.room.store(&k).map(|v| (k, v)))
                .collect(),
            dev_activities: self.room.dev_activities(),
        };
        let _ = self.updates.send(Update::Room(snapshot));
    }
}

/// Cameras, both ways (ADR 0010).
struct CameraState {
    /// Our camera's video source (its track is on every camera line).
    source: rtc_webrtc::libwebrtc::video_source::native::NativeVideoSource,
    /// Our camera, while it's on (or opening).
    capture: Option<camera::Capture>,
    /// The current capture's number (events from older ones are ignored).
    number: u64,
    /// Being opened (no pictures yet).
    starting: bool,
    /// What the camera gives: width, height, frames a second (once started).
    size: Option<(u32, u32, u32)>,
    /// Our own tile's pictures.
    preview: Option<ScreenFeed>,
    /// Each person's camera track (from their camera line).
    tracks: HashMap<PeerId, rtc_webrtc::libwebrtc::video_track::RtcVideoTrack>,
    /// Decoding the cameras that are on.
    watches: HashMap<PeerId, (screen::Watch, ScreenFeed)>,
    /// What each viewer's camera sender was set to: (desktop viewer, the camera's size).
    applied: HashMap<PeerId, (bool, (u32, u32, u32))>,
    /// What the UI was last told.
    shown: Option<CameraView>,
}

/// Screen sharing, both ways.
struct ScreenState {
    /// Our screen's video source (its track is in every connection).
    source: rtc_webrtc::libwebrtc::video_source::native::NativeVideoSource,
    /// Our screen being captured.
    capture: Option<screen::Capture>,
    /// Each peer's incoming video track.
    tracks: HashMap<PeerId, rtc_webrtc::libwebrtc::video_track::RtcVideoTrack>,
    /// Who shares (not us): their id and name.
    sharer: Option<(PeerId, String)>,
    /// Their pictures being decoded, and where they go.
    watch: Option<(screen::Watch, ScreenFeed)>,
    /// The shared track (software viewers' senders carry it).
    raw_track: rtc_webrtc::libwebrtc::media_stream_track::MediaStreamTrack,
    /// How we share.
    options: ScreenOptions,
    /// The size each desktop viewer asked for (`screen-quality`).
    wanted: HashMap<PeerId, u32>,
    /// The size we asked for of someone else's screen.
    my_quality: u32,
    /// Viewers we encode for with the GPU: their pass-through source.
    hw: HashMap<PeerId, rtc_webrtc::libwebrtc::video_source::native::NativeVideoSource>,
    /// Sender settings set per viewer (data, frames, scale ×1000), so they're set once.
    applied: HashMap<PeerId, (u32, u32, u64)>,
    /// What the UI was last told about our viewers.
    sending: Option<(Option<String>, Vec<ScreenViewer>)>,
    /// Our screen's sound: its track (desktop viewers' connections get it).
    sound: rtc_webrtc::voice::ScreenSound,
    /// The computer's sound being captured while we share.
    sound_on: Option<rtc_platform_win::AppSound>,
    /// What we share (remote control plays input back over it).
    shared: Option<ScreenSource>,
}

/// What the video-sharing module sees of the engine.
struct EngineLinks<'a> {
    peers: &'a Peers,
    room: &'a Room,
}

impl stream::Links for EngineLinks<'_> {
    fn bulk(&self, peer: &PeerId) -> Option<rtc_webrtc::libwebrtc::data_channel::DataChannel> {
        self.peers.bulk(peer)
    }

    fn name(&self, peer: &PeerId) -> Option<String> {
        self.room.members().get(peer)?.username.clone()
    }

    fn me(&self) -> String {
        self.room.identity().username.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::type_is;

    #[test]
    fn messages_go_by_their_type_not_their_text() {
        let video = |t: &str| {
            t.starts_with("p2p-")
                && t != "p2p-image-start"
                && t != "p2p-folder-offer"
                && !t.starts_with("p2p-file-")
        };
        let folder = r#"{"type":"p2p-folder-offer","folderId":"f","files":[{"transferId":"t","path":"F/p2p-x/screen-1.png"}]}"#;
        assert!(!type_is(folder, video), "a folder offer is chat, not video");
        assert!(
            !type_is(folder, |t| t.starts_with("screen-")),
            "a file name is not a type"
        );
        let start = r#"{"type":"p2p-file-start","transferId":"t","fileName":"screen-1.png"}"#;
        assert!(!type_is(start, |t| t.starts_with("screen-")));
        assert!(type_is(r#"{"type":"p2p-range-request","streamNo":1}"#, video));
        assert!(type_is(r#"{"type":"screen-pointer","x":0.5}"#, |t| t
            .starts_with("screen-")));
        assert!(!type_is("not json \"screen-", |_| true));
    }
}
