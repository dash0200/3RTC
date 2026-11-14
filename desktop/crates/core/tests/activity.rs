//! Activities in a room (`useActivities.ts`, `useActivityLoad.ts`): opening, joining, leaving,
//! ending, and what goes on the wire.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests: failing loudly is the point

use rtc_core::{ActivityCommand, Command, Effect, Identity, Input, LinkState, Room, UiEvent};
use rtc_protocol::peer::{Envelope, PeerMessage};
use rtc_protocol::signaling::ServerMessage;
use rtc_protocol::{ClientId, PeerId, RoomId};
use serde_json::{Value, json};

fn pid(s: &str) -> PeerId {
    PeerId::new(s).unwrap()
}

fn hosting() -> Room {
    let mut r = Room::new(Identity {
        peer_id: pid("me"),
        client_id: ClientId::new("cid-me").unwrap(),
        username: "Darshan".into(),
        build: "261111.1200".into(),
    });
    r.set_dev_activities(true);
    r.update(Input::Command(Command::CreateRoom), 0.0);
    r.update(
        Input::Server(ServerMessage::RoomCreated {
            room_id: RoomId::parse("12345").unwrap(),
            peer_id: pid("me"),
            host_peer_id: pid("me"),
            seat_token: "seat".into(),
            host_token: "host".into(),
            topology: None,
        }),
        0.0,
    );
    r.update(
        Input::Server(ServerMessage::PeerJoined { peer_id: pid("riya") }),
        0.0,
    );
    r.update(
        Input::Link {
            peer: pid("riya"),
            state: LinkState::Connected,
        },
        0.0,
    );
    r.update(Input::ChannelOpen(pid("riya")), 0.0);
    r
}

fn from_riya(message: PeerMessage) -> Input {
    Input::Peer {
        from: pid("riya"),
        envelope: Envelope {
            sender: Some("Riya".into()),
            timestamp: Some(1.0),
            message,
        },
    }
}

fn act(c: ActivityCommand) -> Input {
    Input::Command(Command::Activity(c))
}

/// Every shared-state message sent (to anyone).
fn wire(fx: &[Effect]) -> Vec<PeerMessage> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Broadcast(env) | Effect::SendToPeer { envelope: env, .. } => Some(env.message.clone()),
            _ => None,
        })
        .filter(|m| {
            matches!(
                m,
                PeerMessage::RoomState { .. }
                    | PeerMessage::RoomStateAction { .. }
                    | PeerMessage::RoomStateRequest { .. }
                    | PeerMessage::RoomStateGone { .. }
            )
        })
        .collect()
}

