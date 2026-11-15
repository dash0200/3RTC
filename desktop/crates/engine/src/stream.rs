//! Sharing a video file (`useStreamTransfer.ts`, `utils/p2pStreamer.ts`, `webrtc/streamTree.ts`).
//!
//! **Owner** (the file is on this computer): a viewer's `p2p-stream-request` gets a header and
//! then the 256 KB blocks its player asks for, read from disk as they're needed (a 2 GB file is
//! never in memory). Swarm viewers also get each block's SHA-256 on request. In the relay tree
//! (viewers that don't swarm) we feed two viewers ourselves and the rest through them. Browsers
//! without on-demand playback get the whole file pushed in 16 KB chunks.
//!
//! **Viewer** (someone else's file): we ask for range mode, cache blocks in memory (up to
//! [`CACHE_BYTES`], far ones dropped first) and hand them to mpv through [`StreamReader`],
//! whose reads block until the data is here. Blocks come from the owner, or from the viewer
//! the owner names (`via`), falling back to the owner when that one is slow or leaves. This app
//! doesn't swarm: it never offers blocks to other viewers.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use rtc_protocol::PeerId;
use rtc_protocol::stream::{
    FileMessage, RANGE_BLOCK_SIZE, RANGE_PACKET_PAYLOAD, RELAY_FANOUT, STREAM_CHUNK_SIZE, StreamMessage,
    block_count, mime_for, pack_chunk, pack_range, parse_range,
};
use rtc_webrtc::libwebrtc::data_channel::{DataChannel, DataChannelState};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

// ---- numbers from p2pStreamer.ts ------------------------------------------------------------------

/// Pause a block stream above this much queued on the channel …
const RANGE_BUFFER_HIGH: u64 = 96 * 1024;
/// … until it's down to this.
const RANGE_BUFFER_LOW: u64 = 32 * 1024;
/// The same for the whole-file push.
const PUSH_BUFFER_HIGH: u64 = 192 * 1024;
const PUSH_BUFFER_LOW: u64 = 64 * 1024;
/// Read-ahead past the block the player reads.
const PREFETCH_BYTES: u64 = 2 * 1024 * 1024;
/// How far ahead blocks are fetched in the background.
const BUFFER_AHEAD_BYTES: u64 = 96 * 1024 * 1024;
/// Background blocks in flight at once.
const IN_FLIGHT_BLOCKS: usize = 16;
/// Blocks kept in memory (a computer's share in the web app).
pub(crate) const CACHE_BYTES: u64 = 700 * 1024 * 1024;
/// Share of the cache kept behind the player.
const KEEP_BEHIND_SHARE: f64 = 0.25;
/// A block asked of the owner is asked again after this (ms).
const BLOCK_WAIT_MS: f64 = 15_000.0;
/// … of a relaying viewer: then the owner is asked instead.
const RELAY_WAIT_MS: f64 = 5_000.0;
/// The player gives up on a block after this long.
const READ_GIVE_UP: Duration = Duration::from_secs(90);
/// The player asks again this often while it waits.
const READ_NUDGE: Duration = Duration::from_millis(1000);

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Reads up to `buf.len()` bytes at `pos` (no shared cursor: several readers may use the file).
fn read_at(file: &File, buf: &mut [u8], pos: u64) -> std::io::Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buf, pos)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buf, pos)
    }
}

fn read_full(file: &File, buf: &mut [u8], pos: u64) -> std::io::Result<()> {
    let mut done = 0;
    while done < buf.len() {
        let n = read_at(file, &mut buf[done..], pos + done as u64)?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        done += n;
    }
    Ok(())
}

