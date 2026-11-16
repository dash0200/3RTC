//! Chat images on the bulk channel (`client-ts/src/utils/p2pImageShare.ts`): after a
//! `p2p-image-start` message, the file goes as binary frames of at most [`CHUNK`] bytes, each
//! `[4 bytes "IMG1"] [2 bytes header length, big-endian] [header JSON {"id","i","t"}] [bytes]`.

use serde::{Deserialize, Serialize};

/// `IMG1`, first in every frame.
pub const MAGIC: [u8; 4] = *b"IMG1";
/// Bytes of the image per frame (60 KB, under SCTP's 64 KB message limit).
pub const CHUNK: usize = 61_440;
/// Most frames one transfer may have (~30 GB at 60 KB chunks).
pub const MAX_CHUNKS: u32 = 500_000;
/// The largest file the app sends (10 GB).
pub const MAX_SEND_BYTES: usize = 10 * 1024 * 1024 * 1024;

/// The image types accepted (anything else is treated as PNG, as the web app does).
pub const MIME_TYPES: [&str; 7] = [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/bmp",
];

#[derive(Serialize)]
struct HeaderOut<'a> {
    id: &'a str,
    i: u32,
    t: u32,
}

#[derive(Deserialize)]
struct Header {
    id: String,
    i: f64,
    t: f64,
}

/// One frame, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame<'a> {
    /// The transfer it belongs to.
    pub transfer_id: String,
    /// Its place (from 0).
    pub index: u32,
    /// How many frames the transfer has.
    pub total: u32,
    /// The image bytes it carries.
    pub data: &'a [u8],
}

/// Makes a frame.
#[must_use]
pub fn pack(transfer_id: &str, index: u32, total: u32, data: &[u8]) -> Vec<u8> {
    let header = serde_json::to_vec(&HeaderOut {
        id: transfer_id,
        i: index,
        t: total,
    })
    .unwrap_or_default();
    let len = u16::try_from(header.len()).unwrap_or(u16::MAX);
    let mut out = Vec::with_capacity(6 + header.len() + data.len());
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&header[..usize::from(len)]);
    out.extend_from_slice(data);
    out
}

/// Reads a frame; `None` for anything that isn't one (other binary traffic shares the channel).
#[must_use]
pub fn parse(bytes: &[u8]) -> Option<Frame<'_>> {
    if bytes.len() < 6 || bytes[..4] != MAGIC {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([bytes[4], bytes[5]]));
    let header = bytes.get(6..6 + len)?;
    let h: Header = serde_json::from_slice(header).ok()?;
    let whole = |v: f64| (v.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&v)).then_some(v);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (index, total) = (whole(h.i)? as u32, whole(h.t)? as u32);
    Some(Frame {
        transfer_id: h.id,
        index,
        total,
        data: &bytes[6 + len..],
    })
}

/// The type to use for `mime` (lowercase, no parameters; PNG when it isn't an image type).
#[must_use]
pub fn clean_mime(mime: &str) -> &'static str {
    let m = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    MIME_TYPES
        .iter()
        .find(|t| **t == m)
        .copied()
        .unwrap_or("image/png")
}

/// Whether a MIME type is a displayable image.
#[must_use]
pub fn is_image_mime(mime: &str) -> bool {
    let m = mime.split(';').next().unwrap_or("").trim();
    m.starts_with("image/") || MIME_TYPES.iter().any(|t| t.eq_ignore_ascii_case(m))
}

/// The MIME type to use for general file transfers.
#[must_use]
pub fn clean_file_mime(mime: &str) -> String {
    let m = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if m.is_empty() {
        "application/octet-stream".to_owned()
    } else {
        m
    }
}

/// The image type for a file name, by its extension (`None`: not an image we send).
#[must_use]
pub fn mime_for_name(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

/// "512 B", "1.5 KB", "2.3 MB", "1.20 GB" (`formatFileSize`).
#[must_use]
pub fn format_size(bytes: u64) -> String {
    #[allow(clippy::cast_precision_loss)]
    let b = bytes as f64;
    if bytes == 0 {
        "0 B".to_owned()
    } else if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", b / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", b / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", b / (1024.0 * 1024.0 * 1024.0))
    }
}

