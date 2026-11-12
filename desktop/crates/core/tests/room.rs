//! The room rules, end to end, with no network.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stderr)] // tests: failing loudly is the point

use rtc_core::{Command, Effect, Identity, Input, LinkState, Phase, RemoteSignal, Room, UiEvent, clean_name};
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
    // her name comes from her identity on this connection, not from the message's `sender`
    assert!(matches!(&fx[0], Effect::Ui(UiEvent::Chat(line)) if !line.is_host && line.name == "Someone"));
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
    connected_to(&mut r, "riya");
    let fx = r.update(
        Input::Server(ServerMessage::PeerLeft { peer_id: pid("riya") }),
        0.0,
    );
    assert!(fx.is_empty());
    assert!(r.members().contains_key(&pid("riya")));
    // a link that isn't up: she's gone
    r.update(
        Input::Server(ServerMessage::PeerJoined {
            peer_id: pid("arjun"),
        }),
        0.0,
    );
    let fx = r.update(
        Input::Server(ServerMessage::PeerLeft {
            peer_id: pid("arjun"),
        }),
        0.0,
    );
    assert!(fx.contains(&Effect::ClosePeer(pid("arjun"))));
}

#[test]
fn reconnecting_reclaims_the_seat() {
    let mut r = hosting();
    let fx = r.update(
        Input::SignalingUp {
            label: "Local".into(),
            backup: false,
        },
        0.0,
    );
    assert_eq!(
        fx[1],
        Effect::Send(ClientMessage::CreateRoom {
            peer_id: pid("me"),
            room_id: Some(room_id()),
            host_token: Some("host".into()),
            seat_token: Some("seat".into()),
        })
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
    // the server's own words, as the web app shows them
    assert!(fx.contains(&Effect::Ui(UiEvent::Notice("full".into()))));
}

#[test]
fn mute_is_announced_in_a_room() {
    let mut r = hosting();
    assert!(r.muted(), "the mic starts off");
    let fx = r.update(Input::Command(Command::SetMuted(false)), 0.0);
    assert_eq!(fx[0], Effect::SetMic(true));
    assert!(fx.iter().any(|e| matches!(
        e,
        Effect::Broadcast(Envelope {
            message: PeerMessage::PeerVoiceStatus { is_muted: false, .. },
            ..
        })
    )));
    assert!(r.update(Input::Command(Command::SetMuted(false)), 0.0).is_empty());
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

fn connected_to(r: &mut Room, peer: &str) {
    r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid(peer) }),
        0.0,
    );
    r.update(
        Input::Link {
            peer: pid(peer),
            state: LinkState::Connected,
        },
        0.0,
    );
    r.update(Input::ChannelOpen(pid(peer)), 0.0);
}

fn logs(fx: &[Effect]) -> Vec<String> {
    fx.iter()
        .filter_map(|e| {
            if let Effect::Ui(UiEvent::Log(t)) = e {
                Some(t.clone())
            } else {
                None
            }
        })
        .collect()
}

#[test]
fn room_events_go_to_the_logs_in_the_web_apps_words() {
    let mut r = me();
    r.update(Input::Command(Command::CreateRoom), 0.0);
    let fx = r.update(
        Input::Server(ServerMessage::RoomCreated {
            room_id: room_id(),
            peer_id: pid("me"),
            host_peer_id: pid("me"),
            seat_token: "s".into(),
            host_token: "h".into(),
        }),
        0.0,
    );
    assert_eq!(
        logs(&fx),
        vec!["You created room 12345 as \"Darshan\".".to_owned()]
    );
    let fx = r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid("riya") }),
        0.0,
    );
    assert_eq!(
        logs(&fx),
        vec!["A peer entered room 12345. Establishing P2P connection...".to_owned()]
    );
    let fx = r.update(Input::ChannelOpen(pid("riya")), 0.0);
    assert_eq!(
        logs(&fx),
        vec!["Direct Peer-to-Peer DataChannel established. Chat & YouTube Sync is live!".to_owned()]
    );
    assert!(r.chat().is_empty(), "none of that is chat");
}

