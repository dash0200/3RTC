//! BitTorrent sequential streaming service (`librqbit`).
//!
//! Provides background downloading and streaming of magnet links and `.torrent` files.
//! Video streams are exposed via a local loopback HTTP server (supporting HTTP Range requests)
//! for instant playback in `mpv`, while downloaded pieces on disk are shared with room peers
//! over 3RTC's WebRTC bulk range channels (`RNG1`).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::Context as _;
use librqbit::{AddTorrent, Api, ManagedTorrent, Session, SessionOptions, http_api::HttpApi};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

/// Progress updates emitted while buffering / streaming a torrent.
#[derive(Debug, Clone)]
pub(crate) enum TorrentProgress {
    /// Connecting to the BitTorrent DHT and tracker peers.
    Connecting {
        /// Magnet or torrent name if known.
        title: String,
    },
    /// Metadata resolved, video file identified inside the torrent.
    Resolved {
        /// Torrent name or video title.
        title: String,
        /// Name of the primary video file selected.
        filename: String,
        /// Size of the video file in bytes.
        size: u64,
        /// Stream URL served by the local loopback HTTP server.
        stream_url: String,
        /// Local physical file path on disk where pieces are saved.
        file_path: PathBuf,
    },
    /// Pre-buffering initial pieces for smooth stutter-free playback.
    Buffering {
        /// Bytes downloaded so far.
        downloaded: u64,
        /// Pre-buffering target threshold (e.g. 15 MB).
        target: u64,
        /// Active connected seeds.
        seeds: usize,
        /// Active connected peers (seeds + leechers).
        peers: usize,
        /// Total discovered peers in the swarm.
        total_peers: usize,
        /// Download speed in bytes per second.
        speed_bps: u64,
    },
    /// The stream has enough buffer to play smoothly.
    ReadyToPlay {
        /// Primary video file name.
        name: String,
        /// Total file size in bytes.
        size: u64,
    },
    /// Ongoing live streaming statistics while playback is active.
    LiveStats {
        /// Active connected seeds.
        seeds: usize,
        /// Active connected peers.
        peers: usize,
        /// Total discovered peers in the swarm.
        total_peers: usize,
        /// Download speed in bytes per second.
        speed_bps: u64,
    },
    /// An error occurred during download or metadata resolution.
    Error(String),
}

/// Global handle to the application Tokio runtime.
static RUNTIME_HANDLE: OnceLock<tokio::runtime::Handle> = OnceLock::new();

/// Registers the application Tokio runtime handle for background torrent operations.
pub(crate) fn set_runtime_handle(handle: tokio::runtime::Handle) {
    let _ = RUNTIME_HANDLE.set(handle);
}

/// Retrieves the active Tokio runtime handle, falling back to ambient current runtime if set.
pub(crate) fn runtime_handle() -> Option<tokio::runtime::Handle> {
    RUNTIME_HANDLE
        .get()
        .cloned()
        .or_else(|| tokio::runtime::Handle::try_current().ok())
}

/// Global singleton session managing the local BitTorrent daemon and HTTP streaming server.
static TORRENT_SERVICE: OnceLock<TorrentService> = OnceLock::new();

/// The active torrent streaming service.
#[derive(Clone)]
pub(crate) struct TorrentService {
    session: Arc<Session>,
    http_port: u16,
    active_handle: Arc<Mutex<Option<Arc<ManagedTorrent>>>>,
}

impl TorrentService {
    /// Gets or initializes the shared torrent service asynchronously.
    pub(crate) async fn get() -> anyhow::Result<Self> {
        if let Some(svc) = TORRENT_SERVICE.get() {
            return Ok(svc.clone());
        }

        let dir = std::env::temp_dir().join("3RTC").join("torrents");
        let _ = std::fs::create_dir_all(&dir);

        // Bind an ephemeral loopback port for HTTP range streaming to mpv
        let bind_addr: SocketAddr = "127.0.0.1:0"
            .parse()
            .map_err(|e| anyhow::anyhow!("Invalid bind address: {e}"))?;
        let listener = librqbit_dualstack_sockets::TcpListener::bind_tcp(bind_addr, Default::default())
            .map_err(|e| anyhow::anyhow!("Failed to bind torrent HTTP listener: {e}"))?;
        let local_addr = listener.bind_addr();
        let http_port = local_addr.port();

        // Create the librqbit session
        let session_opts = SessionOptions {
            persistence: None, // In-memory session tracking for ephemeral streams
            ..Default::default()
        };
        let session = Session::new_with_opts(dir.clone(), session_opts)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to initialize BitTorrent session: {e}"))?;

        // Launch the internal HTTP API server
        let api = Api::new(session.clone(), None, None);
        let http_api = HttpApi::new(api, None);
        if let Some(h) = runtime_handle() {
            h.spawn(async move {
                if let Err(e) = http_api.make_http_api_and_run(listener, None).await {
                    warn!("Torrent HTTP API server exited: {e}");
                }
            });
        } else {
            tokio::spawn(async move {
                if let Err(e) = http_api.make_http_api_and_run(listener, None).await {
                    warn!("Torrent HTTP API server exited: {e}");
                }
            });
        }

        info!("BitTorrent streaming service initialized on port {http_port}, download dir: {dir:?}");

        let svc = Self {
            session,
            http_port,
            active_handle: Arc::new(Mutex::new(None)),
        };

        let _ = TORRENT_SERVICE.set(svc.clone());
        Ok(svc)
    }

