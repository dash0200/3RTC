//! Sharing a video file from this computer (`utils/p2pStreamer.ts`, `useStreamTransfer.ts`).
//!
//! A viewer without the file asks for it (`p2p-stream-request`); the owner answers with a
//! header and then serves 256 KB blocks as the viewer's player asks for them (range mode):
//! `p2p-range-request` / `p2p-range-cancel` in JSON, the block's bytes as binary `RNG1` packets
//! on the bulk channel (16-byte header, 16 KB payload each). In bigger rooms viewers pass blocks
//! on to each other: a relay tree kept by the owner (`via` in the header), or a swarm where
//! blocks from other viewers are checked against the owner's SHA-256 (`p2p-hash-request`).
//! Browsers that can't play on demand get the whole file pushed in 16 KB chunks instead.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bytes in a block (range mode).
pub const RANGE_BLOCK_SIZE: u32 = 256 * 1024;
/// `RNG1`: a range packet.
pub const RANGE_PACKET_MAGIC: u32 = 0x524E_4731;
/// The range packet's header: magic, stream number, block, offset (big-endian `u32`s).
pub const RANGE_HEADER_BYTES: usize = 16;
/// Bytes of a block in one packet.
pub const RANGE_PACKET_PAYLOAD: usize = 16_384;
/// Chunk size of the whole-file push.
pub const STREAM_CHUNK_SIZE: usize = 16_384;
/// Viewers fed by the owner, or by one relaying viewer (`streamTree.ts`).
pub const RELAY_FANOUT: usize = 2;
/// Most blocks one hash request may ask for.
pub const MAX_HASH_BLOCKS: usize = 512;

/// The MIME type the web app gives a file by its name (`getVideoMimeType`).
#[must_use]
pub fn mime_for(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if n.ends_with(".webm") {
        "video/webm"
    } else if n.ends_with(".mov") {
        "video/quicktime"
    } else {
        // .mp4, .m4v, and .mkv too (the web app plays MKV as MP4)
        "video/mp4"
    }
}

/// Blocks in a file of `size` bytes.
#[must_use]
pub fn block_count(size: u64, block_size: u32) -> u32 {
    if block_size == 0 {
        return 0;
    }
    u32::try_from(size.div_ceil(u64::from(block_size))).unwrap_or(u32::MAX)
}

/// A range packet's header and payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangePacket<'a> {
    /// The stream it belongs to.
    pub stream_no: u32,
    /// Block index.
    pub block: u32,
    /// Where in the block the payload goes.
    pub offset: u32,
    /// The bytes.
    pub payload: &'a [u8],
}

