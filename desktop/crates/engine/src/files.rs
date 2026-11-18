//! Chat files both ways (`useChat.ts`, `utils/p2pImageShare.ts`, `docs/PROTOCOL.md`).
//!
//! - Small files (under [`ACCEPT_MIN_BYTES`](rtc_core::transfers::ACCEPT_MIN_BYTES)) go to
//!   everyone straight away on the bulk channels, as before.
//! - A big file is only announced; each receiver who accepts it (`p2p-file-control` `accept`)
//!   gets it on their own: over QUIC from another desktop app (ADR 0009), else on their bulk
//!   channel.
//! - A folder is offered as a list (`p2p-folder-offer`); each receiver accepts the files they
//!   want, which are sent to them one at a time and saved under Downloads in the folder's
//!   layout. Files already there show as such (`Update::FolderHere`).
//! - Cancel: ours stops for everyone (a folder: all its files); a receiver's only for them;
//!   once nobody is waiting for or receiving a file, it's over. The rules are
//!   [`rtc_core::transfers`].

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rtc_core::transfers::{CancelOutcome, Ended, SendStatus, needs_accept};
use rtc_core::{ChatFolder, ChatFolderFile, ChatImage, Command, Input};
use rtc_protocol::PeerId;
use rtc_protocol::peer::{Envelope, PeerMessage};
use rtc_webrtc::libwebrtc::data_channel::DataChannel;

use crate::outgoing::Source;
use crate::quic_flow::{Place, downloads, unique_path};
use crate::{BULK_HIGH_WATER, Engine, FileHere, Msg, OutgoingFolder, OutgoingImage, Update, now_ms};

/// One of our files that can still be sent (to whoever accepts it).
pub(crate) struct OutFile {
    pub(crate) source: Source,
    pub(crate) size: u64,
    pub(crate) file_name: String,
    /// On disk (QUIC sends from there).
    pub(crate) path: Option<PathBuf>,
    /// Its place in a folder being offered.
    pub(crate) relative_path: Option<String>,
    pub(crate) is_image: bool,
    /// The folder offer it belongs to.
    pub(crate) folder: Option<String>,
    /// Its announcement: sent to each receiver right before their copy (and again after a QUIC
    /// fallback), so they expect the frames.
    pub(crate) start: Option<Envelope>,
    /// Waits for receivers to accept it.
    pub(crate) offered: bool,
}

/// A file offered to us, not accepted yet.
struct OfferIn {
    from: PeerId,
    chunks: f64,
    /// A folder's file: its cleaned path inside the folder.
    path: Option<String>,
}

/// Chat files in progress, both ways.
#[derive(Default)]
pub(crate) struct Files {
    /// Ours, by transfer id.
    pub(crate) out: HashMap<String, OutFile>,
    /// Our folder offers: their files' transfer ids.
    folders_out: HashMap<String, Vec<String>>,
    /// Folder files each receiver accepted, sent to them one at a time.
    queue: HashMap<PeerId, VecDeque<String>>,
    /// The file going to each receiver now (folder files).
    busy: HashMap<PeerId, String>,
    /// Each receiver's percent of our file going to them alone.
    progress: HashMap<String, HashMap<PeerId, u8>>,
    /// How many have our file (for the last [`Update::SendState`]).
    sent: HashMap<String, usize>,
    /// Offered to us, not accepted yet.
    offers: HashMap<String, OfferIn>,
    /// Accepted by us: a folder's file's path (saved under Downloads), `None` for a single file.
    pub(crate) accepted: HashMap<String, Option<String>>,
    /// Folders offered to us: their files.
    folders_in: HashMap<String, Vec<String>>,
}

