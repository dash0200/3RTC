//! What's inside a video file, and its subtitles (`features/files/`: `formats.ts`, `mkv.ts`,
//! `mp4.ts`, `ebml.ts`; `utils/subtitleParser.ts`).
//!
//! - [`probe`]: container, video codec, audio and subtitle tracks from the file's header (MKV
//!   from its first 512 KB, MP4 from its `moov` box wherever it is), as the JSON the web app sends
//!   in `file-format`.
//! - [`extract_mkv_subtitles`]: the text of an MKV subtitle track, reading the file once.
//! - [`to_vtt`]: a subtitle file (SRT, WebVTT, ASS/SSA) as WebVTT, as `subtitle-share` carries it.
//!
//! No I/O here: the file is read through a `read_at(pos, len)` the caller gives.

use serde_json::{Value, json};

/// Reads `len` bytes at `pos` (fewer at the end of the file; `None`: can't read).
pub type ReadAt<'a> = dyn FnMut(u64, usize) -> Option<Vec<u8>> + 'a;

// ---- EBML (ebml.ts) -----------------------------------------------------------------------------

/// An element of unknown size.
const UNKNOWN_SIZE: u64 = u64::MAX;

/// A variable-length integer: value (without the marker unless `keep`), length, all ones.
fn vint(b: &[u8], pos: usize, keep: bool) -> Option<(u64, usize, bool)> {
    let first = *b.get(pos)?;
    if first == 0 {
        return None;
    }
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || pos + len > b.len() {
        return None;
    }
    let mask = u8::try_from(0xffu16 >> len).unwrap_or(0);
    let mut value = u64::from(if keep { first } else { first & mask });
    let mut all_ones = first & mask == mask;
    for i in 1..len {
        value = value * 256 + u64::from(b[pos + i]);
        if b[pos + i] != 0xff {
            all_ones = false;
        }
    }
    Some((value, len, all_ones))
}

/// An element header: id, size ([`UNKNOWN_SIZE`] if unknown), header length.
fn element(b: &[u8], pos: usize) -> Option<(u64, u64, usize)> {
    let (id, il, _) = vint(b, pos, true)?;
    let (size, sl, ones) = vint(b, pos + il, false)?;
    Some((id, if ones { UNKNOWN_SIZE } else { size }, il + sl))
}

fn uint(b: &[u8], pos: usize, len: usize) -> u64 {
    b.get(pos..pos + len)
        .map_or(0, |s| s.iter().fold(0u64, |v, x| v * 256 + u64::from(*x)))
}

fn float(b: &[u8], pos: usize, len: usize) -> f64 {
    match (len, b.get(pos..pos + len)) {
        (4, Some(s)) => f64::from(f32::from_be_bytes(s.try_into().unwrap_or([0; 4]))),
        (8, Some(s)) => f64::from_be_bytes(s.try_into().unwrap_or([0; 8])),
        _ => 0.0,
    }
}

fn string(b: &[u8], pos: usize, len: usize) -> String {
    b.get(pos..pos + len)
        .map(|s| String::from_utf8_lossy(s).trim_end_matches('\0').to_owned())
        .unwrap_or_default()
}

fn to_usize(v: u64) -> usize {
    usize::try_from(v).unwrap_or(usize::MAX)
}

// ---- Matroska (mkv.ts) --------------------------------------------------------------------------

mod id {
    pub(super) const EBML: u64 = 0x1a45_dfa3;
    pub(super) const DOC_TYPE: u64 = 0x4282;
    pub(super) const SEGMENT: u64 = 0x1853_8067;
    pub(super) const INFO: u64 = 0x1549_a966;
    pub(super) const TIMECODE_SCALE: u64 = 0x2a_d7b1;
    pub(super) const DURATION: u64 = 0x4489;
    pub(super) const TRACKS: u64 = 0x1654_ae6b;
    pub(super) const TRACK_ENTRY: u64 = 0xae;
    pub(super) const TRACK_NUMBER: u64 = 0xd7;
    pub(super) const TRACK_TYPE: u64 = 0x83;
    pub(super) const CODEC_ID: u64 = 0x86;
    pub(super) const LANGUAGE: u64 = 0x22_b59c;
    pub(super) const LANGUAGE_IETF: u64 = 0x22_b59d;
    pub(super) const NAME: u64 = 0x536e;
    pub(super) const FLAG_DEFAULT: u64 = 0x88;
    pub(super) const FLAG_FORCED: u64 = 0x55aa;
    pub(super) const CLUSTER: u64 = 0x1f43_b675;
    pub(super) const TIMECODE: u64 = 0xe7;
    pub(super) const SIMPLE_BLOCK: u64 = 0xa3;
    pub(super) const BLOCK_GROUP: u64 = 0xa0;
    pub(super) const BLOCK: u64 = 0xa1;
    pub(super) const BLOCK_DURATION: u64 = 0x9b;
}

/// One track in an MKV file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MkvTrack {
    /// Its number (blocks name it).
    pub number: u64,
    /// `video`, `audio`, `subtitle` or `other`.
    pub kind: &'static str,
    /// `V_MPEG4/ISO/AVC`, `A_AAC`, `S_TEXT/UTF8`, …
    pub codec_id: String,
    /// `eng`, `hin`, … (`und` when not given).
    pub language: String,
    /// The track's name.
    pub name: String,
    /// Shown by default.
    pub is_default: bool,
    /// Forced (signs and songs).
    pub is_forced: bool,
}

/// An MKV file's header.
#[derive(Debug, Clone, PartialEq)]
pub struct MkvHeader {
    /// `matroska` or `webm`.
    pub doc_type: String,
    /// Nanoseconds per tick.
    pub timecode_scale: u64,
    /// In ticks.
    pub duration: f64,
    /// The tracks.
    pub tracks: Vec<MkvTrack>,
}

