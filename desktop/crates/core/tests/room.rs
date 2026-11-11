//! The room rules, end to end, with no network.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stderr)] // tests: failing loudly is the point

use rtc_core::{Command, Effect, Identity, Input, Phase, RemoteSignal, Room, UiEvent};
use rtc_protocol::peer::{Envelope, PeerMessage};
use rtc_protocol::sdp::{SdpType, SessionDescription};
use rtc_protocol::signaling::{ClientMessage, ErrorCode, ServerMessage};
use rtc_protocol::{ClientId, PeerId, RoomId};

fn pid(s: &str) -> PeerId {
    PeerId::new(s).unwrap()
}

fn room_id() -> RoomId {
    RoomId::parse("12345").unwrap()
}

fn me() -> Room {
    Room::new(Identity {
        peer_id: pid("me"),
        client_id: ClientId::new("cid-me").unwrap(),
        username: "Darshan".into(),
        build: "261111.1200".into(),
    })
}

fn hosting() -> Room {
    let mut r = me();
    r.update(Input::Command(Command::CreateRoom), 0.0);
    r.update(
        Input::Server(ServerMessage::RoomCreated {
            room_id: room_id(),
            peer_id: pid("me"),
            host_peer_id: pid("me"),
            seat_token: "seat".into(),
            host_token: "host".into(),
        }),
        0.0,
    );
    r
}

fn identity_of(peer: &str, name: &str, is_reply: bool) -> Envelope {
    Envelope {
        sender: Some(name.into()),
        timestamp: Some(1.0),
        message: PeerMessage::PeerIdentity {
            peer_id: pid(peer),
            username: name.into(),
            is_host: false,
            is_muted: false,
            proto: 2,
            build: None,
            client_id: ClientId::new(format!("cid-{peer}")).unwrap(),
            is_reply,
            playback_lock: None,
            client: None,
        },
    }
}

#[test]
fn create_room_then_host_it() {
    let mut r = me();
    let fx = r.update(Input::Command(Command::CreateRoom), 0.0);
    assert!(matches!(
        &fx[0],
        Effect::Send(ClientMessage::CreateRoom { room_id: None, .. })
    ));
    assert_eq!(r.phase(), &Phase::Creating);
    let r = hosting();
    assert_eq!(r.phase(), &Phase::InRoom(room_id()));
    assert!(r.is_host());
}

#[test]
fn the_one_already_in_the_room_offers() {
    let mut r = hosting();
    let fx = r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid("riya") }),
        0.0,
    );
    assert!(fx.contains(&Effect::OpenPeer {
        peer: pid("riya"),
        initiator: true
    }));
}

#[test]
fn a_joiner_waits_for_offers() {
    let mut r = me();
    r.update(Input::Command(Command::Join(room_id())), 0.0);
    let fx = r.update(
        Input::Server(ServerMessage::Joined {
            room_id: room_id(),
            peer_id: pid("me"),
            peers: vec![pid("host"), pid("riya")],
            host_peer_id: pid("host"),
            seat_token: "s".into(),
            host_token: None,
        }),
        0.0,
    );
    assert!(fx.contains(&Effect::OpenPeer {
        peer: pid("host"),
        initiator: false
    }));
    assert!(fx.contains(&Effect::OpenPeer {
        peer: pid("riya"),
        initiator: false
    }));
    assert!(!r.is_host());
    let offer = SessionDescription {
        kind: SdpType::Offer,
        sdp: "v=0".into(),
    };
    let fx = r.update(
        Input::Server(ServerMessage::Offer {
            from: pid("host"),
            offer: offer.clone(),
            fresh: false,
            ice_restart: false,
        }),
        0.0,
    );
    assert_eq!(
        fx,
        vec![Effect::Signal {
            peer: pid("host"),
            signal: RemoteSignal::Offer { offer, fresh: false }
        }]
    );
}

#[test]
fn identities_are_swapped_once_and_name_the_peer() {
    let mut r = hosting();
    r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid("riya") }),
        0.0,
    );
    let fx = r.update(Input::ChannelOpen(pid("riya")), 5.0);
    let Some(Effect::SendToPeer { envelope, .. }) = fx.first() else {
        panic!("no identity sent: {fx:?}")
    };
    assert!(
        matches!(&envelope.message, PeerMessage::PeerIdentity { is_host: true, is_reply: false, client: Some(c), .. } if c == "desktop")
    );

    // their identity (not a reply) gets our reply; a reply gets nothing back
    let fx = r.update(
        Input::Peer {
            from: pid("riya"),
            envelope: identity_of("riya", "Riya", false),
        },
        6.0,
    );
    assert!(fx.iter().any(|e| matches!(e, Effect::SendToPeer { envelope, .. }
        if matches!(envelope.message, PeerMessage::PeerIdentity { is_reply: true, .. }))));
    assert_eq!(r.members()[&pid("riya")].username.as_deref(), Some("Riya"));
    let fx = r.update(
        Input::Peer {
            from: pid("riya"),
            envelope: identity_of("riya", "Riya", true),
        },
        7.0,
    );
    assert!(!fx.iter().any(|e| matches!(e, Effect::SendToPeer { .. })));
}