impl Engine {
    /// Starts sending one of our files: the room logic adds the chat line and announces it;
    /// [`Self::announce`] follows (frames to everyone, or nothing until someone accepts).
    pub(crate) async fn send_image(&mut self, image: OutgoingImage) {
        // a big file stays on disk until it's sent
        let source = match (image.disk_size, &image.path) {
            (Some(size), Some(path)) => Source::Disk {
                path: path.clone(),
                size,
            },
            _ => Source::Memory(Arc::clone(&image.bytes)),
        };
        let size = source.size();
        if size > rtc_protocol::image::MAX_SEND_BYTES as u64 {
            let _ = self.updates.send(Update::Notice(
                "File exceeds 10 GB limit. Please select a smaller file.".to_owned(),
            ));
            return;
        }
        if !self.can_send_files() {
            return;
        }
        let is_image = rtc_protocol::image::is_image_mime(&image.mime)
            || rtc_protocol::image::mime_for_name(&image.file_name).is_some();
        let tid = image.transfer_id.clone();
        self.files.out.insert(
            tid.clone(),
            OutFile {
                source,
                size,
                file_name: image.file_name.clone(),
                path: image.path.clone(),
                relative_path: None,
                is_image,
                folder: None,
                start: None,
                offered: needs_accept(size),
            },
        );
        let mime = if is_image {
            rtc_protocol::image::clean_mime(&image.mime).to_owned()
        } else {
            rtc_protocol::image::clean_file_mime(&image.mime)
        };
        let command = Command::ImageSent {
            id: image.id,
            image: ChatImage {
                transfer_id: tid.clone(),
                file_name: image.file_name,
                file_size: size,
                mime,
            },
            caption: image.caption,
        };
        let fx = self.room.update(Input::Command(command), now_ms());
        self.apply(fx).await;
        // not announced (not in a room): nothing to keep
        if !self.transfers.is_ours(&tid) {
            self.files.out.remove(&tid);
        }
    }

    /// Offers a folder: everyone sees its files and accepts the ones they want.
    pub(crate) async fn send_folder(&mut self, folder: OutgoingFolder) {
        if !self.can_send_files() {
            return;
        }
        let mut files = Vec::new();
        let mut ids = Vec::new();
        for f in folder.files {
            let (Some(path), Some(size)) = (f.path.clone(), f.disk_size) else {
                continue;
            };
            let relative = f.relative_path.clone().unwrap_or_else(|| f.file_name.clone());
            let mime = rtc_protocol::image::clean_file_mime(&f.mime);
            #[allow(clippy::cast_precision_loss)]
            let start = Envelope {
                sender: None,
                timestamp: Some(now_ms()),
                message: PeerMessage::P2pFileStart {
                    id: f.transfer_id.clone(),
                    transfer_id: f.transfer_id.clone(),
                    file_name: f.file_name.clone(),
                    file_size: size as f64,
                    mime_type: mime.clone(),
                    total_chunks: size.div_ceil(rtc_protocol::image::CHUNK as u64).max(1) as f64,
                    is_host: false,
                    caption: String::new(),
                },
            };
            files.push(ChatFolderFile {
                transfer_id: f.transfer_id.clone(),
                path: relative.clone(),
                file_name: f.file_name.clone(),
                file_size: size,
                mime,
            });
            ids.push(f.transfer_id.clone());
            self.files.out.insert(
                f.transfer_id,
                OutFile {
                    source: Source::Disk {
                        path: path.clone(),
                        size,
                    },
                    size,
                    file_name: f.file_name,
                    path: Some(path),
                    relative_path: Some(relative),
                    is_image: false,
                    folder: Some(folder.folder_id.clone()),
                    start: Some(start),
                    offered: true,
                },
            );
        }
        if files.is_empty() {
            return;
        }
        self.files
            .folders_out
            .insert(folder.folder_id.clone(), ids.clone());
        let command = Command::FolderSent {
            id: folder.id,
            folder: ChatFolder {
                folder_id: folder.folder_id.clone(),
                name: folder.name,
                files,
            },
            caption: folder.caption,
        };
        let fx = self.room.update(Input::Command(command), now_ms());
        self.apply(fx).await;
        if ids.first().is_none_or(|t| !self.transfers.is_ours(t)) {
            // not offered (not in a room)
            for t in &ids {
                self.files.out.remove(t);
            }
            self.files.folders_out.remove(&folder.folder_id);
        }
    }

