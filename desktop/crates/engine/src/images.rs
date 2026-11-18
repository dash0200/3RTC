//! Chat pictures arriving on the bulk channels (`P2PImageReceiver` in
//! `client-ts/src/utils/p2pImageShare.ts`): frames are put back together per transfer, with the
//! web app's limits; a transfer with no frame for two minutes is dropped.

use std::collections::HashMap;

use rtc_protocol::image::{self, CHUNK, MAX_CHUNKS};

/// A transfer with no frame for this long is dropped (ms).
pub(crate) const STALE_MS: f64 = 120_000.0;

/// What a frame did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Got {
    /// More of a picture: now this many percent.
    Progress { transfer_id: String, percent: u8 },
    /// The last frame: here's the whole picture.
    Done { transfer_id: String, bytes: Vec<u8> },
}

struct Incoming {
    chunks: Vec<Option<Vec<u8>>>,
    received: usize,
    bytes: usize,
    started: f64,
    percent: u8,
}

/// Pictures on their way in.
#[derive(Default)]
pub(crate) struct Receiver {
    transfers: HashMap<String, Incoming>,
}

impl Receiver {
    /// A `p2p-image-start` arrived: expect `total` frames for `transfer_id`.
    pub(crate) fn start(&mut self, transfer_id: &str, total: f64, now: f64) {
        if transfer_id.trim().is_empty() || transfer_id.len() > 64 {
            return;
        }
        if total.fract() != 0.0 || !(1.0..=f64::from(MAX_CHUNKS)).contains(&total) {
            return;
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let total = total as usize;
        self.transfers.insert(
            transfer_id.to_owned(),
            Incoming {
                chunks: vec![None; total],
                received: 0,
                bytes: 0,
                started: now,
                percent: 0,
            },
        );
    }

    /// A binary message on a bulk channel at `now` (anything that isn't a picture frame is
    /// ignored).
    pub(crate) fn frame(&mut self, bytes: &[u8], now: f64) -> Option<Got> {
        let f = image::parse(bytes)?;
        let t = self.transfers.get_mut(&f.transfer_id)?;
        // still coming: not stale (a big file takes longer than two minutes)
        t.started = now;
        let slot = t.chunks.get_mut(usize::try_from(f.index).ok()?)?;
        if slot.is_some() {
            return None;
        }
        *slot = Some(f.data.to_vec());
        t.received += 1;
        t.bytes += f.data.len();
        if t.bytes > usize::try_from(MAX_CHUNKS).unwrap_or(usize::MAX) * CHUNK {
            self.transfers.remove(&f.transfer_id);
            return None;
        }
        if t.received >= t.chunks.len() {
            let t = self.transfers.remove(&f.transfer_id)?;
            let bytes = t.chunks.into_iter().flatten().flatten().collect();
            return Some(Got::Done {
                transfer_id: f.transfer_id,
                bytes,
            });
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let percent = ((t.received as f64 / t.chunks.len() as f64) * 100.0)
            .round()
            .min(100.0) as u8;
        if percent == t.percent {
            return None;
        }
        t.percent = percent;
        Some(Got::Progress {
            transfer_id: f.transfer_id,
            percent,
        })
    }

    /// A transfer was cancelled: drop what came of it (later frames are ignored).
    pub(crate) fn abort(&mut self, transfer_id: &str) {
        self.transfers.remove(transfer_id);
    }

    /// Drops transfers with no frame for [`STALE_MS`].
    pub(crate) fn clean(&mut self, now: f64) {
        self.transfers.retain(|_, t| now - t.started < STALE_MS);
    }

    /// Left the room: forget everything.
    pub(crate) fn reset(&mut self) {
        self.transfers.clear();
    }
}

#[cfg(test)]
mod tests {
    use rtc_protocol::image::pack;

    use super::{Got, Receiver, STALE_MS};

    #[test]
    fn frames_in_any_order_make_the_picture() {
        let mut r = Receiver::default();
        r.start("t", 3.0, 0.0);
        assert!(
            r.frame(&pack("other", 0, 3, b"x"), 0.0).is_none(),
            "an unknown transfer"
        );
        assert_eq!(
            r.frame(&pack("t", 2, 3, b"cc"), 0.0),
            Some(Got::Progress {
                transfer_id: "t".into(),
                percent: 33
            })
        );
        assert!(r.frame(&pack("t", 2, 3, b"cc"), 0.0).is_none(), "a repeat");
        assert!(r.frame(&pack("t", 9, 3, b"zz"), 0.0).is_none(), "out of range");
        r.frame(&pack("t", 0, 3, b"aa"), 0.0);
        assert_eq!(
            r.frame(&pack("t", 1, 3, b"bb"), 0.0),
            Some(Got::Done {
                transfer_id: "t".into(),
                bytes: b"aabbcc".to_vec()
            })
        );
    }

    #[test]
    fn a_cancelled_transfer_ignores_the_rest_of_its_frames() {
        let mut r = Receiver::default();
        r.start("t", 3.0, 0.0);
        assert!(r.frame(&pack("t", 0, 3, b"aa"), 0.0).is_some());
        r.abort("t");
        assert!(r.frame(&pack("t", 1, 3, b"bb"), 0.0).is_none());
        assert!(r.frame(&pack("t", 2, 3, b"cc"), 0.0).is_none(), "never completes");
        assert!(r.transfers.is_empty());
    }

    #[test]
    fn a_long_transfer_is_not_stale_while_frames_come() {
        let mut r = Receiver::default();
        r.start("t", 3.0, 0.0);
        r.frame(&pack("t", 0, 3, b"aa"), STALE_MS - 1.0);
        r.clean(STALE_MS + 10.0);
        assert_eq!(r.transfers.len(), 1, "a frame came a moment ago");
        r.clean(2.0 * STALE_MS);
        assert!(r.transfers.is_empty(), "nothing for two minutes");
    }

    #[test]
    fn bad_starts_and_stale_transfers() {
        let mut r = Receiver::default();
        r.start("t", 0.0, 0.0);
        r.start("u", 2.5, 0.0);
        r.start(&"x".repeat(65), 2.0, 0.0);
        r.start("v", 2.0, 0.0);
        assert_eq!(r.transfers.len(), 1);
        r.clean(STALE_MS + 1.0);
        assert!(r.transfers.is_empty());
    }
}
