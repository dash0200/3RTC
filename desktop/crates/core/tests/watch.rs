//! The watch party rules (`usePlayback`, `useMediaSync`, `useDriftSync`, `useQueue`), no network.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests: failing loudly is the point

use rtc_core::{
    Command, Effect, Identity, Input, LinkState, PlayerCmd, PlayerReport, Room, Showing, UiEvent, UserAction,
    WatchCommand,
};
use rtc_protocol::media::{Link, detect_link};
use rtc_protocol::peer::{Envelope, PeerMessage};
use rtc_protocol::signaling::ServerMessage;
use rtc_protocol::{ClientId, PeerId, RoomId};
use serde_json::{Value, json};

fn pid(s: &str) -> PeerId {
    PeerId::new(s).unwrap()
}

fn me() -> Room {
    Room::new(Identity {
        peer_id: pid("me"),
        client_id: ClientId::new("cid-me").unwrap(),
        username: "Darshan".into(),
        build: "261112.1200".into(),
    })
}

fn connected_to(r: &mut Room, peer: &str, name: &str) {
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
    r.update(
        from(
            peer,
            PeerMessage::PeerIdentity {
                peer_id: pid(peer),
                username: name.into(),
                is_host: false,
                is_muted: false,
                proto: 2,
                build: None,
                client_id: ClientId::new(format!("cid-{peer}")).unwrap(),
                is_reply: true,
                playback_lock: None,
                client: None,
            },
        ),
        0.0,
    );
}

fn hosting_with(peers: &[(&str, &str)]) -> Room {
    let mut r = me();
    r.update(Input::Command(Command::CreateRoom), 0.0);
    r.update(
        Input::Server(ServerMessage::RoomCreated {
            room_id: RoomId::parse("12345").unwrap(),
            peer_id: pid("me"),
            host_peer_id: pid("me"),
            seat_token: "seat".into(),
            host_token: "host".into(),
        }),
        0.0,
    );
    for (p, n) in peers {
        connected_to(&mut r, p, n);
    }
    r
}

fn guest_of(host: &str) -> Room {
    let mut g = me();
    g.update(
        Input::Command(Command::Join(RoomId::parse("12345").unwrap())),
        0.0,
    );
    g.update(
        Input::Server(ServerMessage::Joined {
            room_id: RoomId::parse("12345").unwrap(),
            peer_id: pid("me"),
            host_peer_id: pid(host),
            peers: vec![pid(host)],
            seat_token: "s".into(),
            host_token: None,
        }),
        0.0,
    );
    connected_to(&mut g, host, "Host");
    g
}

fn from(peer: &str, message: PeerMessage) -> Input {
    Input::Peer {
        from: pid(peer),
        envelope: Envelope {
            sender: Some("Riya".into()),
            timestamp: Some(1.0),
            message,
        },
    }
}

fn watch(c: WatchCommand) -> Input {
    Input::Command(Command::Watch(c))
}

fn sent(fx: &[Effect]) -> Vec<Value> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Broadcast(env) | Effect::SendToPeer { envelope: env, .. } => {
                serde_json::from_str(&env.to_json().unwrap()).ok()
            }
            _ => None,
        })
        .collect()
}

fn player(fx: &[Effect]) -> Vec<PlayerCmd> {
    fx.iter()
        .filter_map(|e| {
            if let Effect::Ui(UiEvent::Player(c)) = e {
                Some(c.clone())
            } else {
                None
            }
        })
        .collect()
}

fn texts(fx: &[Effect]) -> Vec<String> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Ui(UiEvent::Log(t) | UiEvent::Notice(t)) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

fn yt(action: &str, t: Option<f64>) -> PeerMessage {
    PeerMessage::YtAction {
        action: action.into(),
        new_video_id: None,
        video_id: None,
        title: None,
        current_time: t,
        from_host: false,
        by_vote: None,
    }
}

#[test]
fn a_channel_opening_asks_what_they_watch() {
    let mut r = hosting_with(&[]);
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
    let fx = r.update(Input::ChannelOpen(pid("riya")), 0.0);
    assert!(sent(&fx).iter().any(|m| m["type"] == "yt-request-sync"));
}