fn sha256_hex(data: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(64);
    for b in digest {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// One block of our file.
fn read_block(file: &File, size: u64, block: u32) -> std::io::Result<Vec<u8>> {
    let start = u64::from(block) * u64::from(RANGE_BLOCK_SIZE);
    let len = usize::try_from((size - start.min(size)).min(u64::from(RANGE_BLOCK_SIZE))).unwrap_or(0);
    let mut buf = vec![0u8; len];
    read_full(file, &mut buf, start)?;
    Ok(buf)
}

// ---- the relay tree (streamTree.ts) -------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Node {
    parent: Option<PeerId>,
    can_relay: bool,
}

/// Who fetches from whom, kept by the owner.
#[derive(Debug, Default)]
pub(crate) struct Tree(HashMap<PeerId, Node>);

impl Tree {
    fn children(&self, of: Option<&PeerId>, except: &PeerId) -> usize {
        self.0
            .iter()
            .filter(|(id, n)| *id != except && n.parent.as_ref() == of)
            .count()
    }

    fn depth(&self, id: &PeerId) -> usize {
        let mut depth = 0;
        let mut seen = HashSet::new();
        let mut cur = self.0.get(id).and_then(|n| n.parent.clone());
        while let Some(c) = cur {
            if !seen.insert(c.clone()) {
                break;
            }
            depth += 1;
            cur = self.0.get(&c).and_then(|n| n.parent.clone());
        }
        depth
    }

    fn is_under(&self, id: &PeerId, ancestor: &PeerId) -> bool {
        let mut seen = HashSet::new();
        let mut cur = self.0.get(id).and_then(|n| n.parent.clone());
        while let Some(c) = cur {
            if &c == ancestor {
                return true;
            }
            if !seen.insert(c.clone()) {
                break;
            }
            cur = self.0.get(&c).and_then(|n| n.parent.clone());
        }
        false
    }

    /// Where `viewer` should fetch from (`None`: the owner).
    fn choose_parent(&self, viewer: &PeerId, reachable: &dyn Fn(&PeerId) -> bool) -> Option<PeerId> {
        if self.children(None, viewer) < RELAY_FANOUT {
            return None;
        }
        let mut best: Option<(&PeerId, usize)> = None;
        // in a fixed order, so the same tree always picks the same parent
        let mut ids: Vec<&PeerId> = self.0.keys().collect();
        ids.sort();
        for id in ids {
            let node = &self.0[id];
            if id == viewer || !node.can_relay || !reachable(id) || self.is_under(id, viewer) {
                continue;
            }
            if self.children(Some(id), viewer) >= RELAY_FANOUT {
                continue;
            }
            let d = self.depth(id);
            if best.is_none_or(|(_, bd)| d < bd) {
                best = Some((id, d));
            }
        }
        best.map(|(id, _)| id.clone())
    }

    /// A viewer joins (or joins again): its parent (`None`: the owner).
    pub(crate) fn add(
        &mut self,
        viewer: &PeerId,
        can_relay: bool,
        reachable: &dyn Fn(&PeerId) -> bool,
    ) -> Option<PeerId> {
        self.detach(viewer);
        let parent = self.choose_parent(viewer, reachable);
        self.0.insert(
            viewer.clone(),
            Node {
                parent: parent.clone(),
                can_relay,
            },
        );
        parent
    }

    /// A viewer left or stopped: its children fetch from the owner.
    pub(crate) fn detach(&mut self, viewer: &PeerId) {
        if self.0.remove(viewer).is_none() {
            return;
        }
        for n in self.0.values_mut() {
            if n.parent.as_ref() == Some(viewer) {
                n.parent = None;
            }
        }
    }

    /// A viewer asks the owner directly now (it fell back from its parent).
    pub(crate) fn mark_direct(&mut self, viewer: &PeerId) {
        if let Some(n) = self.0.get_mut(viewer) {
            n.parent = None;
        }
    }

    fn clear(&mut self) {
        self.0.clear();
    }
}

// ---- owner: serving blocks to one viewer (P2PRangeSender) ---------------------------------------

#[derive(Default)]
struct ServeQueue {
    queue: VecDeque<u32>,
    current: Option<u32>,
    aborted: bool,
}

/// Serves one viewer, in the order its player needs the blocks.
struct Server {
    stream_no: u32,
    q: Arc<Mutex<ServeQueue>>,
    wake: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
    channel: DataChannel,
}

impl Server {
    fn start(
        channel: DataChannel,
        file: Arc<File>,
        size: u64,
        stream_no: u32,
        hashes: Option<Arc<Mutex<HashMap<u32, String>>>>,
    ) -> Self {
        let q = Arc::new(Mutex::new(ServeQueue::default()));
        let wake = Arc::new(Notify::new());
        let task = tokio::spawn(serve(
            channel.clone(),
            file,
            size,
            stream_no,
            Arc::clone(&q),
            Arc::clone(&wake),
            hashes,
        ));
        Self {
            stream_no,
            q,
            wake,
            task,
            channel,
        }
    }

    fn request(&self, blocks: &[u32], urgent: bool, total: u32) {
        let mut q = lock(&self.q);
        let wanted: Vec<u32> = blocks
            .iter()
            .copied()
            .filter(|b| *b < total && Some(*b) != q.current)
            .collect();
        if urgent {
            q.queue.retain(|b| !wanted.contains(b));
            for b in wanted.into_iter().rev() {
                q.queue.push_front(b);
            }
        } else {
            for b in wanted {
                if !q.queue.contains(&b) {
                    q.queue.push_back(b);
                }
            }
        }
        drop(q);
        self.wake.notify_one();
    }

    fn cancel(&self, blocks: &[u32]) {
        lock(&self.q).queue.retain(|b| !blocks.contains(b));
    }

    /// Stops; `notice` tells the viewer (`p2p-stream-cancel`).
    fn stop(self, notice: Option<&str>) {
        lock(&self.q).aborted = true;
        self.wake.notify_one();
        self.task.abort();
        if let Some(text) = notice
            && self.channel.state() == DataChannelState::Open
        {
            let _ = self.channel.send(text.as_bytes(), false);
        }
    }
}

/// Waits while the channel holds more than `high`, until it's down to `low`. `false`: closed.
async fn drain(dc: &DataChannel, high: u64, low: u64, stop: &(dyn Fn() -> bool + Sync)) -> bool {
    if dc.buffered_amount() <= high {
        return dc.state() == DataChannelState::Open;
    }
    loop {
        if stop() || dc.state() != DataChannelState::Open {
            return false;
        }
        if dc.buffered_amount() <= low {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(4)).await;
    }
}

async fn serve(
    dc: DataChannel,
    file: Arc<File>,
    size: u64,
    stream_no: u32,
    q: Arc<Mutex<ServeQueue>>,
    wake: Arc<Notify>,
    hashes: Option<Arc<Mutex<HashMap<u32, String>>>>,
) {
    let aborted = || lock(&q).aborted;
    loop {
        let next = {
            let mut g = lock(&q);
            if g.aborted {
                return;
            }
            let b = g.queue.pop_front();
            g.current = b;
            b
        };
        let Some(block) = next else {
            wake.notified().await;
            continue;
        };
        let f = Arc::clone(&file);
        let data = match tokio::task::spawn_blocking(move || read_block(&f, size, block)).await {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => {
                tracing::warn!("stream: couldn't read block {block}: {e}");
                lock(&q).current = None;
                continue;
            }
            Err(_) => return,
        };
        // checksum as it goes out: any block a viewer passes on came from us first
        if let Some(h) = &hashes
            && !lock(h).contains_key(&block)
        {
            let hex = sha256_hex(&data);
            lock(h).insert(block, hex);
        }
        for (i, piece) in data.chunks(RANGE_PACKET_PAYLOAD).enumerate() {
            if !drain(&dc, RANGE_BUFFER_HIGH, RANGE_BUFFER_LOW, &aborted).await {
                return;
            }
            let offset = u32::try_from(i * RANGE_PACKET_PAYLOAD).unwrap_or(u32::MAX);
            if let Err(e) = dc.send(&pack_range(stream_no, block, offset, piece), true) {
                tracing::debug!("stream: send failed: {e:?}");
                return;
            }
            // Pace packets to prevent SCTP from saturating the UDP socket and starving voice RTP
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        lock(&q).current = None;
    }
}

/// The whole file in 16 KB chunks (`P2PStreamSender`): for browsers that can't play on demand.
async fn push_whole(
    dc: DataChannel,
    file: Arc<File>,
    size: u64,
    header: String,
    complete: String,
    stop: Arc<AtomicBool>,
) {
    if dc.send(header.as_bytes(), false).is_err() {
        return;
    }
    let chunks = size.div_ceil(STREAM_CHUNK_SIZE as u64);
    let halt = || stop.load(Ordering::Relaxed);
    let mut i: u64 = 0;
    while i < chunks {
        // read a batch of chunks at a time (fewer trips to the disk)
        let first = i;
        let batch = (chunks - i).min(64);
        let f = Arc::clone(&file);
        let start = first * STREAM_CHUNK_SIZE as u64;
        let len = usize::try_from((size - start).min(batch * STREAM_CHUNK_SIZE as u64)).unwrap_or(0);
        let Ok(Ok(data)) = tokio::task::spawn_blocking(move || {
            let mut buf = vec![0u8; len];
            read_full(&f, &mut buf, start).map(|()| buf)
        })
        .await
        else {
            return;
        };
        for (k, piece) in data.chunks(STREAM_CHUNK_SIZE).enumerate() {
            if !drain(&dc, PUSH_BUFFER_HIGH, PUSH_BUFFER_LOW, &halt).await {
                return;
            }
            let index = u32::try_from(first + k as u64).unwrap_or(u32::MAX);
            if dc.send(&pack_chunk(index, piece), true).is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        i += batch;
    }
    let _ = dc.send(complete.as_bytes(), false);
}

// ---- viewer: blocks for the player --------------------------------------------------------------

struct CacheState {
    blocks: HashMap<u32, Arc<Vec<u8>>>,
    cached: u64,
    closed: bool,
}

struct Shared {
    size: u64,
    block_size: u32,
    state: Mutex<CacheState>,
    arrived: Condvar,
    /// Tells the engine the player wants a block.
    want: Box<dyn Fn(u32) + Send + Sync>,
}

/// What mpv reads a shared video through: blocking reads that wait for the blocks to arrive.
#[derive(Clone)]
pub struct StreamReader {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for StreamReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamReader")
            .field("size", &self.shared.size)
            .finish_non_exhaustive()
    }
}

impl PartialEq for StreamReader {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.shared, &other.shared)
    }
}