/// Builds a range packet.
#[must_use]
pub fn pack_range(stream_no: u32, block: u32, offset: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(RANGE_HEADER_BYTES + payload.len());
    out.extend_from_slice(&RANGE_PACKET_MAGIC.to_be_bytes());
    out.extend_from_slice(&stream_no.to_be_bytes());
    out.extend_from_slice(&block.to_be_bytes());
    out.extend_from_slice(&offset.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn be(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Reads a range packet (`None`: not one).
#[must_use]
pub fn parse_range(bytes: &[u8]) -> Option<RangePacket<'_>> {
    if bytes.len() < RANGE_HEADER_BYTES || be(bytes, 0)? != RANGE_PACKET_MAGIC {
        return None;
    }
    Some(RangePacket {
        stream_no: be(bytes, 4)?,
        block: be(bytes, 8)?,
        offset: be(bytes, 12)?,
        payload: &bytes[RANGE_HEADER_BYTES..],
    })
}

/// A whole-file chunk: its index (big-endian) and bytes.
#[must_use]
pub fn pack_chunk(index: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&index.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// A list of block numbers as the web app sends them (`b >>> 0`; anything odd is dropped).
fn blocks<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<u32>, D::Error> {
    let v = Option::<Vec<Value>>::deserialize(d)?.unwrap_or_default();
    Ok(v.iter().filter_map(as_u32).collect())
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn as_u32(v: &Value) -> Option<u32> {
    let f = v.as_f64()?;
    (f.is_finite() && f >= 0.0 && f <= f64::from(u32::MAX)).then_some(f as u32)
}

fn number<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    Ok(Option::<Value>::deserialize(d)?
        .as_ref()
        .and_then(as_u32)
        .unwrap_or(0))
}

fn hashes<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<(u32, String)>, D::Error> {
    let v = Option::<Vec<Value>>::deserialize(d)?.unwrap_or_default();
    Ok(v.iter()
        .filter_map(|item| {
            let a = item.as_array()?;
            Some((as_u32(a.first()?)?, a.get(1)?.as_str()?.to_owned()))
        })
        .collect())
}

fn ser_hashes<S: serde::Serializer>(h: &[(u32, String)], s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq;
    let mut seq = s.serialize_seq(Some(h.len()))?;
    for (b, hex) in h {
        seq.serialize_element(&(b, hex))?;
    }
    seq.end()
}

/// The video-sharing messages (`p2p-*`, apart from chat pictures).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamMessage {
    /// A viewer asks for the file playing (broadcast).
    #[serde(rename = "p2p-stream-request", rename_all = "camelCase")]
    Request {
        /// The viewer's name.
        #[serde(default)]
        requester: Option<String>,
        /// The file it wants.
        #[serde(default)]
        file_name: Option<String>,
        /// It can play on demand (range mode); else the whole file is pushed.
        #[serde(default)]
        supports_range: bool,
        /// It can pass the stream on to other viewers.
        #[serde(default)]
        can_relay: bool,
        /// It fetches from other viewers too (swarm).
        #[serde(default)]
        swarm: bool,
    },
    /// The owner starts a stream to a viewer.
    #[serde(rename = "p2p-stream-header", rename_all = "camelCase")]
    Header {
        /// `range` for on demand; absent for the whole-file push.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        /// The stream's number (range mode).
        #[serde(default, deserialize_with = "number")]
        stream_no: u32,
        /// The whole-file push's id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
        /// The file's name.
        #[serde(default)]
        file_name: String,
        /// Its size in bytes.
        #[serde(default)]
        file_size: f64,
        /// Its type (`video/mp4`, …).
        #[serde(default)]
        mime_type: String,
        /// Block size (range mode).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_size: Option<u32>,
        /// Chunk size (whole file).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chunk_size: Option<u32>,
        /// Chunks (whole file).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total_chunks: Option<u32>,
        /// The viewer it's for (whole file).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_peer_id: Option<String>,
        /// Fetch through this viewer (relay tree).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        via: Option<String>,
        /// The owner takes part in a swarm (it answers hash requests).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        swarm: Option<bool>,
        /// The owner's name.
        #[serde(default)]
        sender: Option<String>,
    },
    /// Blocks wanted (the owner, a relay, or a swarm peer serves them).
    #[serde(rename = "p2p-range-request", rename_all = "camelCase")]
    RangeRequest {
        /// The stream.
        #[serde(default, deserialize_with = "number")]
        stream_no: u32,
        /// The blocks.
        #[serde(default, deserialize_with = "blocks")]
        blocks: Vec<u32>,
        /// The player waits for them: before anything else.
        #[serde(default)]
        urgent: bool,
        /// Asked of another viewer (swarm), not the owner.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        swarm: bool,
    },
    /// Blocks no longer needed.
    #[serde(rename = "p2p-range-cancel", rename_all = "camelCase")]
    RangeCancel {
        /// The stream.
        #[serde(default, deserialize_with = "number")]
        stream_no: u32,
        /// The blocks.
        #[serde(default, deserialize_with = "blocks")]
        blocks: Vec<u32>,
        /// Sent to another viewer (swarm).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        swarm: bool,
    },
    /// A viewer doesn't have these blocks (swarm or relay).
    #[serde(rename = "p2p-range-miss", rename_all = "camelCase")]
    RangeMiss {
        /// The stream.
        #[serde(default, deserialize_with = "number")]
        stream_no: u32,
        /// The blocks.
        #[serde(default, deserialize_with = "blocks")]
        blocks: Vec<u32>,
    },
    /// Checksums wanted (asked of the owner).
    #[serde(rename = "p2p-hash-request", rename_all = "camelCase")]
    HashRequest {
        /// The stream.
        #[serde(default, deserialize_with = "number")]
        stream_no: u32,
        /// The blocks.
        #[serde(default, deserialize_with = "blocks")]
        blocks: Vec<u32>,
    },
    /// The owner's checksums: `[block, sha256 hex]` pairs.
    #[serde(rename = "p2p-block-hashes", rename_all = "camelCase")]
    BlockHashes {
        /// The stream.
        #[serde(default, deserialize_with = "number")]
        stream_no: u32,
        /// The checksums.
        #[serde(default, deserialize_with = "hashes", serialize_with = "ser_hashes")]
        hashes: Vec<(u32, String)>,
    },
    /// The whole-file push is done.
    #[serde(rename = "p2p-stream-complete", rename_all = "camelCase")]
    Complete {
        /// The push.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
    },
    /// The owner stopped sharing, or a viewer stopped receiving.
    #[serde(rename = "p2p-stream-cancel", rename_all = "camelCase")]
    Cancel {
        /// The stream.
        #[serde(default, deserialize_with = "number")]
        stream_no: u32,
    },
    /// A relaying viewer stopped: fetch from the owner.
    #[serde(rename = "p2p-relay-gone", rename_all = "camelCase")]
    RelayGone {
        /// The stream.
        #[serde(default, deserialize_with = "number")]
        stream_no: u32,
    },
    /// A swarm peer stopped serving.
    #[serde(rename = "p2p-swarm-gone", rename_all = "camelCase")]
    SwarmGone {
        /// The stream.
        #[serde(default, deserialize_with = "number")]
        stream_no: u32,
    },
    /// Which blocks a swarm viewer holds (this app doesn't swarm: read and ignored).
    #[serde(rename = "p2p-have")]
    Have,
}

impl StreamMessage {
    /// Reads a data-channel message if it's one of these (`None`: another kind, or broken).
    #[must_use]
    pub fn from_json(text: &str) -> Option<Self> {
        // cheap check first: most messages are something else
        if !text.contains("\"p2p-") || text.contains("\"p2p-image-start\"") {
            return None;
        }
        serde_json::from_str(text).ok()
    }

    /// The JSON to send, with `sender` (if the message has none) and `timestamp` as the web
    /// app's bus adds them.
    ///
    /// # Errors
    /// Never in practice (the values always serialize).
    pub fn to_json(&self, sender: &str, timestamp: f64) -> Result<String, serde_json::Error> {
        let mut v = serde_json::to_value(self)?;
        if let Value::Object(map) = &mut v {
            if !map.get("sender").is_some_and(Value::is_string) {
                map.insert("sender".to_owned(), Value::String(sender.to_owned()));
            }
            if let Some(n) = serde_json::Number::from_f64(timestamp) {
                map.insert("timestamp".to_owned(), Value::Number(n));
            }
        }
        serde_json::to_string(&v)
    }
}

/// What's in a shared video file, and its subtitle tracks (`features/files/useFileFormat.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum FileMessage {
    /// The sharer: what's inside the file (to everyone, and to newcomers).
    #[serde(rename = "file-format", rename_all = "camelCase")]
    Format {
        /// The file.
        #[serde(default)]
        file_name: String,
        /// Its size.
        #[serde(default)]
        file_size: f64,
        /// Container, codecs, tracks (`formats.ts`'s format object).
        #[serde(default)]
        format: Value,
    },
    /// A viewer: whether it can play that.
    #[serde(rename = "file-format-report", rename_all = "camelCase")]
    Report {
        /// The file.
        #[serde(default)]
        file_name: String,
        /// `ok`, `maybe`, `no-video` or `no-audio`.
        #[serde(default)]
        verdict: String,
        /// Why, for people.
        #[serde(default)]
        message: String,
        /// "Chrome on Windows".
        #[serde(default)]
        device: String,
    },
    /// A viewer: please share subtitle track `track` from inside the file.
    #[serde(rename = "file-subtitle-request", rename_all = "camelCase")]
    SubtitleRequest {
        /// The file.
        #[serde(default)]
        file_name: String,
        /// The track's number.
        #[serde(default)]
        track: u64,
    },
    /// The sharer: how reading that track is going.
    #[serde(rename = "file-subtitle-progress", rename_all = "camelCase")]
    SubtitleProgress {
        /// The file.
        #[serde(default)]
        file_name: String,
        /// The track's number.
        #[serde(default)]
        track: u64,
        /// 0–1.
        #[serde(default)]
        progress: f64,
        /// Finished (the subtitles follow as `subtitle-share`).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        done: bool,
        /// Why it failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

impl FileMessage {
    /// Reads a data-channel message if it's one of these.
    #[must_use]
    pub fn from_json(text: &str) -> Option<Self> {
        if !text.contains("\"file-format") && !text.contains("\"file-subtitle-") {
            return None;
        }
        serde_json::from_str(text).ok()
    }

    /// The JSON to send, with `sender` and `timestamp`.
    ///
    /// # Errors
    /// Never in practice.
    pub fn to_json(&self, sender: &str, timestamp: f64) -> Result<String, serde_json::Error> {
        let mut v = serde_json::to_value(self)?;
        if let Value::Object(map) = &mut v {
            map.insert("sender".to_owned(), Value::String(sender.to_owned()));
            if let Some(n) = serde_json::Number::from_f64(timestamp) {
                map.insert("timestamp".to_owned(), Value::Number(n));
            }
        }
        serde_json::to_string(&v)
    }
}

/// Screen sharing (`useScreenShare.ts`, `ScreenPointerOverlay.tsx`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ScreenMessage {
    /// Someone started or stopped sharing their screen (to everyone, and to newcomers).
    #[serde(rename = "screen-share-status", rename_all = "camelCase")]
    Status {
        /// Sharing now.
        #[serde(default)]
        is_sharing: bool,
        /// Who.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        peer_id: Option<String>,
        /// Their name.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username: Option<String>,
        /// With sound.
        #[serde(default)]
        has_audio: bool,
    },
    /// A laser pointer over the shared screen, 0–1 across and down.
    #[serde(rename = "screen-pointer", rename_all = "camelCase")]
    Pointer {
        /// Whose.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        peer_id: Option<String>,
        /// Across.
        #[serde(default)]
        x: f64,
        /// Down.
        #[serde(default)]
        y: f64,
        /// Their name.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username: Option<String>,
        /// `false`: the pointer left the screen.
        #[serde(default = "yes")]
        active: bool,
    },
    /// A click on the shared screen (a ripple there).
    #[serde(rename = "screen-ping", rename_all = "camelCase")]
    Ping {
        /// Unique.
        #[serde(default)]
        id: String,
        /// Across.
        #[serde(default)]
        x: f64,
        /// Down.
        #[serde(default)]
        y: f64,
        /// Their name.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username: Option<String>,
        /// The ripple's colour.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        /// Whose.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        peer_id: Option<String>,
    },
    /// Desktop viewer → the desktop sharing: the tallest picture it wants (0: whatever is sent).
    /// The web app neither sends nor reads it.
    #[serde(rename = "screen-quality", rename_all = "camelCase")]
    Quality {
        /// Lines (1080 for 1080p); 0 for no limit.
        #[serde(default)]
        max_height: u32,
    },
    /// Remote control, desktop to desktop only (the web app neither sends nor reads it): asking
    /// for, offering, giving and taking back control of the shared screen. See [`ControlAction`].
    #[serde(rename = "screen-control", rename_all = "camelCase")]
    Control {
        /// What happens.
        action: ControlAction,
        /// `state`: who controls the screen now (absent: nobody).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        peer_id: Option<String>,
        /// `state`: their name.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username: Option<String>,
    },
    /// Remote control: the controlling viewer's mouse or key, for the sharer to play back.
    /// Ignored unless the sender was given control.
    #[serde(rename = "screen-input")]
    Input(ScreenInput),
}

/// `screen-control` actions. Viewer → sharer: `request`, `cancel` (the request), `accept` or
/// `decline` (an offer), `release` (stop controlling). Sharer → viewer: `offer`, `grant`, `deny`,
/// `revoke` (control taken back, or the offer withdrawn); `state` to every desktop viewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ControlAction {
    /// May I control your screen?
    Request,
    /// Never mind (the request).
    Cancel,
    /// Yes please (to an offer).
    Accept,
    /// No thanks (to an offer).
    Decline,
    /// I stop controlling.
    Release,
    /// Would you like to control my screen?
    Offer,
    /// You control my screen now.
    Grant,
    /// No (to a request).
    Deny,
    /// You don't control my screen any more (or the offer is withdrawn).
    Revoke,
    /// Who controls my screen now (`peerId`, `username`; absent: nobody).
    State,
    /// An action from a newer app: ignored.
    #[serde(other)]
    Other,
}

/// `screen-input`: one mouse or keyboard event over the shared picture. `x`, `y` are 0–1 across
/// and down the picture; `button` 0 left, 1 middle, 2 right; wheel `dx`, `dy` in 1/120ths of a
/// notch (up and right positive); `vk` a Windows virtual-key code.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct ScreenInput {
    /// `move`, `button`, `wheel` or `key`.
    pub e: InputKind,
    /// Across, 0–1.
    #[serde(default)]
    pub x: f64,
    /// Down, 0–1.
    #[serde(default)]
    pub y: f64,
    /// `button`: which.
    #[serde(default, skip_serializing_if = "is_zero_u8")]
    pub button: u8,
    /// `button`, `key`: pressed (else let go).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub down: bool,
    /// `wheel`: sideways.
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub dx: i32,
    /// `wheel`: up and down.
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub dy: i32,
    /// `key`: the key.
    #[serde(default, skip_serializing_if = "is_zero_u16")]
    pub vk: u16,
}