#[test]
fn a_dropped_link_is_restarted_then_rebuilt_by_the_offering_side() {
    let mut r = hosting();
    r.update(
        Input::SignalingUp {
            label: "Local".into(),
            backup: false,
        },
        0.0,
    );
    connected_to(&mut r, "riya");
    r.update(
        Input::Link {
            peer: pid("riya"),
            state: LinkState::Disconnected,
        },
        1000.0,
    );
    let fx = r.update(Input::Tick, 4500.0);
    assert!(fx.contains(&Effect::IceRestart(pid("riya"))));
    assert_eq!(
        logs(&fx),
        vec!["⚠️ Connection to a peer was interrupted. Reconnecting...".to_owned()]
    );
    let mut t = 4500.0;
    let mut rebuilt = false;
    while t < 60_000.0 && !rebuilt {
        t += 500.0;
        let fx = r.update(Input::Tick, t);
        rebuilt = fx.contains(&Effect::OpenPeer {
            peer: pid("riya"),
            initiator: true,
        });
        if rebuilt {
            assert!(fx.contains(&Effect::ClosePeer(pid("riya"))));
        }
    }
    assert!(rebuilt, "rebuilt after the ICE restarts");
    assert!(r.members().contains_key(&pid("riya")), "she's still in the room");
    r.update(
        Input::Link {
            peer: pid("riya"),
            state: LinkState::Connected,
        },
        t + 100.0,
    );
}

#[test]
fn a_bye_or_a_leave_ends_it_and_signaling_loss_alone_does_not() {
    let mut r = hosting();
    connected_to(&mut r, "riya");
    assert!(
        r.update(
            Input::Server(ServerMessage::PeerLeft { peer_id: pid("riya") }),
            0.0
        )
        .is_empty()
    );
    let fx = r.update(Input::ChannelClosed(pid("riya")), 0.0);
    assert!(
        fx.contains(&Effect::ClosePeer(pid("riya"))),
        "signaling gone and the link dropped: she left"
    );
    connected_to(&mut r, "arjun");
    let bye = Envelope {
        sender: None,
        timestamp: None,
        message: PeerMessage::PeerBye,
    };
    let fx = r.update(
        Input::Peer {
            from: pid("arjun"),
            envelope: bye,
        },
        0.0,
    );
    assert!(fx.contains(&Effect::ClosePeer(pid("arjun"))));
    assert!(r.members().is_empty());
}

#[test]
fn deafening_mutes_and_unmuting_undeafens() {
    let mut r = hosting();
    r.update(Input::Command(Command::SetMuted(false)), 0.0);
    let fx = r.update(Input::Command(Command::SetDeafened(true)), 0.0);
    assert!(fx.contains(&Effect::SetDeafened(true)));
    assert!(fx.contains(&Effect::SetMic(false)));
    assert!(r.deafened() && r.muted());
    let fx = r.update(Input::Command(Command::SetMuted(false)), 0.0);
    assert!(fx.contains(&Effect::SetDeafened(false)) && fx.contains(&Effect::SetMic(true)));
    assert!(!r.deafened() && !r.muted());
}

#[test]
fn speaking_shows_on_the_right_person() {
    let mut r = hosting();
    connected_to(&mut r, "riya");
    r.update(
        Input::Speaking {
            peer: Some(pid("riya")),
            speaking: true,
        },
        0.0,
    );
    assert!(r.members()[&pid("riya")].speaking);
    r.update(
        Input::Speaking {
            peer: None,
            speaking: true,
        },
        0.0,
    );
    assert!(r.speaking());
    let muted = Envelope {
        sender: None,
        timestamp: None,
        message: PeerMessage::PeerVoiceStatus {
            peer_id: None,
            is_muted: true,
        },
    };
    r.update(
        Input::Peer {
            from: pid("riya"),
            envelope: muted,
        },
        0.0,
    );
    assert!(!r.members()[&pid("riya")].speaking);
}

#[test]
fn host_handover_is_announced_as_the_web_app_does() {
    let mut r = hosting();
    connected_to(&mut r, "riya");
    r.update(
        Input::Peer {
            from: pid("riya"),
            envelope: identity_of("riya", "Riya", true),
        },
        0.0,
    );
    let fx = r.update(
        Input::Server(ServerMessage::Host {
            host_peer_id: pid("riya"),
            from: Some(pid("me")),
        }),
        0.0,
    );
    assert!(fx.contains(&Effect::Ui(UiEvent::Notice("👑 Riya is now the host".into()))));
}

#[test]
fn names_from_peers_are_cleaned() {
    assert_eq!(clean_name("  Riya\u{200b}\u{202e}  K  "), "Riya K");
    assert_eq!(clean_name("\u{0007}\u{feff}"), "Guest");
    assert_eq!(clean_name(&"x".repeat(40)).chars().count(), 24);
}

