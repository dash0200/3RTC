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
    /// `wss://…` (or `ws://` for a local server).
    pub url: String,
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
    /// Defaults matching the web app: ping every 25 s, dead after 60 s of silence.
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            ping_every: Duration::from_secs(25),
            silence_limit: Duration::from_secs(60),
            connect_timeout: Duration::from_secs(10),
            backoff: Backoff::default(),
        }
    }
}

/// What the client reports.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Connected (first time or again).
    Up,
    /// The connection dropped; reconnecting.
    Down,
    /// A message from the server.
    Message(ServerMessage),
}

/// Sends to the server. Dropping every handle closes the connection and stops the actor.
#[derive(Debug, Clone)]
pub struct Handle {
    tx: mpsc::UnboundedSender<ClientMessage>,
}

impl Handle {
    /// Queues a message. Returns `false` if the actor has stopped.
    pub fn send(&self, msg: ClientMessage) -> bool {
        self.tx.send(msg).is_ok()
    }
}

/// Starts the client on the current tokio runtime.
#[must_use]
pub fn spawn(config: Config) -> (Handle, mpsc::UnboundedReceiver<Event>) {
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
}

async fn run(
    config: Config,
    mut outgoing: mpsc::UnboundedReceiver<ClientMessage>,
    events: mpsc::UnboundedSender<Event>,
) {
    let mut backoff = config.backoff.clone();
    loop {
        // drop what was queued while down
        while outgoing.try_recv().is_ok() {}
        let attempt = timeout(
            config.connect_timeout,
            tokio_tungstenite::connect_async(config.url.as_str()),
        )
        .await;
        match attempt {
            Ok(Ok((socket, _))) => {
                backoff.reset();
                if events.send(Event::Up).is_err() {
                    return;
                }
                match connected(&config, socket, &mut outgoing, &events).await {
                    End::Stop => return,
                    End::Lost => {
                        if events.send(Event::Down).is_err() {
                            return;
                        }
                    }
                }
            }
            Ok(Err(e)) => tracing::debug!("signaling connect failed: {e}"),
            Err(_) => tracing::debug!("signaling connect timed out"),
        }
        let wait = backoff.next_wait(rand::random::<f64>());
        tokio::select! {
            () = sleep(wait) => {}
            // stop promptly if the app quits while we wait
            () = events.closed() => return,
        }
        if outgoing.is_closed() {
            return;
        }
    }
}

async fn connected<S>(
    config: &Config,
    socket: tokio_tungstenite::WebSocketStream<S>,
    outgoing: &mut mpsc::UnboundedReceiver<ClientMessage>,
    events: &mpsc::UnboundedSender<Event>,
) -> End
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut write, mut read) = socket.split();
    let mut ping = interval(config.ping_every);
    ping.tick().await;
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            msg = outgoing.recv() => {
                let Some(msg) = msg else {
                    let _ = write.send(Message::Close(None)).await;
                    return End::Stop;
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