/// Does `b` start a Matroska/WebM file?
#[must_use]
pub fn is_matroska(b: &[u8]) -> bool {
    uint(b, 0, 4) == id::EBML && b.len() >= 4
}

fn track_entry(b: &[u8], start: usize, end: usize) -> MkvTrack {
    let mut t = MkvTrack {
        number: 0,
        kind: "other",
        codec_id: String::new(),
        language: "und".to_owned(),
        name: String::new(),
        is_default: true,
        is_forced: false,
    };
    let mut pos = start;
    while pos < end {
        let Some((eid, size, hl)) = element(b, pos) else {
            break;
        };
        if size == UNKNOWN_SIZE {
            break;
        }
        let d = pos + hl;
        let sz = to_usize(size);
        if d.saturating_add(sz) > b.len() {
            break;
        }
        match eid {
            id::TRACK_NUMBER => t.number = uint(b, d, sz),
            id::TRACK_TYPE => {
                t.kind = match uint(b, d, sz) {
                    1 => "video",
                    2 => "audio",
                    17 => "subtitle",
                    _ => "other",
                }
            }
            id::CODEC_ID => t.codec_id = string(b, d, sz),
            id::LANGUAGE => {
                let l = string(b, d, sz);
                t.language = if l.is_empty() { "und".to_owned() } else { l };
            }
            id::LANGUAGE_IETF => {
                let l = string(b, d, sz);
                if !l.is_empty() {
                    t.language = l;
                }
            }
            id::NAME => t.name = string(b, d, sz),
            id::FLAG_DEFAULT => t.is_default = uint(b, d, sz) == 1,
            id::FLAG_FORCED => t.is_forced = uint(b, d, sz) == 1,
            _ => {}
        }
        pos = d + sz;
    }
    t
}

/// An MKV file's header from its first bytes (`None`: not MKV, or the tracks aren't in `b`).
#[must_use]
pub fn parse_mkv_header(b: &[u8]) -> Option<MkvHeader> {
    fn walk(b: &[u8], start: usize, end: usize, in_segment: bool, out: &mut MkvHeader, found: &mut bool) {
        let mut p = start;
        while p < end {
            let Some((eid, size, hl)) = element(b, p) else {
                return;
            };
            let d = p + hl;
            let stop = if size == UNKNOWN_SIZE {
                end
            } else {
                d.saturating_add(to_usize(size))
            };
            let inner_end = stop.min(b.len());
            let sz = to_usize(size);
            match eid {
                id::EBML => walk(b, d, inner_end, false, out, found),
                id::DOC_TYPE => out.doc_type = string(b, d, sz),
                id::SEGMENT => {
                    walk(b, d, inner_end, true, out, found);
                    return;
                }
                id::INFO if in_segment => walk(b, d, inner_end, true, out, found),
                id::TIMECODE_SCALE => out.timecode_scale = uint(b, d, sz),
                id::DURATION => out.duration = float(b, d, sz),
                id::TRACKS if in_segment => {
                    *found = true;
                    let mut q = d;
                    while q < inner_end {
                        let Some((tid, tsize, thl)) = element(b, q) else {
                            break;
                        };
                        if tsize == UNKNOWN_SIZE {
                            break;
                        }
                        let td = q + thl;
                        let tend = td.saturating_add(to_usize(tsize));
                        if tid == id::TRACK_ENTRY {
                            out.tracks.push(track_entry(b, td, tend.min(b.len())));
                        }
                        q = tend;
                    }
                }
                id::CLUSTER if in_segment => return,
                _ => {}
            }
            if size == UNKNOWN_SIZE {
                return;
            }
            p = stop;
        }
    }
    if !is_matroska(b) {
        return None;
    }
    let mut out = MkvHeader {
        doc_type: "matroska".to_owned(),
        timecode_scale: 1_000_000,
        duration: 0.0,
        tracks: Vec::new(),
    };
    let mut found = false;
    walk(b, 0, b.len(), false, &mut out, &mut found);
    found.then_some(out)
}

/// Text subtitles the desktop can turn into WebVTT.
#[must_use]
pub fn is_text_subtitle(codec_id: &str) -> bool {
    matches!(
        codec_id,
        "S_TEXT/UTF8" | "S_TEXT/ASS" | "S_TEXT/SSA" | "S_TEXT/WEBVTT" | "S_SSA" | "S_ASS"
    )
}

/// The visible text of one ASS/SSA event in a block (`ReadOrder,Layer,Style,…,Text`).
#[must_use]
pub fn ass_event_text(line: &str) -> String {
    let mut rest = line;
    for _ in 0..8 {
        match rest.find(',') {
            Some(c) => rest = &rest[c + 1..],
            None => return line.trim().to_owned(),
        }
    }
    clean_ass(rest)
}

fn clean_ass(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '{' => in_tag = true,
            '}' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("\\N", "\n")
        .replace("\\n", "\n")
        .replace("\\h", " ")
        .trim()
        .to_owned()
}

/// One subtitle line on screen.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    /// When it shows, seconds.
    pub start: f64,
    /// When it goes, seconds.
    pub end: f64,
    /// Its text (lines joined with `\n`).
    pub text: String,
}

const CHUNK: usize = 8 * 1024 * 1024;

