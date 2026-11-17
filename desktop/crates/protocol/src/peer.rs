//! Peer messages: app to app (web or desktop) on the `chat-<peerId>` data channel, as JSON.
//!
//! [`PeerMessage`] holds the types the desktop app acts on; anything else arrives as
//! [`PeerMessage::Unknown`] and is ignored. Every message also carries the sender's display
//! name and a timestamp: [`Envelope`] adds and reads those. See `docs/PROTOCOL.md`, "Peer messages".

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::DecodeError;
use crate::ids::{ClientId, PeerId};

/// The kind of app on the other end, sent in `peer-identity` (older apps leave it out: web).
pub const CLIENT_DESKTOP: &str = "desktop";

/// The QUIC file transfer version this app speaks, sent in `peer-identity` (ADR 0009).
pub const QUIC_VERSION: u32 = 1;

/// One peer message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PeerMessage {
    /// Who I am; sent when the channel opens, answered with `is_reply`.
    #[serde(rename_all = "camelCase")]
    PeerIdentity {
        /// My peer id.
        peer_id: PeerId,
        /// My display name.
        username: String,
        /// Whether I host the room.
        is_host: bool,
        /// Whether my mic is muted.
        is_muted: bool,
        /// Protocol version ([`crate::PROTOCOL_VERSION`]).
        proto: u32,
        /// My app's build (`YYMMDD.HHMM`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        build: Option<String>,
        /// My app install's stable id.
        client_id: ClientId,
        /// This is the answer to your identity.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_reply: bool,
        /// Host only: playback controls locked to the host.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        playback_lock: Option<bool>,
        /// `"desktop"` for the desktop app; absent for the web app.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client: Option<String>,
        /// Host only: active room network topology ("mesh" or "hub").
        #[serde(default, skip_serializing_if = "Option::is_none")]
        topology: Option<String>,
        /// Host only: active room capacity.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_users: Option<u32>,
        /// Desktop app: the QUIC file transfer version it speaks (ADR 0009); absent otherwise.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        quic: Option<u32>,
    },
    /// My mic was muted or unmuted.
    #[serde(rename_all = "camelCase")]
    PeerVoiceStatus {
        /// My peer id (the web app leaves it out: the channel says who it is).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        peer_id: Option<PeerId>,
        /// Muted now.
        is_muted: bool,
    },
    /// I'm leaving on purpose: don't try to reconnect.
    PeerBye,
    /// Latency probe.
    #[serde(rename_all = "camelCase")]
    NetPing {
        /// Probe id, echoed back.
        ping_id: String,
        /// Sender's clock, ms.
        send_time: f64,
    },
    /// Answer to a latency probe.
    #[serde(rename_all = "camelCase")]
    NetPong {
        /// The probe's id.
        ping_id: String,
        /// The probe's `send_time`, echoed.
        send_time: f64,
    },
    /// Periodic link distance & quality telemetry shared across all peers.
    #[serde(rename_all = "camelCase")]
    NetTopologyReport {
        /// Sender's peer id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<PeerId>,
        /// Link metrics to other peers: target peer id -> metric.
        #[serde(default)]
        links: std::collections::HashMap<String, PeerLinkMetric>,
    },
    /// A chat message.
    #[serde(rename_all = "camelCase")]
    Chat {
        /// Unique message id.
        id: String,
        /// Sent by the host.
        #[serde(default)]
        is_host: bool,
        /// The text.
        text: String,
        /// The message it replies to (dropped, not refused, when malformed).
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "lenient_reply"
        )]
        reply_to: Option<ReplyRef>,
        /// Peer ids mentioned with @Name (only the strings are kept).
        #[serde(
            default,
            skip_serializing_if = "Vec::is_empty",
            deserialize_with = "lenient_strings"
        )]
        mentions: Vec<String>,
    },
    /// A floating emoji reaction (`features/reactions/useReactions.ts`).
    Reaction {
        /// Unique id.
        #[serde(default)]
        id: String,
        /// One emoji.
        emoji: String,
        /// Where across the stage it floats up, in percent (the web app sends 20–80, with
        /// fractions).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lane: Option<f64>,
        /// The same emoji this many times in a row (1 = the first of a burst).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        combo: Option<f64>,
    },
    /// A soundboard clip everyone hears (`features/soundboard/useSoundboard.ts`).
    #[serde(rename_all = "camelCase")]
    SoundboardSfx {
        /// Which clip (`quack`, `airhorn`, …).
        sound_id: String,
        /// Its name for people.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sound_name: Option<String>,
        /// Its emoji.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        emoji: Option<String>,
    },
    /// A chat image follows on the bulk channel, as `IMG1` frames ([`crate::image`]).
    #[serde(rename = "p2p-image-start", rename_all = "camelCase")]
    P2pImageStart {
        /// The chat message's id.
        #[serde(default)]
        id: String,
        /// The transfer the frames carry.
        transfer_id: String,
        /// The image's file name.
        #[serde(default)]
        file_name: String,
        /// Its size in bytes.
        #[serde(default)]
        file_size: f64,
        /// `image/png`, `image/jpeg`, …
        #[serde(default)]
        mime_type: String,
        /// How many frames.
        #[serde(default)]
        total_chunks: f64,
        /// Sent by the host.
        #[serde(default)]
        is_host: bool,
        /// Text sent with it.
        #[serde(default)]
        caption: String,
    },
    /// A chat file follows on the bulk channel, as `IMG1` frames ([`crate::image`]).
    #[serde(rename = "p2p-file-start", rename_all = "camelCase")]
    P2pFileStart {
        /// The chat message's id.
        #[serde(default)]
        id: String,
        /// The transfer the frames carry.
        transfer_id: String,
        /// The file's name.
        #[serde(default)]
        file_name: String,
        /// Its size in bytes.
        #[serde(default)]
        file_size: f64,
        /// MIME type.
        #[serde(default)]
        mime_type: String,
        /// How many frames.
        #[serde(default)]
        total_chunks: f64,
        /// Sent by the host.
        #[serde(default)]
        is_host: bool,
        /// Text sent with it.
        #[serde(default)]
        caption: String,
    },
    /// Pause, resume, or cancel a P2P file transfer.
    #[serde(rename = "p2p-file-control", rename_all = "camelCase")]
    P2pFileControl {
        /// Transfer session identifier.
        transfer_id: String,
        /// Control action: "pause", "resume", or "cancel".
        action: String,
        /// Optional start chunk index when resuming.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_chunk: Option<u32>,
    },
    /// Request to resume an interrupted transfer from a specific chunk index upon reconnect.
    #[serde(rename = "p2p-file-sync", rename_all = "camelCase")]
    P2pFileSync {
        /// Transfer session identifier.
        transfer_id: String,
        /// Next chunk index requested.
        resume_from_chunk: u32,
    },
    /// The host locked (or unlocked) playback to themselves.
    #[serde(rename_all = "camelCase")]
    RoomSettings {
        /// Only the host controls playback.
        playback_lock: bool,
        /// Host only: active room network topology ("mesh" or "hub").
        #[serde(default, skip_serializing_if = "Option::is_none")]
        topology: Option<String>,
        /// Host only: active room capacity.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_users: Option<u32>,
    },
    /// A YouTube video loaded, played, paused, seeked or closed (`usePlayback.ts`).
    #[serde(rename_all = "camelCase")]
    YtAction {
        /// `load`, `play`, `pause`, `seek`, `close` or `unload`.
        action: String,
        /// `load`: the video.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        new_video_id: Option<String>,
        /// `load` from older apps.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        video_id: Option<String>,
        /// `load`: its title.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        /// Where, seconds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_time: Option<f64>,
        /// Sent by the host (the host controls lock lets these through).
        #[serde(default)]
        from_host: bool,
        /// A passed skip vote.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by_vote: Option<bool>,
    },
    /// A video file from someone's computer: loaded, played, paused, seeked, closed, or its
    /// subtitles shared (`LocalVideoSyncPlayer.tsx`). Only the name and size travel here; the
    /// file itself is streamed (`p2p-*`) or picked by each viewer.
    #[serde(rename_all = "camelCase")]
    LocalVideoAction {
        /// `load`, `play`, `pause`, `seek`, `close` or `subtitle-share`.
        action: String,
        /// `load`: the file's name (`subtitle-share`: the subtitles' name).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_name: Option<String>,
        /// `load`: its size in bytes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_size: Option<f64>,
        /// Where, seconds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_time: Option<f64>,
        /// Sent by the host.
        #[serde(default)]
        from_host: bool,
        /// `subtitle-share`: the subtitles as WebVTT.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vtt_string: Option<String>,
        /// Subtitles already showing (late joiners).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtitle_info: Option<Value>,
    },
    /// The answer to `yt-request-sync` while a video file plays.
    #[serde(rename_all = "camelCase")]
    LocalVideoSyncState {
        /// Always `local`.
        #[serde(default)]
        media_type: String,
        /// The file's name.
        #[serde(default)]
        file_name: String,
        /// Its size in bytes.
        #[serde(default)]
        file_size: f64,
        /// Where, seconds.
        #[serde(default)]
        current_time: f64,
        /// Playing.
        #[serde(default)]
        is_playing: bool,
        /// Subtitles showing, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subtitle_info: Option<Value>,
    },
    /// The same for a link source (Vimeo, Twitch, a video file, HLS).
    #[serde(rename_all = "camelCase")]
    MediaAction {
        /// As in `yt-action`.
        action: String,
        /// `load`: the source ([`crate::media::normalize`] it).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media: Option<Value>,
        /// Where, seconds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_time: Option<f64>,
        /// Sent by the host.
        #[serde(default)]
        from_host: bool,
        /// A passed skip vote.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by_vote: Option<bool>,
    },
    /// What are you watching? (sent when a channel opens, and by a guest the lock stopped).
    YtRequestSync,
    /// The answer for YouTube, or nothing playing.
    #[serde(rename_all = "camelCase")]
    YtSyncState {
        /// The video (`null` with `nothing_playing`).
        #[serde(default)]
        video_id: Option<String>,
        /// Nothing is playing here.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nothing_playing: Option<bool>,
        /// Where, seconds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_time: Option<f64>,
        /// Playing (not paused).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_playing: Option<bool>,
        /// The queue ([`crate::media::QueueItem::list`]).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue: Option<Vec<Value>>,
        /// Who voted to skip (names).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skip_votes: Option<Vec<String>>,
        /// The video's title.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_video_title: Option<String>,
    },
    /// The answer for a link source.
    #[serde(rename_all = "camelCase")]
    MediaSyncState {
        /// The source.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media: Option<Value>,
        /// The queue.
        #[serde(default)]
        queue: Vec<Value>,
        /// Who voted to skip.
        #[serde(default)]
        skip_votes: Vec<String>,
        /// Where, seconds (absent: the player isn't up yet).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_time: Option<f64>,
        /// Playing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_playing: Option<bool>,
    },
    /// The room's reference app says where it is, every 4 s (`useDriftSync.ts`).
    #[serde(rename_all = "camelCase")]
    MediaHeartbeat {
        /// What is playing (`yt:<id>`, `link:<provider>:<url>`, …).
        key: String,
        /// Where, seconds.
        current_time: f64,
        /// Playing (not paused or buffering).
        is_playing: bool,
    },
    /// The shared watch queue and vote to skip (`useQueue.ts`).
    #[serde(rename_all = "camelCase")]
    QueueAction {
        /// `add`, `remove`, `reorder`, `clear`, `play-item`, `next`, `vote-skip`, `vote-skip-passed`.
        action: String,
        /// `add`: the item.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item: Option<Value>,
        /// `remove`, `play-item`: which.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        /// `reorder`: the new order.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue: Option<Vec<Value>>,
        /// `next`: the video now playing (`null` for a link source).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_video_id: Option<Value>,
        /// `next`: its title.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_title: Option<String>,
        /// `next`: what's left.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        remaining_queue: Option<Vec<Value>>,
        /// `vote-skip`: the votes now.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skip_votes: Option<Vec<Value>>,
    },
    /// Shared state (games, the open activity): the authority's full state for `key`.
    RoomState {
        /// What the state is for (`act:<activity-id>`, …).
        key: String,
        /// Version, rising with each change.
        v: u64,
        /// The state itself (each key has its own shape).
        state: Value,
    },
    /// Shared state: an action for the authority to apply.
    RoomStateAction {
        /// The state it's for.
        key: String,
        /// The action (each key has its own shape).
        action: Value,
    },
    /// Shared state: please send me `key`.
    RoomStateRequest {
        /// The state wanted.
        key: String,
    },
    /// Shared state: `key` was cleared.
    RoomStateGone {
        /// The state cleared.
        key: String,
    },
    /// Whiteboard: a stroke as it is drawn (`wb-live`), see [`BoardLive`].
    WbLive(Box<BoardLive>),
    /// Whiteboard: where someone's pointer is (`wb-cursor`), see [`BoardCursor`].
    WbCursor(Box<BoardCursor>),
    /// QUIC file transfer, desktop to desktop (ADR 0009): the sender offers a file and how to
    /// reach it. Sent to one peer.
    #[serde(rename_all = "camelCase")]
    QuicOffer {
        /// This transfer.
        transfer_id: String,
        /// The file's name (cleaned before use).
        file_name: String,
        /// Its size in bytes.
        file_size: u64,
        /// Its SHA-256, lower-case hex.
        sha256: String,
        /// Where the sender listens: `ip:port`, LAN and public.
        addrs: Vec<String>,
        /// SHA-256 of the sender's certificate (lower-case hex): the only one accepted.
        cert_sha256: String,
        /// A one-time secret (hex) the receiver presents first on the QUIC stream.
        token: String,
        /// In a folder being sent: the file's path inside it (`Photos/2026/a.jpg`), cleaned by
        /// the receiver before use.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        relative_path: Option<String>,
    },
    /// QUIC file transfer: the receiver's addresses (for hole punching) and where to start (0, or
    /// how much it already has, to resume).
    #[serde(rename_all = "camelCase")]
    QuicAnswer {
        /// The transfer answered.
        transfer_id: String,
        /// Where the receiver's packets come from: `ip:port`.
        addrs: Vec<String>,
        /// Bytes already received (resume), else 0.
        #[serde(default)]
        offset: u64,
    },
    /// QUIC file transfer didn't connect, or was turned down: the file goes over the data
    /// channel instead (either side may send it).
    #[serde(rename_all = "camelCase")]
    QuicFallback {
        /// The transfer.
        transfer_id: String,
        /// Why, for the log.
        #[serde(default)]
        reason: String,
    },
    /// A message type this app doesn't handle: ignored (protocol rule 1).
    #[serde(other, skip_serializing)]
    Unknown,
}

