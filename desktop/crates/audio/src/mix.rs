//! Everyone's voice, mixed: one small queue per person (filled by the network side, emptied by
//! the mixer at the speakers' pace), each with its own volume, then the limiter.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use crate::dsp::{FRAME, Limiter, peak, to_f32};

/// Samples a person's queue can hold (200 ms); more is dropped.
pub(crate) const QUEUE: usize = FRAME * 20;
/// Wait for this much before starting to play someone (20 ms), so the first frames don't stutter.
const PREBUFFER: usize = FRAME * 2;
/// More than this queued (60 ms) means the network side runs ahead of the speakers: skip a frame.
const TOO_MUCH: usize = FRAME * 6;

/// A person's volume and level, shared between the mixer and the app.
#[derive(Debug)]
pub struct PeerControl {
    /// Volume (1.0 = as sent; 0 = muted for me), as `f32` bits.
    gain: AtomicU32,
    /// Their voice's peak in the last frame, 0..1, as `f32` bits.
    level: AtomicU32,
}

impl PeerControl {
    pub(crate) fn new() -> Self {
        Self {
            gain: AtomicU32::new(1.0f32.to_bits()),
            level: AtomicU32::new(0),
        }
    }

    /// Sets the volume (0 mutes them for you; 2 is twice as loud).
    pub fn set_gain(&self, gain: f32) {
        self.gain.store(gain.clamp(0.0, 4.0).to_bits(), Ordering::Relaxed);
    }

    /// The volume.
    #[must_use]
    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain.load(Ordering::Relaxed))
    }

    /// How loud they are now (before their volume), 0..1.
    #[must_use]
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
}

/// The network side of a person's queue: decoded 48 kHz mono samples go in here.
pub struct PeerFeed {
    tx: rtrb::Producer<i16>,
}

impl std::fmt::Debug for PeerFeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerFeed").finish_non_exhaustive()
    }
}

impl PeerFeed {
    /// Queues samples; what doesn't fit is dropped (the speakers are far behind).
    pub fn push(&mut self, samples: &[i16]) {
        let _ = self.tx.push_partial_slice(samples);
    }
}

/// The mixer's side of a person's queue.
pub(crate) struct PeerIn {
    pub(crate) key: u64,
    rx: rtrb::Consumer<i16>,
    pub(crate) control: Arc<PeerControl>,
    playing: bool,
}

/// A new person: their feed (for the network side) and their queue (for the mixer).
pub(crate) fn peer(key: u64) -> (PeerFeed, PeerIn) {
    let (tx, rx) = rtrb::RingBuffer::new(QUEUE);
    (
        PeerFeed { tx },
        PeerIn {
            key,
            rx,
            control: Arc::new(PeerControl::new()),
            playing: false,
        },
    )
}

impl PeerIn {
    /// Adds this person's next frame into `mix`.
    fn add_to(&mut self, mix: &mut [f32; FRAME], scratch: &mut [f32; FRAME]) {
        let queued = self.rx.slots();
        if !self.playing {
            if queued < PREBUFFER {
                self.control.level.store(0, Ordering::Relaxed);
                return;
            }
            self.playing = true;
        }
        if queued < FRAME {
            // ran dry: wait for a fresh prebuffer instead of stuttering
            self.playing = false;
            self.control.level.store(0, Ordering::Relaxed);
            return;
        }
        if queued > TOO_MUCH
            && let Ok(skip) = self.rx.read_chunk(FRAME)
        {
            skip.commit_all();
        }
        let Ok(chunk) = self.rx.read_chunk(FRAME) else {
            return;
        };
        let (a, b) = chunk.as_slices();
        for (slot, s) in scratch.iter_mut().zip(a.iter().chain(b)) {
            *slot = to_f32(*s);
        }
        chunk.commit_all();
        self.control
            .level
            .store(peak(scratch).to_bits(), Ordering::Relaxed);
        let gain = self.control.gain();
        for (m, s) in mix.iter_mut().zip(scratch.iter()) {
            *m += s * gain;
        }
    }
}

/// A sound of our own being played: the samples, how far in, its volume, whether a new
/// "replacing" sound stops it.
struct Extra {
    sound: Arc<[f32]>,
    at: usize,
    gain: f32,
    replace: bool,
}

/// Most sounds of our own at once (more: the oldest stops).
const MAX_EXTRAS: usize = 8;

/// Everyone mixed into one frame for the speakers.
pub(crate) struct Mixer {
    pub(crate) peers: Vec<PeerIn>,
    limiter: Limiter,
    scratch: [f32; FRAME],
    /// Sounds of our own (test sound, soundboard, reaction pops).
    extras: Vec<Extra>,
}

