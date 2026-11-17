//! QUIC file transfer between desktop apps (ADR 0009): the parts with no I/O. The engine
//! (`crates/engine/src/quic.rs`) opens the sockets and moves the bytes.
//!
//! - when a file goes over QUIC ([`use_quic`]), and the name its partial download has;
//! - folder entries' relative paths, cleaned ([`clean_relative_path`]);
//! - hex for the hashes and the one-time token;
//! - a STUN binding request and its answer (RFC 5389), to learn the socket's public address;
//! - the peer's addresses from a `quic-offer` / `quic-answer`, checked.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// Files at least this big go over QUIC between desktop apps (smaller ones gain nothing).
pub const QUIC_MIN_BYTES: u64 = 8 * 1024 * 1024;
/// Most addresses taken from a peer (LAN and public, a few each).
pub const MAX_PEER_ADDRS: usize = 8;
/// Longest folder entry path kept.
const MAX_PATH_CHARS: usize = 400;

/// Whether a file of `size` bytes goes over QUIC to a peer (`peer_quic`: it's a desktop app that
/// said it can).
#[must_use]
pub const fn use_quic(size: u64, peer_quic: bool) -> bool {
    peer_quic && size >= QUIC_MIN_BYTES
}

/// The name a download has while it's coming in (kept to resume).
#[must_use]
pub fn partial_name(file_name: &str) -> String {
    format!("{file_name}.3rtc-part")
}