#[test]
fn loading_a_youtube_video_goes_both_ways() {
    let mut r = hosting_with(&[("riya", "Riya")]);
    let fx = r.update(
        watch(WatchCommand::PlayYouTube {
            id: "dQw4w9WgXcQ".into(),
            title: "Song".into(),
        }),
        10.0,
    );
    let out = sent(&fx);
    assert_eq!(out[0]["type"], "yt-action");
    assert_eq!(out[0]["action"], "load");
    assert_eq!(out[0]["newVideoId"], "dQw4w9WgXcQ");
    assert_eq!(out[0]["title"], "Song");
    assert_eq!(out[0]["fromHost"], true);
    assert!(matches!(&player(&fx)[0], PlayerCmd::Open { start, playing: true, .. } if *start == 0.0));
    assert!(texts(&fx).contains(&"🎬 You loaded: \"Song\"".to_owned()));

    // Riya pauses at 42 s
    let fx = r.update(from("riya", yt("pause", Some(42.0))), 2000.0);
    assert_eq!(
        player(&fx),
        vec![PlayerCmd::Pause {
            at: Some(42.0),
            who: "Riya".into()
        }]
    );
    assert!(texts(&fx).contains(&"⏸️ Riya paused the video".to_owned()));
    let fx = r.update(from("riya", yt("seek", Some(75.0))), 2100.0);
    assert!(texts(&fx).contains(&"⏩ Riya seeked to 1:15".to_owned()));

    // we play with the player's own controls: the room hears it
    let fx = r.update(
        watch(WatchCommand::Player(PlayerReport::User {
            action: UserAction::Play,
            time: 75.5,
        })),
        3000.0,
    );
    let out = sent(&fx);
    assert_eq!(
        (out[0]["action"].as_str(), out[0]["currentTime"].as_f64()),
        (Some("play"), Some(75.5))
    );

    // Riya closes it
    let fx = r.update(from("riya", yt("close", None)), 4000.0);
    assert_eq!(player(&fx), vec![PlayerCmd::Close]);
    assert!(r.watch().showing.is_none());
    assert!(texts(&fx).contains(&"🎬 Riya exited the video".to_owned()));
}

#[test]
fn a_late_joiner_lands_where_the_room_is() {
    let mut r = hosting_with(&[("riya", "Riya")]);
    r.update(
        watch(WatchCommand::PlayYouTube {
            id: "dQw4w9WgXcQ".into(),
            title: "Song".into(),
        }),
        0.0,
    );
    r.update(
        watch(WatchCommand::Player(PlayerReport::State {
            time: 30.0,
            playing: true,
            buffering: false,
            duration: 200.0,
        })),
        1000.0,
    );
    // 2 s later someone asks
    let fx = r.update(from("riya", PeerMessage::YtRequestSync), 3000.0);
    let answer = &sent(&fx)[0];
    assert_eq!(answer["type"], "yt-sync-state");
    assert_eq!(answer["videoId"], "dQw4w9WgXcQ");
    assert!((answer["currentTime"].as_f64().unwrap() - 32.0).abs() < 1e-6);
    assert_eq!(answer["isPlaying"], true);
    assert_eq!(answer["activeVideoTitle"], "Song");

    // the other way: we join a room watching something
    let mut g = guest_of("host");
    let fx = g.update(
        from(
            "host",
            PeerMessage::YtSyncState {
                video_id: Some("abcdefghijk".into()),
                nothing_playing: None,
                current_time: Some(61.0),
                is_playing: Some(true),
                queue: Some(vec![
                    json!({"id":"q1","videoId":"zzzzzzzzzzz","title":"Next","addedBy":"Riya","timestamp":1}),
                ]),
                skip_votes: Some(vec!["Riya".into()]),
                active_video_title: Some("Film".into()),
            },
        ),
        5.0,
    );
    assert!(
        matches!(&player(&fx)[0], PlayerCmd::Open { start, playing: true, showing: Showing::YouTube { id, title } } if *start == 61.0 && id == "abcdefghijk" && title == "Film")
    );
    assert_eq!(g.watch().queue.len(), 1);
    assert_eq!(g.watch().skip_votes, vec!["Riya".to_owned()]);
    assert!(texts(&fx).contains(&"🔄 Synced YouTube playback & queue with room".to_owned()));
    // a second answer (someone who just joined, still at 0:00) doesn't move us
    let fx = g.update(
        from(
            "host",
            PeerMessage::YtSyncState {
                video_id: Some("abcdefghijk".into()),
                nothing_playing: None,
                current_time: Some(0.0),
                is_playing: Some(false),
                queue: Some(vec![]),
                skip_votes: None,
                active_video_title: None,
            },
        ),
        6.0,
    );
    assert!(player(&fx).is_empty());
    assert_eq!(g.watch().queue.len(), 1, "the queue only comes with a new video");

    // nothing playing anywhere: the answer says so
    let mut empty = hosting_with(&[("riya", "Riya")]);
    let fx = empty.update(from("riya", PeerMessage::YtRequestSync), 1.0);
    assert_eq!(
        sent(&fx)[0],
        json!({"type":"yt-sync-state","videoId":null,"nothingPlaying":true,"sender":"Darshan","timestamp":1.0})
    );
}

