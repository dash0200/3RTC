//! Audio levels from libwebrtc's stats: how loud our mic is and how loud each person sounds.
//! Works the same whether the mic is the real device or a test tone.

use libwebrtc::stats::RtcStats;

/// Levels found in one stats report (0..1, as `RTCAudioSourceStats.audioLevel`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Levels {
    /// Our microphone, as sent.
    pub local: Option<f64>,
    /// The other person's voice, as received.
    pub remote: Option<f64>,
}

/// Picks the audio levels out of a stats report.
#[must_use]
pub fn levels(report: &[RtcStats]) -> Levels {
    let mut out = Levels::default();
    for s in report {
        match s {
            RtcStats::MediaSource(m) if m.source.kind == "audio" => {
                out.local = Some(out.local.unwrap_or(0.0).max(m.audio.audio_level));
            }
            RtcStats::InboundRtp(r) if r.stream.kind == "audio" => {
                out.remote = Some(out.remote.unwrap_or(0.0).max(r.inbound.audio_level));
            }
            _ => {}
        }
    }
    out
}

/// Level above which someone counts as talking. Chrome's `audioLevel` sits near 0.001–0.01 for
/// room noise and 0.05–0.3 for speech; the web app's analyser threshold lands about here.
pub const SPEAKING_LEVEL: f64 = 0.03;
/// How long a voice stays "speaking" after it drops below the level (no flicker between words).
pub const SPEAKING_HOLD_MS: f64 = 400.0;

/// Speaking detection with a hold, fed one level at a time.
#[derive(Debug, Clone, Copy, Default)]
pub struct Speaking {
    last_loud: Option<f64>,
    on: bool,
}

impl Speaking {
    /// A new level at `now_ms`; returns `Some(new state)` when it changes.
    pub fn feed(&mut self, level: f64, now_ms: f64) -> Option<bool> {
        if level >= SPEAKING_LEVEL {
            self.last_loud = Some(now_ms);
        }
        let on = self.last_loud.is_some_and(|t| now_ms - t <= SPEAKING_HOLD_MS);
        (on != self.on).then(|| {
            self.on = on;
            on
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaking_holds_between_words() {
        let mut s = Speaking::default();
        assert_eq!(s.feed(0.2, 0.0), Some(true));
        assert_eq!(s.feed(0.001, 150.0), None);
        assert_eq!(s.feed(0.001, 300.0), None);
        assert_eq!(s.feed(0.001, 450.0), Some(false));
        assert_eq!(s.feed(0.01, 600.0), None, "room noise isn't speech");
    }
}