/// Measurements of one WebRTC connection to a peer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerLinkMetric {
    /// RTT latency in milliseconds.
    pub rtt_ms: f64,
    /// Candidate path type: "host" (LAN), "srflx" (P2P), "prflx", or "relay" (TURN).
    pub candidate_type: String,
    /// Observed packet loss percentage (0-100).
    #[serde(default)]
    pub loss_pct: f64,
    /// Audio / video packet arrival jitter in milliseconds.
    #[serde(default)]
    pub jitter_ms: f64,
    /// Inbound throughput in KB/s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_kbps: Option<f64>,
    /// Outbound throughput in KB/s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload_kbps: Option<f64>,
}

/// `wb-live`: `e` (board epoch), `id, k, c, w`, `from` (how many numbers were sent before) and
/// `pts` (the new ones), `name`; or `{ e, id, done: true }` when the stroke ends. Fields are kept
/// as sent: the board checks them.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct BoardLive {
    /// The board's epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub e: Option<Value>,
    /// The stroke's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    /// The tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k: Option<Value>,
    /// Its colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c: Option<Value>,
    /// Its width.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<Value>,
    /// How many numbers were sent before these.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Value>,
    /// The new numbers (x, y, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pts: Option<Value>,
    /// Who draws.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<Value>,
    /// The stroke ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<Value>,
}