/// Reads the whole MKV file once and collects the text of subtitle track `track`
/// (`codec_id` as in its header). `progress` gets 0–1 now and then.
#[must_use]
#[allow(
    clippy::cast_precision_loss,
    clippy::collapsible_match,
    clippy::too_many_lines
)]
pub fn extract_mkv_subtitles(
    read_at: &mut ReadAt<'_>,
    file_size: u64,
    track: u64,
    codec_id: &str,
    timecode_scale: u64,
    progress: &mut dyn FnMut(f64),
) -> Vec<Cue> {
    let ass = codec_id.contains("SSA") || codec_id.contains("ASS");
    let scale = timecode_scale as f64 / 1e9;
    let mut win: Vec<u8> = Vec::new();
    let mut win_start: u64 = 0;
    let mut ensure = |pos: u64, need: usize, win: &mut Vec<u8>, win_start: &mut u64| -> bool {
        if pos >= *win_start && pos + need as u64 <= *win_start + win.len() as u64 {
            return true;
        }
        if pos >= file_size {
            return false;
        }
        let len = to_usize((file_size - pos).min(CHUNK.max(need) as u64));
        match read_at(pos, len) {
            Some(d) => {
                *win = d;
                *win_start = pos;
                pos + need as u64 <= *win_start + win.len() as u64
            }
            None => false,
        }
    };
    let mut cues: Vec<(Cue, bool)> = Vec::new();
    let mut pos: u64 = 0;
    let mut cluster_time: i64 = 0;
    let mut last_report: u64 = 0;
    let mut pending_duration: Option<u64> = None;
    let mut last_block: Option<usize> = None;
    while pos < file_size {
        if !ensure(pos, 16, &mut win, &mut win_start) && !ensure(pos, 2, &mut win, &mut win_start) {
            break;
        }
        let at = to_usize(pos - win_start);
        let Some((eid, size, hl)) = element(&win, at) else {
            break;
        };
        let data = pos + hl as u64;
        if matches!(eid, id::SEGMENT | id::CLUSTER | id::BLOCK_GROUP) {
            if eid == id::BLOCK_GROUP {
                pending_duration = None;
                last_block = None;
            }
            pos = data;
            continue;
        }
        if size == UNKNOWN_SIZE {
            break;
        }
        let sz = to_usize(size);
        match eid {
            id::TIMECODE => {
                if ensure(data, sz, &mut win, &mut win_start) {
                    #[allow(clippy::cast_possible_wrap)]
                    {
                        cluster_time = uint(&win, to_usize(data - win_start), sz) as i64;
                    }
                }
            }
            id::SIMPLE_BLOCK | id::BLOCK => {
                ensure(data, sz.min(8), &mut win, &mut win_start);
                let tn = vint(&win, to_usize(data - win_start), false);
                if let Some((n, tl, _)) = tn
                    && n == track
                    && ensure(data, sz, &mut win, &mut win_start)
                {
                    let base = to_usize(data - win_start);
                    let o = base + tl;
                    if o + 3 <= base + sz && base + sz <= win.len() {
                        let rel = i16::from_be_bytes([win[o], win[o + 1]]);
                        let raw = String::from_utf8_lossy(&win[o + 3..base + sz])
                            .trim_end_matches('\0')
                            .replace("\r\n", "\n")
                            .replace('\r', "\n");
                        let start = (cluster_time + i64::from(rel)) as f64 * scale;
                        let text = if ass {
                            ass_event_text(&raw)
                        } else {
                            raw.trim().to_owned()
                        };
                        let mut cue = Cue {
                            start,
                            end: start + 3.0,
                            text,
                        };
                        let mut guessed = true;
                        if eid == id::BLOCK
                            && let Some(d) = pending_duration
                        {
                            cue.end = start + d as f64 * scale;
                            guessed = false;
                        }
                        if cue.text.is_empty() {
                            last_block = None;
                        } else {
                            cues.push((cue, guessed));
                            last_block = (eid == id::BLOCK).then(|| cues.len() - 1);
                        }
                    }
                }
            }
            id::BLOCK_DURATION => {
                if ensure(data, sz, &mut win, &mut win_start) {
                    let d = uint(&win, to_usize(data - win_start), sz);
                    pending_duration = Some(d);
                    if let Some(i) = last_block
                        && let Some((c, g)) = cues.get_mut(i)
                    {
                        c.end = c.start + d as f64 * scale;
                        *g = false;
                    }
                }
            }
            _ => {}
        }
        pos = data + size;
        if pos - last_report > CHUNK as u64 {
            last_report = pos;
            progress((pos as f64 / file_size as f64).min(1.0));
        }
    }
    cues.sort_by(|a, b| a.0.start.total_cmp(&b.0.start));
    // blocks without a duration end at the next one (at most 6 s)
    let starts: Vec<f64> = cues.iter().map(|c| c.0.start).collect();
    for (i, (c, guessed)) in cues.iter_mut().enumerate() {
        if *guessed && let Some(next) = starts.get(i + 1) {
            c.end = (c.start + 0.5).max(next.min(c.start + 6.0));
        }
    }
    progress(1.0);
    cues.into_iter().map(|(c, _)| c).collect()
}

// ---- MP4 (mp4.ts) -------------------------------------------------------------------------------

fn be32(b: &[u8], p: usize) -> u64 {
    uint(b, p, 4)
}

fn fourcc(b: &[u8], p: usize) -> String {
    b.get(p..p + 4)
        .map(|s| s.iter().map(|c| char::from(*c)).collect())
        .unwrap_or_default()
}

/// Does `b` start an MP4/MOV file?
#[must_use]
pub fn is_mp4(b: &[u8]) -> bool {
    b.len() >= 8 && ["ftyp", "moov", "mdat", "free", "wide", "skip"].contains(&fourcc(b, 4).as_str())
}

/// The boxes directly inside `b[start..end]`: (type, contents start, end).
fn boxes(b: &[u8], start: usize, end: usize) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut p = start;
    while p + 8 <= end {
        let mut size = to_usize(be32(b, p));
        let kind = fourcc(b, p + 4);
        let mut header = 8;
        if size == 1 {
            if p + 16 > end {
                break;
            }
            size = to_usize(be32(b, p + 8) * (1 << 32) + be32(b, p + 12));
            header = 16;
        } else if size == 0 {
            size = end - p;
        }
        if size < header {
            break;
        }
        out.push((kind, p + header, p.saturating_add(size).min(end)));
        p = p.saturating_add(size);
    }
    out
}

fn child(b: &[u8], parent: Option<(usize, usize)>, kind: &str) -> Option<(usize, usize)> {
    let (s, e) = parent?;
    boxes(b, s, e)
        .into_iter()
        .find(|x| x.0 == kind)
        .map(|x| (x.1, x.2))
}