impl Mixer {
    pub(crate) fn new() -> Self {
        Self {
            peers: Vec::new(),
            limiter: Limiter::default(),
            scratch: [0.0; FRAME],
            extras: Vec::with_capacity(MAX_EXTRAS),
        }
    }

    /// Plays `sound` (48 kHz mono) once at `gain`, mixed in; `replace` stops the last such one.
    pub(crate) fn play(&mut self, sound: Arc<[f32]>, gain: f32, replace: bool) {
        if replace {
            self.extras.retain(|e| !e.replace);
        }
        if self.extras.len() >= MAX_EXTRAS {
            self.extras.remove(0);
        }
        self.extras.push(Extra {
            sound,
            at: 0,
            gain: gain.clamp(0.0, 2.0),
            replace,
        });
    }

    /// The next 10 ms for the speakers (silence when `deafened`, except our own sounds).
    pub(crate) fn next(&mut self, deafened: bool, out: &mut [f32; FRAME]) {
        out.fill(0.0);
        for p in &mut self.peers {
            // keep emptying the queues while deafened so nothing piles up
            if deafened {
                let mut sink = [0.0f32; FRAME];
                p.add_to(&mut sink, &mut self.scratch);
            } else {
                p.add_to(out, &mut self.scratch);
            }
        }
        for e in &mut self.extras {
            let end = (e.at + FRAME).min(e.sound.len());
            for (o, s) in out.iter_mut().zip(&e.sound[e.at..end]) {
                *o += *s * e.gain;
            }
            e.at = end;
        }
        self.extras.retain(|e| e.at < e.sound.len());
        self.limiter.process(out);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{FRAME, Mixer, peer};

    fn frames(n: usize, v: i16) -> Vec<i16> {
        vec![v; FRAME * n]
    }

    #[test]
    fn mixes_people_with_their_own_volume() {
        let mut m = Mixer::new();
        let (mut fa, a) = peer(1);
        let (mut fb, b) = peer(2);
        let (ca, cb) = (Arc::clone(&a.control), Arc::clone(&b.control));
        m.peers.push(a);
        m.peers.push(b);
        fa.push(&frames(3, 8192)); // 0.25
        fb.push(&frames(3, 8192));
        cb.set_gain(0.0); // B muted for me
        let mut out = [0.0f32; FRAME];
        m.next(false, &mut out);
        assert!((out[0] - 0.25).abs() < 0.01, "only A: {}", out[0]);
        assert!(
            (ca.level() - 0.25).abs() < 0.01 && (cb.level() - 0.25).abs() < 0.01,
            "levels before volume"
        );
        cb.set_gain(2.0);
        m.next(false, &mut out);
        assert!((out[0] - 0.75).abs() < 0.01, "A + 2×B: {}", out[0]);
    }

    #[test]
    fn waits_for_a_prebuffer_and_skips_when_far_behind() {
        let mut m = Mixer::new();
        let (mut f, p) = peer(1);
        m.peers.push(p);
        let mut out = [0.0f32; FRAME];
        f.push(&frames(1, 8192));
        m.next(false, &mut out);
        assert!(out[0].abs() < 1e-6, "10 ms isn't enough to start");
        f.push(&frames(10, 8192)); // 110 ms queued
        m.next(false, &mut out);
        assert!(out[0] > 0.2);
        assert_eq!(m.peers[0].rx.slots(), FRAME * 9, "one frame skipped, one played");
    }

    #[test]
    fn deafened_plays_nothing_but_keeps_up() {
        let mut m = Mixer::new();
        let (mut f, p) = peer(1);
        m.peers.push(p);
        f.push(&frames(4, 8192));
        let mut out = [0.0f32; FRAME];
        m.next(true, &mut out);
        assert!(out[0].abs() < 1e-6);
        assert_eq!(m.peers[0].rx.slots(), FRAME * 3);
        m.play(Arc::from(vec![0.5f32; FRAME + 10]), 1.0, false);
        m.next(true, &mut out);
        assert!((out[0] - 0.5).abs() < 0.01, "our own sounds still play");
    }

    #[test]
    fn our_sounds_overlap_and_a_new_clip_replaces_the_last() {
        let mut m = Mixer::new();
        let mut out = [0.0f32; FRAME];
        m.play(Arc::from(vec![0.1f32; FRAME * 4]), 1.0, false); // a reaction pop
        m.play(Arc::from(vec![0.2f32; FRAME * 4]), 0.5, true); // a clip, at half volume
        m.next(false, &mut out);
        assert!((out[0] - 0.2).abs() < 0.01, "both: {}", out[0]);
        m.play(Arc::from(vec![0.3f32; FRAME * 4]), 1.0, true); // another clip stops the first
        m.next(false, &mut out);
        assert!((out[0] - 0.4).abs() < 0.01, "pop + new clip: {}", out[0]);
    }
}