/// `wb-cursor`: `x, y, name` in board units, or `gone: true`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct BoardCursor {
    /// Across.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<Value>,
    /// Down.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<Value>,
    /// Who.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<Value>,
    /// The pointer left the board.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gone: Option<Value>,
}

/// The message a chat reply quotes: its id, and its sender's name and a short plain snippet of it
/// as the replier saw them (`replyTo` in `docs/PROTOCOL.md`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ReplyRef {
    /// The quoted message's id.
    pub id: String,
    /// Its sender's name.
    #[serde(default)]
    pub sender: String,
    /// A short plain snippet of it.
    #[serde(default)]
    pub text: String,
}

/// `replyTo`, or nothing when it isn't a well-formed object (the message itself still counts).
fn lenient_reply<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ReplyRef>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value::<ReplyRef>(v)
        .ok()
        .filter(|r| !r.id.is_empty()))
}

/// A list of strings, keeping only the strings (anything else: an empty list).
fn lenient_strings<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|i| match i {
                Value::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    })
}

/// A peer message with the fields every message carries: who sent it and when.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    /// The sender's display name (`sender`). For display only: trust the channel's peer id.
    pub sender: Option<String>,
    /// Sender's clock, ms since 1970 (`timestamp`).
    pub timestamp: Option<f64>,
    /// The message.
    pub message: PeerMessage,
}