    /// Somebody to send to (else a notice).
    fn can_send_files(&self) -> bool {
        if self.peers.bulk_channels(self.room.members().keys()).is_empty() {
            let _ = self.updates.send(Update::Notice(
                "Waiting for peer to connect before sending file".to_owned(),
            ));
            return false;
        }
        true
    }

    /// The room logic announced our file or folder ([`rtc_core::Effect::BroadcastBulk`]): it
    /// goes on every open bulk channel; a small file's frames follow.
    pub(crate) fn announce(&mut self, envelope: &Envelope) {
        let all = self.bulk_pairs(self.room.members().keys());
        let Ok(json) = envelope.to_json() else { return };
        for (_, dc) in &all {
            if let Err(e) = dc.send(json.as_bytes(), false) {
                tracing::debug!("file announcement: {e:?}");
            }
        }
        let receivers: Vec<PeerId> = all.iter().map(|(p, _)| p.clone()).collect();
        match &envelope.message {
            PeerMessage::P2pFolderOffer { files, .. } => {
                for f in files {
                    self.transfers.sending(&f.transfer_id, receivers.clone(), true);
                    self.send_state(&f.transfer_id);
                }
            }
            PeerMessage::P2pImageStart { transfer_id, .. }
            | PeerMessage::P2pFileStart { transfer_id, .. } => {
                let Some(file) = self.files.out.get_mut(transfer_id) else {
                    return;
                };
                file.start = Some(envelope.clone());
                if file.offered {
                    self.transfers.sending(transfer_id, receivers, true);
                    self.send_state(transfer_id);
                    return;
                }
                let Some(file) = self.files.out.remove(transfer_id) else {
                    return;
                };
                self.transfers.sending(transfer_id, receivers, false);
                self.spawn_frames(all, file.source, transfer_id.clone());
            }
            _ => {}
        }
    }