impl StreamReader {
    /// The file's size in bytes.
    #[must_use]
    pub fn size(&self) -> u64 {
        self.shared.size
    }

    /// Reads at `pos` into `buf` (at most to the end of a block), waiting for the data.
    /// `Ok(0)`: the end of the file.
    ///
    /// # Errors
    /// The stream stopped (the owner left or stopped sharing), or the block never came.
    pub fn read_at(&self, pos: u64, buf: &mut [u8]) -> Result<usize, String> {
        let s = &self.shared;
        if pos >= s.size || buf.is_empty() {
            return Ok(0);
        }
        let bs = u64::from(s.block_size);
        let index = u32::try_from(pos / bs).unwrap_or(u32::MAX);
        let started = Instant::now();
        let mut st = lock(&s.state);
        let mut asked = false;
        loop {
            if st.closed {
                return Err("the stream stopped".to_owned());
            }
            if let Some(block) = st.blocks.get(&index) {
                let from = usize::try_from(pos - u64::from(index) * bs).unwrap_or(0);
                let n = buf.len().min(block.len().saturating_sub(from));
                buf[..n].copy_from_slice(&block[from..from + n]);
                drop(st);
                // what's playing moves on: tell the engine (it fetches ahead)
                if !asked {
                    (s.want)(index);
                }
                return Ok(n);
            }
            if started.elapsed() > READ_GIVE_UP {
                return Err("the video stopped arriving".to_owned());
            }
            drop(st);
            (s.want)(index);
            asked = true;
            st = lock(&s.state);
            if st.closed || st.blocks.contains_key(&index) {
                continue;
            }
            st = s
                .arrived
                .wait_timeout(st, READ_NUDGE)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// Stops every read now and later (the player is closing).
    pub fn close(&self) {
        lock(&self.shared.state).closed = true;
        self.shared.arrived.notify_all();
    }
}

/// A block on its way in.
struct Partial {
    data: Vec<u8>,
    got: HashSet<u32>,
    received: usize,
}

/// A stream we watch (`P2PRangeReceiver`, without the swarm).
pub(crate) struct View {
    pub(crate) owner: PeerId,
    source: PeerId,
    pub(crate) stream_no: u32,
    pub(crate) name: String,
    size: u64,
    block_size: u32,
    total: u32,
    reader: StreamReader,
    pending: HashMap<u32, f64>,
    partial: HashMap<u32, Partial>,
    window: Option<(u32, u32)>,
    reading: u32,
    received: u64,
    progress_at: f64,
    progress_bytes: u64,
}

/// How the stream we watch is doing (for the bar under the video).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreamProgress {
    /// Bytes held now.
    pub cached: u64,
    /// The file's size.
    pub size: u64,
    /// MB/s lately.
    pub speed: f64,
    /// Fetched through another viewer.
    pub relayed: bool,
}

impl View {
    fn relayed(&self) -> bool {
        self.source != self.owner
    }

    fn has(&self, b: u32) -> bool {
        lock(&self.reader.shared.state).blocks.contains_key(&b)
    }

    fn late(&self, at: f64, now: f64) -> bool {
        now - at
            > if self.relayed() {
                RELAY_WAIT_MS
            } else {
                BLOCK_WAIT_MS
            }
    }

    fn missing(&self, b: u32, now: f64) -> bool {
        !self.has(b) && self.pending.get(&b).is_none_or(|at| self.late(*at, now))
    }

    fn request(&mut self, blocks: Vec<u32>, urgent: bool, out: &mut Vec<Out>) {
        if blocks.is_empty() {
            return;
        }
        out.push(Out::To(
            self.source.clone(),
            StreamMessage::RangeRequest {
                stream_no: self.stream_no,
                blocks,
                urgent,
                swarm: false,
            },
        ));
    }

    /// The player reads block `index` (`_request` + `_noteReading`).
    fn want(&mut self, index: u32, now: f64, out: &mut Vec<Out>) {
        if index >= self.total {
            return;
        }
        self.reading = index;
        let bs = u64::from(self.block_size);
        let ahead = u32::try_from(PREFETCH_BYTES.div_ceil(bs)).unwrap_or(8);
        let last = (self.total - 1).min(index.saturating_add(ahead));
        let wlast =
            (self.total - 1).min(index.saturating_add(u32::try_from(BUFFER_AHEAD_BYTES / bs).unwrap_or(384)));
        self.window = Some((index + 1, wlast));
        // what's no longer near the player
        let stale: Vec<u32> = self
            .pending
            .keys()
            .copied()
            .filter(|b| *b < index || *b > wlast)
            .collect();
        if !stale.is_empty() {
            for b in &stale {
                self.pending.remove(b);
                self.partial.remove(b);
            }
            out.push(Out::To(
                self.source.clone(),
                StreamMessage::RangeCancel {
                    stream_no: self.stream_no,
                    blocks: stale,
                    swarm: false,
                },
            ));
        }
        if self.missing(index, now) {
            self.pending.insert(index, now);
            self.request(vec![index], true, out);
        }
        let prefetch: Vec<u32> = ((index + 1)..=last).filter(|b| self.missing(*b, now)).collect();
        for b in &prefetch {
            self.pending.insert(*b, now);
        }
        self.request(prefetch, false, out);
        self.top_up(now, out);
    }

    /// Keeps up to [`IN_FLIGHT_BLOCKS`] of the read-ahead window on their way.
    fn top_up(&mut self, now: f64, out: &mut Vec<Out>) {
        let Some((first, last)) = self.window else { return };
        let in_flight = self.pending.values().filter(|at| !self.late(**at, now)).count();
        let mut wanted = Vec::new();
        let mut b = first;
        while b <= last && in_flight + wanted.len() < IN_FLIGHT_BLOCKS {
            if self.missing(b, now) {
                wanted.push(b);
            }
            b += 1;
        }
        for w in &wanted {
            self.pending.insert(*w, now);
        }
        self.request(wanted, false, out);
    }

    /// Our relay is slow or gone: everything from the owner (`useOwner`).
    fn use_owner(&mut self, reason: &str, now: f64, out: &mut Vec<Out>) {
        if !self.relayed() {
            return;
        }
        self.source = self.owner.clone();
        out.push(Out::Log(format!(
            "📡 Now streaming straight from the owner ({reason})."
        )));
        let all: Vec<u32> = self.pending.keys().copied().collect();
        for b in &all {
            self.pending.insert(*b, now);
            self.partial.remove(b);
        }
        let urgent: Vec<u32> = all.iter().copied().filter(|b| *b == self.reading).collect();
        let rest: Vec<u32> = all.iter().copied().filter(|b| *b != self.reading).collect();
        self.request(urgent, true, out);
        self.request(rest, false, out);
    }

