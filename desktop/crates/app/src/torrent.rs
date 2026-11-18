//! BitTorrent sequential streaming service (`librqbit`).
//!
//! Provides background downloading and streaming of magnet links and `.torrent` files.
//! Opening one first lists its files without downloading anything; when it holds more than one
//! file the user picks one (`TorrentProgress::ChooseFile`, answered by `TorrentService::choose_file`),
//! with the subtitle files to load with it (those matching it are ticked: `matching_subtitles`),
//! and only those files' pieces are downloaded (librqbit `only_files`). Each subtitle file is
//! reported (`TorrentProgress::Subtitle`) once it's complete.
//!
//! With "Keep torrent downloads" on (the default) files are kept in
//! `Downloads\3RTC\Torrents\<torrent name>\…`, the layout qBittorrent uses ("Original"), so a
//! download can be finished there; off, they go to a temporary folder that is deleted when the
//! torrent stops (and at the next start). Nothing is ever uploaded to the swarm
//! (`disable_upload`): the host's upload is kept for the room's viewers.
//! Video streams are exposed via a local loopback HTTP server (supporting HTTP Range requests)
//! for instant playback in `mpv`, while downloaded pieces on disk are shared with room peers
//! over 3RTC's WebRTC bulk range channels (`RNG1`).

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::Context as _;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, Api, ManagedTorrent, Session, SessionOptions,
    http_api::HttpApi,
};
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
    /// The torrent holds several files: the user picks the one to stream.
    ChooseFile {
        /// Torrent name or video title.
        title: String,
        /// The torrent's real files (the picker groups them with `group_by_folder`).
        files: Vec<TorrentFileEntry>,
        /// The file id we'd pick on our own (the largest video).
        suggested: usize,
    },
    /// A subtitle file picked with the video is complete on disk.
    Subtitle {
        /// Where it is.
        path: PathBuf,
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

/// "Keep torrent downloads" (the setting, also switched from the file picker): read when the
/// torrent's file is picked, so the picker's switch counts for that torrent.
static KEEP: AtomicBool = AtomicBool::new(true);

/// Sets whether the next picked torrent file is kept in `Downloads\3RTC\Torrents`.
pub(crate) fn set_keep(on: bool) {
    KEEP.store(on, Ordering::Relaxed);
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

/// The torrent playing, and whether its files are deleted when it stops (not kept).
type Active = (Arc<ManagedTorrent>, bool);

/// The user's pick: the video's file id and the subtitle files' ids to load with it.
type Choice = (usize, Vec<usize>);

/// The active torrent streaming service.
#[derive(Clone)]
pub(crate) struct TorrentService {
    session: Arc<Session>,
    http_port: u16,
    /// The session's own folder (temporary); each torrent gets its own `output_folder`.
    session_dir: PathBuf,
    /// The torrent playing, and whether its files go when it stops (not kept).
    active_handle: Arc<Mutex<Option<Active>>>,
    active_cancel: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Waiting for the user to pick a file from a multi-file torrent.
    pending_choice: Arc<Mutex<Option<tokio::sync::oneshot::Sender<Choice>>>>,
}

impl TorrentService {
    /// Gets or initializes the shared torrent service asynchronously.
    pub(crate) async fn get() -> anyhow::Result<Self> {
        if let Some(svc) = TORRENT_SERVICE.get() {
            return Ok(svc.clone());
        }

        // the temporary folder: what wasn't kept last time goes now (nothing plays yet)
        let dir = temp_download_dir();
        let _ = std::fs::remove_dir_all(&dir);
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
            // leech only: no bitfield, no haves, piece requests refused
            disable_upload: true,
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
            session_dir: dir,
            active_handle: Arc::new(Mutex::new(None)),
            active_cancel: Arc::new(Mutex::new(None)),
            pending_choice: Arc::new(Mutex::new(None)),
        };

        let _ = TORRENT_SERVICE.set(svc.clone());
        Ok(svc)
    }

    /// The base URL for HTTP range streaming (e.g. `http://127.0.0.1:54321`).
    pub(crate) fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.http_port)
    }

    /// Cancels any currently preloading or streaming torrent.
    pub(crate) fn cancel_stream(runtime: &tokio::runtime::Handle) {
        runtime.spawn(async {
            if let Some(svc) = TORRENT_SERVICE.get() {
                svc.stop_active().await;
            }
        });
    }

    /// The user picked a file (by torrent file id) from the `ChooseFile` list, with the subtitle
    /// files to load with it. Returns `false` when no torrent is waiting for a pick (it was
    /// cancelled or replaced).
    pub(crate) fn choose_file(file_id: usize, subtitles: Vec<usize>) -> bool {
        let Some(svc) = TORRENT_SERVICE.get() else {
            return false;
        };
        let pending = svc.pending_choice.lock().ok().and_then(|mut p| p.take());
        pending.is_some_and(|tx| tx.send((file_id, subtitles)).is_ok())
    }

    /// Stops and removes the active torrent from the session.
    pub(crate) async fn stop_active(&self) {
        // dropping the sender ends a pending file pick
        if let Ok(mut pending) = self.pending_choice.lock() {
            pending.take();
        }
        if let Ok(mut cancel) = self.active_cancel.lock()
            && let Some(tx) = cancel.take()
        {
            let _ = tx.send(());
        }
        let handle = self.active_handle.lock().ok().and_then(|mut h| h.take());
        if let Some((h, delete_files)) = handle {
            info!("Stopping and removing active torrent {:?}", h.info_hash());
            // kept downloads stay on disk; temporary ones go
            let _ = self.session.delete(h.id().into(), delete_files).await;
        }
    }

    /// Starts streaming from a magnet link or `.torrent` file.
    ///
    /// Progress updates are reported via the provided channel sender. Where the file goes is
    /// `set_keep`'s, read once the file is picked.
    pub(crate) fn start_stream(
        runtime: &tokio::runtime::Handle,
        input: TorrentInput,
        tx: mpsc::UnboundedSender<TorrentProgress>,
    ) {
        let tx_err = tx.clone();
        runtime.spawn(async move {
            match Self::get().await {
                Ok(svc) => {
                    // Stop any previous torrent first so only one torrent is ever active
                    svc.stop_active().await;

                    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
                    if let Ok(mut c) = svc.active_cancel.lock() {
                        *c = Some(cancel_tx);
                    }

                    if let Err(e) = svc.run_stream(input, tx.clone(), cancel_rx).await {
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
        mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
    ) -> anyhow::Result<()> {
        let title = match &input {
            TorrentInput::Magnet(m) => parse_magnet_dn(m).unwrap_or_else(|| "Magnet Video".to_owned()),
            TorrentInput::TorrentFile(p) => p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Torrent Video".to_owned()),
        };

        let _ = tx.send(TorrentProgress::Connecting { title: title.clone() });

        let source = match input {
            TorrentInput::Magnet(magnet) => AddTorrent::from_url(magnet),
            TorrentInput::TorrentFile(path) => {
                let bytes = tokio::fs::read(&path)
                    .await
                    .with_context(|| format!("Failed to read torrent file: {path:?}"))?;
                AddTorrent::from_bytes(bytes)
            }
        };

        // Phase 1: metadata only (trackers/DHT for a magnet). Nothing is downloaded or created.
        let list_opts = AddTorrentOptions {
            list_only: true,
            ..Default::default()
        };
        let listed = tokio::select! {
            _ = &mut cancel_rx => {
                info!("Torrent stream cancelled during metadata resolution.");
                return Ok(());
            }
            res = self.session.add_torrent(source, Some(list_opts)) => {
                res.map_err(|e| anyhow::anyhow!("Metadata resolution failed: {e}"))?
            }
            () = tokio::time::sleep(Duration::from_secs(45)) => {
                anyhow::bail!("Timed out resolving torrent metadata (no active peers found).");
            }
        };
        let AddTorrentResponse::ListOnly(listed) = listed else {
            anyhow::bail!("Couldn't read the torrent's file list.");
        };

        let files = file_entries(listed.info.iter_file_details().map(|d| {
            let padding = d.attrs().padding;
            (d.filename.to_pathbuf(), d.len, padding)
        }));
        let suggested = default_file(&files).ok_or_else(|| anyhow::anyhow!("Torrent contains no files"))?;

        // Several files: the user picks one.
        let (file_id, subtitle_ids) = if files.len() > 1 {
            let (choice_tx, choice_rx) = tokio::sync::oneshot::channel();
            if let Ok(mut pending) = self.pending_choice.lock() {
                *pending = Some(choice_tx);
            }
            let _ = tx.send(TorrentProgress::ChooseFile {
                title: title.clone(),
                files: files.clone(),
                suggested,
            });
            tokio::select! {
                _ = &mut cancel_rx => {
                    info!("Torrent stream cancelled while choosing a file.");
                    return Ok(());
                }
                picked = choice_rx => match picked {
                    Ok(choice) => choice,
                    Err(_) => return Ok(()), // cancelled / replaced
                }
            }
        } else {
            (suggested, Vec::new())
        };
        let chosen = files
            .iter()
            .find(|f| f.id == file_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("That file isn't in this torrent."))?;

        // only real subtitle files of this torrent, never the video twice
        let subtitles: Vec<TorrentFileEntry> = files
            .iter()
            .filter(|f| f.subtitle && f.id != chosen.id && subtitle_ids.contains(&f.id))
            .cloned()
            .collect();

        // Phase 2: add it for real, downloading only the chosen files' pieces.
        let only: Vec<usize> = std::iter::once(chosen.id).chain(subtitles.iter().map(|f| f.id)).collect();
        // librqbit's own folder for it (the torrent's name for several files), under ours
        let sub = listed
            .output_folder
            .strip_prefix(&self.session_dir)
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let keep = KEEP.load(Ordering::Relaxed);
        let base = if keep { download_dir() } else { self.session_dir.clone() };
        let opts = AddTorrentOptions {
            overwrite: true,
            output_folder: Some(base.join(sub).to_string_lossy().into_owned()),
            only_files: Some(only.clone()),
            initial_peers: Some(listed.seen_peers),
            ..Default::default()
        };
        let add_resp = self
            .session
            .add_torrent(AddTorrent::from_bytes(listed.torrent_bytes), Some(opts))
            .await
            .map_err(|e| anyhow::anyhow!("Failed to add torrent: {e}"))?;
        let already_managed = matches!(add_resp, AddTorrentResponse::AlreadyManaged(..));

        let handle = add_resp
            .into_handle()
            .ok_or_else(|| anyhow::anyhow!("Torrent added in list-only mode"))?;

        // Store active handle
        {
            let mut active = self
                .active_handle
                .lock()
                .map_err(|_| anyhow::anyhow!("Mutex poisoned"))?;
            *active = Some((handle.clone(), !keep));
        }

        // Pieces already on disk get checked here (no network wait: the metadata is known)
        tokio::select! {
            _ = &mut cancel_rx => {
                info!("Torrent stream cancelled during initialization.");
                return Ok(());
            }
            res = handle.wait_until_initialized() => {
                res.map_err(|e| anyhow::anyhow!("Torrent initialization failed: {e}"))?;
            }
        }
        // A torrent the session already had keeps its old selection: set ours.
        if already_managed {
            let set: HashSet<usize> = only.into_iter().collect();
            self.session
                .update_only_files(&handle, &set)
                .await
                .map_err(|e| anyhow::anyhow!("Couldn't select the file: {e}"))?;
        }

        let TorrentFileEntry {
            id: file_id,
            name: video_filename,
            path: _,
            size: video_size,
            playable: _,
            subtitle: _,
        } = chosen;
        let relative_path = listed_relative_path(&files, file_id);

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
        // subtitle files still downloading: (file id, size, where)
        let mut subs_left: Vec<(usize, u64, PathBuf)> = subtitles
            .iter()
            .map(|f| (f.id, f.size, output_folder.join(listed_relative_path(&files, f.id))))
            .collect();

        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    info!("Torrent stream cancelled during buffering.");
                    return Ok(());
                }
                () = tokio::time::sleep(Duration::from_millis(500)) => {}
            }

            let stats = handle.stats();
            let downloaded = stats.progress_bytes;
            // subtitle files complete on disk: to the player
            subs_left.retain(|(id, size, path)| {
                let done = stats.file_progress.get(*id).is_some_and(|got| got >= size);
                if done {
                    let _ = tx.send(TorrentProgress::Subtitle { path: path.clone() });
                }
                !done
            });
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

/// Torrents not kept: a temporary folder, emptied at start and as each one stops.
fn temp_download_dir() -> PathBuf {
    std::env::temp_dir().join("3RTC").join("torrents")
}

/// Where kept torrents are saved: `Downloads\3RTC\Torrents` (one folder per multi-file torrent,
/// named after it, as qBittorrent does).
pub(crate) fn download_dir() -> PathBuf {
    rtc_core::saves::dir(rtc_core::saves::Kind::Torrents)
}

/// One file inside a torrent, as listed in the file picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TorrentFileEntry {
    /// librqbit's file index (counts padding files too): the `stream/<id>` URL and `only_files`.
    pub(crate) id: usize,
    /// Path inside the torrent, `/`-separated (e.g. `Show/S01/E01.mkv`).
    pub(crate) path: String,
    /// The file name alone.
    pub(crate) name: String,
    /// Size in bytes.
    pub(crate) size: u64,
    /// A video the player can stream.
    pub(crate) playable: bool,
    /// A subtitle file (`.srt`, `.ass`, `.ssa`, `.vtt`, `.sub`).
    pub(crate) subtitle: bool,
}

/// The torrent's real files from `(path, length, is_padding)` in torrent order. Padding files
/// (BEP 47) and empty files are left out; ids keep the torrent's own numbering.
pub(crate) fn file_entries(files: impl IntoIterator<Item = (PathBuf, u64, bool)>) -> Vec<TorrentFileEntry> {
    files
        .into_iter()
        .enumerate()
        .filter(|(_, (_, len, padding))| !*padding && *len > 0)
        .map(|(id, (path, size, _))| {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let path = path
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            TorrentFileEntry {
                id,
                playable: is_video_name(&name),
                subtitle: is_subtitle_name(&name),
                path,
                name,
                size,
            }
        })
        .collect()
}

/// The file we'd stream on our own: the largest video, else the largest file.
pub(crate) fn default_file(files: &[TorrentFileEntry]) -> Option<usize> {
    files
        .iter()
        .filter(|f| f.playable)
        .max_by_key(|f| f.size)
        .or_else(|| files.iter().max_by_key(|f| f.size))
        .map(|f| f.id)
}

/// The subtitle files that go with the video `video`: in its folder named after it
/// (`Movie.mkv` → `Movie.en.srt`), in a `Subs` / `Subtitles` folder beside it (in a sub-folder
/// named after it, or straight in it), or, when it's the only video in its folder, any there.
pub(crate) fn matching_subtitles(files: &[TorrentFileEntry], video: usize) -> Vec<usize> {
    let Some(v) = files.iter().find(|f| f.id == video) else {
        return Vec::new();
    };
    let dir_of = |p: &str| p.rsplit_once('/').map_or(String::new(), |(d, _)| d.to_owned());
    let stem_of = |n: &str| n.rsplit_once('.').map_or(n, |(s, _)| s).to_lowercase();
    let vdir = dir_of(&v.path);
    let vstem = stem_of(&v.name);
    let alone = files.iter().filter(|f| f.playable && dir_of(&f.path) == vdir).count() == 1;
    // named after it: its name, then the end or a separator (`E1` isn't `E10`)
    let named = |n: &str| {
        n.to_lowercase()
            .strip_prefix(vstem.as_str())
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(['.', '_', '-', ' ', '[', '(']))
    };
    files
        .iter()
        .filter(|f| f.subtitle)
        .filter(|f| {
            let dir = dir_of(&f.path);
            if dir == vdir {
                return alone || named(&f.name);
            }
            // under <video folder>/Subs/… or <video folder>/Subtitles/…
            let rest = if vdir.is_empty() {
                Some(dir.as_str())
            } else {
                dir.strip_prefix(&vdir).and_then(|r| r.strip_prefix('/'))
            };
            let Some(rest) = rest else {
                return false;
            };
            let mut parts = rest.split('/');
            let in_subs = parts
                .next()
                .is_some_and(|top| matches!(top.to_lowercase().as_str(), "subs" | "subtitles"));
            if !in_subs {
                return false;
            }
            match parts.next() {
                // Subs/<video name>/2_English.srt
                Some(inner) => inner.to_lowercase() == vstem,
                // Subs/Movie.en.srt, or any when the video is alone
                None => alone || named(&f.name),
            }
        })
        .map(|f| f.id)
        .collect()
}

/// One folder of the picker: its files, videos first then in name order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileFolder {
    /// Folder path inside the torrent, `/`-separated, without the torrent's own top folder;
    /// empty for files at the top.
    pub(crate) folder: String,
    pub(crate) files: Vec<TorrentFileEntry>,
}

/// The picker's folders: files at the top first, then folders in natural name order (`S2` before
/// `S10`); in each, playable videos first, then natural name order (`E2` before `E10`). A top
/// folder every file shares (the torrent's name) is left out of the folder names.
pub(crate) fn group_by_folder(files: &[TorrentFileEntry]) -> Vec<FileFolder> {
    let first = |p: &str| p.split_once('/').map(|(head, _)| head.to_owned());
    let shared_root = files.first().and_then(|f| first(&f.path)).filter(|root| {
        files
            .iter()
            .all(|f| first(&f.path).as_deref() == Some(root.as_str()))
    });
    let mut folders: Vec<FileFolder> = Vec::new();
    for f in files {
        let inside = match &shared_root {
            Some(root) => f.path[root.len() + 1..].to_owned(),
            None => f.path.clone(),
        };
        let folder = inside
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_owned())
            .unwrap_or_default();
        match folders.iter_mut().find(|g| g.folder == folder) {
            Some(g) => g.files.push(f.clone()),
            None => folders.push(FileFolder {
                folder,
                files: vec![f.clone()],
            }),
        }
    }
    folders.sort_by(|a, b| {
        b.folder
            .is_empty()
            .cmp(&a.folder.is_empty())
            .then_with(|| natural_cmp(&a.folder, &b.folder))
    });
    for g in &mut folders {
        g.files.sort_by(|a, b| {
            b.playable
                .cmp(&a.playable)
                .then_with(|| natural_cmp(&a.name, &b.name))
        });
    }
    folders
}