proptest::proptest! {
    /// Whatever arrives from the server or a peer, in any order, the room never panics.
    #[test]
    fn never_panics(msgs in proptest::collection::vec(".{0,200}", 0..30)) {
        let mut r = hosting();
        connected_to(&mut r, "riya");
        for (i, m) in msgs.iter().enumerate() {
            if let Ok(sm) = ServerMessage::from_json(m) { r.update(Input::Server(sm), i as f64); }
            if let Ok(env) = Envelope::from_json(m) { r.update(Input::Peer { from: pid("riya"), envelope: env }, i as f64); }
            r.update(Input::Tick, i as f64 * 1000.0);
        }
    }
}

#[test]
fn a_code_not_on_this_server_is_looked_for_on_the_others() {
    let mut r = me();
    r.update(Input::Command(Command::Join(room_id())), 0.0);
    let not_found = |r: &mut Room| {
        r.update(
            Input::Server(ServerMessage::Error {
                message: "Room \"12345\" not found.".into(),
                code: Some(ErrorCode::NotFound),
                room_id: None,
            }),
            0.0,
        )
    };
    assert_eq!(not_found(&mut r), vec![Effect::FindRoomElsewhere(room_id())]);
    assert_eq!(
        r.phase(),
        &Phase::Joining(room_id()),
        "still joining while we look"
    );
    let fx = r.update(
        Input::RoomFound {
            room: room_id(),
            url: Some("wss://gcp.3rtc.me".into()),
        },
        0.0,
    );
    assert!(fx.contains(&Effect::SwitchServer("wss://gcp.3rtc.me".into())));
    let fx = r.update(
        Input::SignalingUp {
            label: "Google Cloud".into(),
            backup: true,
        },
        0.0,
    );
    assert!(
        fx.iter()
            .any(|e| matches!(e, Effect::Send(ClientMessage::Join { .. }))),
        "joins again there"
    );
    // nowhere: the server's message, back to the home screen
    let mut r = me();
    r.update(Input::Command(Command::Join(room_id())), 0.0);
    not_found(&mut r);
    let fx = r.update(
        Input::RoomFound {
            room: room_id(),
            url: None,
        },
        0.0,
    );
    assert!(fx.contains(&Effect::Ui(UiEvent::Notice("Room \"12345\" not found.".into()))));
    assert_eq!(r.phase(), &Phase::Idle);
}

#[test]
fn push_to_talk_unmutes_and_mutes_quietly() {
    let mut r = hosting();
    let fx = r.update(Input::Command(Command::PushToTalk(true)), 1.0);
    assert!(!r.muted());
    assert!(fx.iter().any(|e| matches!(e, Effect::SetMic(true))));
    assert!(fx.iter().any(|e| matches!(e, Effect::Broadcast(env) if matches!(env.message, PeerMessage::PeerVoiceStatus { is_muted: false, .. }))));
    assert!(logs(&fx).is_empty(), "no log line for every press");
    assert!(
        !fx.iter().any(|e| matches!(e, Effect::Ui(UiEvent::Notice(_)))),
        "no toast either"
    );
    // pressing again while talking changes nothing
    assert!(
        r.update(Input::Command(Command::PushToTalk(true)), 2.0)
            .is_empty()
    );
    let fx = r.update(Input::Command(Command::PushToTalk(false)), 3.0);
    assert!(r.muted());
    assert!(fx.iter().any(|e| matches!(e, Effect::SetMic(false))));
    // deafened: the key doesn't open the mic
    r.update(Input::Command(Command::SetDeafened(true)), 4.0);
    r.update(Input::Command(Command::PushToTalk(true)), 5.0);
    assert!(r.muted());
}

#[test]
fn a_hosted_room_can_be_taken_back_with_its_token() {
    let r = hosting();
    assert_eq!(r.host_token(), Some("host"));
    let mut r = me();
    let fx = r.update(
        Input::Command(Command::Resume {
            room: room_id(),
            host_token: "host".into(),
        }),
        0.0,
    );
    assert!(matches!(
        &fx[0],
        Effect::Send(ClientMessage::CreateRoom { room_id: Some(id), host_token: Some(t), .. }) if *id == room_id() && t == "host"
    ));
    assert_eq!(r.phase(), &Phase::Creating);
    // only from the home screen
    let mut busy = hosting();
    assert!(
        busy.update(
            Input::Command(Command::Resume {
                room: room_id(),
                host_token: "host".into()
            }),
            0.0
        )
        .is_empty()
    );
}
