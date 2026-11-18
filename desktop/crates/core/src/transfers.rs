//! Who gets each chat file, and what `p2p-file-control` `accept` and `cancel` do
//! (`docs/PROTOCOL.md`; the web app has the same rules in
//! `client-ts/src/features/chat/transferPeers.ts`).
//!
//! - A file of [`ACCEPT_MIN_BYTES`] or more, and every file of a folder offer, is only offered:
//!   each receiver is *waiting* until they accept it; then the sender sends it to them alone.
//!   Smaller files go to everyone straight away (as before).
//! - A cancel from the peer that announced a file (its sender) cancels it for everyone:
//!   receivers stop and show it as cancelled.
//! - A cancel from a receiver (or declining an offer) only takes that receiver out: the sender
//!   stops sending to them. Once no receiver is left waiting or receiving, the transfer is over:
//!   finished if anyone got it, else stopped (nobody wanted it).
//! - Any other cancel or accept (another receiver's, seen by a receiver) is ignored.
//!
//! No I/O: the engine sends the frames and the QUIC streams.

use std::collections::{HashMap, HashSet};

use rtc_protocol::PeerId;

/// Files at least this big wait for each receiver to accept them (the same size as QUIC's).
pub const ACCEPT_MIN_BYTES: u64 = crate::quic::QUIC_MIN_BYTES;

/// Whether a single file of `size` bytes waits for receivers to accept it.
#[must_use]
pub const fn needs_accept(size: u64) -> bool {
    size >= ACCEPT_MIN_BYTES
}

/// How a transfer of ours ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// Nobody is waiting or receiving any more, and someone got it.
    Finished,
    /// Nobody is waiting or receiving any more, and nobody got it: stop it.
    NobodyGotIt,
}

/// What a `cancel` means here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelOutcome {
    /// Our file: stop sending it to this peer only (others still wait for or get it).
    StopTo(PeerId),
    /// Our file, and that was the last receiver.
    Over(Ended),
    /// Their file, cancelled by its sender: stop receiving, show it cancelled.
    Cancelled,
    /// Not for us to act on.
    Ignore,
}

/// Where one of our files is with each receiver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SendStatus {
    /// Offered, not accepted yet.
    pub waiting: usize,
    /// Being sent to them.
    pub sending: usize,
    /// They have it.
    pub sent: usize,
}

#[derive(Debug, Default)]
struct Out {
    waiting: HashSet<PeerId>,
    sending: HashSet<PeerId>,
    sent: HashSet<PeerId>,
}

impl Out {
    fn drop_peer(&mut self, peer: &PeerId) -> bool {
        self.waiting.remove(peer) | self.sending.remove(peer)
    }

    fn ended(&self) -> Option<Ended> {
        if !self.waiting.is_empty() || !self.sending.is_empty() {
            return None;
        }
        Some(if self.sent.is_empty() {
            Ended::NobodyGotIt
        } else {
            Ended::Finished
        })
    }
}

/// Our files going out and others' coming in, by transfer id.
#[derive(Debug, Default)]
pub struct Transfers {
    outgoing: HashMap<String, Out>,
    /// Theirs (files and folders): who announced each.
    incoming: HashMap<String, PeerId>,
}

impl Transfers {
    /// We announced `transfer_id` to `peers`: they wait to accept it (`offered`), or get it now.
    pub fn sending(&mut self, transfer_id: &str, peers: impl IntoIterator<Item = PeerId>, offered: bool) {
        let peers: HashSet<PeerId> = peers.into_iter().collect();
        let out = if offered {
            Out {
                waiting: peers,
                ..Out::default()
            }
        } else {
            Out {
                sending: peers,
                ..Out::default()
            }
        };
        self.outgoing.insert(transfer_id.to_owned(), out);
    }

    /// `from` announced `transfer_id` (a file or a folder) to us.
    pub fn receiving(&mut self, transfer_id: &str, from: &PeerId) {
        self.incoming.insert(transfer_id.to_owned(), from.clone());
    }

    /// Who announced `transfer_id` to us.
    #[must_use]
    pub fn sender_of(&self, transfer_id: &str) -> Option<&PeerId> {
        self.incoming.get(transfer_id)
    }

    /// It's our file, still offered or being sent.
    #[must_use]
    pub fn is_ours(&self, transfer_id: &str) -> bool {
        self.outgoing.contains_key(transfer_id)
    }

    /// It's someone else's file (or folder), still coming in or offered.
    #[must_use]
    pub fn is_theirs(&self, transfer_id: &str) -> bool {
        self.incoming.contains_key(transfer_id)
    }

    /// Where our `transfer_id` is with its receivers.
    #[must_use]
    pub fn status(&self, transfer_id: &str) -> Option<SendStatus> {
        self.outgoing.get(transfer_id).map(|o| SendStatus {
            waiting: o.waiting.len(),
            sending: o.sending.len(),
            sent: o.sent.len(),
        })
    }

    /// `from` accepted our `transfer_id`: true when it should now be sent to them (they were
    /// waiting for it).
    pub fn on_accept(&mut self, transfer_id: &str, from: &PeerId) -> bool {
        let Some(out) = self.outgoing.get_mut(transfer_id) else {
            return false;
        };
        if !out.waiting.remove(from) {
            return false;
        }
        out.sending.insert(from.clone());
        true
    }

    /// A `cancel` for `transfer_id` came from `from` (or they declined it).
    pub fn on_cancel(&mut self, transfer_id: &str, from: &PeerId) -> CancelOutcome {
        if let Some(out) = self.outgoing.get_mut(transfer_id) {
            if !out.drop_peer(from) {
                return CancelOutcome::Ignore;
            }
            return match out.ended() {
                Some(end) => {
                    self.finish(transfer_id);
                    CancelOutcome::Over(end)
                }
                None => CancelOutcome::StopTo(from.clone()),
            };
        }
        if self.incoming.get(transfer_id) == Some(from) {
            self.finish(transfer_id);
            return CancelOutcome::Cancelled;
        }
        CancelOutcome::Ignore
    }

    /// `peer` has all of our `transfer_id`. `Some` when that was the last receiver (forgotten).
    pub fn delivered(&mut self, transfer_id: &str, peer: &PeerId) -> Option<Ended> {
        let out = self.outgoing.get_mut(transfer_id)?;
        if !out.sending.remove(peer) {
            return None;
        }
        out.sent.insert(peer.clone());
        let end = out.ended()?;
        self.finish(transfer_id);
        Some(end)
    }

    /// `peer` left: it no longer waits for or gets anything of ours. Returns our files that are
    /// over now (forgotten), in transfer id order.
    pub fn peer_gone(&mut self, peer: &PeerId) -> Vec<(String, Ended)> {
        let mut over: Vec<(String, Ended)> = self
            .outgoing
            .iter_mut()
            .filter_map(|(tid, out)| {
                if !out.drop_peer(peer) {
                    return None;
                }
                out.ended().map(|end| (tid.clone(), end))
            })
            .collect();
        over.sort_by(|a, b| a.0.cmp(&b.0));
        for (tid, _) in &over {
            self.outgoing.remove(tid);
        }
        over
    }

    /// Sent, received, or cancelled here: forget it.
    pub fn finish(&mut self, transfer_id: &str) {
        self.outgoing.remove(transfer_id);
        self.incoming.remove(transfer_id);
    }

    /// Left the room: forget everything.
    pub fn reset(&mut self) {
        self.outgoing.clear();
        self.incoming.clear();
    }
}
