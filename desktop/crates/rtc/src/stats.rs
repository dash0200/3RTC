//! Audio levels from libwebrtc's stats: how loud our mic is and how loud each person sounds.
//! Works the same whether the mic is the real device or a test tone.

use std::collections::HashMap;

use libwebrtc::stats::{IceCandidateType, RtcStats};

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

/// How much voice went each way on one connection, from one stats report (totals so far).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Flow {
    /// Audio bytes we sent.
    pub sent_bytes: u64,
    /// Audio packets we sent.
    pub sent_packets: u64,
    /// Seconds of audio our microphone has captured (0 means the mic isn't delivering).
    pub captured_secs: f64,
    /// Our microphone's level now (0..1).
    pub mic_level: f64,
    /// Audio bytes we received.
    pub received_bytes: u64,
    /// Audio packets we received.
    pub received_packets: u64,
    /// Samples of their voice decoded (0 means nothing is pulling it out to the speakers).
    pub samples_received: u64,
    /// Of those, samples made up to cover gaps.
    pub concealed: u64,
    /// Their voice's level now (0..1).
    pub their_level: f64,
    /// Total seconds their voice has waited in our jitter buffer (summed over samples).
    pub jitter_buffer_secs: f64,
    /// Samples that came out of the jitter buffer (divides the above).
    pub jitter_buffer_samples: u64,
    /// Network round trip on the connection in use (ms).
    pub rtt_ms: Option<f64>,
    /// How the connection runs: "direct (host → host, udp)", "relayed via TURN (udp)"...
    pub path: Option<String>,
}

impl Flow {
    /// Average time their voice waited in our jitter buffer since `before` (ms).
    #[must_use]
    pub fn jitter_buffer_ms_since(&self, before: &Self) -> Option<f64> {
        let samples = self
            .jitter_buffer_samples
            .checked_sub(before.jitter_buffer_samples)?;
        #[allow(clippy::cast_precision_loss)]
        (samples > 0).then(|| 1000.0 * (self.jitter_buffer_secs - before.jitter_buffer_secs) / samples as f64)
    }
}

fn kind(t: Option<IceCandidateType>) -> &'static str {
    match t {
        Some(IceCandidateType::Host) => "host",
        Some(IceCandidateType::Srflx) => "srflx",
        Some(IceCandidateType::Prflx) => "prflx",
        Some(IceCandidateType::Relay) => "relay",
        None => "?",
    }
}

/// Picks the audio totals out of a stats report.
#[must_use]
pub fn flow(report: &[RtcStats]) -> Flow {
    let mut out = Flow::default();
    let mut selected = None;
    let mut pairs = HashMap::new();
    let mut candidates = HashMap::new();
    for s in report {
        match s {
            RtcStats::Transport(t) if !t.transport.selected_candidate_pair_id.is_empty() => {
                selected = Some(t.transport.selected_candidate_pair_id.as_str());
            }
            RtcStats::CandidatePair(p) => {
                pairs.insert(p.rtc.id.as_str(), &p.candidate_pair);
            }
            RtcStats::LocalCandidate(c) => {
                candidates.insert(c.rtc.id.as_str(), &c.local_candidate);
            }
            RtcStats::RemoteCandidate(c) => {
                candidates.insert(c.rtc.id.as_str(), &c.remote_candidate);
            }
            RtcStats::RemoteInboundRtp(r)
                if r.stream.kind == "audio" && r.remote_inbound.round_trip_time > 0.0 =>
            {
                out.rtt_ms
                    .get_or_insert(r.remote_inbound.round_trip_time * 1000.0);
            }
            _ => {}
        }
    }
    let pair = selected
        .and_then(|id| pairs.get(id))
        .or_else(|| pairs.values().find(|p| p.nominated));
    if let Some(p) = pair {
        if p.current_round_trip_time > 0.0 {
            out.rtt_ms = Some(p.current_round_trip_time * 1000.0);
        }
        if let (Some(l), Some(r)) = (
            candidates.get(p.local_candidate_id.as_str()),
            candidates.get(p.remote_candidate_id.as_str()),
        ) {
            let (lk, rk) = (kind(l.candidate_type), kind(r.candidate_type));
            out.path = Some(if lk == "relay" || rk == "relay" {
                format!("relayed via TURN ({lk} → {rk}, {})", l.protocol)
            } else {
                format!("direct ({lk} → {rk}, {})", l.protocol)
            });
        }
    }
    for s in report {
        match s {
            RtcStats::OutboundRtp(o) if o.stream.kind == "audio" => {
                out.sent_bytes += o.sent.bytes_sent;
                out.sent_packets += o.sent.packets_sent;
            }
            RtcStats::MediaSource(m) if m.source.kind == "audio" => {
                out.captured_secs = out.captured_secs.max(m.audio.total_samples_duration);
                out.mic_level = out.mic_level.max(m.audio.audio_level);
            }
            RtcStats::InboundRtp(r) if r.stream.kind == "audio" => {
                out.received_bytes += r.inbound.bytes_received;
                out.received_packets += r.received.packets_received;
                out.samples_received += r.inbound.total_samples_received;
                out.concealed += r.inbound.concealed_samples;
                out.their_level = out.their_level.max(r.inbound.audio_level);
                out.jitter_buffer_secs += r.inbound.jitter_buffer_delay;
                out.jitter_buffer_samples += r.inbound.jitter_buffer_emitted_count;
            }
            _ => {}
        }
    }
    out
}

impl std::fmt::Display for Flow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        #[allow(clippy::cast_precision_loss)]
        let concealed = if self.samples_received == 0 {
            0.0
        } else {
            100.0 * self.concealed as f64 / self.samples_received as f64
        };
        write!(
            f,
            "sent {} packets / {} kB (mic captured {:.0} s, level {:.3}); received {} packets / {} kB \
             ({} samples played, {concealed:.0}% concealed, level {:.3})",
            self.sent_packets,
            self.sent_bytes / 1000,
            self.captured_secs,
            self.mic_level,
            self.received_packets,
            self.received_bytes / 1000,
            self.samples_received,
            self.their_level,
        )
    }
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
