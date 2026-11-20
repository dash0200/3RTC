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

    /// What is wrong with the voice on this connection since `before` (an earlier report), in
    /// words for the log file; empty when it's fine. Thresholds where people notice: a round trip
    /// over [`SLOW_RTT_MS`], more than [`BREAKING_UP_SHARE`] of their voice filled in, their voice
    /// waiting over [`LATE_VOICE_MS`].
    #[must_use]
    pub fn trouble(&self, before: &Self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(rtt) = self.rtt_ms.filter(|r| *r > SLOW_RTT_MS) {
            out.push(format!("slow network (round trip {rtt:.0} ms)"));
        }
        #[allow(clippy::cast_precision_loss)]
        let played = self.samples_received.saturating_sub(before.samples_received) as f64;
        #[allow(clippy::cast_precision_loss)]
        let filled = self.concealed.saturating_sub(before.concealed) as f64;
        if played > 0.0 && filled > BREAKING_UP_SHARE * played {
            out.push(format!(
                "their voice is breaking up ({:.0}% filled in: packets lost or late)",
                100.0 * filled / played
            ));
        }
        if let Some(wait) = self.jitter_buffer_ms_since(before).filter(|w| *w > LATE_VOICE_MS) {
            out.push(format!(
                "their voice arrives late (waits {wait:.0} ms to smooth out the network)"
            ));
        }
        out
    }
}

/// A round trip slower than this (ms) makes talking awkward.
pub const SLOW_RTT_MS: f64 = 400.0;
/// More of someone's voice than this made up to cover gaps sounds choppy.
pub const BREAKING_UP_SHARE: f64 = 0.05;
/// Their voice held back longer than this (ms) to smooth out the network is a noticeable delay.
pub const LATE_VOICE_MS: f64 = 250.0;

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

/// What the connection details show for one connection (`extractPeerConnectionStats`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Net {
    /// Round trip on the chosen path (ms).
    pub rtt_ms: Option<f64>,
    /// Our candidate's type (`host`, `srflx`, `prflx`, `relay`).
    pub local_type: String,
    /// Theirs.
    pub remote_type: String,
    /// `UDP` or `TCP`.
    pub protocol: String,
    /// Audio packets received and lost (for the loss percentage).
    pub packets_received: u64,
    /// Audio packets lost.
    pub packets_lost: u64,
    /// Audio jitter (ms).
    pub jitter_ms: f64,
    /// Bytes on the chosen path so far.
    pub bytes_received: u64,
    /// Bytes sent on it so far.
    pub bytes_sent: u64,
}

impl Net {
    /// Lost audio packets in percent, one decimal (`packetLossPercent`).
    #[must_use]
    pub fn loss_percent(&self) -> f64 {
        let total = self.packets_received + self.packets_lost;
        if total == 0 {
            return 0.0;
        }
        #[allow(clippy::cast_precision_loss)]
        let p = self.packets_lost as f64 / total as f64 * 100.0;
        (p * 10.0).round() / 10.0
    }

    /// "Direct LAN (Host)", "Direct P2P (STUN)", "Relay (TURN)" (`parseCandidateConnectionType`).
    #[must_use]
    pub fn connection_type(&self) -> &'static str {
        let (l, r) = (self.local_type.as_str(), self.remote_type.as_str());
        if l == "relay" || r == "relay" {
            "Relay (TURN)"
        } else if l == "host" && r == "host" {
            "Direct LAN (Host)"
        } else if ["srflx", "prflx"].contains(&l) || ["srflx", "prflx"].contains(&r) {
            "Direct P2P (STUN)"
        } else {
            "Direct P2P"
        }
    }
}

/// Picks the connection details out of a stats report.
#[must_use]
pub fn net(report: &[RtcStats]) -> Net {
    let mut out = Net::default();
    let mut selected = None;
    let mut pairs = HashMap::new();
    let mut candidates = HashMap::new();
    let (mut transport_sent, mut transport_received) = (0, 0);
    for s in report {
        match s {
            RtcStats::Transport(t) => {
                if !t.transport.selected_candidate_pair_id.is_empty() {
                    selected = Some(t.transport.selected_candidate_pair_id.as_str());
                }
                transport_sent = transport_sent.max(t.transport.bytes_sent);
                transport_received = transport_received.max(t.transport.bytes_received);
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
            RtcStats::InboundRtp(r) if r.stream.kind == "audio" => {
                out.packets_received += r.received.packets_received;
                out.packets_lost += u64::try_from(r.received.packets_lost.max(0)).unwrap_or(0);
                out.jitter_ms = r.received.jitter * 1000.0;
            }
            _ => {}
        }
    }
    out.bytes_sent = transport_sent;
    out.bytes_received = transport_received;
    let pair = selected
        .and_then(|id| pairs.get(id))
        .or_else(|| pairs.values().find(|p| p.nominated));
    if let Some(p) = pair {
        if p.current_round_trip_time > 0.0 {
            out.rtt_ms = Some(p.current_round_trip_time * 1000.0);
        } else if out.rtt_ms.is_none() && p.responses_received > 0 {
            // on one machine (or a LAN) the round trip rounds to nothing
            out.rtt_ms = Some(0.0);
        }
        out.bytes_sent = out.bytes_sent.max(p.bytes_sent);
        out.bytes_received = out.bytes_received.max(p.bytes_received);
        if let Some(l) = candidates.get(p.local_candidate_id.as_str()) {
            out.local_type = kind(l.candidate_type).to_owned();
            out.protocol = l.protocol.to_uppercase();
        }
        if let Some(r) = candidates.get(p.remote_candidate_id.as_str()) {
            out.remote_type = kind(r.candidate_type).to_owned();
        }
    }
    if out.protocol.is_empty() {
        "UDP".clone_into(&mut out.protocol);
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
    fn trouble_only_when_people_would_notice() {
        let before = Flow {
            samples_received: 48_000,
            concealed: 100,
            jitter_buffer_secs: 48_000.0 * 0.06,
            jitter_buffer_samples: 48_000,
            ..Flow::default()
        };
        let fine = Flow {
            samples_received: 96_000,
            concealed: 600,
            jitter_buffer_secs: 96_000.0 * 0.06,
            jitter_buffer_samples: 96_000,
            rtt_ms: Some(80.0),
            ..Flow::default()
        };
        assert!(fine.trouble(&before).is_empty());
        let bad = Flow {
            samples_received: 96_000,
            concealed: 100 + 9_600,
            jitter_buffer_secs: 48_000.0 * 0.06 + 48_000.0 * 0.4,
            jitter_buffer_samples: 96_000,
            rtt_ms: Some(650.0),
            ..Flow::default()
        };
        let t = bad.trouble(&before);
        assert_eq!(t.len(), 3, "{t:?}");
        assert!(t[0].contains("650 ms"));
        assert!(t[1].contains("20%"));
        assert!(t[2].contains("400 ms"));
        // nothing played (they're muted): no verdict on breaking up
        assert!(before.trouble(&before).is_empty());
    }

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
