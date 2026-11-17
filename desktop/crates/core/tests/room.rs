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
            topology: None,
            max_users: None,
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
            topology: None,
            max_users: None,
            quic: None,
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
            topology: None,
            max_users: None,
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
            reply_to: None,
        }),
        9.0,
    );
    assert!(fx.iter().any(|e| matches!(e, Effect::Broadcast(Envelope { message: PeerMessage::Chat { text, is_host: true, .. }, .. }) if text == "hi all")));
    let blank = r.update(
        Input::Command(Command::SendChat {
            id: "m2".into(),
            text: "   ".into(),
            reply_to: None,
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
            reply_to: None,
            mentions: Vec::new(),
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
            reason: None,
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
            topology: None,
            max_users: None,
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
fn a_first_connection_that_never_comes_up_is_diagnosed_once() {
    let mut r = hosting();
    r.update(
        Input::SignalingUp {
            label: "Local".into(),
            backup: false,
        },
        0.0,
    );
    r.update(
        Input::Server(ServerMessage::PeerJoined {
            peer_id: pid("aristo"),
        }),
        0.0,
    );
    let mut asked = 0;
    let mut t = 0.0;
    while t < 120_000.0 {
        t += 500.0;
        let fx = r.update(Input::Tick, t);
        asked += fx
            .iter()
            .filter(|e| **e == Effect::DiagnoseLink(pid("aristo")))
            .count();
    }
    assert_eq!(asked, 1, "the blocked notice asks for one diagnosis");
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
            reason: None,
        }),
        0.0,
    );
    assert!(fx.contains(&Effect::Ui(UiEvent::Notice("👑 Riya is now the host".into()))));
}

