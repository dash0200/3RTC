//! Why a peer connection never came up, worked out from what both sides offered (their ICE
//! candidates, exchanged over signaling) and what libwebrtc tried (candidate-pair stats).
//! Same rules and wording as the web app's `client-ts/src/webrtc/iceDiagnosis.ts`.
//!
//! What the candidates tell us about a network:
//! - no `srflx` candidate: the STUN check got no answer, UDP is blocked there;
//! - one public port per local socket: a normal NAT, direct connections usually work;
//! - several public ports for one socket (one per STUN server): a strict ("symmetric") NAT. Two
//!   of these can't connect directly; a TURN relay is needed. A strong hint, not proof (two
//!   network adapters behind one router look the same).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

/// One parsed ICE candidate line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// `udp` or `tcp`.
    pub protocol: String,
    /// IP address or mDNS name.
    pub address: String,
    /// Port.
    pub port: u16,
    /// `host`, `srflx`, `prflx` or `relay`.
    pub kind: String,
    /// The local socket behind a public candidate (`0.0.0.0` when the browser hides it).
    pub related_address: String,
    /// Its port (0 when hidden).
    pub related_port: u16,
}

/// Parses `candidate:1 1 udp 2122260223 1.2.3.4 5000 typ srflx raddr … rport …`.
#[must_use]
pub fn parse_candidate(line: &str) -> Option<Candidate> {
    let line = line.trim();
    let line = line.strip_prefix("a=").unwrap_or(line);
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 8 || parts[6] != "typ" {
        return None;
    }
    let mut extra = BTreeMap::new();
    for kv in parts[8..].chunks_exact(2) {
        extra.insert(kv[0], kv[1]);
    }
    Some(Candidate {
        protocol: parts[2].to_lowercase(),
        address: parts[4].to_owned(),
        port: parts[5].parse().unwrap_or(0),
        kind: parts[7].to_owned(),
        related_address: extra.get("raddr").map_or_else(String::new, |s| (*s).to_owned()),
        related_port: extra.get("rport").and_then(|s| s.parse().ok()).unwrap_or(0),
    })
}

/// How one side's router maps its traffic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NatMapping {
    /// No public address found: UDP blocked.
    Blocked,
    /// Same public port for every destination.
    Normal,
    /// A new public port per destination.
    Strict,
    /// Not enough to tell.
    Unknown,
}

impl NatMapping {
    /// The web app's name for it (`blocked`, `normal`, …).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Normal => "normal",
            Self::Strict => "strict",
            Self::Unknown => "unknown",
        }
    }
}

/// What one side offered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SideSummary {
    /// Candidates parsed.
    pub candidates: usize,
    /// Local addresses.
    pub host: usize,
    /// Public addresses found with STUN.
    pub srflx: usize,
    /// Relay (TURN) addresses.
    pub relay: usize,
    /// Its NAT, as far as the candidates tell.
    pub mapping: NatMapping,
}

/// Sums up one side's candidate lines.
#[must_use]
pub fn summarize_side(lines: &[String]) -> SideSummary {
    let cands: Vec<Candidate> = lines.iter().filter_map(|l| parse_candidate(l)).collect();
    let count = |k: &str| cands.iter().filter(|c| c.kind == k).count();
    let (srflx, relay) = (count("srflx"), count("relay"));
    // Public ports grouped by the local socket they came from (or by public address when hidden)
    let mut ports: BTreeMap<String, BTreeSet<u16>> = BTreeMap::new();
    for c in cands.iter().filter(|c| c.kind == "srflx" && c.protocol == "udp") {
        let base = if c.related_port != 0 && c.related_address != "0.0.0.0" {
            format!("{}:{}", c.related_address, c.related_port)
        } else {
            String::new()
        };
        ports
            .entry(format!("{}|{base}", c.address))
            .or_default()
            .insert(c.port);
    }
    let mapping = if !cands.is_empty() && srflx == 0 && relay == 0 {
        NatMapping::Blocked
    } else if ports.values().any(|p| p.len() > 1) {
        NatMapping::Strict
    } else if ports.is_empty() {
        NatMapping::Unknown
    } else {
        NatMapping::Normal
    };
    SideSummary {
        candidates: cands.len(),
        host: count("host"),
        srflx,
        relay,
        mapping,
    }
}

