//! Chat files over QUIC between desktop apps (ADR 0009): which peers get a file that way, the
//! offer and answer, the background sends and receives, and the fallback to the bulk channel.
//!
//! A file of [`QUIC_MIN_BYTES`](rtc_core::quic::QUIC_MIN_BYTES) or more that was picked from disk
//! (not a picture) goes to each desktop peer that said `quic` over its own QUIC connection; the
//! others get it over the bulk channel exactly as before. Everyone gets the chat line's
//! announcement (`p2p-file-start`) as before; QUIC peers just get no frames. If QUIC doesn't work
//! for a peer (no answer, no path through the routers, a failure on the way), that peer gets the
//! announcement again and the frames over the bulk channel, so nobody is left without the file.
//!
//! A received file is written straight to Downloads (`<name>.3rtc-part` while it comes in, kept
//! after a failure part-way so a new offer of the same file resumes), then renamed.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use rtc_core::quic::{clean_relative_path, from_hex32, partial_name, peer_addrs, to_hex};
use rtc_protocol::PeerId;
use rtc_protocol::peer::{Envelope, PeerMessage};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::outgoing::Source;
use crate::quic::{self, Offer, Sender, Socket};
use crate::{Engine, Msg, Update, now_ms};

/// How long a sender waits for the receiver's answer.
const ANSWER_WAIT: Duration = Duration::from_secs(20);

/// Where a receiver's answer goes: its addresses and the offset to start from.
type AnswerTx = oneshot::Sender<(Vec<String>, u64)>;

/// What the background tasks tell the engine.
#[derive(Debug)]
pub(crate) enum Event {
    /// A send's offer is ready: send it to `peer`, and route the answer to `answer`.
    Offer {
        transfer_id: String,
        peer: PeerId,
        envelope: Envelope,
        answer: AnswerTx,
    },
    /// A receive's answer is ready: send it to `peer`.
    Answer { peer: PeerId, envelope: Envelope },
    /// Sending to `peer` over QUIC didn't work: send it over the bulk channel.
    SendFailed {
        transfer_id: String,
        peer: PeerId,
        reason: String,
    },
    /// Sent to `peer`.
    Sent { transfer_id: String, peer: PeerId },
    /// Received and saved.
    Received { transfer_id: String, path: PathBuf },
    /// A folder's file came in whole on the bulk channel but couldn't be saved.
    SaveFailed { transfer_id: String, reason: String },
    /// Receiving failed: the sender is told, and sends it over the bulk channel.
    ReceiveFailed {
        transfer_id: String,
        peer: PeerId,
        reason: String,
    },
}

/// QUIC transfers in progress.
#[derive(Default)]
pub(crate) struct QuicState {
    /// Our files going over QUIC: to whom, by transfer id.
    out: HashMap<String, HashSet<PeerId>>,
    /// Answers awaited, by transfer and peer.
    answers: HashMap<(String, PeerId), AnswerTx>,
    /// Files coming in, by transfer id: from whom, and the task.
    incoming: HashMap<String, (PeerId, JoinHandle<()>)>,
    /// Our sends in progress, by transfer and peer (to stop one on a cancel).
    sends: HashMap<(String, PeerId), tokio::task::AbortHandle>,
}

/// Where an offered file goes: its name, and its place in a folder (cleaned, under Downloads).
pub(crate) struct Place<'a> {
    pub(crate) file_name: &'a str,
    pub(crate) relative_path: Option<&'a str>,
}

impl Place<'_> {
    /// The cleaned folder path's parts (none for a single file).
    fn parts(&self) -> Vec<String> {
        self.relative_path
            .and_then(clean_relative_path)
            .map(|p| p.split('/').map(str::to_owned).collect())
            .unwrap_or_default()
    }

    /// The folder it goes in, under `downloads`.
    pub(crate) fn dir(&self, downloads: &Path) -> PathBuf {
        let parts = self.parts();
        let mut dir = downloads.to_owned();
        if parts.len() > 1 {
            for part in &parts[..parts.len() - 1] {
                dir.push(part);
            }
        }
        dir
    }

    /// The file's own name, made safe.
    pub(crate) fn name(&self) -> String {
        let last = self.parts().pop().unwrap_or_else(|| self.file_name.to_owned());
        rtc_protocol::image::safe_file_save_name(&last, "application/octet-stream")
    }
}

/// Where received files go (as the app saves pictures).
pub(crate) fn downloads() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map_or_else(std::env::temp_dir, |h| PathBuf::from(h).join("Downloads"))
}