#[test]
fn a_host_who_left_is_replaced_as_the_web_app_says() {
    let mut r = hosting();
    connected_to(&mut r, "riya");
    connected_to(&mut r, "arjun");
    r.update(
        Input::Peer {
            from: pid("riya"),
            envelope: identity_of("riya", "Riya", false),
        },
        0.0,
    );
    let host_left = |who: &str| {
        Input::Server(ServerMessage::Host {
            host_peer_id: pid(who),
            from: None,
            reason: Some("host-left".into()),
        })
    };
    let fx = r.update(host_left("riya"), 0.0);
    assert!(fx.contains(&Effect::Ui(UiEvent::Notice(
        "👑 The host left. Riya is now the host".into()
    ))));
    assert!(!r.is_host());
    let fx = r.update(host_left("me"), 0.0);
    assert!(fx.contains(&Effect::Ui(UiEvent::Notice(
        "👑 The host left. You're the host now".into()
    ))));
    assert!(r.is_host());
    // A plain update of who the host is says nothing
    let fx = r.update(
        Input::Server(ServerMessage::Host {
            host_peer_id: pid("arjun"),
            from: None,
            reason: None,
        }),
        0.0,
    );
    assert!(!fx.iter().any(|e| matches!(e, Effect::Ui(UiEvent::Notice(_)))));
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

fn from(peer: &str, message: PeerMessage) -> Input {
    Input::Peer {
        from: pid(peer),
        envelope: Envelope {
            sender: Some("Liar".into()),
            timestamp: Some(1.0),
            message,
        },
    }
}

fn with_riya() -> Room {
    let mut r = hosting();
    connected_to(&mut r, "riya");
    r.update(
        Input::Peer {
            from: pid("riya"),
            envelope: identity_of("riya", "Riya", false),
        },
        0.0,
    );
    r
}

#[test]
fn reactions_go_out_and_come_in_with_limits() {
    let mut r = with_riya();
    let fx = r.update(
        Input::Command(Command::React {
            id: "r1".into(),
            emoji: "🔥".into(),
            lane: 120.0,
        }),
        10_000.0,
    );
    assert!(fx.iter().any(|e| matches!(e, Effect::Broadcast(Envelope {
        message: PeerMessage::Reaction { lane: Some(l), combo: Some(c), .. }, .. }) if (*l - 90.0).abs() < 1e-9 && (*c - 1.0).abs() < 1e-9)));
    assert!(
        fx.iter().any(
            |e| matches!(e, Effect::Ui(UiEvent::Reaction(x)) if x.from.is_none() && x.name == "Darshan")
        )
    );
    let again = r.update(
        Input::Command(Command::React {
            id: "r2".into(),
            emoji: "🔥".into(),
            lane: 50.0,
        }),
        10_050.0,
    );
    assert!(again.is_empty(), "too soon");

    let shown = |fx: &[Effect]| {
        fx.iter().find_map(|e| match e {
            Effect::Ui(UiEvent::Reaction(x)) => Some(x.clone()),
            _ => None,
        })
    };
    let x = shown(&r.update(
        from(
            "riya",
            PeerMessage::Reaction {
                id: "a".into(),
                emoji: "👍".into(),
                lane: Some(33.5),
                combo: Some(4.0),
            },
        ),
        20_000.0,
    ))
    .unwrap();
    assert_eq!(
        (x.name.as_str(), x.combo),
        ("Riya", 4),
        "the name comes from the connection"
    );
    assert!((x.lane - 33.5).abs() < 1e-9);
    // older apps post the reaction as chat too: that copy is skipped, other chat isn't
    let chat = |r: &mut Room, text: &str, at: f64| {
        r.update(
            from(
                "riya",
                PeerMessage::Chat {
                    id: format!("c{at}"),
                    is_host: false,
                    text: text.into(),
                    reply_to: None,
                    mentions: Vec::new(),
                },
            ),
            at,
        )
        .iter()
        .any(|e| matches!(e, Effect::Ui(UiEvent::Chat(_))))
    };
    assert!(!chat(&mut r, "👍", 20_100.0));
    assert!(chat(&mut r, "👍", 30_000.0));
    assert!(
        shown(&r.update(
            from(
                "riya",
                PeerMessage::Reaction {
                    id: "b".into(),
                    emoji: "two words".into(),
                    lane: None,
                    combo: None
                }
            ),
            40_000.0,
        ))
        .is_none()
    );
}

#[test]
fn soundboard_plays_everywhere_and_says_who() {
    let mut r = with_riya();
    let fx = r.update(
        Input::Command(Command::PlaySound {
            sound_id: "quack".into(),
            sound_name: "Quack".into(),
            emoji: "🦆".into(),
        }),
        1_000.0,
    );
    assert!(fx.iter().any(|e| matches!(
        e,
        Effect::Broadcast(Envelope {
            message: PeerMessage::SoundboardSfx { .. },
            ..
        })
    )));
    assert!(
        fx.iter()
            .any(|e| matches!(e, Effect::Ui(UiEvent::Sound(s)) if s.from.is_none()))
    );
    let fx = r.update(
        from(
            "riya",
            PeerMessage::SoundboardSfx {
                sound_id: "airhorn".into(),
                sound_name: Some("Airhorn".into()),
                emoji: Some("📢".into()),
            },
        ),
        5_000.0,
    );
    assert!(
        fx.iter()
            .any(|e| matches!(e, Effect::Ui(UiEvent::Notice(n)) if n == "🔊 Riya played Airhorn 📢"))
    );
    assert!(
        logs(&fx)
            .iter()
            .any(|l| l == "🔊 Riya played soundboard clip: \"Airhorn\"")
    );
    assert!(
        fx.iter()
            .any(|e| matches!(e, Effect::Ui(UiEvent::Sound(s)) if s.sound_id == "airhorn"))
    );
}

#[test]
fn a_chat_picture_becomes_a_chat_line() {
    let mut r = hosting();
    connected_to(&mut r, "riya");
    let fx = r.update(
        from(
            "riya",
            PeerMessage::P2pImageStart {
                id: "m1".into(),
                transfer_id: "t1".into(),
                file_name: "cat.png".into(),
                file_size: 70_000.0,
                mime_type: "text/html".into(),
                total_chunks: 2.0,
                is_host: true,
                caption: "look".into(),
            },
        ),
        5_000.0,
    );
    let line = fx
        .iter()
        .find_map(|e| match e {
            Effect::Ui(UiEvent::Chat(l)) => Some(l.clone()),
            _ => None,
        })
        .unwrap();
    let image = line.image.unwrap();
    assert_eq!(
        (line.text.as_str(), line.is_host),
        ("look", false),
        "the host flag comes from who hosts"
    );
    assert_eq!(
        (image.transfer_id.as_str(), image.file_size, image.mime.as_str()),
        ("t1", 70_000, "image/png")
    );
}

#[test]
fn the_host_can_lock_playback_and_guests_learn_it() {
    let mut r = with_riya();
    let fx = r.update(Input::Command(Command::SetPlaybackLock(true)), 1.0);
    assert!(r.playback_lock());
    assert!(fx.iter().any(|e| matches!(
        e,
        Effect::Broadcast(Envelope {
            message: PeerMessage::RoomSettings {
                playback_lock: true,
                ..
            },
            ..
        })
    )));
    assert!(
        fx.iter()
            .any(|e| matches!(e, Effect::Ui(UiEvent::Notice(n)) if n == "🔒 Only you can control playback"))
    );
    // our identity tells people who join later
    let fx = r.update(
        Input::Peer {
            from: pid("riya"),
            envelope: identity_of("riya", "Riya", false),
        },
        2.0,
    );
    assert!(fx.iter().any(|e| matches!(
        e,
        Effect::SendToPeer {
            envelope: Envelope {
                message: PeerMessage::PeerIdentity {
                    playback_lock: Some(true),
                    ..
                },
                ..
            },
            ..
        }
    )));

    // a guest: only the host's word counts
    let mut g = me();
    g.update(Input::Command(Command::Join(room_id())), 0.0);
    g.update(
        Input::Server(ServerMessage::Joined {
            room_id: room_id(),
            peer_id: pid("me"),
            host_peer_id: pid("host"),
            peers: vec![pid("host"), pid("other")],
            seat_token: "s".into(),
            host_token: None,
            topology: None,
            max_users: None,
        }),
        0.0,
    );
    connected_to(&mut g, "host");
    connected_to(&mut g, "other");
    g.update(
        from(
            "other",
            PeerMessage::RoomSettings {
                playback_lock: true,
                topology: None,
                max_users: None,
            },
        ),
        1.0,
    );
    assert!(!g.playback_lock(), "not from the host");
    let fx = g.update(
        from(
            "host",
            PeerMessage::RoomSettings {
                playback_lock: true,
                topology: None,
                max_users: None,
            },
        ),
        2.0,
    );
    assert!(g.playback_lock());
    assert!(fx.iter().any(
        |e| matches!(e, Effect::Ui(UiEvent::Notice(n)) if n == "🔒 Only the host can control playback")
    ));
    // the host leaves: after the grace period the lock goes
    g.update(from("host", PeerMessage::PeerBye), 3.0);
    g.update(Input::Tick, 4.0);
    assert!(g.playback_lock(), "maybe only reconnecting");
    let fx = g.update(Input::Tick, 4.0 + 4000.0);
    assert!(!g.playback_lock());
    assert!(fx.iter().any(|e| matches!(e, Effect::Ui(UiEvent::Notice(n)) if n == "🔓 The host left: everyone can control playback")));
}

#[test]
fn host_can_switch_topology() {
    let mut h = hosting();
    assert_eq!(h.topology(), "mesh");

    // Non-host or same topology has no effect
    let fx = h.update(Input::Command(Command::SetTopology("mesh".into())), 1.0);
    assert!(fx.is_empty());

    // Host switches to hub
    let fx = h.update(Input::Command(Command::SetTopology("hub".into())), 2.0);
    assert!(fx.contains(&Effect::Send(ClientMessage::SetTopology {
        topology: "hub".into(),
    })));
    assert_eq!(h.topology(), "hub");
    assert!(
        fx.iter()
            .any(|e| matches!(e, Effect::Ui(UiEvent::Notice(n)) if n.contains("Host-Hub")))
    );

    // Server sends legacy error (older signaling server without set-topology): ignored gracefully
    let fx = h.update(
        Input::Server(ServerMessage::Error {
            message: "Unknown message type: \"set-topology\"".into(),
            code: None,
            room_id: None,
        }),
        2.5,
    );
    assert!(fx.is_empty(), "legacy signaling error is gracefully ignored");
    assert_eq!(h.topology(), "hub");

    // Server confirms topology change
    let _ = h.update(
        Input::Server(ServerMessage::TopologyChanged {
            topology: "hub".into(),
            host_peer_id: pid("me"),
        }),
        3.0,
    );
    assert_eq!(h.topology(), "hub");

    // A guest cannot switch topology
    let mut g = me();
    g.update(Input::Command(Command::Join(room_id())), 0.0);
    g.update(
        Input::Server(ServerMessage::Joined {
            room_id: room_id(),
            peer_id: pid("me"),
            host_peer_id: pid("host"),
            peers: vec![pid("host")],
            seat_token: "s".into(),
            host_token: None,
            topology: Some("hub".into()),
            max_users: None,
        }),
        1.0,
    );
    assert_eq!(g.topology(), "hub");
    let fx = g.update(Input::Command(Command::SetTopology("mesh".into())), 2.0);
    assert!(fx.is_empty(), "guests cannot switch topology");
}

#[test]
fn host_hub_relays_broadcast_messages() {
    let mut h = hosting();
    connected_to(&mut h, "riya");
    connected_to(&mut h, "alex");

    let chat = Envelope {
        sender: Some(pid("riya").to_string()),
        timestamp: Some(1234.0),
        message: PeerMessage::Chat {
            id: "msg-1".into(),
            is_host: false,
            text: "Hello from Riya".into(),
            reply_to: None,
            mentions: Vec::new(),
        },
    };

    // In mesh mode: host receives chat but does NOT relay
    let fx = h.update(
        Input::Peer {
            from: pid("riya"),
            envelope: chat.clone(),
        },
        1.0,
    );
    assert!(!fx.iter().any(|e| matches!(e, Effect::SendToPeer { .. })));

    // Switch to Host-Hub mode
    h.update(
        Input::Server(ServerMessage::TopologyChanged {
            topology: "hub".into(),
            host_peer_id: pid("me"),
        }),
        2.0,
    );
    assert_eq!(h.topology(), "hub");

    // In hub mode: host relays chat to alex, but not back to riya
    let fx = h.update(
        Input::Peer {
            from: pid("riya"),
            envelope: chat.clone(),
        },
        3.0,
    );
    let relays: Vec<_> = fx
        .iter()
        .filter_map(|e| match e {
            Effect::SendToPeer { peer, envelope } => Some((peer.clone(), envelope.clone())),
            _ => None,
        })
        .collect();

    assert_eq!(relays.len(), 1);
    assert_eq!(relays[0].0, pid("alex"));
    assert_eq!(relays[0].1.message, chat.message);
}

#[test]
fn rich_chat_replies_and_mentions_as_the_web_app_sends_them() {
    use rtc_protocol::peer::ReplyRef;
    let mut r = hosting();
    connected_to(&mut r, "riya");
    r.update(
        Input::Peer {
            from: pid("riya"),
            envelope: identity_of("riya", "Riya", false),
        },
        0.0,
    );
    // Riya writes; we reply to her and mention her
    let said = |id: &str, text: &str, reply_to: Option<ReplyRef>, mentions: Vec<String>| Input::Peer {
        from: pid("riya"),
        envelope: Envelope {
            sender: Some("Riya".into()),
            timestamp: Some(5.0),
            message: PeerMessage::Chat {
                id: id.into(),
                is_host: false,
                text: text.into(),
                reply_to,
                mentions,
            },
        },
    };
    r.update(said("r1", "**movie** at 9?", None, vec![]), 5.0);
    let fx = r.update(
        Input::Command(Command::SendChat {
            id: "m1".into(),
            text: "yes @Riya!".into(),
            reply_to: Some("r1".into()),
        }),
        6.0,
    );
    let sent = fx.iter().find_map(|e| match e {
        Effect::Broadcast(Envelope {
            message: PeerMessage::Chat {
                reply_to, mentions, ..
            },
            ..
        }) => Some((reply_to.clone(), mentions.clone())),
        _ => None,
    });
    let (reply_to, mentions) = sent.expect("the chat was sent");
    assert_eq!(
        reply_to,
        Some(ReplyRef {
            id: "r1".into(),
            sender: "Riya".into(),
            text: "movie at 9?".into()
        })
    );
    assert_eq!(mentions, vec!["riya".to_owned()]);
    let mine = r.chat().last().unwrap();
    assert_eq!(
        mine.reply.as_ref().map(|q| (q.name.as_str(), q.mine)),
        Some(("Riya", false))
    );

    // She replies to us and mentions us: quoted from our own copy, and we're told
    let fx = r.update(
        said(
            "r2",
            "great",
            Some(ReplyRef {
                id: "m1".into(),
                sender: "Faked Name".into(),
                text: "faked".into(),
            }),
            vec!["me".into()],
        ),
        7.0,
    );
    let line = r.chat().last().unwrap();
    assert!(line.mentions_me);
    let q = line.reply.as_ref().unwrap();
    assert!(q.mine, "it quotes our own message");
    assert_eq!(q.text, "yes @Riya!");
    assert!(
        fx.iter()
            .any(|e| matches!(e, Effect::Ui(UiEvent::Notice(n)) if n == "💬 Riya mentioned you: great"))
    );

    // A reply to a message we don't have keeps what she sent, cut to size
    r.update(
        said(
            "r3",
            "and this",
            Some(ReplyRef {
                id: "gone".into(),
                sender: "x".repeat(100),
                text: "y".repeat(500),
            }),
            vec![],
        ),
        8.0,
    );
    let q = r.chat().last().unwrap().reply.clone().unwrap();
    assert_eq!(q.name.chars().count(), 40);
    assert!(q.text.chars().count() <= 140);
    assert!(!r.chat().last().unwrap().mentions_me);
}

#[test]
fn quic_is_only_for_desktop_apps_that_say_so() {
    let mut r = hosting();
    for p in ["web", "old-desktop", "new-desktop", "liar"] {
        connected_to(&mut r, p);
    }
    let say = |peer: &str, client: Option<&str>, quic: Option<u32>| {
        let mut e = identity_of(peer, peer, true);
        if let PeerMessage::PeerIdentity {
            client: c, quic: q, ..
        } = &mut e.message
        {
            *c = client.map(str::to_owned);
            *q = quic;
        }
        Input::Peer {
            from: pid(peer),
            envelope: e,
        }
    };
    r.update(say("web", None, None), 0.0);
    r.update(say("old-desktop", Some("desktop"), None), 0.0);
    r.update(say("new-desktop", Some("desktop"), Some(1)), 0.0);
    r.update(say("liar", None, Some(1)), 0.0);
    let quic = |p: &str| r.members()[&pid(p)].quic;
    assert!(!quic("web"));
    assert!(!quic("old-desktop"));
    assert!(quic("new-desktop"));
    assert!(
        !quic("liar"),
        "a web app saying quic doesn't make it a desktop app"
    );
}

#[test]
fn our_identity_says_we_do_quic() {
    let mut r = hosting();
    r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid("riya") }),
        0.0,
    );
    let fx = r.update(Input::ChannelOpen(pid("riya")), 0.0);
    let Some(Effect::SendToPeer { envelope, .. }) = fx.first() else {
        panic!("no identity sent: {fx:?}")
    };
    assert!(matches!(
        &envelope.message,
        PeerMessage::PeerIdentity { quic: Some(1), .. }
    ));
}
