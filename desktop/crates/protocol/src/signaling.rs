//! Signaling messages: the app and the signaling server, over a WebSocket.
//!
//! [`ClientMessage`] is what the app sends, [`ServerMessage`] what it receives. Wire names match
//! `server/signaling.js` exactly; see `docs/PROTOCOL.md`, "Signaling messages".

use serde::{Deserialize, Serialize};

use crate::DecodeError;
use crate::ids::{PeerId, RoomId};
use crate::sdp::{IceCandidate, SessionDescription};

/// App → server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    /// Open a new room, or take back a room you host (`room_id` + `host_token`).
    #[serde(rename_all = "camelCase")]
    CreateRoom {
        /// This app's peer id.
        peer_id: PeerId,
        /// The room to resume (with `host_token`).
        #[serde(skip_serializing_if = "Option::is_none")]
        room_id: Option<RoomId>,
        /// Proof you host `room_id`.
        #[serde(skip_serializing_if = "Option::is_none")]
        host_token: Option<String>,
        /// Proof the peer id's seat is yours.
        #[serde(skip_serializing_if = "Option::is_none")]
        seat_token: Option<String>,
    },
    /// Join a room by its code; `rejoin` with a `seat_token` takes your seat back.
    #[serde(rename_all = "camelCase")]
    Join {
        /// The room's code.
        room_id: RoomId,
        /// This app's peer id.
        peer_id: PeerId,
        /// Coming back after a drop.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        rejoin: bool,
        /// Proof the seat is yours.
        #[serde(skip_serializing_if = "Option::is_none")]
        seat_token: Option<String>,
    },
    /// Leave the room on purpose.
    Leave,
    /// Send an SDP offer to one peer.
    #[serde(rename_all = "camelCase")]
    Offer {
        /// Who it's for.
        target_id: PeerId,
        /// The offer.
        offer: SessionDescription,
        /// A brand-new connection (replace any old one).
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        fresh: bool,
        /// An ICE restart of an existing connection.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        ice_restart: bool,
    },
    /// Send an SDP answer to one peer.
    #[serde(rename_all = "camelCase")]
    Answer {
        /// Who it's for.
        target_id: PeerId,
        /// The answer.
        answer: SessionDescription,
    },
    /// Send one ICE candidate to one peer.
    #[serde(rename_all = "camelCase")]
    IceCandidate {
        /// Who it's for.
        target_id: PeerId,
        /// The candidate.
        candidate: IceCandidate,
    },
    /// Keep-alive; the server answers [`ServerMessage::Pong`].
    Ping,
    /// The host makes someone else the host.
    #[serde(rename_all = "camelCase")]
    TransferHost {
        /// The new host.
        target_peer_id: PeerId,
    },
    /// The host changes room topology between mesh and hub.
    #[serde(rename_all = "camelCase")]
    SetTopology {
        /// "mesh" or "hub".
        topology: String,
    },
    /// The host dynamically changes room capacity.
    #[serde(rename_all = "camelCase")]
    SetRoomSize {
        /// Maximum peers allowed in the room.
        max_users: u32,
    },
    /// Ask whether a room exists on this server (answered by [`ServerMessage::RoomFound`]).
    #[serde(rename_all = "camelCase")]
    FindRoom {
        /// The room's code.
        room_id: RoomId,
    },
}

impl ClientMessage {
    /// The JSON text to send.
    ///
    /// # Errors
    /// Only if serialization itself fails, which these types never do in practice.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

/// Why the server refused something (`code` on an `error` message).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// A resume (`create-room` with a host token) was refused.
    ResumeDenied,
    /// That peer id's seat is held by someone else.
    SeatTaken,
    /// The room has the most people it allows.
    RoomFull,
    /// No such room.
    NotFound,
    /// The server can't open a room right now.
    ServerBusy,
    /// Too many messages or join attempts.
    RateLimited,
    /// Only the host can do that.
    NotHost,
    /// The person isn't in the room any more.
    TargetNotFound,
    /// A code this app doesn't know yet.
    #[serde(other)]
    Other,
}