/// Case-insensitive compare where runs of digits compare as numbers (`E2` < `E10`).
pub(crate) fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut n = String::new();
                while let Some(c) = x.next_if(char::is_ascii_digit) {
                    n.push(c);
                }
                let mut m = String::new();
                while let Some(d) = y.next_if(char::is_ascii_digit) {
                    m.push(d);
                }
                let (n, m) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let ord = n.len().cmp(&m.len()).then_with(|| n.cmp(m));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(c), Some(d)) => {
                let ord = c.to_lowercase().cmp(d.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// The chosen file's path relative to the torrent's output folder.
fn listed_relative_path(files: &[TorrentFileEntry], id: usize) -> PathBuf {
    files
        .iter()
        .find(|f| f.id == id)
        .map(|f| f.path.split('/').fold(PathBuf::new(), |p, part| p.join(part)))
        .unwrap_or_default()
}

/// A subtitle file the player can load.
pub(crate) fn is_subtitle_name(name: &str) -> bool {
    let n = name.to_lowercase();
    [".srt", ".ass", ".ssa", ".vtt", ".sub"].iter().any(|e| n.ends_with(e))
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

    fn entry(id: usize, path: &str, size: u64) -> TorrentFileEntry {
        let name = path.rsplit('/').next().unwrap_or(path).to_owned();
        TorrentFileEntry {
            id,
            path: path.to_owned(),
            playable: is_video_name(&name),
            subtitle: is_subtitle_name(&name),
            name,
            size,
        }
    }

    #[test]
    fn subtitles_next_to_the_video_named_after_it() {
        let files = vec![
            entry(0, "Show/E01.mkv", 9),
            entry(1, "Show/E01.en.srt", 1),
            entry(2, "Show/E02.mkv", 9),
            entry(3, "Show/E02.srt", 1),
            entry(4, "Show/notes.txt", 1),
        ];
        assert_eq!(matching_subtitles(&files, 0), vec![1]);
        assert_eq!(matching_subtitles(&files, 2), vec![3]);
        let numbered = vec![entry(0, "E1.mkv", 9), entry(1, "E10.mkv", 9), entry(2, "E10.srt", 1)];
        assert_eq!(matching_subtitles(&numbered, 0), Vec::<usize>::new());
        assert_eq!(matching_subtitles(&numbered, 1), vec![2]);
    }

    #[test]
    fn subtitles_in_a_subs_folder() {
        let files = vec![
            entry(0, "Movie/Movie.2020.mkv", 9),
            entry(1, "Movie/Subs/English.srt", 1),
            entry(2, "Movie/Subtitles/French.ass", 1),
            entry(3, "Movie/Other/English.srt", 1),
        ];
        // the only video in its folder: every subtitle in its Subs folders
        assert_eq!(matching_subtitles(&files, 0), vec![1, 2]);
        let pack = vec![
            entry(0, "Pack/E01.mkv", 9),
            entry(1, "Pack/E02.mkv", 9),
            entry(2, "Pack/Subs/E01/2_English.srt", 1),
            entry(3, "Pack/Subs/E02/2_English.srt", 1),
            entry(4, "Pack/Subs/E02.srt", 1),
        ];
        assert_eq!(matching_subtitles(&pack, 1), vec![3, 4]);
        assert_eq!(matching_subtitles(&pack, 9), Vec::<usize>::new());
    }

    #[test]
    fn detects_subtitle_files() {
        assert!(is_subtitle_name("a.SRT"));
        assert!(is_subtitle_name("b.ass"));
        assert!(!is_subtitle_name("c.mkv"));
    }

    #[test]
    fn file_entries_skip_padding_and_keep_torrent_ids() {
        let files = file_entries(vec![
            (Path::new("Show").join("E01.mkv"), 700, false),
            (Path::new(".pad").join("123"), 300, true),
            (Path::new("Show").join("empty.txt"), 0, false),
            (Path::new("Show").join("E02.mkv"), 650, false),
        ]);
        assert_eq!(
            files,
            vec![entry(0, "Show/E01.mkv", 700), entry(3, "Show/E02.mkv", 650)]
        );
    }

    #[test]
    fn default_file_prefers_the_largest_video() {
        let files = vec![
            entry(0, "Movie/extras.zip", 5_000),
            entry(1, "Movie/sample.mkv", 50),
            entry(2, "Movie/movie.mkv", 1_000),
            entry(3, "Movie/movie.srt", 2),
        ];
        assert_eq!(default_file(&files), Some(2));
        assert_eq!(
            default_file(&[entry(0, "a.txt", 1), entry(1, "b.zip", 9)]),
            Some(1)
        );
        assert_eq!(default_file(&[]), None);
    }

    #[test]
    fn groups_files_by_folder_without_the_shared_top_folder() {
        let files = vec![
            entry(0, "Show/S10/E1.mkv", 1),
            entry(1, "Show/S2/E10.mkv", 1),
            entry(2, "Show/S2/notes.txt", 1),
            entry(3, "Show/S2/E2.mkv", 1),
            entry(4, "Show/readme.txt", 1),
        ];
        let groups = group_by_folder(&files);
        let shape: Vec<(&str, Vec<usize>)> = groups
            .iter()
            .map(|g| (g.folder.as_str(), g.files.iter().map(|f| f.id).collect()))
            .collect();
        assert_eq!(
            shape,
            vec![("", vec![4]), ("S2", vec![3, 1, 2]), ("S10", vec![0])]
        );
    }

    #[test]
    fn keeps_top_folders_when_files_dont_share_one() {
        let files = vec![entry(0, "a.mkv", 1), entry(1, "Extras/b.mkv", 1)];
        let folders: Vec<String> = group_by_folder(&files).into_iter().map(|g| g.folder).collect();
        assert_eq!(folders, vec![String::new(), "Extras".to_owned()]);
    }

    #[test]
    fn natural_order_compares_numbers_by_value() {
        use std::cmp::Ordering;
        assert_eq!(natural_cmp("E2", "E10"), Ordering::Less);
        assert_eq!(natural_cmp("e02", "E10"), Ordering::Less);
        assert_eq!(natural_cmp("Season 9", "season 10"), Ordering::Less);
        assert_eq!(natural_cmp("b", "A"), Ordering::Greater);
    }

    #[test]
    fn relative_path_rebuilds_the_chosen_files_location() {
        let files = vec![entry(0, "Show/S01/E01.mkv", 1), entry(5, "Show/E02.mkv", 1)];
        assert_eq!(
            listed_relative_path(&files, 0),
            Path::new("Show").join("S01").join("E01.mkv")
        );
        assert_eq!(listed_relative_path(&files, 9), PathBuf::new());
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