/// One path (candidate pair) libwebrtc tried.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PathTried {
    /// Our end (`srflx/udp`).
    pub local: String,
    /// Their end.
    pub remote: String,
    /// `frozen`, `waiting`, `in-progress`, `failed` or `succeeded`.
    pub state: String,
    /// Chosen for the connection.
    pub nominated: bool,
    /// Connectivity checks sent.
    pub requests_sent: u64,
    /// Answers to them.
    pub responses_received: u64,
}

/// Totals over the paths tried.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PairStats {
    /// Paths tried.
    pub pairs: usize,
    /// Paths that worked.
    pub succeeded: usize,
    /// Paths that failed.
    pub failed: usize,
    /// Checks sent.
    pub requests_sent: u64,
    /// Checks answered.
    pub responses_received: u64,
}

impl PairStats {
    /// Adds up `paths`.
    #[must_use]
    pub fn of(paths: &[PathTried]) -> Self {
        Self {
            pairs: paths.len(),
            succeeded: paths.iter().filter(|p| p.state == "succeeded").count(),
            failed: paths.iter().filter(|p| p.state == "failed").count(),
            requests_sent: paths.iter().map(|p| p.requests_sent).sum(),
            responses_received: paths.iter().map(|p| p.responses_received).sum(),
        }
    }
}

/// What went wrong (the web app's `FailureCause`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureCause {
    /// We offered no addresses.
    NoLocalCandidates,
    /// None arrived from them.
    NoRemoteCandidates,
    /// Both block UDP.
    BothUdpBlocked,
    /// Ours blocks UDP.
    LocalUdpBlocked,
    /// Theirs blocks UDP.
    RemoteUdpBlocked,
    /// Both strict NATs.
    BothStrictNat,
    /// Ours is a strict NAT.
    LocalStrictNat,
    /// Theirs is a strict NAT.
    RemoteStrictNat,
    /// A path worked; the secure connection on it didn't.
    PathOkSetupFailed,
    /// Both look normal, packets are dropped somewhere.
    Filtered,
}

impl FailureCause {
    /// The web app's name for it (`both-strict-nat`, …).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NoLocalCandidates => "no-local-candidates",
            Self::NoRemoteCandidates => "no-remote-candidates",
            Self::BothUdpBlocked => "both-udp-blocked",
            Self::LocalUdpBlocked => "local-udp-blocked",
            Self::RemoteUdpBlocked => "remote-udp-blocked",
            Self::BothStrictNat => "both-strict-nat",
            Self::LocalStrictNat => "local-strict-nat",
            Self::RemoteStrictNat => "remote-strict-nat",
            Self::PathOkSetupFailed => "path-ok-setup-failed",
            Self::Filtered => "filtered",
        }
    }
}

/// The diagnosis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnosis {
    /// What went wrong.
    pub cause: FailureCause,
    /// One plain sentence for the room log.
    pub summary: String,
    /// Details for the room log (no addresses).
    pub details: Vec<String>,
    /// Our side.
    pub local: SideSummary,
    /// Their side.
    pub remote: SideSummary,
    /// The paths tried, if the stats were read.
    pub pairs: Option<PairStats>,
}

const RELAY_FIX: &str =
    "A TURN relay server fixes this; until then, one of you can switch to another network.";