    fn packet(&mut self, block: u32, offset: u32, payload: &[u8], now: f64, out: &mut Vec<Out>) {
        if block >= self.total || self.has(block) {
            return;
        }
        let bs = u64::from(self.block_size);
        let len = usize::try_from((self.size - u64::from(block) * bs).min(bs)).unwrap_or(0);
        let p = self.partial.entry(block).or_insert_with(|| Partial {
            data: vec![0; len],
            got: HashSet::new(),
            received: 0,
        });
        let at = usize::try_from(offset).unwrap_or(usize::MAX);
        if at.saturating_add(payload.len()) > p.data.len() || !p.got.insert(offset) {
            return;
        }
        p.data[at..at + payload.len()].copy_from_slice(payload);
        p.received += payload.len();
        if p.received < p.data.len() {
            return;
        }
        let Some(done) = self.partial.remove(&block) else {
            return;
        };
        self.pending.remove(&block);
        self.received += done.data.len() as u64;
        let shared = &self.reader.shared;
        let mut st = lock(&shared.state);
        st.cached += done.data.len() as u64;
        st.blocks.insert(block, Arc::new(done.data));
        Self::evict(&mut st, self.reading, self.block_size, self.window);
        drop(st);
        shared.arrived.notify_all();
        self.top_up(now, out);
    }

    /// Over the cache size: drop the blocks farthest from the player (`_evict`).
    fn evict(st: &mut CacheState, index: u32, block_size: u32, window: Option<(u32, u32)>) {
        if st.cached <= CACHE_BYTES {
            return;
        }
        let bs = f64::from(block_size);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let behind = ((CACHE_BYTES as f64 * KEEP_BEHIND_SHARE) / bs).ceil() as u32;
        let keep_from = index.saturating_sub(behind);
        let ahead = u32::try_from(PREFETCH_BYTES.div_ceil(u64::from(block_size))).unwrap_or(8);
        let keep_to = index.saturating_add(ahead).max(window.map_or(0, |w| w.1));
        let mut victims: Vec<u32> = st
            .blocks
            .keys()
            .copied()
            .filter(|b| *b < keep_from || *b > keep_to)
            .collect();
        victims.sort_by_key(|b| std::cmp::Reverse(b.abs_diff(index)));
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let target = (CACHE_BYTES as f64 * 0.9) as u64;
        for b in victims {
            if st.cached <= target {
                break;
            }
            if let Some(d) = st.blocks.remove(&b) {
                st.cached -= d.len() as u64;
            }
        }
    }

    fn tick(&mut self, now: f64, out: &mut Vec<Out>) {
        if self.relayed() && self.pending.values().any(|at| self.late(*at, now)) {
            self.use_owner("the viewer passing it on was too slow", now, out);
        }
        // the block the player waits for, if it's late
        if let Some(at) = self.pending.get(&self.reading)
            && self.late(*at, now)
        {
            self.pending.insert(self.reading, now);
            self.request(vec![self.reading], true, out);
        }
        self.top_up(now, out);
    }

    fn progress(&mut self, now: f64) -> StreamProgress {
        let dt = ((now - self.progress_at) / 1000.0).max(0.05);
        #[allow(clippy::cast_precision_loss)]
        let speed = (self.received.saturating_sub(self.progress_bytes)) as f64 / (1024.0 * 1024.0) / dt;
        self.progress_at = now;
        self.progress_bytes = self.received;
        StreamProgress {
            cached: lock(&self.reader.shared.state).cached,
            size: self.size,
            speed,
            relayed: self.relayed(),
        }
    }

    fn close(&self) {
        self.reader.close();
    }
}

/// "English – SDH" (`subtitleTrackLabel` without the codec).
fn track_label(t: &serde_json::Value) -> String {
    let code = t["language"].as_str().unwrap_or("und");
    let lang = match code.split('-').next().unwrap_or(code) {
        "eng" | "en" => "English",
        "hin" | "hi" => "Hindi",
        "kan" | "kn" => "Kannada",
        "tam" | "ta" => "Tamil",
        "tel" | "te" => "Telugu",
        "mal" | "ml" => "Malayalam",
        "mar" => "Marathi",
        "ben" => "Bengali",
        "spa" | "es" => "Spanish",
        "fre" | "fra" | "fr" => "French",
        "ger" | "deu" | "de" => "German",
        "ita" | "it" => "Italian",
        "jpn" | "ja" => "Japanese",
        "kor" | "ko" => "Korean",
        "chi" | "zho" | "zh" => "Chinese",
        "por" | "pt" => "Portuguese",
        "rus" | "ru" => "Russian",
        "ara" | "ar" => "Arabic",
        "und" | "" => "",
        _ => code,
    };
    let name = t["name"].as_str().unwrap_or_default();
    let name = if name == lang { "" } else { name };
    let main = [lang, name]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" – ");
    if main.is_empty() {
        format!("Track {}", t["number"])
    } else {
        main
    }
}

// ---- the whole thing ----------------------------------------------------------------------------

/// Our file, offered to the room.
struct Own {
    file: Arc<File>,
    name: String,
    size: u64,
    stream_no: u32,
    hashes: Arc<Mutex<HashMap<u32, String>>>,
}

/// What comes back to the engine from other threads.
#[derive(Debug)]
pub(crate) enum Back {
    /// The player wants block `.1` of stream `.0`.
    Want(u32, u32),
    /// Tell everyone (subtitle extraction progress).
    Broadcast(FileMessage),
    /// Subtitles read out of our file: share them (`subtitle-share`).
    Subtitles {
        /// Their name.
        name: String,
        /// WebVTT.
        vtt: String,
    },
}

/// What the engine should do.
#[derive(Debug)]
pub(crate) enum Out {
    /// A file-format message to one peer (main channel).
    ToFile(PeerId, FileMessage),
    /// To everyone.
    BroadcastFile(FileMessage),
    /// What's in the file someone shares (shown on the offer card).
    Format {
        /// The file.
        name: String,
        /// "MKV · HEVC (H.265) · AAC · 2 subtitles".
        description: String,
    },
    /// Viewers whose app can't play our file properly ("Riya (Chrome on Windows): …").
    Problems(Vec<String>),
    /// A message to one peer (on the bulk channel when open, else the main one).
    To(PeerId, StreamMessage),
    /// To everyone.
    Broadcast(StreamMessage),
    /// The Logs tab.
    Log(String),
    /// A toast.
    Notice(String),
    /// A stream we asked for started: the player can open it.
    Ready {
        /// The file's name.
        name: String,
        /// Its size.
        size: u64,
        /// What the player reads.
        reader: StreamReader,
    },
    /// The stream we watch stopped.
    Ended(String),
    /// How the stream we watch is doing.
    Progress(StreamProgress),
}

/// What the stream module needs from the engine.
pub(crate) trait Links {
    /// The open bulk channel to a peer.
    fn bulk(&self, peer: &PeerId) -> Option<DataChannel>;
    /// A member's name.
    fn name(&self, peer: &PeerId) -> Option<String>;
    /// Our name.
    fn me(&self) -> String;
}

pub(crate) struct Streams {
    /// How other threads reach the engine.
    back: Arc<dyn Fn(Back) + Send + Sync>,
    /// What's in our file (`file-format`), once read.
    own_format: Option<serde_json::Value>,
    /// Viewers' answers about our file: name, verdict, message, device.
    reports: HashMap<PeerId, (String, String, String, String)>,
    /// A subtitle track being read out of our file.
    extracting: Arc<AtomicBool>,
    own: Option<Own>,
    servers: HashMap<PeerId, Server>,
    pushes: HashMap<PeerId, Arc<AtomicBool>>,
    tree: Tree,
    view: Option<View>,
    /// We asked for a stream of this file (name), waiting for a header.
    asked: Option<String>,
}

