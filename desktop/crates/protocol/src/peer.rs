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
    },
    /// My mic was muted or unmuted.
    #[serde(rename_all = "camelCase")]
    PeerVoiceStatus {
        /// My peer id.
        peer_id: PeerId,
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
    },
    /// A floating emoji reaction.
    Reaction {
        /// Unique id.
        id: String,
        /// One emoji.
        emoji: String,
        /// Which lane it floats up in.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lane: Option<u32>,
        /// Combo count.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        combo: Option<u32>,
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
    /// A message type this app doesn't handle: ignored (protocol rule 1).
    #[serde(other, skip_serializing)]
    Unknown,
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
                text: "hi".into()
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
            },
        };
        let v: Value = serde_json::from_str(&e.to_json().unwrap()).unwrap();
        assert_eq!(
            v,
            json!({"type": "chat", "id": "m2", "isHost": true, "text": "hello", "sender": "Darshan"})
        );
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
                               message: PeerMessage::Chat { id, is_host: false, text } };
            let back = Envelope::from_json(&e.to_json().unwrap()).unwrap();
            proptest::prop_assert_eq!(back, e);
        }
    }
}