fn describe(side: &SideSummary) -> String {
    if side.candidates == 0 {
        return "no connection addresses".to_owned();
    }
    let mut parts = vec![format!(
        "{} address{}",
        side.candidates,
        if side.candidates == 1 { "" } else { "es" }
    )];
    if side.relay > 0 {
        parts.push("relay available".to_owned());
    }
    parts.push(
        match side.mapping {
            NatMapping::Blocked => "no public address found (UDP blocked)",
            NatMapping::Strict => "public port changes per destination (strict NAT)",
            NatMapping::Normal => "public port stays the same (normal NAT)",
            NatMapping::Unknown => "NAT type unknown",
        }
        .to_owned(),
    );
    parts.join(", ")
}

/// Works out why the connection failed.
#[must_use]
pub fn diagnose(local: &[String], remote: &[String], pairs: Option<PairStats>) -> Diagnosis {
    use FailureCause as C;
    use NatMapping as M;
    let (l, r) = (summarize_side(local), summarize_side(remote));
    let (cause, summary) = if l.candidates == 0 {
        (
            C::NoLocalCandidates,
            "This app gave no connection addresses (a firewall or security program may block it).".to_owned(),
        )
    } else if r.candidates == 0 {
        (
            C::NoRemoteCandidates,
            "No connection addresses arrived from them: their browser blocks WebRTC, or the room server lost them."
                .to_owned(),
        )
    } else if pairs.is_some_and(|p| p.succeeded > 0) {
        (
            C::PathOkSetupFailed,
            "A network path to them was found, but the secure connection on top of it failed to start."
                .to_owned(),
        )
    } else {
        match (l.mapping, r.mapping) {
            (M::Blocked, M::Blocked) => (
                C::BothUdpBlocked,
                format!("Both your network and theirs block direct-connection traffic (UDP). {RELAY_FIX}"),
            ),
            (M::Blocked, _) => (
                C::LocalUdpBlocked,
                format!(
                    "Your network blocks direct-connection traffic (UDP): a firewall, VPN, or work/school network. {RELAY_FIX}"
                ),
            ),
            (_, M::Blocked) => (
                C::RemoteUdpBlocked,
                format!(
                    "Their network blocks direct-connection traffic (UDP): a firewall, VPN, or work/school network. {RELAY_FIX}"
                ),
            ),
            (M::Strict, M::Strict) => (
                C::BothStrictNat,
                format!(
                    "You and them are both behind a strict NAT (common with mobile data and some broadband ISPs); two of these can't connect directly. {RELAY_FIX}"
                ),
            ),
            (M::Strict, _) => (
                C::LocalStrictNat,
                format!(
                    "Your network uses a strict NAT and theirs doesn't let unexpected traffic in, so no direct path opens. {RELAY_FIX}"
                ),
            ),
            (_, M::Strict) => (
                C::RemoteStrictNat,
                format!(
                    "Their network uses a strict NAT and yours doesn't let unexpected traffic in, so no direct path opens. {RELAY_FIX}"
                ),
            ),
            _ => (
                C::Filtered,
                "Both networks look normal, but no test packet got through: a firewall, antivirus or VPN on one side is likely dropping them."
                    .to_owned(),
            ),
        }
    };
    let mut details = vec![
        format!("You: {}.", describe(&l)),
        format!("Them: {}.", describe(&r)),
    ];
    if let Some(p) = pairs {
        details.push(format!(
            "Connection checks: {} path{} tried, {} worked, {} test packets sent, {} answered.",
            p.pairs,
            if p.pairs == 1 { "" } else { "s" },
            p.succeeded,
            p.requests_sent,
            p.responses_received
        ));
    }
    Diagnosis {
        cause,
        summary,
        details,
        local: l,
        remote: r,
        pairs,
    }
}

/// Hides the last part of each IPv4 address (1.2.3.4 → 1.2.3.x) and of each IPv6 address, and
/// drops ICE usernames and passwords.
#[must_use]
pub fn mask_candidate(line: &str) -> String {
    let mut out = Vec::new();
    let mut skip = false;
    for word in line.split_whitespace() {
        if skip {
            skip = false;
            continue;
        }
        if word == "ufrag" || word == "pwd" {
            skip = true;
            continue;
        }
        out.push(mask_address(word));
    }
    out.join(" ")
}