impl Envelope {
    /// Reads one data-channel message.
    ///
    /// # Errors
    /// [`DecodeError`] if it isn't a JSON object with a string `type`, or a known type has the
    /// wrong shape. Unknown types come back as [`PeerMessage::Unknown`].
    pub fn from_json(text: &str) -> Result<Self, DecodeError> {
        let value: Value = serde_json::from_str(text)?;
        let Value::Object(map) = &value else {
            return Err(DecodeError::NoType);
        };
        if !map.get("type").is_some_and(Value::is_string) {
            return Err(DecodeError::NoType);
        }
        let sender = map.get("sender").and_then(Value::as_str).map(str::to_owned);
        let timestamp = map.get("timestamp").and_then(Value::as_f64);
        let message = serde_json::from_value(value)?;
        Ok(Self {
            sender,
            timestamp,
            message,
        })
    }

    /// The JSON text to send, with `sender` and `timestamp` added as the web app's bus does.
    ///
    /// # Errors
    /// Serializing [`PeerMessage::Unknown`] is an error: it's for messages received, never sent.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        let mut map = match serde_json::to_value(&self.message)? {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        if let Some(sender) = &self.sender {
            map.entry("sender")
                .or_insert_with(|| Value::String(sender.clone()));
        }
        if let Some(ts) = self.timestamp
            && let Some(n) = serde_json::Number::from_f64(ts)
        {
            map.entry("timestamp").or_insert(Value::Number(n));
        }
        serde_json::to_string(&Value::Object(map))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn whiteboard_messages_keep_what_was_sent() {
        let text = r##"{"type":"wb-live","sender":"Riya","timestamp":5.5,"e":0,"id":"a1","k":"pen","c":"#1f2329","w":6,"from":4,"pts":[1,2],"name":"Riya"}"##;
        let e = Envelope::from_json(text).unwrap();
        let PeerMessage::WbLive(b) = &e.message else {
            panic!("not wb-live: {:?}", e.message)
        };
        assert_eq!(b.pts, Some(json!([1, 2])));
        assert_eq!(b.from, Some(json!(4)));
        let back: Value = serde_json::from_str(&e.to_json().unwrap()).unwrap();
        assert_eq!(back, serde_json::from_str::<Value>(text).unwrap());
        // odd shapes are kept as sent (the board checks them), not refused
        let odd = Envelope::from_json(r#"{"type":"wb-cursor","x":"12","gone":1}"#).unwrap();
        assert_eq!(
            odd.message,
            PeerMessage::WbCursor(Box::new(BoardCursor {
                x: Some(json!("12")),
                gone: Some(json!(1)),
                ..BoardCursor::default()
            }))
        );
    }

    fn identity() -> PeerMessage {
        PeerMessage::PeerIdentity {
            peer_id: PeerId::new("p1").unwrap(),
            username: "Darshan".into(),
            is_host: true,
            is_muted: false,
            proto: crate::PROTOCOL_VERSION,
            build: Some("261111.1200".into()),
            client_id: ClientId::new("c-123").unwrap(),
            is_reply: false,
            playback_lock: None,
            client: Some(CLIENT_DESKTOP.into()),
            topology: None,
            max_users: None,
            quic: None,
        }
    }

    #[test]
    fn identity_matches_the_web_app() {
        let e = Envelope {
            sender: Some("Darshan".into()),
            timestamp: Some(1_700_000_000_000.0),
            message: identity(),
        };
        let v: Value = serde_json::from_str(&e.to_json().unwrap()).unwrap();
        assert_eq!(
            v,
            json!({"type": "peer-identity", "peerId": "p1", "username": "Darshan", "isHost": true,
                   "isMuted": false, "proto": 2, "build": "261111.1200", "clientId": "c-123",
                   "client": "desktop", "sender": "Darshan", "timestamp": 1_700_000_000_000.0})
        );
    }

    #[test]
    fn reads_a_web_identity_and_chat() {
        // what the web app sends today: no `client`, a reply, a playback lock
        let e = Envelope::from_json(
            r#"{"type":"peer-identity","peerId":"w1","username":"Riya","isHost":false,"isMuted":true,
                "proto":2,"build":"261023.1100","clientId":"cid-9","isReply":true,"playbackLock":true,
                "sender":"Riya","timestamp":1}"#,
        )
        .unwrap();
        assert_eq!(e.sender.as_deref(), Some("Riya"));
        assert!(matches!(
            e.message,
            PeerMessage::PeerIdentity {
                is_reply: true,
                client: None,
                ..
            }
        ));
        let c =
            Envelope::from_json(r#"{"type":"chat","id":"m1","sender":"Riya","isHost":false,"text":"hi"}"#)
                .unwrap();
        assert_eq!(
            c.message,
            PeerMessage::Chat {
                id: "m1".into(),
                is_host: false,
                text: "hi".into(),
                reply_to: None,
                mentions: Vec::new()
            }
        );
        assert_eq!(c.sender.as_deref(), Some("Riya"));
    }

    #[test]
    fn chat_keeps_its_own_sender() {
        let e = Envelope {
            sender: Some("Darshan".into()),
            timestamp: None,
            message: PeerMessage::Chat {
                id: "m2".into(),
                is_host: true,
                text: "hello".into(),
                reply_to: None,
                mentions: Vec::new(),
            },
        };
        let v: Value = serde_json::from_str(&e.to_json().unwrap()).unwrap();
        assert_eq!(
            v,
            json!({"type": "chat", "id": "m2", "isHost": true, "text": "hello", "sender": "Darshan"})
        );
    }

    #[test]
    fn reads_the_web_apps_voice_status() {
        // exactly what useVoiceChat.ts sends: no peerId
        let e =
            Envelope::from_json(r#"{"type":"peer-voice-status","sender":"Riya","isMuted":false}"#).unwrap();
        assert_eq!(
            e.message,
            PeerMessage::PeerVoiceStatus {
                peer_id: None,
                is_muted: false
            }
        );
    }

    #[test]
    fn chat_reply_and_mentions_are_read_leniently() {
        let e = Envelope::from_json(
            r#"{"type":"chat","id":"c1","text":"hi @Riya","replyTo":{"id":"m0","sender":"Riya","text":"yo"},
                "mentions":["p-riya", 7, null, "p-arjun"],"sender":"Darshan"}"#,
        )
        .unwrap();
        let PeerMessage::Chat {
            reply_to, mentions, ..
        } = e.message
        else {
            panic!("not chat")
        };
        assert_eq!(reply_to.map(|r| r.id), Some("m0".to_owned()));
        assert_eq!(mentions, vec!["p-riya".to_owned(), "p-arjun".to_owned()]);
        // malformed: the message still arrives, without them
        for bad in [
            r#""replyTo":"m0","mentions":"all""#,
            r#""replyTo":{"id":""},"mentions":{}"#,
            r#""replyTo":null"#,
        ] {
            let e =
                Envelope::from_json(&format!(r#"{{"type":"chat","id":"c2","text":"ok",{bad}}}"#)).unwrap();
            let PeerMessage::Chat {
                text,
                reply_to,
                mentions,
                ..
            } = e.message
            else {
                panic!("not chat: {bad}")
            };
            assert_eq!(text, "ok");
            assert!(reply_to.is_none() && mentions.is_empty(), "{bad}");
        }
        // none of it is written when unused (older apps see the same message as before)
        let plain = Envelope {
            sender: None,
            timestamp: None,
            message: PeerMessage::Chat {
                id: "c3".into(),
                is_host: false,
                text: "t".into(),
                reply_to: None,
                mentions: Vec::new(),
            },
        };
        let json = plain.to_json().unwrap();
        assert!(!json.contains("replyTo") && !json.contains("mentions"), "{json}");
    }

    #[test]
    fn quic_messages_use_the_documented_names() {
        let offer = Envelope {
            sender: None,
            timestamp: None,
            message: PeerMessage::QuicOffer {
                transfer_id: "t1".into(),
                file_name: "film.mkv".into(),
                file_size: 9_000_000,
                sha256: "ab".repeat(32),
                addrs: vec!["192.168.1.5:5000".into()],
                cert_sha256: "cd".repeat(32),
                token: "ef".repeat(32),
                relative_path: Some("Photos/a.jpg".into()),
            },
        };
        let v: Value = serde_json::from_str(&offer.to_json().unwrap()).unwrap();
        assert_eq!(v["type"], "quic-offer");
        for key in [
            "transferId",
            "fileName",
            "fileSize",
            "sha256",
            "addrs",
            "certSha256",
            "token",
            "relativePath",
        ] {
            assert!(v.get(key).is_some(), "{key}");
        }
        let answer =
            Envelope::from_json(r#"{"type":"quic-answer","transferId":"t1","addrs":["1.2.3.4:5"]}"#).unwrap();
        assert_eq!(
            answer.message,
            PeerMessage::QuicAnswer {
                transfer_id: "t1".into(),
                addrs: vec!["1.2.3.4:5".into()],
                offset: 0
            }
        );
        let fallback = Envelope::from_json(r#"{"type":"quic-fallback","transferId":"t1"}"#).unwrap();
        assert!(matches!(fallback.message, PeerMessage::QuicFallback { reason, .. } if reason.is_empty()));
    }

    #[test]
    fn unknown_and_extra_fields() {
        let e =
            Envelope::from_json(r#"{"type":"chess-move","from":"e2","to":"e4","sender":"Riya"}"#).unwrap();
        assert_eq!(e.message, PeerMessage::Unknown);
        let p = Envelope::from_json(r#"{"type":"peer-bye","sender":"Riya","futureField":[1,2]}"#).unwrap();
        assert_eq!(p.message, PeerMessage::PeerBye);
        assert!(
            Envelope {
                sender: None,
                timestamp: None,
                message: PeerMessage::Unknown
            }
            .to_json()
            .is_err()
        );
    }

    #[test]
    fn reads_the_web_apps_reactions_sounds_and_images() {
        // the lane has fractions; older apps add fields we skip
        let r = Envelope::from_json(
            r#"{"type":"reaction","id":"r1","emoji":"🔥","lane":47.25,"combo":3,"driftVariant":2,"sender":"Riya"}"#,
        )
        .unwrap();
        assert_eq!(
            r.message,
            PeerMessage::Reaction {
                id: "r1".into(),
                emoji: "🔥".into(),
                lane: Some(47.25),
                combo: Some(3.0),
            }
        );
        let s = Envelope::from_json(
            r#"{"type":"soundboard-sfx","soundId":"quack","soundName":"Quack","emoji":"🦆","timestamp":5}"#,
        )
        .unwrap();
        assert_eq!(
            s.message,
            PeerMessage::SoundboardSfx {
                sound_id: "quack".into(),
                sound_name: Some("Quack".into()),
                emoji: Some("🦆".into())
            }
        );
        let i = Envelope::from_json(
            r#"{"type":"p2p-image-start","id":"m1","transferId":"t1","fileName":"cat.png","fileSize":70000,
                "mimeType":"image/png","totalChunks":2,"sender":"Riya","isHost":true,"caption":"look","timestamp":9}"#,
        )
        .unwrap();
        assert!(matches!(
            i.message,
            PeerMessage::P2pImageStart { ref transfer_id, total_chunks, is_host: true, .. }
                if transfer_id == "t1" && (total_chunks - 2.0).abs() < f64::EPSILON
        ));
        let v: Value = serde_json::from_str(
            &Envelope {
                sender: None,
                timestamp: None,
                message: PeerMessage::RoomSettings {
                    playback_lock: true,
                    topology: None,
                    max_users: None,
                },
            }
            .to_json()
            .unwrap(),
        )
        .unwrap();
        assert_eq!(v, json!({"type": "room-settings", "playbackLock": true}));
    }

    #[test]
    fn reads_the_web_apps_local_video_messages() {
        let e = Envelope::from_json(r#"{"type":"local-video-action","action":"load","fromHost":true,"fileName":"Film.mkv","fileSize":2147483648,"sender":"Riya","timestamp":5}"#).unwrap();
        assert!(
            matches!(e.message, PeerMessage::LocalVideoAction { ref action, ref file_name, file_size: Some(s), from_host: true, .. } if action == "load" && file_name.as_deref() == Some("Film.mkv") && (s - 2_147_483_648.0).abs() < 1.0)
        );
        let s = Envelope::from_json(r#"{"type":"local-video-sync-state","mediaType":"local","fileName":"Film.mkv","fileSize":10,"currentTime":61.5,"isPlaying":true}"#).unwrap();
        assert!(
            matches!(s.message, PeerMessage::LocalVideoSyncState { ref file_name, current_time, is_playing: true, .. } if file_name == "Film.mkv" && (current_time - 61.5).abs() < 1e-9)
        );
    }

    #[test]
    fn reads_the_web_apps_playback_messages() {
        let e = Envelope::from_json(r#"{"type":"yt-action","action":"load","fromHost":true,"newVideoId":"dQw4w9WgXcQ","title":"T","sender":"Riya","timestamp":5}"#).unwrap();
        assert!(
            matches!(e.message, PeerMessage::YtAction { ref action, ref new_video_id, from_host: true, .. } if action == "load" && new_video_id.as_deref() == Some("dQw4w9WgXcQ"))
        );
        let s =
            Envelope::from_json(r#"{"type":"yt-sync-state","videoId":null,"nothingPlaying":true}"#).unwrap();
        assert!(matches!(
            s.message,
            PeerMessage::YtSyncState {
                video_id: None,
                nothing_playing: Some(true),
                ..
            }
        ));
        let s = Envelope::from_json(r#"{"type":"yt-sync-state","mediaType":"youtube","videoId":"dQw4w9WgXcQ","currentTime":12.5,"isPlaying":true,"isBuffering":false,"queue":[],"skipVotes":["Riya"],"activeVideoTitle":"T"}"#).unwrap();
        assert!(
            matches!(s.message, PeerMessage::YtSyncState { current_time: Some(t), is_playing: Some(true), .. } if (t - 12.5).abs() < 1e-9)
        );
        let q = Envelope::from_json(r#"{"type":"queue-action","action":"next","nextVideoId":null,"nextTitle":"V","remainingQueue":[]}"#).unwrap();
        assert!(matches!(
            q.message,
            PeerMessage::QueueAction {
                next_video_id: None,
                ..
            }
        ));
        let r = Envelope {
            sender: None,
            timestamp: None,
            message: PeerMessage::YtRequestSync,
        }
        .to_json()
        .unwrap();
        assert_eq!(r, r#"{"type":"yt-request-sync"}"#);
        let n = Envelope {
            sender: None,
            timestamp: None,
            message: PeerMessage::YtSyncState {
                video_id: None,
                nothing_playing: Some(true),
                current_time: None,
                is_playing: None,
                queue: None,
                skip_votes: None,
                active_video_title: None,
            },
        }
        .to_json()
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&n).unwrap(),
            serde_json::json!({"type":"yt-sync-state","videoId":null,"nothingPlaying":true})
        );
    }

    #[test]
    fn shared_state_passes_any_shape() {
        let e = Envelope::from_json(
            r#"{"type":"room-state","key":"act:ludo","v":7,"state":{"turn":1,"board":[0,3]}}"#,
        )
        .unwrap();
        assert_eq!(
            e.message,
            PeerMessage::RoomState {
                key: "act:ludo".into(),
                v: 7,
                state: json!({"turn": 1, "board": [0, 3]})
            }
        );
    }

    #[test]
    fn net_topology_report_round_trips() {
        let mut links = std::collections::HashMap::new();
        links.insert(
            "peer-bob".to_owned(),
            PeerLinkMetric {
                rtt_ms: 45.2,
                candidate_type: "srflx".to_owned(),
                loss_pct: 0.1,
                jitter_ms: 1.5,
                download_kbps: Some(120.0),
                upload_kbps: Some(60.0),
            },
        );
        let e = Envelope {
            sender: Some("Alice".to_owned()),
            timestamp: Some(10.0),
            message: PeerMessage::NetTopologyReport {
                from: Some(PeerId::new("alice").unwrap()),
                links,
            },
        };
        let json_str = e.to_json().unwrap();
        let back = Envelope::from_json(&json_str).unwrap();
        assert_eq!(back, e);
    }

    proptest::proptest! {
        /// Whatever arrives, reading it never panics.
        #[test]
        fn never_panics_on_input(s in ".*") {
            let _ = Envelope::from_json(&s);
            let _ = crate::signaling::ServerMessage::from_json(&s);
        }

        /// Chat survives a round trip with any text and name.
        #[test]
        fn chat_round_trips(text in ".*", sender in ".{1,40}", id in "[a-z0-9]{1,16}") {
            let e = Envelope { sender: Some(sender), timestamp: Some(5.0),
                               message: PeerMessage::Chat { id, is_host: false, text, reply_to: None, mentions: Vec::new() } };
            let back = Envelope::from_json(&e.to_json().unwrap()).unwrap();
            proptest::prop_assert_eq!(back, e);
        }
    }
}