/// What a [`ScreenInput`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputKind {
    /// The pointer moved.
    #[default]
    Move,
    /// A mouse button.
    Button,
    /// The wheel.
    Wheel,
    /// A key.
    Key,
    /// From a newer app: ignored.
    #[serde(other)]
    Other,
}

const fn is_zero_u8(v: &u8) -> bool {
    *v == 0
}

const fn is_zero_u16(v: &u16) -> bool {
    *v == 0
}

const fn is_zero_i32(v: &i32) -> bool {
    *v == 0
}

const fn yes() -> bool {
    true
}

impl ScreenMessage {
    /// Reads a data-channel message if it's one of these.
    #[must_use]
    pub fn from_json(text: &str) -> Option<Self> {
        if !text.contains("\"screen-") {
            return None;
        }
        serde_json::from_str(text).ok()
    }

    /// The JSON to send, with `sender` and `timestamp`.
    ///
    /// # Errors
    /// Never in practice.
    pub fn to_json(&self, sender: &str, timestamp: f64) -> Result<String, serde_json::Error> {
        let mut v = serde_json::to_value(self)?;
        if let Value::Object(map) = &mut v {
            map.insert("sender".to_owned(), Value::String(sender.to_owned()));
            if let Some(n) = serde_json::Number::from_f64(timestamp) {
                map.insert("timestamp".to_owned(), Value::Number(n));
            }
        }
        serde_json::to_string(&v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_control_messages_round_trip() {
        let m = ScreenMessage::Control {
            action: ControlAction::State,
            peer_id: Some("p2".into()),
            username: Some("Asha".into()),
        };
        let json = m.to_json("Darshan", 5.0).unwrap();
        assert!(
            json.contains(r#""type":"screen-control""#) && json.contains(r#""action":"state""#),
            "{json}"
        );
        assert_eq!(ScreenMessage::from_json(&json), Some(m));
        let i = ScreenMessage::Input(ScreenInput {
            e: InputKind::Button,
            x: 0.25,
            y: 0.75,
            button: 2,
            down: true,
            ..ScreenInput::default()
        });
        let json = i.to_json("Asha", 6.0).unwrap();
        assert!(
            json.contains(r#""type":"screen-input""#) && json.contains(r#""e":"button""#),
            "{json}"
        );
        assert!(!json.contains("\"vk\""), "unused fields are left out: {json}");
        assert_eq!(ScreenMessage::from_json(&json), Some(i));
        // from a newer app: still read, the new parts ignored
        assert!(matches!(
            ScreenMessage::from_json(r#"{"type":"screen-control","action":"teleport"}"#),
            Some(ScreenMessage::Control {
                action: ControlAction::Other,
                ..
            })
        ));
        assert!(matches!(
            ScreenMessage::from_json(r#"{"type":"screen-input","e":"pen","x":0.5}"#),
            Some(ScreenMessage::Input(ScreenInput {
                e: InputKind::Other,
                ..
            }))
        ));
    }

    #[test]
    fn range_packets_round_trip() {
        let p = pack_range(0xDEAD_BEEF, 7, 16_384, b"abc");
        assert_eq!(&p[..4], b"RNG1");
        let r = parse_range(&p).unwrap();
        assert_eq!(
            (r.stream_no, r.block, r.offset, r.payload),
            (0xDEAD_BEEF, 7, 16_384, &b"abc"[..])
        );
        assert!(parse_range(b"IMG1............x").is_none());
        assert!(parse_range(b"RNG1").is_none());
    }

    #[test]
    fn reads_the_web_apps_messages() {
        let m = StreamMessage::from_json(
            r#"{"type":"p2p-stream-request","requester":"Riya","fileName":"a.mkv","supportsRange":true,"canRelay":true,"swarm":true,"sender":"Riya","timestamp":1}"#,
        );
        assert!(matches!(
            m,
            Some(StreamMessage::Request {
                supports_range: true,
                can_relay: true,
                swarm: true,
                ..
            })
        ));
        let h = StreamMessage::from_json(
            r#"{"type":"p2p-stream-header","mode":"range","streamNo":4294967295,"fileName":"a.mp4","fileSize":1000,"mimeType":"video/mp4","blockSize":262144,"sender":"Riya","timestamp":2,"via":"p9"}"#,
        );
        assert!(
            matches!(h, Some(StreamMessage::Header { stream_no: u32::MAX, ref via, .. }) if via.as_deref() == Some("p9"))
        );
        let r = StreamMessage::from_json(
            r#"{"type":"p2p-range-request","streamNo":5,"blocks":[1,2,-1,"x",3],"urgent":true}"#,
        );
        assert_eq!(
            r,
            Some(StreamMessage::RangeRequest {
                stream_no: 5,
                blocks: vec![1, 2, 3],
                urgent: true,
                swarm: false
            })
        );
        let x =
            StreamMessage::from_json(r#"{"type":"p2p-block-hashes","streamNo":5,"hashes":[[1,"ab"],[2]]}"#);
        assert_eq!(
            x,
            Some(StreamMessage::BlockHashes {
                stream_no: 5,
                hashes: vec![(1, "ab".into())]
            })
        );
        assert!(StreamMessage::from_json(r#"{"type":"p2p-have","streamNo":5,"ranges":[0,3]}"#).is_some());
        assert!(StreamMessage::from_json(r#"{"type":"p2p-image-start","transferId":"t"}"#).is_none());
        assert!(StreamMessage::from_json(r#"{"type":"chat","text":"p2p-"}"#).is_none());
    }

    #[test]
    fn writes_what_the_web_app_reads() {
        let v: Value = serde_json::from_str(
            &StreamMessage::RangeRequest {
                stream_no: 9,
                blocks: vec![3],
                urgent: false,
                swarm: false,
            }
            .to_json("Dash", 5.0)
            .unwrap(),
        )
        .unwrap();
        assert_eq!(v["type"], "p2p-range-request");
        assert_eq!(v["streamNo"], 9);
        assert_eq!(v["blocks"][0], 3);
        assert_eq!(v["sender"], "Dash");
        assert!(v.get("swarm").is_none());
        let h: Value = serde_json::from_str(
            &StreamMessage::BlockHashes {
                stream_no: 9,
                hashes: vec![(3, "ff".into())],
            }
            .to_json("Dash", 5.0)
            .unwrap(),
        )
        .unwrap();
        assert_eq!(h["hashes"][0][0], 3);
        assert_eq!(h["hashes"][0][1], "ff");
    }

    #[test]
    fn file_format_messages() {
        let m = FileMessage::from_json(
            r#"{"type":"file-format-report","fileName":"a.mkv","verdict":"no-audio","message":"m","device":"Chrome on Windows","sender":"Riya"}"#,
        );
        assert!(matches!(m, Some(FileMessage::Report { ref verdict, .. }) if verdict == "no-audio"));
        let r = FileMessage::from_json(r#"{"type":"file-subtitle-request","fileName":"a.mkv","track":4}"#);
        assert!(matches!(r, Some(FileMessage::SubtitleRequest { track: 4, .. })));
        let v: Value = serde_json::from_str(
            &FileMessage::Format {
                file_name: "a.mkv".into(),
                file_size: 5.0,
                format: serde_json::json!({ "container": "matroska" }),
            }
            .to_json("Dash", 1.0)
            .unwrap(),
        )
        .unwrap();
        assert_eq!(v["type"], "file-format");
        assert_eq!(v["fileName"], "a.mkv");
        assert_eq!(v["format"]["container"], "matroska");
    }

    #[test]
    fn screen_messages() {
        let m = ScreenMessage::from_json(
            r#"{"type":"screen-share-status","isSharing":true,"peerId":"p1","username":"Riya","hasAudio":false,"sender":"Riya"}"#,
        );
        assert!(
            matches!(m, Some(ScreenMessage::Status { is_sharing: true, ref username, .. }) if username.as_deref() == Some("Riya"))
        );
        let p = ScreenMessage::from_json(r#"{"type":"screen-pointer","peerId":"p1","active":false}"#);
        assert!(matches!(p, Some(ScreenMessage::Pointer { active: false, .. })));
        let q = ScreenMessage::from_json(r#"{"type":"screen-pointer","x":0.5,"y":0.25,"username":"R"}"#);
        assert!(matches!(q, Some(ScreenMessage::Pointer { active: true, .. })));
        let wanted = ScreenMessage::Quality { max_height: 1080 }
            .to_json("Darshan", 1.0)
            .unwrap_or_default();
        assert!(wanted.contains(r#""type":"screen-quality""#) && wanted.contains(r#""maxHeight":1080"#));
        assert!(matches!(
            ScreenMessage::from_json(&wanted),
            Some(ScreenMessage::Quality { max_height: 1080 })
        ));
    }

    #[test]
    fn names_and_counts() {
        assert_eq!(mime_for("A.MKV"), "video/mp4");
        assert_eq!(mime_for("x.webm"), "video/webm");
        assert_eq!(block_count(0, RANGE_BLOCK_SIZE), 0);
        assert_eq!(block_count(1, RANGE_BLOCK_SIZE), 1);
        assert_eq!(
            block_count(u64::from(RANGE_BLOCK_SIZE) * 3 + 1, RANGE_BLOCK_SIZE),
            4
        );
    }
}