    /// The base URL for HTTP range streaming (e.g. `http://127.0.0.1:54321`).
    pub(crate) fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.http_port)
    }

    /// Starts streaming from a magnet link or `.torrent` file.
    ///
    /// Progress updates are reported via the provided channel sender.
    pub(crate) fn start_stream(
        runtime: &tokio::runtime::Handle,
        input: TorrentInput,
        tx: mpsc::UnboundedSender<TorrentProgress>,
    ) {
        let tx_err = tx.clone();
        runtime.spawn(async move {
            match Self::get().await {
                Ok(svc) => {
                    if let Err(e) = svc.run_stream(input, tx.clone()).await {
                        error!("Torrent stream error: {e}");
                        let _ = tx.send(TorrentProgress::Error(e.to_string()));
                    }
                }
                Err(e) => {
                    error!("Failed to start torrent service: {e}");
                    let _ = tx_err.send(TorrentProgress::Error(e.to_string()));
                }
            }
        });
    }

    async fn run_stream(
        &self,
        input: TorrentInput,
        tx: mpsc::UnboundedSender<TorrentProgress>,
    ) -> anyhow::Result<()> {
        let title = match &input {
            TorrentInput::Magnet(m) => parse_magnet_dn(m).unwrap_or_else(|| "Magnet Video".to_owned()),
            TorrentInput::TorrentFile(p) => p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Torrent Video".to_owned()),
        };

        let _ = tx.send(TorrentProgress::Connecting { title: title.clone() });

        let add_torrent = match input {
            TorrentInput::Magnet(magnet) => AddTorrent::from_url(magnet),
            TorrentInput::TorrentFile(path) => {
                let bytes = tokio::fs::read(&path)
                    .await
                    .with_context(|| format!("Failed to read torrent file: {path:?}"))?;
                AddTorrent::from_bytes(bytes)
            }
        };

        let opts = librqbit::AddTorrentOptions {
            overwrite: true,
            ..Default::default()
        };
        let add_resp = self
            .session
            .add_torrent(add_torrent, Some(opts))
            .await
            .map_err(|e| anyhow::anyhow!("Failed to add torrent: {e}"))?;

        let handle = add_resp
            .into_handle()
            .ok_or_else(|| anyhow::anyhow!("Torrent added in list-only mode"))?;

        // Store active handle
        {
            let mut active = self
                .active_handle
                .lock()
                .map_err(|_| anyhow::anyhow!("Mutex poisoned"))?;
            *active = Some(handle.clone());
        }

        // Wait for metadata resolution (trackers/DHT)
        tokio::select! {
            res = handle.wait_until_initialized() => {
                res.map_err(|e| anyhow::anyhow!("Metadata resolution failed: {e}"))?;
            }
            () = tokio::time::sleep(Duration::from_secs(45)) => {
                anyhow::bail!("Timed out resolving torrent metadata (no active peers found).");
            }
        }

        // Identify the largest video file
        let (file_id, video_filename, relative_path, video_size) = handle
            .with_metadata(|meta| {
                let mut best: Option<(usize, String, PathBuf, u64)> = None;
                for (idx, details) in meta.info.iter_file_details().enumerate() {
                    let pathbuf = details.filename.to_pathbuf();
                    let filename = pathbuf
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let len = details.len;
                    let is_vid = is_video_name(&filename);

                    match &best {
                        None => {
                            best = Some((idx, filename, pathbuf, len));
                        }
                        Some((_, _, _, best_len)) => {
                            if (is_vid && len > *best_len / 2) || len > *best_len {
                                best = Some((idx, filename, pathbuf, len));
                            }
                        }
                    }
                }
                best
            })
            .map_err(|e| anyhow::anyhow!("Failed reading torrent metadata: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("Torrent contains no files"))?;

        let output_folder = handle.output_folder();
        let file_path = output_folder.join(&relative_path);
        let info_hash = handle.info_hash();
        let stream_url = format!(
            "{}/torrents/{}/stream/{}",
            self.base_url(),
            info_hash.as_string(),
            file_id
        );

        info!(
            "Torrent resolved: {:?} ({} bytes), streaming from {}",
            video_filename, video_size, stream_url
        );

        let _ = tx.send(TorrentProgress::Resolved {
            title: title.clone(),
            filename: video_filename.clone(),
            size: video_size,
            stream_url: stream_url.clone(),
            file_path: file_path.clone(),
        });

        // Pre-buffering threshold: first ~15 MB or 5% of file (whichever is smaller)
        let target_buffer = (video_size / 20).clamp(5 * 1024 * 1024, 20 * 1024 * 1024);
        let mut last_check = std::time::Instant::now();
        let mut last_downloaded: u64 = 0;
        let mut ready_sent = false;

        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;

            let stats = handle.stats();
            let downloaded = stats.progress_bytes;
            let (seeds, peers, total_peers) = if let Some(l) = &stats.live {
                let p = &l.snapshot.peer_stats;
                (
                    p.live_seeders as usize,
                    p.live as usize,
                    (p.seen.max(p.live) + p.connecting + p.queued) as usize,
                )
            } else {
                (0, 0, 0)
            };

            let elapsed = last_check.elapsed();
            let speed = if elapsed.as_secs_f64() > 0.0 {
                let delta = downloaded.saturating_sub(last_downloaded);
                (delta as f64 / elapsed.as_secs_f64()) as u64
            } else {
                0
            };
            last_downloaded = downloaded;
            last_check = std::time::Instant::now();

            if !ready_sent {
                let _ = tx.send(TorrentProgress::Buffering {
                    downloaded,
                    target: target_buffer,
                    seeds,
                    peers,
                    total_peers,
                    speed_bps: speed,
                });

                // When target buffer reached, or if file is small, signal ready to play
                if downloaded >= target_buffer || downloaded >= video_size || stats.finished {
                    info!(
                        "Torrent pre-buffer ready: {} / {} bytes",
                        downloaded, target_buffer
                    );
                    let _ = tx.send(TorrentProgress::ReadyToPlay {
                        name: video_filename.clone(),
                        size: video_size,
                    });
                    ready_sent = true;
                }
            } else {
                let _ = tx.send(TorrentProgress::LiveStats {
                    seeds,
                    peers,
                    total_peers,
                    speed_bps: speed,
                });
            }

            debug!(
                "Torrent progress: {} / {} MB (s:{} p:{}/{}, {:.1} MB/s)",
                downloaded / (1024 * 1024),
                video_size / (1024 * 1024),
                seeds,
                peers,
                total_peers,
                speed as f64 / (1024.0 * 1024.0)
            );
        }
    }
}