fn mdhd_language(b: &[u8], mdhd: Option<(usize, usize)>) -> String {
    let Some((s, _)) = mdhd else {
        return "und".to_owned();
    };
    let p = s + if b.get(s) == Some(&1) { 32 } else { 20 };
    let packed = uint(b, p, 2);
    let l: String = [(packed >> 10) & 31, (packed >> 5) & 31, packed & 31]
        .iter()
        .filter_map(|c| char::from_u32(u32::try_from(c + 0x60).unwrap_or(0)))
        .collect();
    if l.len() == 3 && l.chars().all(|c| c.is_ascii_lowercase()) {
        l
    } else {
        "und".to_owned()
    }
}

fn mp4a_object_type(b: &[u8], entry: (usize, usize)) -> Option<u8> {
    let version = uint(b, entry.0 + 8, 2);
    let extra = match version {
        1 => 16,
        2 => 36,
        _ => 0,
    };
    let inner = boxes(b, entry.0 + 28 + extra, entry.1);
    let esds = inner
        .iter()
        .find(|x| x.0 == "esds")
        .map(|x| (x.1, x.2))
        .or_else(|| {
            let wave = inner.iter().find(|x| x.0 == "wave")?;
            boxes(b, wave.1, wave.2)
                .into_iter()
                .find(|x| x.0 == "esds")
                .map(|x| (x.1, x.2))
        })?;
    let mut p = esds.0 + 4;
    while p + 2 < esds.1 {
        if b.get(p) == Some(&0x04) {
            let mut q = p + 1;
            for _ in 0..4 {
                if b.get(q).is_some_and(|x| x & 0x80 != 0) {
                    q += 1;
                } else {
                    break;
                }
            }
            return b.get(q + 1).copied();
        }
        p += 1;
    }
    None
}

fn mp4_video(fourcc: &str) -> String {
    match fourcc {
        "avc1" | "avc3" => "h264",
        "hvc1" | "hev1" | "dvh1" | "dvhe" => "hevc",
        "av01" => "av1",
        "vp09" => "vp9",
        "vp08" => "vp8",
        "mp4v" => "mpeg4",
        "s263" => "h263",
        "mjpa" | "jpeg" => "mjpeg",
        "apcn" | "apch" | "apcs" | "apco" | "ap4h" => "prores",
        other => return format!("other:{other}"),
    }
    .to_owned()
}

fn mp4_audio(fourcc: &str) -> String {
    match fourcc {
        "ac-3" => "ac3",
        "ec-3" => "eac3",
        "ac-4" => "ac4",
        "Opus" => "opus",
        "fLaC" => "flac",
        ".mp3" => "mp3",
        "alac" => "alac",
        "dtsc" | "dtsh" | "dtsl" | "dtse" => "dts",
        "samr" => "amr",
        "sowt" | "twos" | "lpcm" | "ipcm" | "raw " => "pcm",
        other => return format!("other:{other}"),
    }
    .to_owned()
}