/// A safe file name to save any received file or image as.
#[must_use]
pub fn safe_file_save_name(name: &str, mime: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    let clean_stem: String = stem
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '-'))
        .collect();
    let clean_stem: String = clean_stem.trim().chars().take(50).collect();
    let base = if clean_stem.is_empty() {
        "shared-file"
    } else {
        clean_stem.as_str()
    };
    if let Some((_, ext)) = name.rsplit_once('.') {
        let clean_ext: String = ext.chars().filter(char::is_ascii_alphanumeric).take(10).collect();
        if !clean_ext.is_empty() {
            return format!("{base}.{clean_ext}");
        }
    }
    save_name(name, mime)
}

/// A safe file name to save a received image as (`safeImageDownloadName`).
#[must_use]
pub fn save_name(name: &str, mime: &str) -> String {
    let m = mime.to_ascii_lowercase();
    let ext = if m.contains("jpeg") || m.contains("jpg") {
        ".jpg"
    } else if m.contains("webp") {
        ".webp"
    } else if m.contains("gif") {
        ".gif"
    } else if m.contains("avif") {
        ".avif"
    } else {
        ".png"
    };
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    let clean: String = stem
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '-'))
        .collect();
    let clean: String = clean.trim().chars().take(50).collect();
    let base = if clean.is_empty() {
        "shared-image"
    } else {
        clean.as_str()
    };
    format!("{base}{ext}")
}

#[cfg(test)]
mod tests {
    use super::{clean_mime, format_size, pack, parse, save_name};

    #[test]
    fn frames_round_trip_and_match_the_web_layout() {
        let f = pack("t-1", 3, 9, b"abc");
        // exactly what createImagePacket makes
        let header = br#"{"id":"t-1","i":3,"t":9}"#;
        #[allow(clippy::cast_possible_truncation)]
        let web = [b"IMG1".as_slice(), &[0, header.len() as u8], header, b"abc"].concat();
        assert_eq!(f, web);
        let a = parse(&web).unwrap();
        assert_eq!(
            (a.transfer_id.as_str(), a.index, a.total, a.data),
            ("t-1", 3, 9, b"abc".as_slice())
        );
        let b = parse(&f).unwrap();
        assert_eq!((b.index, b.total, b.data), (3, 9, b"abc".as_slice()));
        let floats = [b"IMG1".as_slice(), &[0, 26], br#"{"id":"t","i":1.0,"t":2.0}"#].concat();
        assert_eq!(parse(&floats).map(|p| (p.index, p.total)), Some((1, 2)));
        assert!(parse(b"VID1....").is_none());
        assert!(parse(&[b"IMG1".as_slice(), &[0, 50], b"{}"].concat()).is_none());
    }

    #[test]
    fn names_types_and_sizes() {
        assert_eq!(clean_mime("IMAGE/JPEG; q=1"), "image/jpeg");
        assert_eq!(clean_mime("text/html"), "image/png");
        assert_eq!(
            super::clean_file_mime("application/x-bittorrent; charset=utf-8"),
            "application/x-bittorrent"
        );
        assert_eq!(super::clean_file_mime(""), "application/octet-stream");
        assert!(super::is_image_mime("image/png"));
        assert!(!super::is_image_mime("application/x-bittorrent"));
        assert_eq!(format_size(512), "512 B");
        assert_eq!(format_size(1536), "1.5 KB");
        assert_eq!(format_size(3 * 1024 * 1024), "3.0 MB");
        assert_eq!(save_name("../../evil.exe", "image/jpeg"), "evil.jpg");
        assert_eq!(save_name("", "image/gif"), "shared-image.gif");
    }

    proptest::proptest! {
        #[test]
        fn reading_never_panics(bytes in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..200)) {
            let _ = parse(&bytes);
        }
    }
}