#[test]
fn link_sources_load_and_sync() {
    let mut r = hosting_with(&[("riya", "Riya")]);
    let Ok(Link::Media { media, .. }) = detect_link("https://vimeo.com/76979871") else {
        panic!()
    };
    let fx = r.update(watch(WatchCommand::PlayLink(media)), 1.0);
    let out = sent(&fx);
    assert_eq!(out[0]["type"], "media-action");
    assert_eq!(
        out[0]["media"],
        json!({"provider":"vimeo","url":"https://vimeo.com/76979871","id":"76979871"})
    );
    assert!(texts(&fx).contains(&"🎬 You opened: \"Vimeo video\"".to_owned()));
    let fx = r.update(from("riya", PeerMessage::YtRequestSync), 1001.0);
    assert_eq!(sent(&fx)[0]["type"], "media-sync-state");

    // someone opens a Twitch channel (fields rebuilt from its link)
    let fx = r.update(
        from(
            "riya",
            PeerMessage::MediaAction {
                action: "load".into(),
                media: Some(json!({"provider":"file","url":"https://www.twitch.tv/Someone","title":"Live!"})),
                current_time: None,
                from_host: false,
                by_vote: None,
            },
        ),
        2.0,
    );
    let Some(Showing::Link(m)) = r.watch().showing else {
        panic!()
    };
    assert_eq!(
        (m.channel.as_deref(), m.live, m.title.as_deref()),
        (Some("someone"), Some(true), Some("Live!"))
    );
    assert!(texts(&fx).contains(&"🎬 Riya opened: \"Live!\"".to_owned()));
    // a yt-action pause doesn't touch a link player
    let fx = r.update(from("riya", yt("pause", Some(3.0))), 3.0);
    assert!(player(&fx).is_empty());
}