impl Streams {
    pub(crate) fn new(back: impl Fn(Back) + Send + Sync + 'static) -> Self {
        Self {
            back: Arc::new(back),
            own_format: None,
            reports: HashMap::new(),
            extracting: Arc::new(AtomicBool::new(false)),
            own: None,
            servers: HashMap::new(),
            pushes: HashMap::new(),
            tree: Tree::default(),
            view: None,
            asked: None,
        }
    }

    /// Our own file to offer (`None`: none now). Viewers of the old one are told it stopped.
    pub(crate) fn share(&mut self, file: Option<(PathBuf, String, u64)>, links: &dyn Links) -> Vec<Out> {
        let same = match (&file, &self.own) {
            (Some((_, name, size)), Some(o)) => *name == o.name && *size == o.size,
            _ => false,
        };
        if same {
            return Vec::new();
        }
        self.stop_serving(links);
        self.own_format = None;
        self.reports.clear();
        let mut out = vec![Out::Problems(Vec::new())];
        self.own = file.and_then(|(path, name, size)| match File::open(&path) {
            Ok(f) => Some(Own {
                file: Arc::new(f),
                name,
                size,
                stream_no: rand::random::<u32>(),
                hashes: Arc::new(Mutex::new(HashMap::new())),
            }),
            Err(e) => {
                tracing::warn!("stream: can't open {}: {e}", path.display());
                None
            }
        });
        // what's inside, for the viewers' format card (a few MB read at most)
        if let Some(own) = &self.own {
            let file = Arc::clone(&own.file);
            let format = rtc_core::files::probe(
                &mut |pos, len| {
                    let mut buf = vec![0u8; len];
                    let n = read_at(&file, &mut buf, pos).ok()?;
                    let mut total = n;
                    while total < len {
                        match read_at(&file, &mut buf[total..], pos + total as u64) {
                            Ok(0) | Err(_) => break,
                            Ok(k) => total += k,
                        }
                    }
                    buf.truncate(total);
                    Some(buf)
                },
                own.size,
            );
            out.push(Out::BroadcastFile(FileMessage::Format {
                file_name: own.name.clone(),
                #[allow(clippy::cast_precision_loss)]
                file_size: own.size as f64,
                format: format.clone(),
            }));
            self.own_format = Some(format);
        }
        out
    }

    /// A channel opened: a newcomer learns what's in our file.
    pub(crate) fn peer_open(&self, peer: &PeerId) -> Vec<Out> {
        match (&self.own, &self.own_format) {
            (Some(own), Some(format)) => vec![Out::ToFile(
                peer.clone(),
                FileMessage::Format {
                    file_name: own.name.clone(),
                    #[allow(clippy::cast_precision_loss)]
                    file_size: own.size as f64,
                    format: format.clone(),
                },
            )],
            _ => Vec::new(),
        }
    }

    fn problems(&self) -> Out {
        let mut list: Vec<String> = self
            .reports
            .values()
            .filter(|(_, v, _, _)| v == "no-video" || v == "no-audio")
            .map(|(name, _, message, device)| {
                if device.is_empty() {
                    format!("{name}: {message}")
                } else {
                    format!("{name} ({device}): {message}")
                }
            })
            .collect();
        list.sort();
        Out::Problems(list)
    }

    /// A file-format message from a peer.
    pub(crate) fn file_message(&mut self, from: &PeerId, m: FileMessage, links: &dyn Links) -> Vec<Out> {
        let mut out = Vec::new();
        match m {
            FileMessage::Format {
                file_name, format, ..
            } => {
                if self.own.as_ref().is_some_and(|o| o.name == file_name) || file_name.is_empty() {
                    return out;
                }
                // mpv plays every container and codec the web app knows
                let known = format["container"].as_str().is_some_and(|c| c != "unknown");
                out.push(Out::ToFile(
                    from.clone(),
                    FileMessage::Report {
                        file_name: file_name.clone(),
                        verdict: if known { "ok" } else { "maybe" }.to_owned(),
                        message: String::new(),
                        device: "3RTC for Windows".to_owned(),
                    },
                ));
                out.push(Out::Format {
                    name: file_name,
                    description: rtc_core::files::describe(&format),
                });
            }
            FileMessage::Report {
                file_name,
                verdict,
                message,
                device,
            } => {
                if self.own.as_ref().is_none_or(|o| o.name != file_name) {
                    return out;
                }
                let name = links.name(from).unwrap_or_else(|| "Someone".to_owned());
                let cut = |s: String, n: usize| s.chars().take(n).collect::<String>();
                self.reports.insert(
                    from.clone(),
                    (cut(name, 40), verdict, cut(message, 300), cut(device, 60)),
                );
                out.push(self.problems());
            }
            FileMessage::SubtitleRequest { file_name, track } => {
                let (Some(own), Some(format)) = (&self.own, &self.own_format) else {
                    return out;
                };
                if own.name != file_name {
                    return out;
                }
                let Some(t) = format["subtitles"]
                    .as_array()
                    .and_then(|subs| subs.iter().find(|s| s["number"].as_u64() == Some(track)))
                else {
                    return out;
                };
                let codec = t["codec"].as_str().unwrap_or_default().to_owned();
                if t["kind"] != "text" || t.get("embeddedMp4").is_some() {
                    out.push(Out::BroadcastFile(FileMessage::SubtitleProgress {
                        file_name,
                        track,
                        progress: 0.0,
                        done: false,
                        error: Some("Picture subtitles can't be shared from the desktop app yet".to_owned()),
                    }));
                    return out;
                }
                if self.extracting.swap(true, Ordering::SeqCst) {
                    return out;
                }
                let label = track_label(t);
                let scale = format["timecodeScale"].as_u64().unwrap_or(1_000_000);
                let (file, size, back, busy) = (
                    Arc::clone(&own.file),
                    own.size,
                    Arc::clone(&self.back),
                    Arc::clone(&self.extracting),
                );
                out.push(Out::BroadcastFile(FileMessage::SubtitleProgress {
                    file_name: file_name.clone(),
                    track,
                    progress: 0.0,
                    done: false,
                    error: None,
                }));
                std::thread::spawn(move || {
                    let mut last = 0.0;
                    let fname = file_name.clone();
                    let b2 = Arc::clone(&back);
                    let cues = rtc_core::files::extract_mkv_subtitles(
                        &mut |pos, len| {
                            let mut buf = vec![0u8; len];
                            let mut total = 0;
                            while total < len {
                                match read_at(&file, &mut buf[total..], pos + total as u64) {
                                    Ok(0) | Err(_) => break,
                                    Ok(k) => total += k,
                                }
                            }
                            buf.truncate(total);
                            Some(buf)
                        },
                        size,
                        track,
                        &codec,
                        scale,
                        &mut |p| {
                            if p - last >= 0.1 && p < 1.0 {
                                last = p;
                                b2(Back::Broadcast(FileMessage::SubtitleProgress {
                                    file_name: fname.clone(),
                                    track,
                                    progress: p,
                                    done: false,
                                    error: None,
                                }));
                            }
                        },
                    );
                    busy.store(false, Ordering::SeqCst);
                    if cues.is_empty() {
                        back(Back::Broadcast(FileMessage::SubtitleProgress {
                            file_name,
                            track,
                            progress: 0.0,
                            done: false,
                            error: Some("That subtitle track is empty".to_owned()),
                        }));
                        return;
                    }
                    back(Back::Broadcast(FileMessage::SubtitleProgress {
                        file_name,
                        track,
                        progress: 1.0,
                        done: true,
                        error: None,
                    }));
                    back(Back::Subtitles {
                        name: format!("{label} (from the video).vtt"),
                        vtt: rtc_core::files::cues_to_vtt(&cues),
                    });
                });
            }
            FileMessage::SubtitleProgress { .. } => {}
        }
        out
    }