/// `dir/name`, or `dir/name (1)`… if that's taken.
pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = name.rsplit_once('.').map_or((name, ""), |(s, e)| (s, e));
    for n in 1..1000 {
        let candidate = if ext.is_empty() {
            dir.join(format!("{stem} ({n})"))
        } else {
            dir.join(format!("{stem} ({n}).{ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

/// A progress reporter: percent of `size`, sent only when it changes (`peer`: sending to them).
fn progress(
    queue: mpsc::UnboundedSender<Msg>,
    transfer_id: String,
    size: u64,
    peer: Option<PeerId>,
) -> impl Fn(u64) + Send {
    let last = AtomicU8::new(0);
    move |done: u64| {
        let percent = u8::try_from(done.saturating_mul(100) / size.max(1))
            .unwrap_or(100)
            .min(100);
        if last.swap(percent, Ordering::Relaxed) != percent {
            let _ = queue.send(Msg::ImageSending(transfer_id.clone(), peer.clone(), percent));
        }
    }
}

impl Engine {
    /// Sends our file (accepted by `peer`, a desktop app that does QUIC) over QUIC. A failure
    /// falls back to their bulk channel ([`Event::SendFailed`]).
    pub(crate) fn quic_send_to(&mut self, transfer_id: &str, peer: &PeerId) {
        let Some(file) = self.files.out.get(transfer_id) else {
            return;
        };
        let Some(path) = file.path.clone() else {
            return;
        };
        let job = SendJob {
            queue: self.queue_tx.clone(),
            transfer_id: transfer_id.to_owned(),
            peer: peer.clone(),
            file_name: file.file_name.clone(),
            relative_path: file.relative_path.clone(),
            path,
            size: file.size,
            source: file.source.clone(),
        };
        self.quic
            .out
            .entry(transfer_id.to_owned())
            .or_default()
            .insert(peer.clone());
        let task = tokio::spawn(job.run());
        self.quic
            .sends
            .insert((transfer_id.to_owned(), peer.clone()), task.abort_handle());
        self.sending.push(task);
    }

    /// `peer` left: our QUIC sends to them stop (theirs to us end on their own).
    pub(crate) fn quic_peer_gone(&mut self, peer: &PeerId) {
        let tids: Vec<String> = self
            .quic
            .sends
            .keys()
            .filter(|(_, p)| p == peer)
            .map(|(t, _)| t.clone())
            .collect();
        for tid in tids {
            self.quic_stop_to(&tid, peer);
        }
    }

    /// A QUIC message from a peer. True when it was one (nothing else needs it).
    pub(crate) fn quic_message(&mut self, from: &PeerId, message: &PeerMessage) -> bool {
        match message {
            PeerMessage::QuicOffer {
                transfer_id,
                file_name,
                file_size,
                sha256,
                addrs,
                cert_sha256,
                token,
                relative_path,
            } => {
                let place = Place {
                    file_name,
                    relative_path: relative_path.as_deref(),
                };
                self.quic_offer(
                    from,
                    transfer_id,
                    &place,
                    *file_size,
                    sha256,
                    addrs,
                    cert_sha256,
                    token,
                );
                true
            }
            PeerMessage::QuicAnswer {
                transfer_id,
                addrs,
                offset,
            } => {
                if let Some(tx) = self.quic.answers.remove(&(transfer_id.clone(), from.clone())) {
                    let _ = tx.send((addrs.clone(), *offset));
                }
                true
            }
            PeerMessage::QuicFallback { transfer_id, reason } => {
                tracing::info!("QUIC transfer {transfer_id} with {from} falls back: {reason}");
                // as the sender: no answer is coming (the send task falls back)
                self.quic.answers.remove(&(transfer_id.clone(), from.clone()));
                // as the receiver: the file comes over the bulk channel now
                if self
                    .quic
                    .incoming
                    .get(transfer_id)
                    .is_some_and(|(p, _)| p == from)
                    && let Some((_, task)) = self.quic.incoming.remove(transfer_id)
                {
                    task.abort();
                }
                true
            }
            _ => false,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn quic_offer(
        &mut self,
        from: &PeerId,
        transfer_id: &str,
        place: &Place<'_>,
        size: u64,
        sha256: &str,
        addrs: &[String],
        cert_sha256: &str,
        token: &str,
    ) {
        let refuse = |me: &mut Self, reason: &str| me.quic_fallback_to(from, transfer_id, reason);
        // only from a desktop app in the room that said it does QUIC, once per transfer
        if !self.room.members().get(from).is_some_and(|m| m.quic)
            || transfer_id.is_empty()
            || transfer_id.len() > 64
        {
            return refuse(self, "not expected");
        }
        if self.quic.incoming.contains_key(transfer_id) {
            return;
        }
        // only files we accepted (an older app offers without asking)
        if !self.files.accepted.contains_key(transfer_id) {
            return refuse(self, "not accepted");
        }
        let (Some(sha256), Some(cert_sha256), Some(token)) =
            (from_hex32(sha256), from_hex32(cert_sha256), from_hex32(token))
        else {
            return refuse(self, "bad offer");
        };
        let addrs = peer_addrs(addrs);
        if addrs.is_empty() || size == 0 || size > rtc_protocol::image::MAX_SEND_BYTES as u64 {
            return refuse(self, "bad offer");
        }
        let job = ReceiveJob {
            queue: self.queue_tx.clone(),
            transfer_id: transfer_id.to_owned(),
            peer: from.clone(),
            offer: Offer {
                addrs,
                cert_sha256,
                token,
                size,
                sha256,
            },
            dir: place.dir(&downloads()),
            name: place.name(),
        };
        let task = tokio::spawn(job.run());
        self.quic
            .incoming
            .insert(transfer_id.to_owned(), (from.clone(), task));
    }

    /// Tells `peer` this transfer goes over the bulk channel instead.
    fn quic_fallback_to(&self, peer: &PeerId, transfer_id: &str, reason: &str) {
        let envelope = Envelope {
            sender: None,
            timestamp: Some(now_ms()),
            message: PeerMessage::QuicFallback {
                transfer_id: transfer_id.to_owned(),
                reason: reason.to_owned(),
            },
        };
        self.peers.send(peer, &envelope);
    }

    /// What a background task reported.
    pub(crate) fn quic_event(&mut self, event: Event) {
        match event {
            Event::Offer {
                transfer_id,
                peer,
                envelope,
                answer,
            } => {
                self.quic.answers.insert((transfer_id, peer.clone()), answer);
                self.peers.send(&peer, &envelope);
            }
            Event::Answer { peer, envelope } => self.peers.send(&peer, &envelope),
            Event::SendFailed {
                transfer_id,
                peer,
                reason,
            } => {
                // stopped already (cancelled): nothing to fall back to
                if self
                    .quic
                    .sends
                    .remove(&(transfer_id.clone(), peer.clone()))
                    .is_none()
                {
                    return;
                }
                tracing::info!(
                    "QUIC send of {transfer_id} to {peer} failed ({reason}): bulk channel instead"
                );
                self.quic.answers.remove(&(transfer_id.clone(), peer.clone()));
                self.quic_fallback_to(&peer, &transfer_id, &reason);
                if let Some(to) = self.quic.out.get_mut(&transfer_id) {
                    to.remove(&peer);
                    if to.is_empty() {
                        self.quic.out.remove(&transfer_id);
                    }
                }
                let Some(file) = self.files.out.get(&transfer_id) else {
                    self.part_failed(&transfer_id, &peer);
                    return;
                };
                // the announcement again (so the receiver expects the frames), then the frames
                let channels = self.bulk_pairs(std::iter::once(&peer));
                if channels.is_empty() {
                    self.part_failed(&transfer_id, &peer);
                    return;
                }
                if let Some(json) = file.start.as_ref().and_then(|s| s.to_json().ok()) {
                    for (_, dc) in &channels {
                        let _ = dc.send(json.as_bytes(), false);
                    }
                }
                let source = file.source.clone();
                self.spawn_frames(channels, source, transfer_id.clone());
            }
            Event::Sent { transfer_id, peer } => {
                if self
                    .quic
                    .sends
                    .remove(&(transfer_id.clone(), peer.clone()))
                    .is_none()
                {
                    return;
                }
                tracing::info!("QUIC: {transfer_id} sent to {peer}");
                if let Some(to) = self.quic.out.get_mut(&transfer_id) {
                    to.remove(&peer);
                    if to.is_empty() {
                        self.quic.out.remove(&transfer_id);
                    }
                }
                self.delivered_to(&transfer_id, &peer);
            }
            Event::SaveFailed { transfer_id, reason } => {
                tracing::warn!("couldn't save {transfer_id}: {reason}");
                let _ = self
                    .updates
                    .send(Update::Notice(format!("Couldn't save a file: {reason}")));
                let _ = self.updates.send(Update::TransferCancelled { transfer_id });
            }
            Event::Received { transfer_id, path } => {
                self.quic.incoming.remove(&transfer_id);
                self.files.accepted.remove(&transfer_id);
                self.transfers.finish(&transfer_id);
                let _ = self.updates.send(Update::FileSaved { transfer_id, path });
            }
            Event::ReceiveFailed {
                transfer_id,
                peer,
                reason,
            } => {
                tracing::info!(
                    "QUIC receive of {transfer_id} failed ({reason}): asking for the bulk channel"
                );
                self.quic.incoming.remove(&transfer_id);
                self.quic_fallback_to(&peer, &transfer_id, &reason);
            }
        }
    }

    /// A receiver cancelled (or left): stop sending them this file over QUIC. True when a send
    /// to them was stopped (its part of the transfer is over).
    pub(crate) fn quic_stop_to(&mut self, transfer_id: &str, peer: &PeerId) -> bool {
        self.quic.answers.remove(&(transfer_id.to_owned(), peer.clone()));
        if let Some(to) = self.quic.out.get_mut(transfer_id) {
            to.remove(peer);
            if to.is_empty() {
                self.quic.out.remove(transfer_id);
            }
        }
        match self.quic.sends.remove(&(transfer_id.to_owned(), peer.clone())) {
            Some(task) => {
                task.abort();
                true
            }
            None => false,
        }
    }

    /// Our file was cancelled: stop every QUIC send of it.
    pub(crate) fn quic_cancel(&mut self, transfer_id: &str) {
        self.quic.out.remove(transfer_id);
        self.quic.answers.retain(|(t, _), _| t != transfer_id);
        self.quic.sends.retain(|(t, _), task| {
            if t == transfer_id {
                task.abort();
                false
            } else {
                true
            }
        });
    }

    /// A file coming in over QUIC was cancelled: stop receiving it (its `.3rtc-part` stays,
    /// as after a failure).
    pub(crate) fn quic_stop_incoming(&mut self, transfer_id: &str) {
        if let Some((_, task)) = self.quic.incoming.remove(transfer_id) {
            task.abort();
        }
    }

    /// Leaving the room: stop every QUIC transfer.
    pub(crate) fn quic_reset(&mut self) {
        self.quic.out.clear();
        self.quic.answers.clear();
        for (_, task) in self.quic.sends.drain() {
            task.abort();
        }
        for (_, (_, task)) in self.quic.incoming.drain() {
            task.abort();
        }
    }
}

/// Sends one file to one peer over QUIC.
struct SendJob {
    queue: mpsc::UnboundedSender<Msg>,
    transfer_id: String,
    peer: PeerId,
    file_name: String,
    relative_path: Option<String>,
    path: PathBuf,
    size: u64,
    source: Source,
}

impl SendJob {
    async fn run(self) {
        let failed = |reason: String| {
            Msg::Quic(Event::SendFailed {
                transfer_id: self.transfer_id.clone(),
                peer: self.peer.clone(),
                reason,
            })
        };
        let result = self.send().await;
        let _ = self.queue.send(match result {
            Ok(()) => Msg::Quic(Event::Sent {
                transfer_id: self.transfer_id.clone(),
                peer: self.peer.clone(),
            }),
            Err(reason) => failed(reason),
        });
    }

    async fn send(&self) -> Result<(), String> {
        let socket = Socket::open(IpAddr::V4(Ipv4Addr::UNSPECIFIED), true)
            .await
            .map_err(|e| e.0)?;
        let sender = Sender::new(socket, self.path.clone(), self.size).map_err(|e| e.0)?;
        let sha = self.source.sha256().await.map_err(|e| e.to_string())?;
        let (tx, rx) = oneshot::channel();
        let envelope = Envelope {
            sender: None,
            timestamp: Some(now_ms()),
            message: PeerMessage::QuicOffer {
                transfer_id: self.transfer_id.clone(),
                file_name: self.file_name.clone(),
                file_size: self.size,
                sha256: to_hex(&sha),
                addrs: sender.addrs().iter().map(ToString::to_string).collect(),
                cert_sha256: to_hex(&sender.cert_sha256),
                token: to_hex(&sender.token),
                relative_path: self.relative_path.clone(),
            },
        };
        self.queue
            .send(Msg::Quic(Event::Offer {
                transfer_id: self.transfer_id.clone(),
                peer: self.peer.clone(),
                envelope,
                answer: tx,
            }))
            .map_err(|_| "engine stopped".to_owned())?;
        let (addrs, _offset) = tokio::time::timeout(ANSWER_WAIT, rx)
            .await
            .map_err(|_| "no answer".to_owned())?
            .map_err(|_| "turned down".to_owned())?;
        let addrs = peer_addrs(&addrs);
        if addrs.is_empty() {
            return Err("no address to reach them".to_owned());
        }
        let progress = progress(
            self.queue.clone(),
            self.transfer_id.clone(),
            self.size,
            Some(self.peer.clone()),
        );
        sender.serve(&addrs, progress).await.map(|_| ()).map_err(|e| e.0)
    }
}

/// Receives one file from one peer over QUIC into Downloads.
struct ReceiveJob {
    queue: mpsc::UnboundedSender<Msg>,
    transfer_id: String,
    peer: PeerId,
    offer: Offer,
    dir: PathBuf,
    name: String,
}

impl ReceiveJob {
    async fn run(self) {
        let event = match self.receive().await {
            Ok(path) => Event::Received {
                transfer_id: self.transfer_id.clone(),
                path,
            },
            Err(reason) => Event::ReceiveFailed {
                transfer_id: self.transfer_id.clone(),
                peer: self.peer.clone(),
                reason,
            },
        };
        let _ = self.queue.send(Msg::Quic(event));
    }

    async fn receive(&self) -> Result<PathBuf, String> {
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|e| e.to_string())?;
        let partial = self.dir.join(partial_name(&self.name));
        // part of it already here (an earlier try of the same file): carry on from there
        let offset = tokio::fs::metadata(&partial)
            .await
            .map(|m| m.len())
            .ok()
            .filter(|len| *len < self.offer.size)
            .unwrap_or(0);
        let socket = Socket::open(IpAddr::V4(Ipv4Addr::UNSPECIFIED), true)
            .await
            .map_err(|e| e.0)?;
        let envelope = Envelope {
            sender: None,
            timestamp: Some(now_ms()),
            message: PeerMessage::QuicAnswer {
                transfer_id: self.transfer_id.clone(),
                addrs: socket.addrs.iter().map(ToString::to_string).collect(),
                offset,
            },
        };
        self.queue
            .send(Msg::Quic(Event::Answer {
                peer: self.peer.clone(),
                envelope,
            }))
            .map_err(|_| "engine stopped".to_owned())?;
        let progress = progress(
            self.queue.clone(),
            self.transfer_id.clone(),
            self.offer.size,
            None,
        );
        match quic::receive(socket, &self.offer, &partial, offset, progress).await {
            Ok(_) => {
                let path = unique_path(&self.dir, &self.name);
                tokio::fs::rename(&partial, &path)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(path)
            }
            Err(e) => {
                // nothing arrived: don't leave an empty part behind
                if tokio::fs::metadata(&partial).await.is_ok_and(|m| m.len() == 0) {
                    let _ = tokio::fs::remove_file(&partial).await;
                }
                Err(e.0)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Place, unique_path};

    #[test]
    fn a_folder_file_lands_in_its_folder_inside_downloads() {
        let downloads = std::path::Path::new("D");
        let p = Place {
            file_name: "a.jpg",
            relative_path: Some("Photos/2026/a.jpg"),
        };
        assert_eq!(p.dir(downloads), downloads.join("Photos").join("2026"));
        assert_eq!(p.name(), "a.jpg");
        let escape = Place {
            file_name: "x.dll",
            relative_path: Some("../../Windows/x.dll"),
        };
        assert_eq!(
            escape.dir(downloads),
            downloads.join("Windows"),
            "never above Downloads"
        );
        let single = Place {
            file_name: "film.mkv",
            relative_path: None,
        };
        assert_eq!(single.dir(downloads), downloads.to_path_buf());
        assert_eq!(single.name(), "film.mkv");
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let dir = std::env::temp_dir().join(format!("3rtc-unique-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::remove_file(dir.join("film.mkv"));
        let _ = std::fs::remove_file(dir.join("film (1).mkv"));
        assert_eq!(unique_path(&dir, "film.mkv"), dir.join("film.mkv"));
        std::fs::write(dir.join("film.mkv"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "film.mkv"), dir.join("film (1).mkv"));
        std::fs::write(dir.join("noext"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "noext"), dir.join("noext (1)"));
    }
}