/// A folder entry's path from a peer, made safe to create under the download folder: `/`
/// separators, no empty, `.` or `..` parts, no drive letters or roots, no characters Windows
/// refuses, no reserved device names. `None` when nothing is left.
#[must_use]
pub fn clean_relative_path(raw: &str) -> Option<String> {
    const RESERVED: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    if raw.chars().count() > MAX_PATH_CHARS {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for part in raw.split(['/', '\\']) {
        let cleaned: String = part
            .chars()
            .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
            .collect();
        let cleaned = cleaned.trim().trim_end_matches('.').to_owned();
        if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
            continue;
        }
        let stem = cleaned.split('.').next().unwrap_or("").to_ascii_lowercase();
        if RESERVED.contains(&stem.as_str()) {
            parts.push(format!("_{cleaned}"));
        } else {
            parts.push(cleaned);
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Lower-case hex.
#[must_use]
pub fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// 32 bytes from 64 hex digits (any case), else `None`.
#[must_use]
pub fn from_hex32(text: &str) -> Option<[u8; 32]> {
    let t = text.as_bytes();
    if t.len() != 64 {
        return None;
    }
    let digit = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut out = [0u8; 32];
    for (i, pair) in t.chunks_exact(2).enumerate() {
        out[i] = (digit(pair[0])? << 4) | digit(pair[1])?;
    }
    Some(out)
}

/// Equal without telling, by its timing, how much of it matched (for the token).
#[must_use]
pub fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The peer's addresses: parsed, unique, at most [`MAX_PEER_ADDRS`], and only ones a UDP packet
/// may go to (no unspecified, multicast or broadcast address, no port 0).
#[must_use]
pub fn peer_addrs(raw: &[String]) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = Vec::new();
    for text in raw.iter().take(MAX_PEER_ADDRS * 2) {
        let Ok(addr) = text.trim().parse::<SocketAddr>() else {
            continue;
        };
        let ok_ip = match addr.ip() {
            IpAddr::V4(ip) => !(ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast()),
            IpAddr::V6(ip) => !(ip.is_unspecified() || ip.is_multicast()),
        };
        if ok_ip && addr.port() != 0 && !out.contains(&addr) {
            out.push(addr);
        }
        if out.len() == MAX_PEER_ADDRS {
            break;
        }
    }
    out
}

// ---- STUN (RFC 5389), just the binding request -----------------------------------------------

const STUN_MAGIC: u32 = 0x2112_A442;

/// A binding request with this transaction id.
#[must_use]
pub fn stun_request(txid: [u8; 12]) -> [u8; 20] {
    let mut m = [0u8; 20];
    m[0..2].copy_from_slice(&0x0001u16.to_be_bytes());
    // length 0 (no attributes)
    m[4..8].copy_from_slice(&STUN_MAGIC.to_be_bytes());
    m[8..20].copy_from_slice(&txid);
    m
}

/// The public address in a binding success answer for `txid` (XOR-MAPPED-ADDRESS, else
/// MAPPED-ADDRESS), or `None` for anything else.
#[must_use]
pub fn stun_mapped_address(msg: &[u8], txid: [u8; 12]) -> Option<SocketAddr> {
    if msg.len() < 20
        || u16::from_be_bytes([msg[0], msg[1]]) != 0x0101
        || u32::from_be_bytes([msg[4], msg[5], msg[6], msg[7]]) != STUN_MAGIC
        || msg[8..20] != txid
    {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([msg[2], msg[3]]));
    let body = msg.get(20..20 + len)?;
    let mut plain = None;
    let mut at = 0;
    while at + 4 <= body.len() {
        let kind = u16::from_be_bytes([body[at], body[at + 1]]);
        let alen = usize::from(u16::from_be_bytes([body[at + 2], body[at + 3]]));
        let value = body.get(at + 4..at + 4 + alen)?;
        match kind {
            0x0020 => return address(value, Some(&msg[4..20])),
            0x0001 => plain = address(value, None),
            _ => {}
        }
        at += 4 + alen.div_ceil(4) * 4;
    }
    plain
}

/// An address attribute's value, XOR-ed with the magic cookie and transaction id when `xor`.
fn address(v: &[u8], xor: Option<&[u8]>) -> Option<SocketAddr> {
    if v.len() < 8 {
        return None;
    }
    let mask = |i: usize| xor.map_or(0, |k| k[i]);
    let port = u16::from_be_bytes([v[2] ^ mask(0), v[3] ^ mask(1)]);
    match v[1] {
        0x01 => {
            let o: Vec<u8> = (0..4).map(|i| v[4 + i] ^ mask(i)).collect();
            Some(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::new(o[0], o[1], o[2], o[3])),
                port,
            ))
        }
        0x02 if v.len() >= 20 => {
            let mut o = [0u8; 16];
            for (i, b) in o.iter_mut().enumerate() {
                *b = v[4 + i] ^ mask(i);
            }
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(o)), port))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quic_only_for_big_files_to_desktop_apps() {
        assert!(use_quic(QUIC_MIN_BYTES, true));
        assert!(!use_quic(QUIC_MIN_BYTES - 1, true));
        assert!(!use_quic(10 * QUIC_MIN_BYTES, false), "a web app never gets it");
    }

    #[test]
    fn folder_paths_stay_inside_the_download_folder() {
        assert_eq!(
            clean_relative_path("photos/2026/a.jpg").as_deref(),
            Some("photos/2026/a.jpg")
        );
        assert_eq!(
            clean_relative_path("photos\\b.png").as_deref(),
            Some("photos/b.png")
        );
        assert_eq!(
            clean_relative_path("../../Windows/system32/x.dll").as_deref(),
            Some("Windows/system32/x.dll")
        );
        assert_eq!(clean_relative_path("/etc/passwd").as_deref(), Some("etc/passwd"));
        assert_eq!(
            clean_relative_path("C:\\Users\\a.txt").as_deref(),
            Some("C/Users/a.txt")
        );
        assert_eq!(clean_relative_path("a/./b/../c").as_deref(), Some("a/b/c"));
        assert_eq!(
            clean_relative_path("con/nul.txt").as_deref(),
            Some("_con/_nul.txt")
        );
        assert_eq!(clean_relative_path("what?.txt.").as_deref(), Some("what.txt"));
        assert_eq!(clean_relative_path("../.."), None);
        assert_eq!(clean_relative_path(""), None);
        assert_eq!(clean_relative_path(&"a/".repeat(300)), None);
    }

    #[test]
    fn hex_round_trips() {
        let bytes: [u8; 32] = std::array::from_fn(|i| u8::try_from(i * 7 % 256).unwrap_or(0));
        let text = to_hex(&bytes);
        assert_eq!(text.len(), 64);
        assert_eq!(from_hex32(&text), Some(bytes));
        assert_eq!(from_hex32(&text.to_uppercase()), Some(bytes));
        assert_eq!(from_hex32("zz"), None);
        assert_eq!(from_hex32(&"g".repeat(64)), None);
    }

    #[test]
    fn secrets_compare_fully() {
        assert!(same_secret(b"abc", b"abc"));
        assert!(!same_secret(b"abc", b"abd"));
        assert!(!same_secret(b"abc", b"ab"));
    }

    #[test]
    fn peer_addresses_are_checked() {
        let raw: Vec<String> = [
            "192.168.1.5:5000",
            "49.36.1.10:61000",
            "0.0.0.0:5000",
            "224.0.0.1:5000",
            "1.2.3.4:0",
            "not an address",
            "192.168.1.5:5000",
            "[2001:db8::1]:7000",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let got = peer_addrs(&raw);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].to_string(), "192.168.1.5:5000");
        assert_eq!(got[2].to_string(), "[2001:db8::1]:7000");
        let many: Vec<String> = (1..40).map(|i| format!("10.0.0.{i}:9000")).collect();
        assert_eq!(peer_addrs(&many).len(), MAX_PEER_ADDRS);
    }

    #[test]
    fn stun_request_and_answer() {
        let txid = [7u8; 12];
        let req = stun_request(txid);
        assert_eq!(&req[0..2], &[0, 1]);
        assert_eq!(&req[4..8], &STUN_MAGIC.to_be_bytes());
        // A success answer with XOR-MAPPED-ADDRESS 49.36.1.10:61000
        let ip = [49u8, 36, 1, 10];
        let port: u16 = 61000;
        let cookie = STUN_MAGIC.to_be_bytes();
        let xport = port ^ 0x2112;
        let mut attr = vec![0x00, 0x20, 0x00, 0x08, 0x00, 0x01];
        attr.extend_from_slice(&xport.to_be_bytes());
        attr.extend(ip.iter().zip(cookie.iter()).map(|(a, b)| a ^ b));
        let mut msg = vec![0x01, 0x01];
        msg.extend_from_slice(&u16::try_from(attr.len()).unwrap_or(0).to_be_bytes());
        msg.extend_from_slice(&cookie);
        msg.extend_from_slice(&txid);
        msg.extend_from_slice(&attr);
        assert_eq!(
            stun_mapped_address(&msg, txid),
            Some("49.36.1.10:61000".parse().unwrap())
        );
        assert_eq!(
            stun_mapped_address(&msg, [8u8; 12]),
            None,
            "someone else's answer"
        );
        assert_eq!(stun_mapped_address(&msg[..24], txid), None, "cut short");
        assert_eq!(stun_mapped_address(&[0u8; 3], txid), None);
    }
}