fn mask_address(word: &str) -> String {
    let dots: Vec<&str> = word.split('.').collect();
    if dots.len() == 4
        && dots
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return format!("{}.{}.{}.x", dots[0], dots[1], dots[2]);
    }
    let colons: Vec<&str> = word.split(':').collect();
    if colons.len() >= 4
        && colons
            .iter()
            .all(|p| p.len() <= 4 && p.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return format!("{}:{}:{}:…", colons[0], colons[1], colons[2]);
    }
    word.to_owned()
}

/// Extra facts for the full log.
#[derive(Debug, Clone, Default)]
pub struct ReportInfo {
    /// Who we couldn't reach.
    pub peer_id: String,
    /// When (ISO 8601 or anything readable).
    pub time: String,
    /// This app and its version.
    pub app: String,
    /// Connection states (`connection=failed`, …).
    pub states: Vec<(String, String)>,
    /// The paths tried.
    pub paths: Vec<PathTried>,
    /// Our candidate lines.
    pub local_candidates: Vec<String>,
    /// Theirs.
    pub remote_candidates: Vec<String>,
}

/// The full log to copy and share: everything the diagnosis used, addresses partly hidden.
/// Same layout as the web app's `formatIceReport`.
#[must_use]
pub fn format_report(d: &Diagnosis, info: &ReportInfo) -> String {
    let mut s = String::from("=== 3RTC connection failure log ===\n");
    let mut line = |text: &str| {
        s.push_str(text);
        s.push('\n');
    };
    if !info.time.is_empty() {
        line(&format!("Time: {}", info.time));
    }
    if !info.app.is_empty() {
        line(&format!("App: {}", info.app));
    }
    if !info.peer_id.is_empty() {
        line(&format!("Peer: {}", info.peer_id));
    }
    line("");
    line(&format!("Cause: {}", d.cause.as_str()));
    line(&format!("Why: {}", d.summary));
    for detail in &d.details {
        line(detail);
    }
    line("");
    for (who, side) in [("You", &d.local), ("Them", &d.remote)] {
        line(&format!(
            "{who} (NAT {}): {} host, {} srflx, {} relay",
            side.mapping.as_str(),
            side.host,
            side.srflx,
            side.relay
        ));
    }
    if !info.states.is_empty() {
        let states: Vec<String> = info.states.iter().map(|(k, v)| format!("{k}={v}")).collect();
        line(&format!("States: {}", states.join(", ")));
    }
    let mut section = |title: &str, items: Vec<String>| {
        let _ = write!(s, "\n--- {title} ({}) ---\n", items.len());
        for i in items {
            s.push_str(&i);
            s.push('\n');
        }
    };
    section(
        "Your candidates",
        info.local_candidates.iter().map(|l| mask_candidate(l)).collect(),
    );
    section(
        "Their candidates",
        info.remote_candidates.iter().map(|l| mask_candidate(l)).collect(),
    );
    section(
        "Paths tried",
        info.paths
            .iter()
            .map(|p| {
                format!(
                    "{} -> {} {}{}, {} sent, {} answered",
                    p.local,
                    p.remote,
                    p.state,
                    if p.nominated { " nominated" } else { "" },
                    p.requests_sent,
                    p.responses_received
                )
            })
            .collect(),
    );
    s.trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "candidate:1 1 udp 2122260223 abc.local 50000 typ host generation 0";

    fn srflx(ip: &str, port: u16) -> String {
        format!("candidate:2 1 udp 1686052607 {ip} {port} typ srflx raddr 0.0.0.0 rport 0 generation 0")
    }

    fn normal() -> Vec<String> {
        vec![HOST.to_owned(), srflx("49.36.1.10", 61000)]
    }

    fn strict() -> Vec<String> {
        vec![
            HOST.to_owned(),
            srflx("106.200.5.7", 40001),
            srflx("106.200.5.7", 40377),
        ]
    }

    fn blocked() -> Vec<String> {
        vec![HOST.to_owned()]
    }

    #[test]
    fn parses_a_candidate() {
        let c = parse_candidate("a=candidate:2 1 UDP 1 1.2.3.4 5000 typ srflx raddr 192.168.1.5 rport 6000")
            .unwrap();
        assert_eq!(c.protocol, "udp");
        assert_eq!(
            (c.address.as_str(), c.port, c.kind.as_str()),
            ("1.2.3.4", 5000, "srflx")
        );
        assert_eq!(
            (c.related_address.as_str(), c.related_port),
            ("192.168.1.5", 6000)
        );
        assert!(parse_candidate("").is_none());
        assert!(parse_candidate("candidate:1 1 udp").is_none());
    }

    #[test]
    fn tells_networks_apart() {
        assert_eq!(summarize_side(&normal()).mapping, NatMapping::Normal);
        assert_eq!(summarize_side(&strict()).mapping, NatMapping::Strict);
        assert_eq!(summarize_side(&blocked()).mapping, NatMapping::Blocked);
        assert_eq!(summarize_side(&[]).mapping, NatMapping::Unknown);
    }

    #[test]
    fn names_the_side_at_fault() {
        let pairs = |succeeded| {
            Some(PairStats {
                pairs: 4,
                succeeded,
                failed: 4 - succeeded,
                requests_sent: 10,
                responses_received: 0,
            })
        };
        let cause = |l: &[String], r: &[String], ok| diagnose(l, r, pairs(ok)).cause;
        assert_eq!(cause(&strict(), &strict(), 0), FailureCause::BothStrictNat);
        assert_eq!(cause(&strict(), &normal(), 0), FailureCause::LocalStrictNat);
        assert_eq!(cause(&normal(), &strict(), 0), FailureCause::RemoteStrictNat);
        assert_eq!(cause(&blocked(), &normal(), 0), FailureCause::LocalUdpBlocked);
        assert_eq!(cause(&normal(), &blocked(), 0), FailureCause::RemoteUdpBlocked);
        assert_eq!(cause(&blocked(), &blocked(), 0), FailureCause::BothUdpBlocked);
        assert_eq!(cause(&normal(), &normal(), 0), FailureCause::Filtered);
        assert_eq!(cause(&[], &normal(), 0), FailureCause::NoLocalCandidates);
        assert_eq!(cause(&normal(), &[], 0), FailureCause::NoRemoteCandidates);
        assert_eq!(cause(&strict(), &strict(), 1), FailureCause::PathOkSetupFailed);
    }

    #[test]
    fn the_full_log_hides_addresses() {
        let d = diagnose(&strict(), &normal(), None);
        let room_text = format!("{} {}", d.summary, d.details.join(" "));
        assert!(!room_text.contains("106.200"), "{room_text}");
        let info = ReportInfo {
            peer_id: "p2".into(),
            local_candidates: strict().iter().map(|l| format!("{l} ufrag abcd")).collect(),
            remote_candidates: normal(),
            paths: vec![PathTried {
                local: "srflx/udp".into(),
                remote: "srflx/udp".into(),
                state: "failed".into(),
                requests_sent: 7,
                ..PathTried::default()
            }],
            ..ReportInfo::default()
        };
        let log = format_report(&d, &info);
        assert!(log.contains("Cause: local-strict-nat"), "{log}");
        assert!(
            log.contains("106.200.5.x 40001") && log.contains("106.200.5.x 40377"),
            "{log}"
        );
        assert!(
            log.contains("srflx/udp -> srflx/udp failed, 7 sent, 0 answered"),
            "{log}"
        );
        assert!(
            !log.contains("106.200.5.7") && !log.contains("49.36.1.10") && !log.contains("ufrag"),
            "{log}"
        );
        assert_eq!(
            mask_candidate("x 2001:db8:85a3:0:0:8a2e:370:7334 y"),
            "x 2001:db8:85a3:… y"
        );
    }
}
