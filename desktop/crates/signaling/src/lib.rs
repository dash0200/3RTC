//! The signaling client: one WebSocket to the 3RTC server, run as an actor.
//!
//! [`spawn`] starts it and returns a [`Handle`] to send with and a stream of [`Event`]s. It
//! reconnects by itself with jittered backoff, pings every 25 s (the server drops quiet
//! sockets) and treats a socket that has gone silent as dead. Messages sent while it is down
//! are dropped: on [`Event::Up`] the room logic re-claims its seat, and old offers are stale.

#![deny(missing_docs)]

mod backoff;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rtc_protocol::signaling::{ClientMessage, ServerMessage};
use tokio::sync::mpsc;
use tokio::time::{Instant, interval, sleep, timeout};
use tokio_tungstenite::tungstenite::Message;

pub use backoff::Backoff;

/// How the client connects.
#[derive(Debug, Clone)]
pub struct Config {
    /// Servers to try, in order (`wss://…`, or `ws://` for a local one). After a failed attempt
    /// the next one is tried; once connected the client stays on that one.
    pub urls: Vec<String>,
    /// How often to ping.
    pub ping_every: Duration,
    /// No message for this long means the socket is dead.
    pub silence_limit: Duration,
    /// Give up on a connection attempt after this long.
    pub connect_timeout: Duration,
    /// Waits between reconnect attempts.
    pub backoff: Backoff,
}

impl Config {
    /// Defaults matching the web app: ping every 25 s, dead after 35 s of silence (a ping not
    /// answered within 10 s: after a network change the old socket can look open for minutes).
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self::with_fallbacks(vec![url.into()])
    }

    /// The first server, then the others in order when it can't be reached.
    #[must_use]
    pub fn with_fallbacks(urls: Vec<String>) -> Self {
        Self {
            urls,
            ping_every: Duration::from_secs(25),
            silence_limit: Duration::from_secs(35),
            connect_timeout: Duration::from_secs(10),
            backoff: Backoff::default(),
        }
    }
}

/// How often the session checks for silence.
const SILENCE_CHECK_EVERY: Duration = Duration::from_secs(5);

/// What the client reports.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Connected (first time or again), to this server.
    Up {
        /// Its URL.
        url: String,
        /// Its name for people ("Oracle Cloud", "Local").
        label: &'static str,
        /// It isn't the first server in the list.
        backup: bool,
    },
    /// The connection dropped; reconnecting.
    Down,
    /// A message from the server.
    Message(ServerMessage),
}

/// What the actor is asked to do.
#[derive(Debug)]
enum Request {
    Send(ClientMessage),
    /// Move to this server now and stay on it (it has our room).
    Switch(String),
}

/// Sends to the server. Dropping every handle closes the connection and stops the actor.
#[derive(Debug, Clone)]
pub struct Handle {
    tx: mpsc::UnboundedSender<Request>,
}

impl Handle {
    /// Queues a message. Returns `false` if the actor has stopped.
    pub fn send(&self, msg: ClientMessage) -> bool {
        self.tx.send(Request::Send(msg)).is_ok()
    }

    /// Moves to `url` now (dropping the current connection) and stays there for reconnects.
    pub fn switch_server(&self, url: String) -> bool {
        self.tx.send(Request::Switch(url)).is_ok()
    }
}

/// The name people see for a server (`getServerLabel` in `useSignalingConnection.ts`).
#[must_use]
pub fn server_label(url: &str) -> &'static str {
    if url.contains("orc.3rtc.me") {
        "Oracle Cloud"
    } else if url.contains("gcp.3rtc.me") {
        "Google Cloud"
    } else if url.contains("localhost") || url.contains("127.0.0.1") {
        "Local"
    } else {
        "Cloud"
    }
}

/// Picks the TLS crypto for `wss://` once per process (ring). Without it rustls can't choose one
/// and panics on the first secure connection.
pub fn install_tls_crypto() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Err only means another part of the process installed one first: that one is used
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Starts the client on the current tokio runtime.
#[must_use]
pub fn spawn(config: Config) -> (Handle, mpsc::UnboundedReceiver<Event>) {
    install_tls_crypto();
    let (tx, rx) = mpsc::unbounded_channel();
    let (events_tx, events) = mpsc::unbounded_channel();
    tokio::spawn(run(config, rx, events_tx));
    (Handle { tx }, events)
}

/// Why one connection ended.
enum End {
    /// Every handle is gone (or nobody listens to events): stop for good.
    Stop,
    /// The socket broke: reconnect.
    Lost,
    /// Asked to move to another server.
    Switch(String),
}