/// An MP4 track: kind, codec, language.
type Mp4Track = (&'static str, String, String);

#[allow(clippy::cast_precision_loss)]
fn parse_moov(b: &[u8], moov: (usize, usize)) -> (Vec<Mp4Track>, f64) {
    let mut tracks = Vec::new();
    let mut duration = 0.0;
    if let Some((s, _)) = child(b, Some(moov), "mvhd") {
        let v1 = b.get(s) == Some(&1);
        let scale = if v1 { be32(b, s + 20) } else { be32(b, s + 12) };
        let dur = if v1 {
            be32(b, s + 24) * (1 << 32) + be32(b, s + 28)
        } else {
            be32(b, s + 16)
        };
        if scale > 0 {
            duration = dur as f64 / scale as f64;
        }
    }
    for (kind, s, e) in boxes(b, moov.0, moov.1) {
        if kind != "trak" {
            continue;
        }
        let mdia = child(b, Some((s, e)), "mdia");
        let handler = child(b, mdia, "hdlr")
            .map(|h| fourcc(b, h.0 + 8))
            .unwrap_or_default();
        let stsd = child(b, child(b, child(b, mdia, "minf"), "stbl"), "stsd");
        let entry = stsd.and_then(|(s, e)| boxes(b, s + 8, e).into_iter().next());
        let sample = entry.as_ref().map(|x| x.0.clone()).unwrap_or_default();
        let language = mdhd_language(b, child(b, mdia, "mdhd"));
        let (k, codec) = match handler.as_str() {
            "vide" => ("video", mp4_video(&sample)),
            "soun" => (
                "audio",
                if sample == "mp4a" {
                    let ot = entry.as_ref().and_then(|x| mp4a_object_type(b, (x.1, x.2)));
                    match ot {
                        Some(0x69 | 0x6b) => "mp3",
                        Some(0xa5) => "ac3",
                        Some(0xa6) => "eac3",
                        Some(0xa9) => "dts",
                        _ => "aac",
                    }
                    .to_owned()
                } else {
                    mp4_audio(&sample)
                },
            ),
            "subt" | "text" | "sbtl" | "clcp" => ("subtitle", sample.clone()),
            _ => (
                "other",
                if sample.is_empty() {
                    "unknown".to_owned()
                } else {
                    sample.clone()
                },
            ),
        };
        tracks.push((k, codec, language));
    }
    (tracks, duration)
}

/// What [`parse_mp4`] finds.
#[derive(Debug, Clone, PartialEq)]
pub struct Mp4Info {
    /// The `ftyp` brand (`qt  ` for QuickTime).
    pub brand: String,
    /// (kind, codec, language) of each track.
    pub tracks: Vec<(&'static str, String, String)>,
    /// Seconds.
    pub duration: f64,
    /// The index is after the media (slow to start when streamed).
    pub moov_at_end: bool,
}

const MAX_MOOV: u64 = 64 * 1024 * 1024;

/// The tracks of an MP4/MOV file (`None`: no `moov`).
#[must_use]
pub fn parse_mp4(read_at: &mut ReadAt<'_>, file_size: u64) -> Option<Mp4Info> {
    let head = read_at(0, to_usize(file_size.min(64 * 1024)))?;
    if !is_mp4(&head) {
        return None;
    }
    let brand = if fourcc(&head, 4) == "ftyp" {
        fourcc(&head, 8)
    } else {
        String::new()
    };
    let mut pos: u64 = 0;
    let mut first_mdat: Option<u64> = None;
    while pos + 8 <= file_size {
        let h = read_at(pos, 16)?;
        if h.len() < 8 {
            break;
        }
        let mut size = be32(&h, 0);
        let kind = fourcc(&h, 4);
        let mut header = 8u64;
        if size == 1 {
            size = be32(&h, 8) * (1 << 32) + be32(&h, 12);
            header = 16;
        } else if size == 0 {
            size = file_size - pos;
        }
        if size < header {
            break;
        }
        if kind == "mdat" && first_mdat.is_none() {
            first_mdat = Some(pos);
        }
        if kind == "moov" {
            if size > MAX_MOOV {
                return None;
            }
            let bytes = read_at(pos, to_usize(size))?;
            let (tracks, duration) = parse_moov(&bytes, (to_usize(header), bytes.len()));
            return Some(Mp4Info {
                brand,
                tracks,
                duration,
                moov_at_end: first_mdat.is_some_and(|m| m < pos),
            });
        }
        pos += size;
    }
    None
}

// ---- the format (formats.ts) --------------------------------------------------------------------

/// "H.264", "Dolby Digital (AC-3)", … (`codecLabel`).
#[must_use]
pub fn codec_label(codec: &str) -> String {
    let l = match codec {
        "h264" => "H.264",
        "hevc" => "HEVC (H.265)",
        "av1" => "AV1",
        "vp9" => "VP9",
        "vp8" => "VP8",
        "mpeg4" => "MPEG-4 Part 2 (XviD/DivX)",
        "mpeg2" => "MPEG-2",
        "mpeg1" => "MPEG-1",
        "theora" => "Theora",
        "h263" => "H.263",
        "mjpeg" => "Motion JPEG",
        "prores" => "ProRes",
        "vc1" => "VC-1",
        "wmv" => "WMV",
        "realvideo" => "RealVideo",
        "aac" => "AAC",
        "mp3" => "MP3",
        "mp2" => "MP2",
        "opus" => "Opus",
        "vorbis" => "Vorbis",
        "flac" => "FLAC",
        "alac" => "ALAC",
        "ac3" => "Dolby Digital (AC-3)",
        "eac3" => "Dolby Digital Plus (E-AC-3)",
        "ac4" => "Dolby AC-4",
        "dts" => "DTS",
        "truehd" => "Dolby TrueHD",
        "pcm" => "PCM",
        "amr" => "AMR",
        "wma" => "WMA",
        "" => "unknown",
        other => {
            return other.strip_prefix("other:").map_or_else(
                || other.to_owned(),
                |s| {
                    if s.trim().is_empty() {
                        "unknown".to_owned()
                    } else {
                        s.trim().to_owned()
                    }
                },
            );
        }
    };
    l.to_owned()
}

/// "MKV", "MP4", …
#[must_use]
pub fn container_label(container: &str) -> &'static str {
    match container {
        "mp4" => "MP4",
        "mov" => "MOV",
        "webm" => "WebM",
        "matroska" => "MKV",
        "avi" => "AVI",
        "asf" => "WMV/ASF",
        "mpegts" => "MPEG-TS",
        "flv" => "FLV",
        "ogg" => "Ogg",
        _ => "Unknown",
    }
}

fn mkv_video(id: &str) -> String {
    let table: [(&str, &str); 13] = [
        ("V_MPEG4/ISO/AVC", "h264"),
        ("V_MPEGH/ISO/HEVC", "hevc"),
        ("V_AV1", "av1"),
        ("V_VP9", "vp9"),
        ("V_VP8", "vp8"),
        ("V_MPEG4/ISO/", "mpeg4"),
        ("V_MS/VFW/FOURCC", "mpeg4"),
        ("V_MPEG2", "mpeg2"),
        ("V_MPEG1", "mpeg1"),
        ("V_THEORA", "theora"),
        ("V_REAL", "realvideo"),
        ("V_MJPEG", "mjpeg"),
        ("V_PRORES", "prores"),
    ];
    table
        .iter()
        .find(|(p, _)| id.starts_with(p))
        .map_or_else(|| format!("other:{id}"), |(_, c)| (*c).to_owned())
}

fn mkv_audio(id: &str) -> String {
    let table: [(&str, &str); 13] = [
        ("A_AAC", "aac"),
        ("A_MPEG/L3", "mp3"),
        ("A_MPEG/L2", "mp2"),
        ("A_OPUS", "opus"),
        ("A_VORBIS", "vorbis"),
        ("A_FLAC", "flac"),
        ("A_EAC3", "eac3"),
        ("A_AC3", "ac3"),
        ("A_DTS", "dts"),
        ("A_TRUEHD", "truehd"),
        ("A_PCM", "pcm"),
        ("A_ALAC", "alac"),
        ("A_MS/ACM", "wma"),
    ];
    table
        .iter()
        .find(|(p, _)| id.starts_with(p))
        .map_or_else(|| format!("other:{id}"), |(_, c)| (*c).to_owned())
}

fn mkv_sub_label(id: &str) -> String {
    match id {
        "S_TEXT/UTF8" => "SRT",
        "S_TEXT/ASS" | "S_ASS" => "ASS",
        "S_TEXT/SSA" | "S_SSA" => "SSA",
        "S_TEXT/WEBVTT" => "WebVTT",
        "S_HDMV/PGS" => "PGS (picture)",
        "S_VOBSUB" => "VobSub (picture)",
        "S_DVBSUB" => "DVB (picture)",
        "S_HDMV/TEXTST" => "HDMV text",
        other => other,
    }
    .to_owned()
}

/// An MKV header as the web app's format object (`formatFromMkv`).
#[must_use]
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
pub fn format_from_mkv(h: &MkvHeader) -> Value {
    let video = h.tracks.iter().find(|t| t.kind == "video").map(|t| {
        let c = mkv_video(&t.codec_id);
        json!({ "codec": c, "label": codec_label(&c) })
    });
    let audio: Vec<Value> = h
        .tracks
        .iter()
        .filter(|t| t.kind == "audio")
        .map(|t| {
            let c = mkv_audio(&t.codec_id);
            json!({ "number": t.number, "codec": c, "codecId": t.codec_id, "label": codec_label(&c), "language": t.language, "name": t.name })
        })
        .collect();
    let subtitles: Vec<Value> = h
        .tracks
        .iter()
        .filter(|t| t.kind == "subtitle")
        .map(|t| {
            json!({
                "number": t.number,
                "codec": t.codec_id,
                "kind": if is_text_subtitle(&t.codec_id) { "text" } else { "image" },
                "label": mkv_sub_label(&t.codec_id),
                "language": t.language,
                "name": t.name,
                "isDefault": t.is_default,
                "isForced": t.is_forced,
            })
        })
        .collect();
    let scale = if h.timecode_scale == 0 {
        1_000_000
    } else {
        h.timecode_scale
    };
    json!({
        "container": if h.doc_type == "webm" { "webm" } else { "matroska" },
        "video": video,
        "audio": audio,
        "subtitles": subtitles,
        "duration": ((h.duration * scale as f64) / 1e9).round() as u64,
        "timecodeScale": scale,
    })
}

/// MP4 tracks as the web app's format object (`formatFromMp4`).
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn format_from_mp4(info: &Mp4Info) -> Value {
    let video = info
        .tracks
        .iter()
        .find(|t| t.0 == "video")
        .map(|t| json!({ "codec": t.1, "label": codec_label(&t.1) }));
    let audio: Vec<Value> = info
        .tracks
        .iter()
        .filter(|t| t.0 == "audio")
        .enumerate()
        .map(|(i, t)| json!({ "number": i + 1, "codec": t.1, "label": codec_label(&t.1), "language": t.2, "name": "" }))
        .collect();
    let subtitles: Vec<Value> = info
        .tracks
        .iter()
        .filter(|t| t.0 == "subtitle")
        .enumerate()
        .map(|(i, t)| {
            json!({
                "number": i + 1, "codec": t.1, "kind": "text",
                "label": if t.1 == "tx3g" { "MP4 text".to_owned() } else { t.1.clone() },
                "language": t.2, "name": "", "isDefault": false, "embeddedMp4": true,
            })
        })
        .collect();
    let mut f = json!({
        "container": if info.brand == "qt  " { "mov" } else { "mp4" },
        "video": video,
        "audio": audio,
        "subtitles": subtitles,
        "duration": info.duration.max(0.0).round() as u64,
    });
    if info.moov_at_end {
        f["moovAtEnd"] = Value::Bool(true);
    }
    f
}

/// Other containers by their first bytes (`sniffContainer`).
#[must_use]
pub fn sniff_container(b: &[u8]) -> &'static str {
    let s = |p: usize, n: usize| b.get(p..p + n).unwrap_or_default();
    if b.len() >= 12 && s(0, 4) == b"RIFF" && s(8, 4) == b"AVI " {
        "avi"
    } else if b.len() >= 4 && s(0, 4) == [0x30, 0x26, 0xb2, 0x75] {
        "asf"
    } else if b.len() >= 3 && s(0, 3) == b"FLV" {
        "flv"
    } else if b.len() >= 4 && s(0, 4) == b"OggS" {
        "ogg"
    } else if (b.len() >= 377 && b[0] == 0x47 && b[188] == 0x47 && b[376] == 0x47)
        || (b.len() >= 192 * 2 + 5 && b[4] == 0x47 && b[196] == 0x47)
    {
        "mpegts"
    } else {
        "unknown"
    }
}