    fn stop_serving(&mut self, links: &dyn Links) {
        let me = links.me();
        for (_, s) in self.servers.drain() {
            let text = StreamMessage::Cancel {
                stream_no: s.stream_no,
            }
            .to_json(&me, now_ms())
            .ok();
            s.stop(text.as_deref());
        }
        for (_, p) in self.pushes.drain() {
            p.store(true, Ordering::Relaxed);
        }
        self.tree.clear();
    }

    /// Asks the room for the file playing (`requestStream`).
    pub(crate) fn ask(&mut self, file_name: &str, links: &dyn Links) -> Vec<Out> {
        self.stop_view(links);
        self.asked = Some(file_name.to_owned());
        vec![
            Out::Broadcast(StreamMessage::Request {
                requester: Some(links.me()),
                file_name: Some(file_name.to_owned()),
                supports_range: true,
                can_relay: false,
                swarm: false,
            }),
            Out::Log("📡 Requesting direct P2P video stream from peer...".to_owned()),
        ]
    }

    /// We stop watching a stream (closed, or another video).
    pub(crate) fn stop_view(&mut self, links: &dyn Links) -> Vec<Out> {
        self.asked = None;
        let Some(v) = self.view.take() else {
            return Vec::new();
        };
        v.close();
        let _ = links;
        vec![Out::To(
            v.owner.clone(),
            StreamMessage::Cancel {
                stream_no: v.stream_no,
            },
        )]
    }

    /// The player wants block `index` of stream `stream_no`.
    pub(crate) fn want(&mut self, stream_no: u32, index: u32) -> Vec<Out> {
        let mut out = Vec::new();
        if let Some(v) = &mut self.view
            && v.stream_no == stream_no
        {
            v.want(index, now_ms(), &mut out);
        }
        out
    }

    /// Twice a second.
    pub(crate) fn tick(&mut self, progress: bool) -> Vec<Out> {
        let mut out = Vec::new();
        let now = now_ms();
        if let Some(v) = &mut self.view {
            v.tick(now, &mut out);
            if progress {
                out.push(Out::Progress(v.progress(now)));
            }
        }
        self.servers.retain(|_, s| !s.task.is_finished());
        out
    }