async fn run(
    config: Config,
    mut requests: mpsc::UnboundedReceiver<Request>,
    events: mpsc::UnboundedSender<Event>,
) {
    let mut backoff = config.backoff.clone();
    let mut index = 0;
    // the server that has our room, once known: used for every reconnect
    let mut pinned: Option<String> = None;
    loop {
        let url = pinned
            .clone()
            .unwrap_or_else(|| config.urls.get(index).cloned().unwrap_or_default());
        // drop what was queued while down; honour a switch asked meanwhile
        while let Ok(r) = requests.try_recv() {
            if let Request::Switch(to) = r {
                pinned = Some(to);
            }
        }
        let url = pinned.clone().unwrap_or(url);
        let attempt = timeout(
            config.connect_timeout,
            tokio_tungstenite::connect_async(url.as_str()),
        )
        .await;
        match attempt {
            Ok(Ok((socket, _))) => {
                backoff.reset();
                let backup = config.urls.first().is_some_and(|first| *first != url);
                if events
                    .send(Event::Up {
                        url: url.clone(),
                        label: server_label(&url),
                        backup,
                    })
                    .is_err()
                {
                    return;
                }
                match connected(&config, socket, &mut requests, &events).await {
                    End::Stop => return,
                    End::Lost => {
                        if events.send(Event::Down).is_err() {
                            return;
                        }
                    }
                    End::Switch(to) => {
                        pinned = Some(to);
                        if events.send(Event::Down).is_err() {
                            return;
                        }
                        continue;
                    }
                }
            }
            Ok(Err(e)) => {
                tracing::debug!("signaling connect to {url} failed: {e}");
                if pinned.is_none() && !config.urls.is_empty() {
                    index = (index + 1) % config.urls.len();
                }
            }
            Err(_) => {
                tracing::debug!("signaling connect to {url} timed out");
                if pinned.is_none() && !config.urls.is_empty() {
                    index = (index + 1) % config.urls.len();
                }
            }
        }
        let wait = backoff.next_wait(rand::random::<f64>());
        tokio::select! {
            () = sleep(wait) => {}
            // stop promptly if the app quits while we wait
            () = events.closed() => return,
        }
        if requests.is_closed() {
            return;
        }
    }
}

/// Which of `urls` has room `room` (all asked at once), or `None` if none says yes in time
/// (`findRoomOn` in `client-ts/src/webrtc/findRoom.ts`).
pub async fn find_room(urls: Vec<String>, room: rtc_protocol::RoomId, wait: Duration) -> Option<String> {
    install_tls_crypto();
    use futures_util::stream::{FuturesUnordered, StreamExt as _};
    let ask = |url: String| async move {
        let (mut socket, _) = tokio_tungstenite::connect_async(url.as_str()).await.ok()?;
        let msg = ClientMessage::FindRoom { room_id: room }.to_json().ok()?;
        socket.send(Message::text(msg)).await.ok()?;
        while let Some(Ok(frame)) = socket.next().await {
            if let Message::Text(text) = frame {
                match ServerMessage::from_json(&text) {
                    Ok(ServerMessage::RoomFound { room_id, exists }) if room_id == room => {
                        let _ = socket.close(None).await;
                        return exists.then_some(url);
                    }
                    Ok(ServerMessage::Error { .. }) => return None,
                    _ => {}
                }
            }
        }
        None
    };
    let mut asks: FuturesUnordered<_> = urls.into_iter().map(ask).collect();
    timeout(wait, async {
        while let Some(found) = asks.next().await {
            if found.is_some() {
                return found;
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

async fn connected<S>(
    config: &Config,
    socket: tokio_tungstenite::WebSocketStream<S>,
    requests: &mut mpsc::UnboundedReceiver<Request>,
    events: &mpsc::UnboundedSender<Event>,
) -> End
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut write, mut read) = socket.split();
    let mut ping = interval(config.ping_every);
    ping.tick().await;
    // Silence is checked often, so a dead socket is noticed soon after the limit (not at the next ping)
    let mut check = interval(SILENCE_CHECK_EVERY.min(config.silence_limit));
    check.tick().await;
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            req = requests.recv() => {
                let msg = match req {
                    None => {
                        let _ = write.send(Message::Close(None)).await;
                        return End::Stop;
                    }
                    Some(Request::Switch(to)) => {
                        let _ = write.send(Message::Close(None)).await;
                        return End::Switch(to);
                    }
                    Some(Request::Send(msg)) => msg,
                };
                let Ok(text) = msg.to_json() else { continue };
                if write.send(Message::text(text)).await.is_err() {
                    return End::Lost;
                }
            }
            frame = read.next() => {
                heard = Instant::now();
                match frame {
                    Some(Ok(Message::Text(text))) => match ServerMessage::from_json(&text) {
                        Ok(ServerMessage::Pong) => {}
                        Ok(m) => if events.send(Event::Message(m)).is_err() { return End::Stop },
                        Err(e) => tracing::warn!("bad server message: {e}"),
                    },
                    Some(Ok(Message::Close(_)) | Err(_)) | None => return End::Lost,
                    Some(Ok(_)) => {}
                }
            }
            _ = check.tick() => {
                if heard.elapsed() > config.silence_limit {
                    tracing::info!("signaling silent for {:?}: reconnecting", heard.elapsed());
                    return End::Lost;
                }
            }
            _ = ping.tick() => {
                if heard.elapsed() > config.silence_limit {
                    tracing::info!("signaling silent for {:?}: reconnecting", heard.elapsed());
                    return End::Lost;
                }
                let Ok(text) = ClientMessage::Ping.to_json() else { continue };
                if write.send(Message::text(text)).await.is_err() {
                    return End::Lost;
                }
            }
        }
    }
}