/// What's inside a video file, as the web app's format object (`probeFile`). Never fails: an
/// unreadable file gives container `unknown`.
#[must_use]
pub fn probe(read_at: &mut ReadAt<'_>, file_size: u64) -> Value {
    let empty =
        |c: &str| json!({ "container": c, "video": null, "audio": [], "subtitles": [], "duration": 0 });
    let Some(head) = read_at(0, to_usize(file_size.min(512 * 1024))) else {
        return empty("unknown");
    };
    if is_matroska(&head) {
        let mut header = parse_mkv_header(&head);
        if header.is_none() && file_size > head.len() as u64 {
            header = read_at(0, to_usize(file_size.min(6 * 1024 * 1024))).and_then(|b| parse_mkv_header(&b));
        }
        return header.as_ref().map_or_else(|| empty("matroska"), format_from_mkv);
    }
    if is_mp4(&head) {
        return parse_mp4(read_at, file_size)
            .as_ref()
            .map_or_else(|| empty("mp4"), format_from_mp4);
    }
    empty(sniff_container(&head))
}

/// "MKV · H.264 · AAC + 1 more audio · 3 subtitles" (`describeFormat`).
#[must_use]
pub fn describe(format: &Value) -> String {
    let mut parts = vec![container_label(format["container"].as_str().unwrap_or("unknown")).to_owned()];
    if let Some(l) = format["video"]["label"].as_str() {
        parts.push(l.to_owned());
    }
    if let Some(a) = format["audio"].as_array().filter(|a| !a.is_empty()) {
        let first = a[0]["label"].as_str().unwrap_or("unknown");
        parts.push(if a.len() > 1 {
            format!("{first} + {} more audio", a.len() - 1)
        } else {
            first.to_owned()
        });
    }
    if let Some(s) = format["subtitles"].as_array().filter(|s| !s.is_empty()) {
        parts.push(format!(
            "{} subtitle{}",
            s.len(),
            if s.len() > 1 { "s" } else { "" }
        ));
    }
    parts.join(" · ")
}