    /// The open bulk channels of these peers, with whose each is.
    pub(crate) fn bulk_pairs<'a>(
        &self,
        peers: impl Iterator<Item = &'a PeerId>,
    ) -> Vec<(PeerId, DataChannel)> {
        peers
            .filter_map(|p| {
                self.peers
                    .bulk_channels(std::iter::once(p))
                    .pop()
                    .map(|dc| (p.clone(), dc))
            })
            .collect()
    }

    /// `from` accepted our file: send it to them (a folder's file waits for their earlier ones).
    fn peer_accepted(&mut self, transfer_id: &str, from: &PeerId) {
        if !self.transfers.on_accept(transfer_id, from) {
            return;
        }
        let in_folder = self
            .files
            .out
            .get(transfer_id)
            .is_some_and(|f| f.folder.is_some());
        if in_folder {
            self.files
                .queue
                .entry(from.clone())
                .or_default()
                .push_back(transfer_id.to_owned());
            self.pump(from);
        } else {
            self.start_to(transfer_id, from);
        }
        self.send_state(transfer_id);
    }

    /// Starts the next folder file `peer` accepted, if none is going to them.
    fn pump(&mut self, peer: &PeerId) {
        if self.files.busy.contains_key(peer) {
            return;
        }
        while let Some(tid) = self.files.queue.get_mut(peer).and_then(VecDeque::pop_front) {
            if !self.files.out.contains_key(&tid) {
                continue; // cancelled meanwhile
            }
            self.files.busy.insert(peer.clone(), tid.clone());
            self.start_to(&tid, peer);
            return;
        }
    }

    /// Sends our file to one receiver: over QUIC to a desktop app that can (big files from
    /// disk, a folder's files), else its announcement and frames on their bulk channel.
    fn start_to(&mut self, transfer_id: &str, peer: &PeerId) {
        let Some(file) = self.files.out.get(transfer_id) else {
            return;
        };
        let peer_quic = self
            .room
            .members()
            .get(peer)
            .is_some_and(|m| m.connected && m.quic);
        let quic = peer_quic
            && file.path.is_some()
            && (file.folder.is_some() || (!file.is_image && rtc_core::quic::use_quic(file.size, true)));
        if quic {
            self.quic_send_to(transfer_id, peer);
            return;
        }
        let channels = self.bulk_pairs(std::iter::once(peer));
        if channels.is_empty() {
            self.part_failed(transfer_id, peer);
            return;
        }
        // they expect the frames from now (a folder's file, or after a long wait to accept)
        if let Some(json) = file.start.as_ref().and_then(|s| s.to_json().ok()) {
            for (_, dc) in &channels {
                let _ = dc.send(json.as_bytes(), false);
            }
        }
        let source = file.source.clone();
        self.spawn_frames(channels, source, transfer_id.to_owned());
    }

    /// Sends a file's frames on `channels` (its announcement already went), waiting whenever a
    /// channel is backed up. Receivers who cancel get no more of it; it stops for everyone on a
    /// cancel ([`crate::outgoing::Stop`]). [`Msg::FramesDone`] says who got it all.
    pub(crate) fn spawn_frames(
        &mut self,
        channels: Vec<(PeerId, DataChannel)>,
        source: Source,
        transfer_id: String,
    ) {
        let stop = Arc::clone(self.stops.entry(transfer_id.clone()).or_default());
        let progress = self.queue_tx.clone();
        // one receiver: its own progress (the engine averages everyone's)
        let only = (channels.len() == 1).then(|| channels[0].0.clone());
        self.sending.push(tokio::spawn(async move {
            use rtc_protocol::image::{CHUNK, pack};
            use rtc_webrtc::libwebrtc::data_channel::DataChannelState;
            let frames = async {
                let total = u32::try_from(source.size().div_ceil(CHUNK as u64).max(1)).unwrap_or(u32::MAX);
                let mut reader = source.reader();
                let mut last = 0u8;
                for index in 0..total {
                    loop {
                        if stop.is_all() {
                            tracing::info!("File transfer {transfer_id} cancelled");
                            return false;
                        }
                        let open: Vec<_> = channels
                            .iter()
                            .filter(|(p, dc)| dc.state() == DataChannelState::Open && !stop.stopped(p))
                            .map(|(_, dc)| dc)
                            .collect();
                        if open.is_empty() {
                            tracing::info!(
                                "File transfer {transfer_id}: nobody on the bulk channels receives it"
                            );
                            return false;
                        }
                        if open.iter().all(|dc| dc.buffered_amount() <= BULK_HIGH_WATER) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    // read as it goes (a big file is never all in memory)
                    let piece = match reader.next(CHUNK).await {
                        Ok(piece) => piece,
                        Err(e) => {
                            tracing::info!("❌ File transfer failed: couldn't read the file: {e}");
                            return false;
                        }
                    };
                    let frame = pack(&transfer_id, index, total, &piece);
                    for (p, dc) in &channels {
                        if dc.state() == DataChannelState::Open && !stop.stopped(p) {
                            let _ = dc.send(&frame, true);
                        }
                    }
                    #[allow(
                        clippy::cast_possible_truncation,
                        clippy::cast_sign_loss,
                        clippy::cast_precision_loss
                    )]
                    let percent = ((f64::from(index + 1) / f64::from(total)) * 100.0)
                        .round()
                        .min(100.0) as u8;
                    if percent != last {
                        last = percent;
                        let _ = progress.send(Msg::ImageSending(transfer_id.clone(), only.clone(), percent));
                    }
                    tokio::task::yield_now().await;
                }
                true
            };
            let complete = frames.await;
            let (ok, failed): (Vec<_>, Vec<_>) = channels
                .iter()
                .map(|(p, dc)| {
                    (
                        p.clone(),
                        complete && dc.state() == DataChannelState::Open && !stop.stopped(p),
                    )
                })
                .partition(|(_, got)| *got);
            let _ = progress.send(Msg::FramesDone {
                transfer_id,
                ok: ok.into_iter().map(|(p, _)| p).collect(),
                failed: failed.into_iter().map(|(p, _)| p).collect(),
            });
        }));
    }

    /// A frames task ended: `ok` got the whole file, `failed` didn't.
    pub(crate) fn frames_done(&mut self, transfer_id: &str, ok: &[PeerId], failed: &[PeerId]) {
        for p in ok {
            self.delivered_to(transfer_id, p);
        }
        for p in failed {
            self.part_failed(transfer_id, p);
        }
    }

    /// Progress of our file going out: to everyone (`peer` none), or to one receiver (shown as
    /// the average of everyone's).
    pub(crate) fn sending_progress(&mut self, transfer_id: String, peer: Option<PeerId>, percent: u8) {
        let percent = match peer {
            None => percent,
            Some(p) => {
                let each = self.files.progress.entry(transfer_id.clone()).or_default();
                each.insert(p, percent);
                let sum: u32 = each.values().map(|v| u32::from(*v)).sum();
                u8::try_from(sum / u32::try_from(each.len().max(1)).unwrap_or(1)).unwrap_or(100)
            }
        };
        let _ = self.updates.send(Update::ImageProgress { transfer_id, percent });
    }

    /// `peer` has all of our file.
    pub(crate) fn delivered_to(&mut self, transfer_id: &str, peer: &PeerId) {
        self.part_over(transfer_id, peer);
        if self.transfers.status(transfer_id).is_some() {
            *self.files.sent.entry(transfer_id.to_owned()).or_default() += 1;
        }
        match self.transfers.delivered(transfer_id, peer) {
            Some(_) => self.out_over(transfer_id),
            None => self.send_state(transfer_id),
        }
        self.pump(peer);
    }

    /// Sending our file to `peer` stopped short (their channel closed, a read failed).
    pub(crate) fn part_failed(&mut self, transfer_id: &str, peer: &PeerId) {
        self.part_over(transfer_id, peer);
        match self.transfers.on_cancel(transfer_id, peer) {
            CancelOutcome::Over(Ended::NobodyGotIt) => self.stop_sending(transfer_id, true),
            CancelOutcome::Over(Ended::Finished) => self.out_over(transfer_id),
            _ => self.send_state(transfer_id),
        }
        self.pump(peer);
    }

    /// One receiver's copy is done with (whichever way).
    fn part_over(&mut self, transfer_id: &str, peer: &PeerId) {
        if let Some(each) = self.files.progress.get_mut(transfer_id) {
            each.remove(peer);
        }
        if self.files.busy.get(peer).is_some_and(|t| t == transfer_id) {
            self.files.busy.remove(peer);
        }
    }

    /// Everyone who wanted our file has it: forget it.
    fn out_over(&mut self, transfer_id: &str) {
        let sent = self.files.sent.remove(transfer_id).unwrap_or(1);
        let offered = self.files.out.remove(transfer_id).is_some_and(|f| f.offered);
        self.files.progress.remove(transfer_id);
        self.stops.remove(transfer_id);
        self.transfers.finish(transfer_id);
        if offered {
            let _ = self.updates.send(Update::SendState {
                transfer_id: transfer_id.to_owned(),
                status: SendStatus {
                    waiting: 0,
                    sending: 0,
                    sent,
                },
            });
        }
    }

    /// Tells the UI where our offered file is with its receivers.
    fn send_state(&self, transfer_id: &str) {
        if !self.files.out.get(transfer_id).is_some_and(|f| f.offered) {
            return;
        }
        if let Some(mut status) = self.transfers.status(transfer_id) {
            status.sent = status
                .sent
                .max(self.files.sent.get(transfer_id).copied().unwrap_or(0));
            let _ = self.updates.send(Update::SendState {
                transfer_id: transfer_id.to_owned(),
                status,
            });
        }
    }

    // ---- receiving ----

    /// A file's announcement from a peer. A big one waits for us to accept it (its frames are
    /// expected only then). True when it isn't a chat line of its own (a folder's file).
    pub(crate) fn file_announced(&mut self, from: &PeerId, message: &PeerMessage, now: f64) -> bool {
        let (tid, chunks, file_size) = match message {
            PeerMessage::P2pImageStart {
                transfer_id,
                total_chunks,
                file_size,
                ..
            }
            | PeerMessage::P2pFileStart {
                transfer_id,
                total_chunks,
                file_size,
                ..
            } => (transfer_id.as_str(), *total_chunks, *file_size),
            _ => return false,
        };
        // accepted already: the frames come now (a folder's file, a QUIC fallback, a late start)
        if let Some(path) = self.files.accepted.get(tid) {
            let folder_file = path.is_some();
            if self.transfers.sender_of(tid) == Some(from) {
                self.images.start(tid, chunks, now);
            }
            return folder_file;
        }
        if let Some(offer) = self.files.offers.get(tid) {
            return offer.path.is_some();
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let size = if file_size.is_finite() && file_size > 0.0 {
            file_size as u64
        } else {
            0
        };
        self.transfers.receiving(tid, from);
        if needs_accept(size) {
            self.files.offers.insert(
                tid.to_owned(),
                OfferIn {
                    from: from.clone(),
                    chunks,
                    path: None,
                },
            );
        } else {
            self.images.start(tid, chunks, now);
        }
        false
    }

    /// A folder offered to us: its files wait for us to accept them; the ones already in
    /// Downloads are looked for ([`Update::FolderHere`]).
    pub(crate) fn folder_offered(&mut self, from: &PeerId, message: &PeerMessage) {
        let PeerMessage::P2pFolderOffer {
            folder_id,
            name,
            files,
            ..
        } = message
        else {
            return;
        };
        let Some(folder) = rtc_core::clean_folder(folder_id.clone(), name, files.clone()) else {
            return;
        };
        if self.files.folders_in.contains_key(&folder.folder_id) {
            return;
        }
        self.transfers.receiving(&folder.folder_id, from);
        let mut ids = Vec::new();
        let mut look = Vec::new();
        for f in &folder.files {
            #[allow(clippy::cast_precision_loss)]
            let chunks = f.file_size.div_ceil(rtc_protocol::image::CHUNK as u64).max(1) as f64;
            self.transfers.receiving(&f.transfer_id, from);
            self.files.offers.insert(
                f.transfer_id.clone(),
                OfferIn {
                    from: from.clone(),
                    chunks,
                    path: Some(f.path.clone()),
                },
            );
            ids.push(f.transfer_id.clone());
            look.push((
                f.transfer_id.clone(),
                f.path.clone(),
                f.file_name.clone(),
                f.file_size,
            ));
        }
        self.files.folders_in.insert(folder.folder_id.clone(), ids);
        let queue = self.queue_tx.clone();
        let folder_id = folder.folder_id;
        tokio::task::spawn_blocking(move || {
            let root = downloads();
            let here: Vec<(String, FileHere)> = look
                .into_iter()
                .filter_map(|(tid, path, file_name, size)| {
                    let place = Place {
                        file_name: &file_name,
                        relative_path: Some(&path),
                    };
                    let dir = place.dir(&root);
                    let whole = dir.join(place.name());
                    if std::fs::metadata(&whole).is_ok_and(|m| m.is_file() && m.len() == size) {
                        return Some((tid, FileHere::Whole(whole)));
                    }
                    let part = dir.join(rtc_core::quic::partial_name(&place.name()));
                    std::fs::metadata(part).is_ok().then_some((tid, FileHere::Partly))
                })
                .collect();
            if !here.is_empty() {
                let _ = queue.send(Msg::FolderHere(folder_id, here));
            }
        });
    }

    /// Accept (the card's or the folder window's button): the sender starts sending it to us.
    pub(crate) fn accept_transfer(&mut self, transfer_id: &str) {
        let Some(offer) = self.files.offers.remove(transfer_id) else {
            return;
        };
        if !self.room.members().contains_key(&offer.from) {
            let _ = self.updates.send(Update::TransferCancelled {
                transfer_id: transfer_id.to_owned(),
            });
            return;
        }
        // single files: the frames may start right away (the sender sends the announcement
        // again first, which restarts this)
        self.images.start(transfer_id, offer.chunks, now_ms());
        self.files.accepted.insert(transfer_id.to_owned(), offer.path);
        self.broadcast(&Envelope {
            sender: None,
            timestamp: Some(now_ms()),
            message: PeerMessage::P2pFileControl {
                transfer_id: transfer_id.to_owned(),
                action: "accept".to_owned(),
                start_chunk: None,
            },
        });
    }

    /// A file came in whole on the bulk channel: a folder's file is saved in its place under
    /// Downloads, anything else goes to the chat.
    pub(crate) fn file_arrived(&mut self, transfer_id: String, bytes: Vec<u8>) {
        self.transfers.finish(&transfer_id);
        let Some(Some(path)) = self.files.accepted.remove(&transfer_id) else {
            let _ = self.updates.send(Update::ImageReady {
                transfer_id,
                bytes: bytes.into(),
            });
            return;
        };
        let queue = self.queue_tx.clone();
        tokio::spawn(async move {
            let file_name = path.rsplit('/').next().unwrap_or_default().to_owned();
            let place = Place {
                file_name: &file_name,
                relative_path: Some(&path),
            };
            let dir = place.dir(&downloads());
            let name = place.name();
            let saved = async {
                tokio::fs::create_dir_all(&dir).await?;
                let target = unique_path(&dir, &name);
                tokio::fs::write(&target, &bytes).await?;
                Ok::<_, std::io::Error>(target)
            }
            .await;
            let event = match saved {
                Ok(path) => crate::quic_flow::Event::Received { transfer_id, path },
                Err(e) => crate::quic_flow::Event::SaveFailed {
                    transfer_id,
                    reason: e.to_string(),
                },
            };
            let _ = queue.send(Msg::Quic(event));
        });
    }

    // ---- cancel ----

    /// The card's Cancel (or Decline), for our file or folder, or one offered or coming in.
    pub(crate) fn cancel_transfer(&mut self, transfer_id: &str) {
        if let Some(ids) = self.files.folders_out.remove(transfer_id) {
            // our folder: every file, and one message for the folder
            for tid in &ids {
                self.stop_sending(tid, false);
            }
            self.broadcast_cancel(transfer_id);
            let _ = self.updates.send(Update::TransferCancelled {
                transfer_id: transfer_id.to_owned(),
            });
            return;
        }
        if self.transfers.is_ours(transfer_id) || self.files.out.contains_key(transfer_id) {
            self.stop_sending(transfer_id, true);
            return;
        }
        self.stop_receiving(transfer_id);
        self.transfers.finish(transfer_id);
        self.broadcast_cancel(transfer_id);
    }

    /// A `p2p-file-control` from a peer: `accept` and `cancel` (pause and resume are the web
    /// app's).
    pub(crate) fn file_control(&mut self, from: &PeerId, message: &PeerMessage) {
        let PeerMessage::P2pFileControl {
            transfer_id, action, ..
        } = message
        else {
            return;
        };
        match action.as_str() {
            "accept" => self.peer_accepted(transfer_id, from),
            "cancel" => match self.transfers.on_cancel(transfer_id, from) {
                CancelOutcome::StopTo(peer) => self.stop_sending_to(transfer_id, &peer),
                CancelOutcome::Over(Ended::NobodyGotIt) => self.nobody_receiving(transfer_id),
                CancelOutcome::Over(Ended::Finished) => {
                    self.stop_sending_to(transfer_id, from);
                    self.out_over(transfer_id);
                }
                CancelOutcome::Cancelled => {
                    if let Some(ids) = self.files.folders_in.remove(transfer_id.as_str()) {
                        for tid in ids {
                            self.transfers.finish(&tid);
                            self.stop_receiving(&tid);
                        }
                    }
                    self.stop_receiving(transfer_id);
                }
                CancelOutcome::Ignore => {}
            },
            _ => {}
        }
    }

    /// `peer` left the room: they no longer wait for or get our files (one nobody gets stops),
    /// and what they offered us can't come any more.
    pub(crate) fn transfers_peer_gone(&mut self, peer: &PeerId) {
        self.files.queue.remove(peer);
        self.files.busy.remove(peer);
        self.quic_peer_gone(peer);
        for (tid, end) in self.transfers.peer_gone(peer) {
            match end {
                Ended::NobodyGotIt => {
                    let single = self.files.out.get(&tid).is_some_and(|f| f.folder.is_none());
                    if single {
                        self.nobody_receiving(&tid);
                    } else {
                        self.stop_sending(&tid, true);
                    }
                }
                Ended::Finished => self.out_over(&tid),
            }
        }
        let theirs: Vec<String> = self
            .files
            .offers
            .iter()
            .filter(|(_, o)| &o.from == peer)
            .map(|(t, _)| t.clone())
            .collect();
        for tid in theirs {
            self.transfers.finish(&tid);
            self.stop_receiving(&tid);
        }
        self.files
            .folders_in
            .retain(|folder, _| self.transfers.sender_of(folder) != Some(peer));
    }

    /// No receiver is left for our file: stop sending it.
    fn nobody_receiving(&mut self, transfer_id: &str) {
        self.stop_sending(transfer_id, true);
        let _ = self.updates.send(Update::Notice(
            "Stopped sending the file: nobody is receiving it".to_owned(),
        ));
    }

    /// A receiver cancelled (or declined) our file: no more of it goes to them; their next
    /// folder file starts.
    fn stop_sending_to(&mut self, transfer_id: &str, peer: &PeerId) {
        if let Some(stop) = self.stops.get(transfer_id) {
            stop.stop_to(peer.clone());
        }
        if self.quic_stop_to(transfer_id, peer) {
            // no event comes from an aborted QUIC send
            self.part_over(transfer_id, peer);
            self.pump(peer);
        }
        self.send_state(transfer_id);
    }

    /// Stops sending our file to everyone (`tell`: and tells them), and shows it cancelled.
    pub(crate) fn stop_sending(&mut self, transfer_id: &str, tell: bool) {
        self.transfers.finish(transfer_id);
        if let Some(stop) = self.stops.remove(transfer_id) {
            stop.stop_all();
        }
        self.quic_cancel(transfer_id);
        self.files.out.remove(transfer_id);
        self.files.progress.remove(transfer_id);
        self.files.sent.remove(transfer_id);
        for q in self.files.queue.values_mut() {
            q.retain(|t| t != transfer_id);
        }
        let freed: Vec<PeerId> = self
            .files
            .busy
            .iter()
            .filter(|(_, t)| *t == transfer_id)
            .map(|(p, _)| p.clone())
            .collect();
        for p in &freed {
            self.files.busy.remove(p);
        }
        if tell {
            self.broadcast_cancel(transfer_id);
        }
        let _ = self.updates.send(Update::TransferCancelled {
            transfer_id: transfer_id.to_owned(),
        });
        for p in freed {
            self.pump(&p);
        }
    }

    /// Stops receiving a file (offered, bulk frames or QUIC) and shows it cancelled.
    fn stop_receiving(&mut self, transfer_id: &str) {
        self.files.offers.remove(transfer_id);
        self.files.accepted.remove(transfer_id);
        self.images.abort(transfer_id);
        self.quic_stop_incoming(transfer_id);
        let _ = self.updates.send(Update::TransferCancelled {
            transfer_id: transfer_id.to_owned(),
        });
    }

    /// Tells everyone `transfer_id` is cancelled (by us).
    fn broadcast_cancel(&self, transfer_id: &str) {
        self.broadcast(&Envelope {
            sender: None,
            timestamp: Some(now_ms()),
            message: PeerMessage::P2pFileControl {
                transfer_id: transfer_id.to_owned(),
                action: "cancel".to_owned(),
                start_chunk: None,
            },
        });
    }

    /// Left the room: every file both ways stops.
    pub(crate) fn files_reset(&mut self) {
        self.files = Files::default();
        self.transfers.reset();
        for (_, stop) in self.stops.drain() {
            stop.stop_all();
        }
    }
}