#[test]
fn chat_goes_out_and_comes_in_once() {
    let mut r = hosting();
    r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid("riya") }),
        0.0,
    );
    let fx = r.update(
        Input::Command(Command::SendChat {
            id: "m1".into(),
            text: "  hi all ".into(),
        }),
        9.0,
    );
    assert!(fx.iter().any(|e| matches!(e, Effect::Broadcast(Envelope { message: PeerMessage::Chat { text, is_host: true, .. }, .. }) if text == "hi all")));
    let blank = r.update(
        Input::Command(Command::SendChat {
            id: "m2".into(),
            text: "   ".into(),
        }),
        9.0,
    );
    assert!(blank.is_empty());

    let msg = Envelope {
        sender: Some("Riya".into()),
        timestamp: Some(1.0),
        message: PeerMessage::Chat {
            id: "r1".into(),
            is_host: true,
            text: "hey".into(),
        },
    };
    let fx = r.update(
        Input::Peer {
            from: pid("riya"),
            envelope: msg.clone(),
        },
        10.0,
    );
    // she isn't the host, whatever the message claims
    assert!(matches!(&fx[0], Effect::Ui(UiEvent::Chat(line)) if !line.is_host && line.name == "Riya"));
    assert!(
        r.update(
            Input::Peer {
                from: pid("riya"),
                envelope: msg
            },
            11.0
        )
        .is_empty(),
        "duplicate shown twice"
    );
}

#[test]
fn messages_from_strangers_are_ignored() {
    let mut r = hosting();
    let fx = r.update(
        Input::Peer {
            from: pid("ghost"),
            envelope: identity_of("ghost", "Ghost", false),
        },
        0.0,
    );
    assert!(fx.is_empty());
}

#[test]
fn signaling_loss_keeps_a_live_peer() {
    let mut r = hosting();
    r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid("riya") }),
        0.0,
    );
    r.update(Input::ChannelOpen(pid("riya")), 0.0);
    let fx = r.update(
        Input::Server(ServerMessage::PeerLeft { peer_id: pid("riya") }),
        0.0,
    );
    assert!(fx.is_empty());
    assert!(r.members().contains_key(&pid("riya")));
    r.update(Input::ChannelClosed(pid("riya")), 0.0);
    let fx = r.update(
        Input::Server(ServerMessage::PeerLeft { peer_id: pid("riya") }),
        0.0,
    );
    assert!(fx.contains(&Effect::ClosePeer(pid("riya"))));
}

#[test]
fn reconnecting_reclaims_the_seat() {
    let mut r = hosting();
    let fx = r.update(Input::SignalingUp, 0.0);
    assert_eq!(
        fx,
        vec![Effect::Send(ClientMessage::CreateRoom {
            peer_id: pid("me"),
            room_id: Some(room_id()),
            host_token: Some("host".into()),
            seat_token: Some("seat".into()),
        })]
    );
}

#[test]
fn leave_says_bye_and_closes_everything() {
    let mut r = hosting();
    r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid("riya") }),
        0.0,
    );
    let fx = r.update(Input::Command(Command::Leave), 0.0);
    assert!(matches!(
        &fx[0],
        Effect::Broadcast(Envelope {
            message: PeerMessage::PeerBye,
            ..
        })
    ));
    assert!(fx.contains(&Effect::Send(ClientMessage::Leave)));
    assert!(fx.contains(&Effect::ClosePeer(pid("riya"))));
    assert_eq!(r.phase(), &Phase::Idle);
}

#[test]
fn transfer_host_only_when_hosting_and_to_a_member() {
    let mut r = hosting();
    assert!(
        r.update(Input::Command(Command::TransferHost(pid("nobody"))), 0.0)
            .is_empty()
    );
    r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid("riya") }),
        0.0,
    );
    let fx = r.update(Input::Command(Command::TransferHost(pid("riya"))), 0.0);
    assert_eq!(
        fx,
        vec![Effect::Send(ClientMessage::TransferHost {
            target_peer_id: pid("riya")
        })]
    );
    r.update(
        Input::Server(ServerMessage::Host {
            host_peer_id: pid("riya"),
            from: Some(pid("me")),
        }),
        0.0,
    );
    assert!(!r.is_host());
}

#[test]
fn a_full_room_goes_back_to_idle_with_a_notice() {
    let mut r = me();
    r.update(Input::Command(Command::Join(room_id())), 0.0);
    let fx = r.update(
        Input::Server(ServerMessage::Error {
            message: "full".into(),
            code: Some(ErrorCode::RoomFull),
            room_id: None,
        }),
        0.0,
    );
    assert_eq!(r.phase(), &Phase::Idle);
    assert!(fx.contains(&Effect::Ui(UiEvent::Notice("That room is full.".into()))));
}

#[test]
fn mute_is_announced_in_a_room() {
    let mut r = hosting();
    let fx = r.update(Input::Command(Command::SetMuted(true)), 0.0);
    assert!(matches!(
        &fx[0],
        Effect::Broadcast(Envelope {
            message: PeerMessage::PeerVoiceStatus { is_muted: true, .. },
            ..
        })
    ));
    assert!(r.update(Input::Command(Command::SetMuted(true)), 0.0).is_empty());
}

#[test]
fn the_name_can_change_only_between_rooms() {
    let mut r = me();
    r.update(Input::Command(Command::SetName("Dash".into())), 0.0);
    assert_eq!(r.identity().username, "Dash");
    let mut r = hosting();
    r.update(Input::Command(Command::SetName("Other".into())), 0.0);
    assert_eq!(r.identity().username, "Darshan");
}