// ---- subtitle files (subtitleParser.ts) ---------------------------------------------------------

fn time(s: &str) -> f64 {
    let n = s.trim().replace(',', ".");
    let parts: Vec<f64> = n.split(':').map(|p| p.parse().unwrap_or(0.0)).collect();
    match parts.as_slice() {
        [h, m, s] => h * 3600.0 + m * 60.0 + s,
        [m, s] => m * 60.0 + s,
        [s] => *s,
        _ => 0.0,
    }
}

fn is_stamp(s: &str) -> bool {
    let s = s.trim();
    let digits = s.chars().filter(char::is_ascii_digit).count();
    digits >= 6 && s.contains(':') && (s.contains(',') || s.contains('.'))
}

/// SRT or WebVTT text as cues (`parseSrt` / `parseVtt`).
#[must_use]
pub fn parse_srt_or_vtt(text: &str) -> Vec<Cue> {
    let cleaned = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut cues = Vec::new();
    for block in cleaned.trim().split("\n\n") {
        let block = block.trim();
        if block.is_empty()
            || block.starts_with("WEBVTT")
            || block.starts_with("NOTE")
            || block.starts_with("STYLE")
        {
            continue;
        }
        let lines: Vec<&str> = block.lines().collect();
        let Some(ti) = lines.iter().position(|l| {
            l.split_once("-->")
                .is_some_and(|(a, b)| is_stamp(a) && is_stamp(b.split_whitespace().next().unwrap_or("")))
        }) else {
            continue;
        };
        let (a, b) = lines[ti].split_once("-->").unwrap_or(("", ""));
        let text: Vec<&str> = lines[ti + 1..]
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        if !text.is_empty() {
            cues.push(Cue {
                start: time(a),
                end: time(b.split_whitespace().next().unwrap_or("")),
                text: text.join("\n"),
            });
        }
    }
    cues
}

/// ASS/SSA `Dialogue:` lines as cues.
#[must_use]
pub fn parse_ass(text: &str) -> Vec<Cue> {
    let mut fields: Vec<String> = Vec::new();
    let mut cues = Vec::new();
    for line in text.lines() {
        let line = line.trim_start_matches('\u{feff}').trim();
        if let Some(f) = line.strip_prefix("Format:") {
            fields = f.split(',').map(|x| x.trim().to_lowercase()).collect();
        } else if let Some(d) = line.strip_prefix("Dialogue:") {
            let n = fields.len().max(10);
            let parts: Vec<&str> = d.splitn(n, ',').collect();
            let at = |name: &str, default: usize| fields.iter().position(|f| f == name).unwrap_or(default);
            let (si, ei, ti) = (at("start", 1), at("end", 2), at("text", n - 1));
            let (Some(s), Some(e), Some(t)) = (parts.get(si), parts.get(ei), parts.get(ti)) else {
                continue;
            };
            let t = clean_ass(t);
            if !t.is_empty() {
                cues.push(Cue {
                    start: time(s),
                    end: time(e),
                    text: t,
                });
            }
        }
    }
    cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    cues
}

fn vtt_stamp(secs: f64) -> String {
    let s = if secs.is_finite() { secs.max(0.0) } else { 0.0 };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let whole = s as u64;
    let (h, m) = (whole / 3600, (whole % 3600) / 60);
    format!("{h:02}:{m:02}:{:06.3}", s % 60.0)
}

/// Cues as WebVTT (`cuesToWebVTT`).
#[must_use]
pub fn cues_to_vtt(cues: &[Cue]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for (i, c) in cues.iter().enumerate() {
        let start = c.start.max(0.0);
        let end = c.end.max(start + 0.05);
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            vtt_stamp(start),
            vtt_stamp(end),
            c.text
        ));
    }
    out
}

