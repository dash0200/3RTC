//! Against the real Node signaling server (`server/server.js`): create a room, join it from a
//! second client, relay an offer, and come back after the server restarts.
//! Skipped (passes) when `node` or the server's packages aren't installed.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stderr)] // tests: failing loudly is the point

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use rtc_protocol::PeerId;
use rtc_protocol::sdp::{SdpType, SessionDescription};
use rtc_protocol::signaling::{ClientMessage, ServerMessage};
use rtc_signaling::{Backoff, Config, Event, find_room, spawn};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::timeout;

fn server_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../server")
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn start_server(port: u16) -> Option<Child> {
    let dir = server_dir();
    if !dir.join("node_modules").exists() {
        eprintln!("skipping: run `npm ci` in server/ first");
        return None;
    }
    let child = Command::new("node")
        .arg("server.js")
        .current_dir(dir)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(child) = child else {
        eprintln!("skipping: node isn't installed");
        return None;
    };
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Some(child);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("server didn't start on {port}");
}

fn config(port: u16) -> Config {
    let mut c = Config::new(format!("ws://127.0.0.1:{port}"));
    c.backoff = Backoff::new(Duration::from_millis(100), Duration::from_millis(400));
    c
}

async fn next(events: &mut UnboundedReceiver<Event>) -> Event {
    timeout(Duration::from_secs(10), events.recv())
        .await
        .expect("no event in 10 s")
        .expect("actor stopped")
}

/// The next server message, skipping ones that don't matter here.
async fn next_message(events: &mut UnboundedReceiver<Event>) -> ServerMessage {
    loop {
        match next(events).await {
            Event::Message(ServerMessage::HostToken { .. } | ServerMessage::Host { .. }) => {}
            Event::Message(m) => return m,
            e => panic!("expected a message, got {e:?}"),
        }
    }
}

#[tokio::test]
async fn create_join_relay_and_reconnect() {
    let port = free_port();
    let Some(server) = start_server(port).await else {
        return;
    };

    let (host, mut host_events) = spawn(config(port));
    assert!(matches!(
        next(&mut host_events).await,
        Event::Up {
            label: "Local",
            backup: false,
            ..
        }
    ));
    host.send(ClientMessage::CreateRoom {
        peer_id: PeerId::new("desk-host").unwrap(),
        room_id: None,
        host_token: None,
        seat_token: None,
    });
    let ServerMessage::RoomCreated { room_id, .. } = next_message(&mut host_events).await else {
        panic!("no room-created")
    };

    let (guest, mut guest_events) = spawn(config(port));
    assert!(matches!(next(&mut guest_events).await, Event::Up { .. }));
    guest.send(ClientMessage::Join {
        room_id,
        peer_id: PeerId::new("desk-guest").unwrap(),
        rejoin: false,
        seat_token: None,
    });
    let ServerMessage::Joined { peers, .. } = next_message(&mut guest_events).await else {
        panic!("no joined")
    };
    assert_eq!(peers, vec![PeerId::new("desk-host").unwrap()]);
    assert_eq!(
        next_message(&mut host_events).await,
        ServerMessage::PeerJoined {
            peer_id: PeerId::new("desk-guest").unwrap()
        }
    );

    let offer = SessionDescription {
        kind: SdpType::Offer,
        sdp: "v=0\r\n".into(),
    };
    host.send(ClientMessage::Offer {
        target_id: PeerId::new("desk-guest").unwrap(),
        offer: offer.clone(),
        fresh: false,
        ice_restart: false,
    });
    let ServerMessage::Offer { from, offer: got, .. } = next_message(&mut guest_events).await else {
        panic!("offer not relayed")
    };
    assert_eq!((from.as_str(), got), ("desk-host", offer));

    // the server goes away and comes back: the client notices and reconnects by itself
    drop(server);
    assert_eq!(next(&mut host_events).await, Event::Down);
    let _server = start_server(port).await.expect("restart");
    let up = timeout(Duration::from_secs(15), async {
        loop {
            if matches!(host_events.recv().await, Some(Event::Up { .. })) {
                break;
            }
        }
    })
    .await;
    assert!(up.is_ok(), "never reconnected");
}

#[tokio::test]
async fn falls_back_to_the_next_server_and_finds_rooms_across_servers() {
    let (dead, a_port, b_port) = (free_port(), free_port(), free_port());
    let Some(_a) = start_server(a_port).await else {
        return;
    };
    let Some(_b) = start_server(b_port).await else {
        return;
    };

    // the first server is down: the client moves on to the second and says it's a backup
    let mut c = Config::with_fallbacks(vec![
        format!("ws://127.0.0.1:{dead}"),
        format!("ws://127.0.0.1:{b_port}"),
    ]);
    c.backoff = Backoff::new(Duration::from_millis(50), Duration::from_millis(100));
    let (host, mut events) = spawn(c);
    let Event::Up { url, backup, .. } = next(&mut events).await else {
        panic!("not up")
    };
    assert!(url.ends_with(&b_port.to_string()) && backup);
    host.send(ClientMessage::CreateRoom {
        peer_id: PeerId::new("on-b").unwrap(),
        room_id: None,
        host_token: None,
        seat_token: None,
    });
    let ServerMessage::RoomCreated { room_id, .. } = next_message(&mut events).await else {
        panic!("no room")
    };

    // someone on server A looks for the room: only B has it
    let urls = vec![
        format!("ws://127.0.0.1:{a_port}"),
        format!("ws://127.0.0.1:{b_port}"),
    ];
    let found = find_room(urls.clone(), room_id, Duration::from_secs(5)).await;
    assert_eq!(found.as_deref(), Some(urls[1].as_str()));
    let missing = find_room(
        urls,
        rtc_protocol::RoomId::parse("99999").unwrap(),
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(missing, None);

    // switching moves the connection and keeps it there
    host.switch_server(format!("ws://127.0.0.1:{a_port}"));
    assert_eq!(next(&mut events).await, Event::Down);
    let Event::Up { url, .. } = next(&mut events).await else {
        panic!("not up after switch")
    };
    assert!(url.ends_with(&a_port.to_string()));
}

/// Secure servers (wss://) must not panic for want of TLS crypto (they did on Windows, where the
/// real server is wss://orc.3rtc.me): a wss connection that can't be made just fails and retries.
#[tokio::test]
async fn a_wss_server_is_tried_without_panicking() {
    // something that accepts the TCP connection (and then speaks no TLS), so the TLS setup runs
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            drop(sock);
        }
    });
    let mut c = Config::new(format!("wss://127.0.0.1:{port}"));
    c.backoff = Backoff::new(Duration::from_millis(50), Duration::from_millis(100));
    let (_h, mut events) = spawn(c);
    // the actor must still be alive (a panic would close the channel) after several attempts
    let still_running = timeout(Duration::from_millis(800), events.recv()).await.is_err();
    assert!(still_running, "the client stopped (panicked?)");
    let found = find_room(
        vec![format!("wss://127.0.0.1:{port}")],
        rtc_protocol::RoomId::parse("12345").unwrap(),
        Duration::from_secs(2),
    )
    .await;
    assert_eq!(found, None);
}