/// The input source for a torrent.
#[derive(Debug, Clone)]
pub(crate) enum TorrentInput {
    /// A `magnet:?xt=urn:btih:...` link.
    Magnet(String),
    /// A local `.torrent` file on disk.
    TorrentFile(PathBuf),
}

/// Helper to check if a filename has a video extension.
pub(crate) fn is_video_name(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".mp4")
        || n.ends_with(".mkv")
        || n.ends_with(".webm")
        || n.ends_with(".mov")
        || n.ends_with(".avi")
        || n.ends_with(".m4v")
        || n.ends_with(".ts")
        || n.ends_with(".flv")
}

/// Parses the display name (`dn`) from a magnet URI if available.
pub(crate) fn parse_magnet_dn(magnet: &str) -> Option<String> {
    if !magnet.starts_with("magnet:?") {
        return None;
    }
    for part in magnet["magnet:?".len()..].split('&') {
        if let Some(dn) = part.strip_prefix("dn=") {
            let decoded = urlencoding::decode(dn).ok()?.into_owned();
            if !decoded.trim().is_empty() {
                return Some(decoded);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_magnet_display_name() {
        let uri = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969";
        assert_eq!(parse_magnet_dn(uri), Some("Sintel".to_owned()));

        let uri_encoded = "magnet:?xt=urn:btih:12345&dn=Big%20Buck%20Bunny%201080p";
        assert_eq!(
            parse_magnet_dn(uri_encoded),
            Some("Big Buck Bunny 1080p".to_owned())
        );

        assert_eq!(parse_magnet_dn("https://youtube.com"), None);
        assert_eq!(parse_magnet_dn("magnet:?xt=urn:btih:12345"), None);
    }

    #[test]
    fn detects_video_file_extensions() {
        assert!(is_video_name("movie.mp4"));
        assert!(is_video_name("film.MKV"));
        assert!(is_video_name("clip.webm"));
        assert!(is_video_name("video.avi"));
        assert!(is_video_name("stream.m4v"));
        assert!(is_video_name("recording.mov"));

        assert!(!is_video_name("subtitles.srt"));
        assert!(!is_video_name("cover.jpg"));
        assert!(!is_video_name("readme.txt"));
        assert!(!is_video_name("info.nfo"));
    }
}