#[test]
fn the_reference_keeps_everyone_within_a_second_and_a_half() {
    // we're a guest; the host is the reference
    let mut g = guest_of("host");
    g.update(
        from(
            "host",
            PeerMessage::YtAction {
                action: "load".into(),
                new_video_id: Some("abcdefghijk".into()),
                video_id: None,
                title: Some("Film".into()),
                current_time: None,
                from_host: true,
                by_vote: None,
            },
        ),
        0.0,
    );
    let beat = |t: f64| PeerMessage::MediaHeartbeat {
        key: "yt:abcdefghijk".into(),
        current_time: t,
        is_playing: true,
    };
    // too soon after a change: left alone
    let fx = g.update(from("host", beat(50.0)), 1000.0);
    assert!(player(&fx).is_empty());
    // we're at ~10 s, the host at 50 s: jump (a little ahead)
    g.update(
        watch(WatchCommand::Player(PlayerReport::State {
            time: 10.0,
            playing: true,
            buffering: false,
            duration: 100.0,
        })),
        9000.0,
    );
    let fx = g.update(from("host", beat(50.0)), 9000.0);
    assert!(matches!(&player(&fx)[0], PlayerCmd::Seek { to, drift: true, .. } if (*to - 50.3).abs() < 1e-9));
    assert!(texts(&fx).contains(&"🔄 Re-synced with the room (was -40.0 s off)".to_owned()));
    // within 1.5 s: nothing
    g.update(
        watch(WatchCommand::Player(PlayerReport::State {
            time: 51.0,
            playing: true,
            buffering: false,
            duration: 100.0,
        })),
        10_000.0,
    );
    assert!(player(&g.update(from("host", beat(52.0)), 10_000.0)).is_empty());
    // not the reference: ignored
    connected_to(&mut g, "aaa", "Aaa");
    assert!(player(&g.update(from("aaa", beat(90.0)), 10_000.0)).is_empty());
    // keeps falling behind: three jumps, then it stops for two minutes
    for n in 0..2 {
        g.update(
            watch(WatchCommand::Player(PlayerReport::State {
                time: 0.0,
                playing: true,
                buffering: false,
                duration: 100.0,
            })),
            11_000.0 + f64::from(n),
        );
        let fx = g.update(from("host", beat(60.0)), 11_000.0 + f64::from(n));
        assert!(!player(&fx).is_empty());
        if n == 1 {
            assert!(
                texts(&fx)
                    .iter()
                    .any(|t| t.contains("Auto re-sync paused for 2 minutes"))
            );
        }
    }
    g.update(
        watch(WatchCommand::Player(PlayerReport::State {
            time: 0.0,
            playing: true,
            buffering: false,
            duration: 100.0,
        })),
        12_000.0,
    );
    assert!(player(&g.update(from("host", beat(60.0)), 12_000.0)).is_empty());

    // as the host, we send the heartbeat every 4 s
    let mut h = hosting_with(&[("riya", "Riya")]);
    h.update(
        watch(WatchCommand::PlayYouTube {
            id: "abcdefghijk".into(),
            title: "Film".into(),
        }),
        0.0,
    );
    let fx = h.update(Input::Tick, 5000.0);
    let hb = &sent(&fx)[0];
    assert_eq!(
        (hb["type"].as_str(), hb["key"].as_str(), hb["isPlaying"].as_bool()),
        (Some("media-heartbeat"), Some("yt:abcdefghijk"), Some(true))
    );
    assert!(sent(&h.update(Input::Tick, 6000.0)).is_empty());
}

#[test]
fn the_host_lock_stops_guests_and_puts_them_back() {
    let mut g = guest_of("host");
    g.update(
        from("host", PeerMessage::RoomSettings { playback_lock: true }),
        1.0,
    );
    let fx = g.update(
        watch(WatchCommand::PlayYouTube {
            id: "abcdefghijk".into(),
            title: "x".into(),
        }),
        2.0,
    );
    assert!(texts(&fx).contains(&"🔒 Only the host can control playback right now".to_owned()));
    assert_eq!(
        sent(&fx)[0]["type"],
        "yt-request-sync",
        "asks the host to put it back"
    );
    assert!(g.watch().showing.is_none());
    // a guest's pause from an older app is dropped; the host's goes through
    g.update(
        from(
            "host",
            PeerMessage::YtAction {
                action: "load".into(),
                new_video_id: Some("abcdefghijk".into()),
                video_id: None,
                title: None,
                current_time: None,
                from_host: true,
                by_vote: None,
            },
        ),
        3.0,
    );
    assert!(g.watch().showing.is_some());
    connected_to(&mut g, "riya", "Riya");
    assert!(player(&g.update(from("riya", yt("pause", Some(1.0))), 4.0)).is_empty());
    // our own pause under the lock: blocked, the host's answer puts us back
    let fx = g.update(
        watch(WatchCommand::Player(PlayerReport::User {
            action: UserAction::Pause,
            time: 9.0,
        })),
        10_000.0,
    );
    assert!(!sent(&fx).iter().any(|m| m["type"] == "yt-action"));
    let fx = g.update(
        from(
            "host",
            PeerMessage::YtSyncState {
                video_id: Some("abcdefghijk".into()),
                nothing_playing: None,
                current_time: Some(9.5),
                is_playing: Some(true),
                queue: None,
                skip_votes: None,
                active_video_title: None,
            },
        ),
        10_100.0,
    );
    assert!(matches!(&player(&fx)[0], PlayerCmd::Play { at: Some(t), .. } if *t == 9.5));
}