fn notices(fx: &[Effect]) -> Vec<String> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Ui(UiEvent::Notice(n)) => Some(n.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn the_host_opens_a_game_for_the_room_and_plays_it() {
    let mut r = hosting();
    // in a room, the activity store asks the room for its state
    let fx = r.update(Input::Tick, 1000.0);
    let _ = fx;
    let fx = r.update(act(ActivityCommand::Start("sample-counter".into())), 2000.0);
    let a = r.activity().expect("open");
    assert_eq!(a.current.id, "sample-counter");
    assert_eq!(a.current.started_by, "me");
    assert_eq!(a.current.started_by_name, "Darshan");
    assert!(a.loaded && a.known, "it loads for whoever opened it");
    let sent = wire(&fx);
    assert!(
        sent.iter().any(|m| matches!(m, PeerMessage::RoomState { key, v: 1, state } if key == "activity" && state["current"]["id"] == "sample-counter")),
        "{sent:?}"
    );
    // its own store opened: it asks the room for the game's state
    assert!(
        sent.iter()
            .any(|m| matches!(m, PeerMessage::RoomStateRequest { key } if key == "act:sample-counter"))
    );
    // a move
    let fx = r.update(
        act(ActivityCommand::Dispatch {
            key: "act:sample-counter".into(),
            action: rtc_games::sample::add(1, "Darshan"),
        }),
        3000.0,
    );
    let s = r.store("act:sample-counter").unwrap();
    assert_eq!(s.state["count"], json!(1));
    assert_eq!(s.version, 1);
    assert!(
        wire(&fx)
            .iter()
            .any(|m| matches!(m, PeerMessage::RoomState { key, .. } if key == "act:sample-counter"))
    );
    // Riya's move comes through the host (who decides)
    r.update(
        from_riya(PeerMessage::RoomStateAction {
            key: "act:sample-counter".into(),
            action: rtc_games::sample::add(-1, "Riya"),
        }),
        3100.0,
    );
    let s = r.store("act:sample-counter").unwrap();
    assert_eq!(
        s.state,
        json!({"count": 0, "last": {"by": "riya", "name": "Riya", "step": -1}})
    );
    assert_eq!(rtc_games::sample::view(&s.state).1, "Riya took 1");
    // End for everyone
    r.update(act(ActivityCommand::End), 4000.0);
    assert!(r.activity().is_none());
    assert!(r.store("act:sample-counter").is_none(), "its state is dropped");
}

#[test]
fn a_game_someone_else_opens_is_an_invitation() {
    let mut r = hosting();
    r.update(Input::Tick, 1000.0);
    // Riya opens it: her action reaches the host, who decides
    let fx = r.update(
        from_riya(PeerMessage::RoomStateAction {
            key: "activity".into(),
            action: json!({"kind": "start", "id": "sample-counter", "byName": "Riya"}),
        }),
        2000.0,
    );
    let a = r.activity().unwrap();
    assert_eq!(a.current.started_by, "riya");
    assert!(!a.loaded, "not loaded here until we join");
    assert_eq!(
        notices(&fx),
        vec!["🧪 Riya started Sample counter: tap 🧪 to join".to_owned()]
    );
    // we tell the room we don't have it, and answer for it
    assert!(
        wire(&fx)
            .iter()
            .any(|m| matches!(m, PeerMessage::RoomStateGone { key } if key == "act:sample-counter"))
    );
    let fx = r.update(
        from_riya(PeerMessage::RoomStateRequest {
            key: "act:sample-counter".into(),
        }),
        2100.0,
    );
    assert!(
        wire(&fx)
            .iter()
            .any(|m| matches!(m, PeerMessage::RoomStateGone { key } if key == "act:sample-counter"))
    );
    assert!(r.store("act:sample-counter").is_none());

    // Join: it loads, and its store asks for the game
    let fx = r.update(act(ActivityCommand::Join), 3000.0);
    assert!(r.activity().unwrap().loaded);
    assert!(
        wire(&fx)
            .iter()
            .any(|m| matches!(m, PeerMessage::RoomStateRequest { key } if key == "act:sample-counter"))
    );
    assert!(r.store("act:sample-counter").is_some());

    // Leave: unloaded here, the others told
    let fx = r.update(act(ActivityCommand::Leave), 4000.0);
    assert!(!r.activity().unwrap().loaded);
    assert!(r.store("act:sample-counter").is_none());
    assert!(
        wire(&fx)
            .iter()
            .any(|m| matches!(m, PeerMessage::RoomStateGone { key } if key == "act:sample-counter"))
    );
}

#[test]
fn a_game_this_app_doesnt_have_asks_for_an_update() {
    let mut r = hosting();
    r.update(Input::Tick, 1000.0);
    r.update(
        from_riya(PeerMessage::RoomStateAction {
            key: "activity".into(),
            action: json!({"kind": "start", "id": "space-race", "byName": "Riya"}),
        }),
        2000.0,
    );
    let a = r.activity().unwrap();
    assert_eq!(a.current.id, "space-race");
    assert!(!a.known);
}

#[test]
fn with_the_lock_on_only_the_host_opens_or_ends_games() {
    let mut r = hosting();
    r.update(Input::Command(Command::SetPlaybackLock(true)), 0.0);
    r.update(Input::Tick, 1000.0);
    // a guest's start is rejected by the host's rules
    r.update(
        from_riya(PeerMessage::RoomStateAction {
            key: "activity".into(),
            action: json!({"kind": "start", "id": "sample-counter", "byName": "Riya"}),
        }),
        2000.0,
    );
    assert!(r.activity().is_none());
    // the host can
    r.update(act(ActivityCommand::Start("sample-counter".into())), 2500.0);
    assert!(r.activity().is_some());
}

#[test]
fn a_guest_follows_the_hosts_state_and_sends_its_moves_there() {
    // we are the guest this time: the host is Riya
    let mut r = Room::new(Identity {
        peer_id: pid("me"),
        client_id: ClientId::new("cid-me").unwrap(),
        username: "Darshan".into(),
        build: "261111.1200".into(),
    });
    r.set_dev_activities(true);
    r.update(
        Input::Command(Command::Join(RoomId::parse("12345").unwrap())),
        0.0,
    );
    r.update(
        Input::Server(ServerMessage::Joined {
            room_id: RoomId::parse("12345").unwrap(),
            peer_id: pid("me"),
            peers: vec![pid("riya")],
            host_peer_id: pid("riya"),
            seat_token: "seat".into(),
            host_token: None,
            topology: None,
        }),
        0.0,
    );
    r.update(
        Input::Link {
            peer: pid("riya"),
            state: LinkState::Connected,
        },
        0.0,
    );
    r.update(Input::ChannelOpen(pid("riya")), 0.0);
    // the host's state arrives
    let state = json!({"current": {"id": "sample-counter", "startedBy": "riya", "startedByName": "Riya", "startedAt": 5}});
    r.update(
        from_riya(PeerMessage::RoomState {
            key: "activity".into(),
            v: 1,
            state,
        }),
        100.0,
    );
    assert_eq!(r.activity().unwrap().current.started_by_name, "Riya");
    r.update(act(ActivityCommand::Join), 200.0);
    // our move goes to the host, not applied here
    let fx = r.update(
        act(ActivityCommand::Dispatch {
            key: "act:sample-counter".into(),
            action: rtc_games::sample::add(1, "Darshan"),
        }),
        300.0,
    );
    let to_host = fx.iter().any(|e| {
        matches!(e, Effect::SendToPeer { peer, envelope } if peer.as_str() == "riya"
            && matches!(&envelope.message, PeerMessage::RoomStateAction { key, .. } if key == "act:sample-counter"))
    });
    assert!(to_host);
    assert_eq!(
        r.store("act:sample-counter").unwrap().state["count"],
        Value::from(0)
    );
    // a state from someone else than the host is ignored; the host's is taken
    r.update(
        from_riya(PeerMessage::RoomState {
            key: "act:sample-counter".into(),
            v: 1,
            state: json!({"count": 1, "last": null}),
        }),
        400.0,
    );
    assert_eq!(
        r.store("act:sample-counter").unwrap().state["count"],
        Value::from(1)
    );
}