/// A subtitle file (by its name: `.srt`, `.vtt`, `.ass`, `.ssa`) as WebVTT; `None` when it
/// holds no cues.
#[must_use]
pub fn to_vtt(name: &str, text: &str) -> Option<String> {
    let lower = name.to_lowercase();
    let cues = if lower.ends_with(".ass") || lower.ends_with(".ssa") || text.contains("[Events]") {
        parse_ass(text)
    } else {
        parse_srt_or_vtt(text)
    };
    (!cues.is_empty()).then(|| cues_to_vtt(&cues))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An EBML element: id bytes, then an 8-byte size, then the data.
    fn el(id: &[u8], data: &[u8]) -> Vec<u8> {
        let mut out = id.to_vec();
        out.push(0x01);
        out.extend_from_slice(&(data.len() as u64).to_be_bytes()[1..]);
        out.extend_from_slice(data);
        out
    }

    fn mkv(blocks: &[u8]) -> Vec<u8> {
        let header = el(&[0x1a, 0x45, 0xdf, 0xa3], &el(&[0x42, 0x82], b"matroska"));
        let info = el(
            &[0x15, 0x49, 0xa9, 0x66],
            &el(&[0x2a, 0xd7, 0xb1], &[0x0f, 0x42, 0x40]),
        );
        let video = el(
            &[0xae],
            &[
                el(&[0xd7], &[1]),
                el(&[0x83], &[1]),
                el(&[0x86], b"V_MPEGH/ISO/HEVC"),
            ]
            .concat(),
        );
        let audio = el(
            &[0xae],
            &[
                el(&[0xd7], &[2]),
                el(&[0x83], &[2]),
                el(&[0x86], b"A_AC3"),
                el(&[0x22, 0xb5, 0x9c], b"hin"),
            ]
            .concat(),
        );
        let subs = el(
            &[0xae],
            &[
                el(&[0xd7], &[3]),
                el(&[0x83], &[17]),
                el(&[0x86], b"S_TEXT/UTF8"),
                el(&[0x22, 0xb5, 0x9c], b"eng"),
            ]
            .concat(),
        );
        let tracks = el(&[0x16, 0x54, 0xae, 0x6b], &[video, audio, subs].concat());
        let segment = el(
            &[0x18, 0x53, 0x80, 0x67],
            &[info, tracks, blocks.to_vec()].concat(),
        );
        [header, segment].concat()
    }

    fn block(track: u8, rel: i16, text: &str) -> Vec<u8> {
        let mut d = vec![0x80 | track];
        d.extend_from_slice(&rel.to_be_bytes());
        d.push(0x80);
        d.extend_from_slice(text.as_bytes());
        el(&[0xa3], &d)
    }

    #[test]
    fn reads_an_mkv_header_into_the_web_apps_format() {
        let file = mkv(&[]);
        let f = probe(
            &mut |p, n| Some(file[p as usize..(p as usize + n).min(file.len())].to_vec()),
            file.len() as u64,
        );
        assert_eq!(f["container"], "matroska");
        assert_eq!(f["video"]["codec"], "hevc");
        assert_eq!(f["video"]["label"], "HEVC (H.265)");
        assert_eq!(f["audio"][0]["codec"], "ac3");
        assert_eq!(f["audio"][0]["language"], "hin");
        assert_eq!(f["subtitles"][0]["kind"], "text");
        assert_eq!(f["subtitles"][0]["label"], "SRT");
        assert_eq!(f["subtitles"][0]["number"], 3);
        assert_eq!(
            describe(&f),
            "MKV · HEVC (H.265) · Dolby Digital (AC-3) · 1 subtitle"
        );
    }

    #[test]
    fn pulls_the_text_of_a_subtitle_track() {
        let cluster = el(
            &[0x1f, 0x43, 0xb6, 0x75],
            &[
                el(&[0xe7], &[0x03, 0xe8]),
                block(3, 500, "Hello"),
                block(1, 0, "video data"),
                block(3, 2500, "World"),
            ]
            .concat(),
        );
        let file = mkv(&cluster);
        let cues = extract_mkv_subtitles(
            &mut |p, n| Some(file[p as usize..(p as usize + n).min(file.len())].to_vec()),
            file.len() as u64,
            3,
            "S_TEXT/UTF8",
            1_000_000,
            &mut |_| {},
        );
        assert_eq!(cues.len(), 2);
        assert!(
            (cues[0].start - 1.5).abs() < 1e-9 && (cues[0].end - 3.5).abs() < 1e-9,
            "{cues:?}"
        );
        assert_eq!(cues[1].text, "World");
        let vtt = cues_to_vtt(&cues);
        assert!(
            vtt.starts_with("WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.500\nHello\n\n"),
            "{vtt}"
        );
    }

    #[test]
    fn subtitle_files_become_webvtt() {
        let srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHi <i>there</i>\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,000\r\nBye\r\n";
        let v = to_vtt("a.srt", srt).unwrap();
        assert!(
            v.contains("00:00:01.000 --> 00:00:02.500\nHi <i>there</i>"),
            "{v}"
        );
        assert!(v.contains("00:01:00.000 --> 00:01:02.000\nBye"));
        let ass = "[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,{\\i1}Hola,\\Nmundo\n";
        let v = to_vtt("b.ass", ass).unwrap();
        assert!(v.contains("00:00:05.000 --> 00:00:07.500\nHola,\nmundo"), "{v}");
        assert!(to_vtt("c.srt", "nothing here").is_none());
        assert_eq!(
            ass_event_text("1,0,Default,,0,0,0,,Line {\\b1}one\\Ntwo"),
            "Line one\ntwo"
        );
    }

    #[test]
    fn reads_an_mp4s_tracks_wherever_its_index_is() {
        fn bx(kind: &str, data: &[u8]) -> Vec<u8> {
            let mut out = u32::try_from(data.len() + 8).unwrap().to_be_bytes().to_vec();
            out.extend_from_slice(kind.as_bytes());
            out.extend_from_slice(data);
            out
        }
        let hdlr = |h: &str| bx("hdlr", &[&[0u8; 8][..], h.as_bytes(), &[0; 12]].concat());
        let mdhd = bx("mdhd", &[&[0u8; 20][..], &[0x15, 0xc7], &[0; 2]].concat()); // "eng"
        let stsd = |entry: Vec<u8>| bx("stsd", &[&[0u8; 8][..], &entry].concat());
        let trak = |h: &str, entry: Vec<u8>| {
            bx(
                "trak",
                &bx(
                    "mdia",
                    &[mdhd.clone(), hdlr(h), bx("minf", &bx("stbl", &stsd(entry)))].concat(),
                ),
            )
        };
        let mvhd = bx(
            "mvhd",
            &[
                &[0u8; 12][..],
                &1000u32.to_be_bytes(),
                &60_000u32.to_be_bytes(),
                &[0; 8],
            ]
            .concat(),
        );
        let moov = bx(
            "moov",
            &[
                mvhd,
                trak("vide", bx("avc1", &[0; 78])),
                trak("soun", bx("ac-3", &[0; 28])),
            ]
            .concat(),
        );
        let file = [bx("ftyp", b"isom\0\0\0\0"), bx("mdat", &[0; 100]), moov].concat();
        let f = probe(
            &mut |p, n| Some(file[p as usize..(p as usize + n).min(file.len())].to_vec()),
            file.len() as u64,
        );
        assert_eq!(f["container"], "mp4");
        assert_eq!(f["video"]["codec"], "h264");
        assert_eq!(f["audio"][0]["codec"], "ac3");
        assert_eq!(f["audio"][0]["language"], "eng");
        assert_eq!(f["duration"], 60);
        assert_eq!(f["moovAtEnd"], true);
        assert_eq!(sniff_container(b"RIFF\0\0\0\0AVI LIST"), "avi");
    }
}