#[test]
fn the_queue_and_vote_to_skip() {
    let mut r = hosting_with(&[("riya", "Riya"), ("sam", "Sam")]);
    // nothing playing: the first one added starts at once
    let fx = r.update(
        watch(WatchCommand::QueueAdd {
            id: "a".into(),
            video_id: Some("aaaaaaaaaaa".into()),
            media: None,
            title: "A".into(),
            autoplay: true,
        }),
        1.0,
    );
    assert!(texts(&fx).contains(&"▶️ Now playing: \"A\"".to_owned()));
    let fx = r.update(
        watch(WatchCommand::QueueAdd {
            id: "b".into(),
            video_id: Some("bbbbbbbbbbb".into()),
            media: None,
            title: "B".into(),
            autoplay: true,
        }),
        2.0,
    );
    let add = &sent(&fx)[0];
    assert_eq!(
        (
            add["type"].as_str(),
            add["action"].as_str(),
            add["item"]["videoId"].as_str()
        ),
        (Some("queue-action"), Some("add"), Some("bbbbbbbbbbb"))
    );
    assert!(texts(&fx).contains(&"📑 Added to queue: \"B\"".to_owned()));
    // Riya adds one, then reorders
    r.update(
        from(
            "riya",
            PeerMessage::QueueAction {
                action: "add".into(),
                item: Some(
                    json!({"id":"c","videoId":"ccccccccccc","title":"C","addedBy":"Riya","timestamp":3}),
                ),
                item_id: None,
                queue: None,
                next_video_id: None,
                next_title: None,
                remaining_queue: None,
                skip_votes: None,
            },
        ),
        3.0,
    );
    let fx = r.update(
        watch(WatchCommand::QueueMove {
            id: "c".into(),
            to: 0,
        }),
        4.0,
    );
    assert_eq!(
        sent(&fx)[0]["queue"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["c", "b"]
    );
    // the video ends: next one, and everyone is told what's left
    let fx = r.update(watch(WatchCommand::Player(PlayerReport::Ended)), 5.0);
    let next = sent(&fx)
        .into_iter()
        .find(|m| m["type"] == "queue-action")
        .unwrap();
    assert_eq!(
        (
            next["action"].as_str(),
            next["nextVideoId"].as_str(),
            next["remainingQueue"].as_array().map(Vec::len)
        ),
        (Some("next"), Some("ccccccccccc"), Some(1))
    );
    assert!(matches!(r.watch().showing, Some(Showing::YouTube { ref id, .. }) if id == "ccccccccccc"));
    // 3 people: 2 votes skip (ceil(2/2) = 1 from the others' count... the web app's formula)
    let fx = r.update(watch(WatchCommand::VoteSkip), 6.0);
    assert!(
        texts(&fx)
            .iter()
            .any(|t| t.starts_with("⏭️ Vote skip passed (1/1)"))
    );
    assert!(matches!(r.watch().showing, Some(Showing::YouTube { ref id, .. }) if id == "bbbbbbbbbbb"));
    assert!(sent(&fx).iter().any(|m| m["action"] == "vote-skip-passed"));
    assert_eq!(r.watch().votes_needed, 2, "the player shows ceil(3/2)");
    // nothing left: a passed vote closes it for everyone
    let fx = r.update(watch(WatchCommand::VoteSkip), 7.0);
    assert!(r.watch().showing.is_none());
    assert!(
        sent(&fx)
            .iter()
            .any(|m| m["type"] == "yt-action" && m["action"] == "close" && m["byVote"] == true)
    );
}