/// Server → app.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMessage {
    /// Your new room is open; you're its host.
    #[serde(rename_all = "camelCase")]
    RoomCreated {
        /// The room's code.
        room_id: RoomId,
        /// Your peer id.
        peer_id: PeerId,
        /// The host (you).
        host_peer_id: PeerId,
        /// Keep: proves your seat on a rejoin.
        seat_token: String,
        /// Keep: proves you host the room.
        host_token: String,
        /// Room topology ("mesh" or "hub").
        #[serde(default)]
        topology: Option<String>,
        /// Configured room capacity.
        #[serde(default)]
        max_users: Option<u32>,
    },
    /// You got your room back as its host.
    #[serde(rename_all = "camelCase")]
    RoomResumed {
        /// The room's code.
        room_id: RoomId,
        /// Your peer id.
        peer_id: PeerId,
        /// Everyone else in the room.
        peers: Vec<PeerId>,
        /// The host (you).
        host_peer_id: PeerId,
        /// Keep: proves your seat.
        seat_token: String,
        /// Keep: proves you host the room.
        host_token: String,
        /// Room topology ("mesh" or "hub").
        #[serde(default)]
        topology: Option<String>,
        /// Configured room capacity.
        #[serde(default)]
        max_users: Option<u32>,
    },
    /// You're in.
    #[serde(rename_all = "camelCase")]
    Joined {
        /// The room's code.
        room_id: RoomId,
        /// Your peer id.
        peer_id: PeerId,
        /// Everyone else in the room (they'll offer to you).
        peers: Vec<PeerId>,
        /// The host.
        host_peer_id: PeerId,
        /// Keep: proves your seat on a rejoin.
        seat_token: String,
        /// Present when you are the host (after a host handover).
        #[serde(default)]
        host_token: Option<String>,
        /// Room topology ("mesh" or "hub").
        #[serde(default)]
        topology: Option<String>,
        /// Configured room capacity.
        #[serde(default)]
        max_users: Option<u32>,
    },
    /// The host changed.
    #[serde(rename_all = "camelCase")]
    Host {
        /// The new host.
        host_peer_id: PeerId,
        /// Who handed it on (a transfer), if anyone.
        #[serde(default)]
        from: Option<PeerId>,
        /// Why, when not a transfer: `host-left` (the host left and didn't come back in time, so
        /// the server made whoever was in the room longest the host).
        #[serde(default)]
        reason: Option<String>,
    },
    /// You're the new host: your host token.
    #[serde(rename_all = "camelCase")]
    HostToken {
        /// The room's code.
        room_id: RoomId,
        /// Keep: proves you host the room.
        host_token: String,
    },
    /// Room topology changed between mesh and hub.
    #[serde(rename_all = "camelCase")]
    TopologyChanged {
        /// "mesh" or "hub".
        topology: String,
        /// The host's peer id.
        host_peer_id: PeerId,
    },
    /// Room capacity changed.
    #[serde(rename_all = "camelCase")]
    RoomSizeChanged {
        /// Maximum peers allowed in the room.
        max_users: u32,
        /// Who changed it.
        #[serde(default)]
        from: Option<PeerId>,
    },
    /// Someone joined: offer to them.
    #[serde(rename_all = "camelCase")]
    PeerJoined {
        /// Who.
        peer_id: PeerId,
    },
    /// Someone left (on purpose, or their connection to the server timed out).
    #[serde(rename_all = "camelCase")]
    PeerLeft {
        /// Who.
        peer_id: PeerId,
    },
    /// You left.
    Left,
    /// An SDP offer from a peer.
    #[serde(rename_all = "camelCase")]
    Offer {
        /// Who sent it.
        from: PeerId,
        /// The offer.
        offer: SessionDescription,
        /// A brand-new connection (replace any old one).
        #[serde(default)]
        fresh: bool,
        /// An ICE restart.
        #[serde(default)]
        ice_restart: bool,
    },
    /// An SDP answer from a peer.
    #[serde(rename_all = "camelCase")]
    Answer {
        /// Who sent it.
        from: PeerId,
        /// The answer.
        answer: SessionDescription,
    },
    /// An ICE candidate from a peer.
    #[serde(rename_all = "camelCase")]
    IceCandidate {
        /// Who sent it.
        from: PeerId,
        /// The candidate.
        candidate: IceCandidate,
    },
    /// Answer to [`ClientMessage::Ping`].
    Pong,
    /// Answer to [`ClientMessage::FindRoom`].
    #[serde(rename_all = "camelCase")]
    RoomFound {
        /// The room asked about.
        room_id: RoomId,
        /// Whether it's open on this server.
        exists: bool,
    },
    /// Something was refused.
    #[serde(rename_all = "camelCase")]
    Error {
        /// For people.
        message: String,
        /// For code; absent on older or generic errors.
        #[serde(default)]
        code: Option<ErrorCode>,
        /// The room it's about, when there is one.
        #[serde(default)]
        room_id: Option<RoomId>,
    },
    /// A message type this app doesn't know: ignored (protocol rule 1).
    #[serde(other)]
    Unknown,
}