    /// Binary data on a bulk channel that isn't a chat picture.
    pub(crate) fn binary(&mut self, from: &PeerId, data: &[u8]) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(p) = parse_range(data) else { return out };
        if let Some(v) = &mut self.view
            && v.stream_no == p.stream_no
            && (*from == v.source || *from == v.owner)
        {
            v.packet(p.block, p.offset, p.payload, now_ms(), &mut out);
        }
        out
    }

    /// A peer left: stop serving it; our relay or owner gone.
    pub(crate) fn peer_gone(&mut self, peer: &PeerId) -> Vec<Out> {
        let mut out = Vec::new();
        if self.reports.remove(peer).is_some() {
            out.push(self.problems());
        }
        if let Some(s) = self.servers.remove(peer) {
            s.stop(None);
        }
        if let Some(p) = self.pushes.remove(peer) {
            p.store(true, Ordering::Relaxed);
        }
        self.tree.detach(peer);
        if let Some(v) = &mut self.view {
            if v.owner == *peer {
                let name = v.name.clone();
                v.close();
                self.view = None;
                out.push(Out::Ended(format!("The owner of \"{name}\" left")));
            } else if v.source == *peer {
                v.use_owner("the viewer passing it on left", now_ms(), &mut out);
            }
        }
        out
    }

    /// A video-sharing message from a peer.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn message(&mut self, from: &PeerId, m: StreamMessage, links: &dyn Links) -> Vec<Out> {
        let mut out = Vec::new();
        let who = links.name(from).unwrap_or_else(|| "peer".to_owned());
        match m {
            StreamMessage::Request {
                requester,
                supports_range,
                can_relay,
                swarm,
                ..
            } => {
                let Some(own) = &self.own else { return out };
                let Some(channel) = links.bulk(from) else {
                    return out;
                };
                let requester = requester.unwrap_or(who);
                if let Some(s) = self.servers.remove(from) {
                    s.stop(None);
                }
                let me = links.me();
                if supports_range {
                    let header = |via: Option<PeerId>, swarm: bool| StreamMessage::Header {
                        mode: Some("range".to_owned()),
                        stream_no: own.stream_no,
                        stream_id: None,
                        file_name: own.name.clone(),
                        #[allow(clippy::cast_precision_loss)]
                        file_size: own.size as f64,
                        mime_type: mime_for(&own.name).to_owned(),
                        block_size: Some(RANGE_BLOCK_SIZE),
                        chunk_size: None,
                        total_chunks: None,
                        target_peer_id: None,
                        via: via.map(|p| p.as_str().to_owned()),
                        swarm: swarm.then_some(true),
                        sender: Some(me.clone()),
                    };
                    if swarm {
                        // swarm: served by us, and by the other viewers for what they have
                        self.tree.detach(from);
                        out.push(Out::To(from.clone(), header(None, true)));
                        self.servers.insert(
                            from.clone(),
                            Server::start(
                                channel,
                                Arc::clone(&own.file),
                                own.size,
                                own.stream_no,
                                Some(Arc::clone(&own.hashes)),
                            ),
                        );
                        out.push(Out::Log(format!(
                            "📡 Streaming \"{}\" to {requester} (shared between viewers).",
                            own.name
                        )));
                    } else {
                        let parent = self.tree.add(from, can_relay, &|id| links.bulk(id).is_some());
                        if let Some(p) = parent {
                            let via_name = links.name(&p).unwrap_or_else(|| "another viewer".to_owned());
                            out.push(Out::To(from.clone(), header(Some(p), false)));
                            out.push(Out::Log(format!(
                                "📡 {requester} is streaming \"{}\" through {via_name}.",
                                own.name
                            )));
                        } else {
                            out.push(Out::To(from.clone(), header(None, false)));
                            self.servers.insert(
                                from.clone(),
                                Server::start(
                                    channel,
                                    Arc::clone(&own.file),
                                    own.size,
                                    own.stream_no,
                                    Some(Arc::clone(&own.hashes)),
                                ),
                            );
                            out.push(Out::Log(format!(
                                "📡 Streaming \"{}\" on demand to {requester}.",
                                own.name
                            )));
                        }
                    }
                    out.push(Out::Notice(format!("Streaming video to {requester}...")));
                } else {
                    // the whole file, pushed
                    let total =
                        u32::try_from(own.size.div_ceil(STREAM_CHUNK_SIZE as u64)).unwrap_or(u32::MAX);
                    let id = format!("{:016x}", rand::random::<u64>());
                    let header = StreamMessage::Header {
                        mode: None,
                        stream_no: 0,
                        stream_id: Some(id.clone()),
                        file_name: own.name.clone(),
                        #[allow(clippy::cast_precision_loss)]
                        file_size: own.size as f64,
                        mime_type: mime_for(&own.name).to_owned(),
                        block_size: None,
                        chunk_size: Some(u32::try_from(STREAM_CHUNK_SIZE).unwrap_or(16_384)),
                        total_chunks: Some(total),
                        target_peer_id: Some(from.as_str().to_owned()),
                        via: None,
                        swarm: None,
                        sender: Some(me.clone()),
                    };
                    let complete = StreamMessage::Complete { stream_id: Some(id) };
                    let (Ok(h), Ok(c)) = (header.to_json(&me, now_ms()), complete.to_json(&me, now_ms()))
                    else {
                        return out;
                    };
                    let stop = Arc::new(AtomicBool::new(false));
                    if let Some(old) = self.pushes.insert(from.clone(), Arc::clone(&stop)) {
                        old.store(true, Ordering::Relaxed);
                    }
                    tokio::spawn(push_whole(channel, Arc::clone(&own.file), own.size, h, c, stop));
                    out.push(Out::Log(format!(
                        "📡 Peer \"{requester}\" requested video stream. Slicing and streaming chunks..."
                    )));
                    out.push(Out::Notice(format!("Streaming video to {requester}...")));
                }
            }
            StreamMessage::RangeRequest {
                stream_no,
                blocks,
                urgent,
                swarm,
            } => {
                let total = self
                    .own
                    .as_ref()
                    .map_or(0, |o| block_count(o.size, RANGE_BLOCK_SIZE));
                let ours = self.own.as_ref().is_some_and(|o| o.stream_no == stream_no);
                if !ours {
                    // not ours, and we don't pass streams on
                    if swarm || self.view.as_ref().is_some_and(|v| v.stream_no == stream_no) {
                        out.push(Out::To(
                            from.clone(),
                            StreamMessage::RangeMiss { stream_no, blocks },
                        ));
                    }
                    return out;
                }
                let needs = self
                    .servers
                    .get(from)
                    .is_none_or(|s| s.stream_no != stream_no || s.task.is_finished());
                if needs {
                    // a new channel, or a viewer whose parent dropped out
                    let (Some(own), Some(channel)) = (&self.own, links.bulk(from)) else {
                        return out;
                    };
                    self.tree.mark_direct(from);
                    self.servers.insert(
                        from.clone(),
                        Server::start(
                            channel,
                            Arc::clone(&own.file),
                            own.size,
                            own.stream_no,
                            Some(Arc::clone(&own.hashes)),
                        ),
                    );
                }
                if let Some(s) = self.servers.get(from) {
                    s.request(&blocks, urgent, total);
                }
            }
            StreamMessage::RangeCancel {
                stream_no, blocks, ..
            } => {
                if let Some(s) = self.servers.get(from)
                    && s.stream_no == stream_no
                {
                    s.cancel(&blocks);
                }
            }
            StreamMessage::HashRequest { stream_no, blocks } => {
                let Some(own) = &self.own else { return out };
                if own.stream_no != stream_no {
                    return out;
                }
                let total = block_count(own.size, RANGE_BLOCK_SIZE);
                let blocks: Vec<u32> = blocks.into_iter().take(512).filter(|b| *b < total).collect();
                let known: Vec<(u32, String)> = {
                    let h = lock(&own.hashes);
                    blocks
                        .iter()
                        .filter_map(|b| Some((*b, h.get(b)?.clone())))
                        .collect()
                };
                if !known.is_empty() {
                    out.push(Out::To(
                        from.clone(),
                        StreamMessage::BlockHashes {
                            stream_no,
                            hashes: known,
                        },
                    ));
                }
                let rest: Vec<u32> = {
                    let h = lock(&own.hashes);
                    blocks.into_iter().filter(|b| !h.contains_key(b)).collect()
                };
                for group in rest.chunks(8) {
                    let mut hashes = Vec::new();
                    for b in group {
                        if let Ok(data) = read_block(&own.file, own.size, *b) {
                            let hex = sha256_hex(&data);
                            lock(&own.hashes).insert(*b, hex.clone());
                            hashes.push((*b, hex));
                        }
                    }
                    if !hashes.is_empty() {
                        out.push(Out::To(
                            from.clone(),
                            StreamMessage::BlockHashes { stream_no, hashes },
                        ));
                    }
                }
            }
            StreamMessage::Header {
                mode,
                stream_no,
                file_name,
                file_size,
                block_size,
                via,
                sender,
                ..
            } => {
                // only a stream we asked for
                let Some(wanted) = self.asked.clone() else {
                    return out;
                };
                if mode.as_deref() != Some("range") {
                    out.push(Out::Log(
                        "📡 The owner sent the whole file instead of streaming: not supported here"
                            .to_owned(),
                    ));
                    return out;
                }
                if !file_name.is_empty() && file_name != wanted {
                    tracing::debug!("stream: header for {file_name}, wanted {wanted}");
                }
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let size = if file_size.is_finite() && file_size > 0.0 {
                    file_size as u64
                } else {
                    0
                };
                if size == 0 {
                    return out;
                }
                self.asked = None;
                if let Some(old) = self.view.take() {
                    old.close();
                }
                let block_size = block_size
                    .filter(|b| *b > 0 && *b <= 1024 * 1024)
                    .unwrap_or(RANGE_BLOCK_SIZE);
                let relay = via
                    .and_then(|v| PeerId::new(v).ok())
                    .filter(|v| v != from && links.bulk(v).is_some());
                let owner_name = sender.unwrap_or(who);
                let name = if file_name.is_empty() { wanted } else { file_name };
                out.push(Out::Log(match &relay {
                    Some(r) => format!(
                        "📡 Streaming \"{name}\" from {owner_name}, passed along by {} (plays while it loads).",
                        links.name(r).unwrap_or_else(|| "another viewer".to_owned())
                    ),
                    None => format!("📡 Streaming \"{name}\" from {owner_name} (plays while it loads)."),
                }));
                let reader = StreamReader {
                    shared: Arc::new(Shared {
                        size,
                        block_size,
                        state: Mutex::new(CacheState {
                            blocks: HashMap::new(),
                            cached: 0,
                            closed: false,
                        }),
                        arrived: Condvar::new(),
                        want: {
                            let w = Arc::clone(&self.back);
                            Box::new(move |b| w(Back::Want(stream_no, b)))
                        },
                    }),
                };
                self.view = Some(View {
                    owner: from.clone(),
                    source: relay.unwrap_or_else(|| from.clone()),
                    stream_no,
                    name: name.clone(),
                    size,
                    block_size,
                    total: block_count(size, block_size),
                    reader: reader.clone(),
                    pending: HashMap::new(),
                    partial: HashMap::new(),
                    window: None,
                    reading: 0,
                    received: 0,
                    progress_at: now_ms(),
                    progress_bytes: 0,
                });
                out.push(Out::Ready { name, size, reader });
            }
            StreamMessage::RelayGone { .. } => {
                if let Some(v) = &mut self.view
                    && v.source == *from
                {
                    v.use_owner("relay stopped", now_ms(), &mut out);
                }
            }
            StreamMessage::Cancel { .. } => {
                if let Some(s) = self.servers.remove(from) {
                    s.stop(None);
                }
                if let Some(p) = self.pushes.remove(from) {
                    p.store(true, Ordering::Relaxed);
                }
                self.tree.detach(from);
                if let Some(v) = &self.view
                    && v.owner == *from
                {
                    let name = v.name.clone();
                    v.close();
                    self.view = None;
                    out.push(Out::Ended(format!("{who} stopped sharing \"{name}\"")));
                }
            }
            StreamMessage::RangeMiss { .. }
            | StreamMessage::BlockHashes { .. }
            | StreamMessage::Complete { .. }
            | StreamMessage::SwarmGone { .. }
            | StreamMessage::Have => {}
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PeerId {
        PeerId::new(s).unwrap()
    }

    #[test]
    fn the_owner_feeds_two_then_viewers_relay() {
        let mut t = Tree::default();
        let all = |_: &PeerId| true;
        assert_eq!(t.add(&p("a1"), true, &all), None);
        assert_eq!(t.add(&p("b1"), true, &all), None);
        // the third goes under the shallowest relaying viewer
        assert_eq!(t.add(&p("c1"), true, &all), Some(p("a1")));
        assert_eq!(t.add(&p("d1"), false, &all), Some(p("a1")));
        assert_eq!(t.add(&p("e1"), true, &all), Some(p("b1")));
        // a viewer that can't relay never gets children
        t.detach(&p("a1"));
        assert_eq!(t.0[&p("c1")].parent, None, "a1's children go to the owner");
        assert_eq!(t.0[&p("d1")].parent, None);
    }

    #[test]
    fn never_under_its_own_child() {
        let mut t = Tree::default();
        let all = |_: &PeerId| true;
        t.add(&p("a1"), true, &all);
        t.add(&p("b1"), true, &all);
        t.add(&p("c1"), true, &all); // under a1
        // a1 asks again: the owner is full (b1 and c1? no: c1 is under a1), so not under c1
        let parent = t.add(&p("a1"), true, &all);
        assert_ne!(parent, Some(p("c1")));
        // unreachable viewers aren't picked
        let mut t = Tree::default();
        t.add(&p("a1"), true, &all);
        t.add(&p("b1"), true, &all);
        assert_eq!(
            t.add(&p("c1"), true, &|id: &PeerId| id.as_str() == "b1"),
            Some(p("b1"))
        );
    }

    fn view(size: u64) -> View {
        let reader = StreamReader {
            shared: Arc::new(Shared {
                size,
                block_size: RANGE_BLOCK_SIZE,
                state: Mutex::new(CacheState {
                    blocks: HashMap::new(),
                    cached: 0,
                    closed: false,
                }),
                arrived: Condvar::new(),
                want: Box::new(|_| {}),
            }),
        };
        View {
            owner: p("own1"),
            source: p("own1"),
            stream_no: 7,
            name: "v.mp4".into(),
            size,
            block_size: RANGE_BLOCK_SIZE,
            total: block_count(size, RANGE_BLOCK_SIZE),
            reader,
            pending: HashMap::new(),
            partial: HashMap::new(),
            window: None,
            reading: 0,
            received: 0,
            progress_at: 0.0,
            progress_bytes: 0,
        }
    }

    fn asked(out: &[Out]) -> Vec<(Vec<u32>, bool)> {
        out.iter()
            .filter_map(|o| match o {
                Out::To(_, StreamMessage::RangeRequest { blocks, urgent, .. }) => {
                    Some((blocks.clone(), *urgent))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_player_gets_its_block_first_then_read_ahead() {
        let mut v = view(u64::from(RANGE_BLOCK_SIZE) * 100);
        let mut out = Vec::new();
        v.want(10, 0.0, &mut out);
        let a = asked(&out);
        assert_eq!(a[0], (vec![10], true), "the block the player waits for, urgent");
        assert_eq!(a[1].0, (11..=18).collect::<Vec<_>>(), "2 MB after it");
        assert!(!a[1].1);
        let in_flight = v.pending.len();
        assert_eq!(in_flight, 9 + 7, "plus the background top-up to 16 in flight");
        // asking again soon asks nothing new
        let mut again = Vec::new();
        v.want(10, 100.0, &mut again);
        assert!(asked(&again).is_empty());
    }

    #[test]
    fn a_block_arrives_in_packets_and_the_reader_gets_it() {
        let size = u64::from(RANGE_BLOCK_SIZE) + 100;
        let mut v = view(size);
        let mut out = Vec::new();
        v.want(1, 0.0, &mut out);
        let block: Vec<u8> = (0..100u8).collect();
        v.packet(1, 0, &block, 1.0, &mut out);
        assert!(v.has(1), "the last block is short");
        let mut buf = [0u8; 10];
        let n = v
            .reader
            .read_at(u64::from(RANGE_BLOCK_SIZE) + 5, &mut buf)
            .unwrap();
        assert_eq!((n, buf[0]), (10, 5));
        assert_eq!(v.reader.read_at(size, &mut buf), Ok(0), "the end");
        // a full block, in two packets, either order; repeats are dropped
        let big = vec![7u8; RANGE_BLOCK_SIZE as usize];
        v.packet(0, 16_384, &big[16_384..32_768], 2.0, &mut out);
        v.packet(0, 16_384, &big[16_384..32_768], 2.0, &mut out);
        assert!(!v.has(0));
        for off in (0..RANGE_BLOCK_SIZE as usize)
            .step_by(16_384)
            .filter(|o| *o != 16_384)
        {
            v.packet(
                0,
                u32::try_from(off).unwrap(),
                &big[off..off + 16_384],
                3.0,
                &mut out,
            );
        }
        assert!(v.has(0));
        v.reader.close();
        assert!(v.reader.read_at(0, &mut buf).is_err(), "closed");
    }

    #[test]
    fn a_slow_relay_falls_back_to_the_owner() {
        let mut v = view(u64::from(RANGE_BLOCK_SIZE) * 10);
        v.source = p("relay1");
        let mut out = Vec::new();
        v.want(0, 0.0, &mut out);
        assert!(
            out.iter()
                .all(|o| matches!(o, Out::To(to, _) if to.as_str() == "relay1"))
        );
        let mut later = Vec::new();
        v.tick(RELAY_WAIT_MS + 1.0, &mut later);
        assert_eq!(v.source, p("own1"));
        assert!(later.iter().any(|o| matches!(o, Out::To(to, StreamMessage::RangeRequest { urgent: true, .. }) if to.as_str() == "own1")));
    }

    #[test]
    fn hashes_match_the_web_apps() {
        // crypto.subtle.digest('SHA-256', "abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
