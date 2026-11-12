//! One 3RTC per person: starting it again (or clicking a `3rtc://` link, which starts it with the
//! link) hands a one-line message to the app already running and quits. The running app shows
//! its window, and for a link asks whether to join.
//!
//! Windows: a named pipe in the user's own session. Elsewhere (tests): a Unix socket.

use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// Bring the window to the front.
pub(crate) const SHOW: &str = "show";

/// What the claim found.
pub(crate) enum Instance {
    /// We're the first: messages from later launches arrive here.
    First(UnboundedReceiver<String>),
    /// Another 3RTC is running and got our message: quit.
    Forwarded,
}

fn user() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

/// Where instances meet (`RTC_INSTANCE` picks another, for tests).
fn name() -> String {
    name_for(&std::env::var("RTC_INSTANCE").unwrap_or_else(|_| user()))
}

/// The meeting point for `tag`: a named pipe on Windows, a socket file elsewhere.
fn name_for(tag: &str) -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\3rtc-{tag}")
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir()
            .join(format!("3rtc-{tag}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

/// Hands `message` to a running 3RTC, or becomes the one others hand theirs to. If neither
/// works (an odd system), the app just runs on its own.
pub(crate) fn claim(runtime: &tokio::runtime::Handle, message: &str) -> Instance {
    claim_at(runtime, name(), message)
}

// on Windows the pipe's name moves into the listening task
#[cfg_attr(not(windows), allow(clippy::needless_pass_by_value))]
fn claim_at(runtime: &tokio::runtime::Handle, name: String, message: &str) -> Instance {
    if runtime.block_on(send(&name, message)) {
        return Instance::Forwarded;
    }
    let (tx, rx) = unbounded_channel();
    let _guard = runtime.enter();
    #[cfg(windows)]
    let listening = listen(name, tx);
    #[cfg(not(windows))]
    let listening = listen(&name, tx);
    if let Err(e) = listening {
        tracing::warn!("couldn't listen for other launches: {e}");
    }
    Instance::First(rx)
}

async fn hand_over(mut stream: impl tokio::io::AsyncWrite + Unpin, message: &str) -> bool {
    stream.write_all(message.as_bytes()).await.is_ok()
        && stream.write_all(b"\n").await.is_ok()
        && stream.flush().await.is_ok()
}

async fn read_line(stream: impl tokio::io::AsyncRead + Unpin, tx: &UnboundedSender<String>) {
    let mut line = String::new();
    // no launch gets to send more than a short line
    let mut reader = BufReader::new(tokio::io::AsyncReadExt::take(stream, 4096));
    if reader.read_line(&mut line).await.is_ok() {
        let line = line.trim();
        if !line.is_empty() {
            let _ = tx.send(line.to_owned());
        }
    }
}

#[cfg(windows)]
async fn send(name: &str, message: &str) -> bool {
    use tokio::net::windows::named_pipe::ClientOptions;
    // the running app may be between two clients for a moment: try a few times
    for _ in 0..10 {
        match ClientOptions::new().open(name) {
            Ok(client) => return hand_over(client, message).await,
            // ERROR_PIPE_BUSY
            Err(e) if e.raw_os_error() == Some(231) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(_) => return false,
        }
    }
    false
}

#[cfg(windows)]
fn listen(name: String, tx: UnboundedSender<String>) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut server = ServerOptions::new().first_pipe_instance(true).create(&name)?;
    tokio::spawn(async move {
        loop {
            if server.connect().await.is_err() {
                return;
            }
            let client = server;
            server = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("stopped listening for other launches: {e}");
                    return;
                }
            };
            let tx = tx.clone();
            tokio::spawn(async move { read_line(client, &tx).await });
        }
    });
    Ok(())
}

#[cfg(not(windows))]
async fn send(name: &str, message: &str) -> bool {
    match tokio::net::UnixStream::connect(name).await {
        Ok(stream) => hand_over(stream, message).await,
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn listen(name: &str, tx: UnboundedSender<String>) -> std::io::Result<()> {
    // nobody answered, so a leftover socket file is stale
    let _ = std::fs::remove_file(name);
    let listener = tokio::net::UnixListener::bind(name)?;
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move { read_line(stream, &tx).await });
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic)] // tests: failing loudly is the point

    use super::{Instance, claim_at, name_for};

    #[test]
    fn a_second_launch_hands_its_message_to_the_first() {
        let name = name_for(&format!("test-{}", std::process::id()));
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let Instance::First(mut rx) = claim_at(rt.handle(), name.clone(), "first") else {
            panic!("the first launch must be first");
        };
        assert!(matches!(
            claim_at(rt.handle(), name, "link 12345"),
            Instance::Forwarded
        ));
        let got =
            rt.block_on(async { tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await });
        assert_eq!(got.ok().flatten().as_deref(), Some("link 12345"));
    }
}