impl ServerMessage {
    /// Reads one message from the server.
    ///
    /// # Errors
    /// [`DecodeError`] if it isn't a JSON object with a `type`, or a known type has the wrong
    /// shape. Unknown types are not errors: they come back as [`ServerMessage::Unknown`].
    pub fn from_json(text: &str) -> Result<Self, DecodeError> {
        let value: serde_json::Value = serde_json::from_str(text)?;
        if !value.get("type").is_some_and(serde_json::Value::is_string) {
            return Err(DecodeError::NoType);
        }
        Ok(serde_json::from_value(value)?)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::sdp::SdpType;

    fn pid(s: &str) -> PeerId {
        PeerId::new(s).unwrap()
    }

    #[test]
    fn join_matches_the_web_app() {
        let m = ClientMessage::Join {
            room_id: RoomId::parse("12345").unwrap(),
            peer_id: pid("p1"),
            rejoin: false,
            seat_token: None,
        };
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            json!({"type": "join", "roomId": "12345", "peerId": "p1"})
        );
        let r = ClientMessage::Join {
            room_id: RoomId::parse("12345").unwrap(),
            peer_id: pid("p1"),
            rejoin: true,
            seat_token: Some("v1.x".into()),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"type": "join", "roomId": "12345", "peerId": "p1", "rejoin": true, "seatToken": "v1.x"})
        );
    }

    #[test]
    fn offer_and_candidate_use_browser_shapes() {
        let o = ClientMessage::Offer {
            target_id: pid("p2"),
            offer: SessionDescription {
                kind: SdpType::Offer,
                sdp: "v=0".into(),
            },
            fresh: true,
            ice_restart: false,
        };
        assert_eq!(
            serde_json::to_value(&o).unwrap(),
            json!({"type": "offer", "targetId": "p2", "offer": {"type": "offer", "sdp": "v=0"}, "fresh": true})
        );
        let c = ClientMessage::IceCandidate {
            target_id: pid("p2"),
            candidate: IceCandidate {
                candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host".into(),
                sdp_mid: Some("0".into()),
                sdp_m_line_index: Some(0),
                username_fragment: None,
            },
        };
        assert_eq!(
            serde_json::to_value(&c).unwrap(),
            json!({"type": "ice-candidate", "targetId": "p2",
                   "candidate": {"candidate": "candidate:1 1 udp 1 1.2.3.4 5 typ host", "sdpMid": "0", "sdpMLineIndex": 0}})
        );
    }

    #[test]
    fn small_messages() {
        assert_eq!(ClientMessage::Ping.to_json().unwrap(), r#"{"type":"ping"}"#);
        assert_eq!(ClientMessage::Leave.to_json().unwrap(), r#"{"type":"leave"}"#);
        let t = ClientMessage::TransferHost {
            target_peer_id: pid("p9"),
        };
        assert_eq!(
            serde_json::to_value(&t).unwrap(),
            json!({"type": "transfer-host", "targetPeerId": "p9"})
        );
    }

    #[test]
    fn topology_messages_round_trip() {
        let set = ClientMessage::SetTopology {
            topology: "hub".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(&set).unwrap(),
            json!({"type": "set-topology", "topology": "hub"})
        );

        let changed =
            ServerMessage::from_json(r#"{"type":"topology-changed","topology":"hub","hostPeerId":"host-1"}"#)
                .unwrap();
        assert_eq!(
            changed,
            ServerMessage::TopologyChanged {
                topology: "hub".to_owned(),
                host_peer_id: pid("host-1"),
            }
        );
    }

    #[test]
    fn reads_what_the_server_sends() {
        let m = ServerMessage::from_json(
            r#"{"type":"joined","roomId":"54321","peerId":"me","peers":["a","b"],"hostPeerId":"a","seatToken":"s"}"#,
        )
        .unwrap();
        assert_eq!(
            m,
            ServerMessage::Joined {
                room_id: RoomId::parse("54321").unwrap(),
                peer_id: pid("me"),
                peers: vec![pid("a"), pid("b")],
                host_peer_id: pid("a"),
                seat_token: "s".into(),
                host_token: None,
                topology: None,
                max_users: None,
            }
        );
        let h = ServerMessage::from_json(r#"{"type":"host","hostPeerId":"b","from":"a"}"#).unwrap();
        assert_eq!(
            h,
            ServerMessage::Host {
                host_peer_id: pid("b"),
                from: Some(pid("a")),
                reason: None
            }
        );
        let left =
            ServerMessage::from_json(r#"{"type":"host","hostPeerId":"b","reason":"host-left"}"#).unwrap();
        assert_eq!(
            left,
            ServerMessage::Host {
                host_peer_id: pid("b"),
                from: None,
                reason: Some("host-left".to_owned())
            }
        );
    }

    #[test]
    fn unknown_types_and_fields_are_ignored() {
        assert_eq!(
            ServerMessage::from_json(r#"{"type":"hologram","x":1}"#).unwrap(),
            ServerMessage::Unknown
        );
        assert_eq!(
            ServerMessage::from_json(r#"{"type":"pong","serverTime":123,"region":"eu"}"#).unwrap(),
            ServerMessage::Pong
        );
        let e =
            ServerMessage::from_json(r#"{"type":"error","message":"no","code":"brand-new-code"}"#).unwrap();
        assert_eq!(
            e,
            ServerMessage::Error {
                message: "no".into(),
                code: Some(ErrorCode::Other),
                room_id: None
            }
        );
    }

    #[test]
    fn error_codes() {
        let e = ServerMessage::from_json(
            r#"{"type":"error","message":"full","code":"room-full","roomId":"11111"}"#,
        )
        .unwrap();
        assert_eq!(
            e,
            ServerMessage::Error {
                message: "full".into(),
                code: Some(ErrorCode::RoomFull),
                room_id: Some(RoomId::parse("11111").unwrap())
            }
        );
    }

    #[test]
    fn rejects_non_messages() {
        assert!(matches!(
            ServerMessage::from_json("[1,2]"),
            Err(DecodeError::NoType)
        ));
        assert!(matches!(
            ServerMessage::from_json(r#"{"type":5}"#),
            Err(DecodeError::NoType)
        ));
        assert!(matches!(
            ServerMessage::from_json("not json"),
            Err(DecodeError::Malformed(_))
        ));
        assert!(matches!(
            ServerMessage::from_json(r#"{"type":"peer-joined"}"#),
            Err(DecodeError::Malformed(_))
        ));
    }
}
