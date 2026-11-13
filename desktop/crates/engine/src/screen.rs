//! Screen sharing (`features/screenshare/useScreenShare.ts`, `ScreenPointerOverlay.tsx`).
//!
//! Every connection already has a video transceiver (as `usePeerMesh`), so sharing is a track
//! swapped into it: no new offer. `screen-share-status` tells the room who shares; a viewer shows
//! the video only once that says so (a negotiated video line alone means nothing).
//!
//! **Sharing** (ADR 0005): libwebrtc's desktop capturer (DXGI on Windows) on its own thread at the
//! screen's own size, up to 60 frames a second, as I420. Each viewer gets their own picture:
//! - **hardware** (H.264 negotiated and the GPU has an encoder): we encode for that viewer with
//!   the GPU (`rtc_platform_win::H264Encoder`) at their size, and libwebrtc sends the access
//!   units as they are (a pass-through source per viewer). The network's estimate drives the
//!   encoder's rate; a viewer's request for a keyframe makes one.
//! - **software** (otherwise): the shared picture goes into one source and libwebrtc encodes it
//!   for each viewer, scaled down for them by their sender's settings.
//!
//! Either way a viewer's picture is the smallest of: the screen, the sharer's limit (Native,
//! 1440p, 1080p, 720p), the viewer's own choice (desktop viewers send `screen-quality`), and
//! 1440p for web viewers. The rate cap grows with the picture (about 50 Mbit/s for 4K at 60),
//! and the network's estimate decides within it; the picture keeps its size when the network is
//! short (frames are dropped first, so text stays sharp).
//!
//! **Watching**: the sharer's track decoded by libwebrtc, each frame scaled to the size it's shown
//! at and turned into BGRA for the UI ([`ScreenFeed`]); the UI shows the latest one.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use rtc_platform_win::{EncodedUnit, H264Encoder};
use rtc_webrtc::libwebrtc::desktop_capturer::{
    CaptureSource, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
};
use rtc_webrtc::libwebrtc::native::yuv_helper;
use rtc_webrtc::libwebrtc::prelude::{
    I420Buffer, VideoBuffer as _, VideoFrame, VideoResolution, VideoRotation,
};
use rtc_webrtc::libwebrtc::video_frame::native::VideoFrameBufferExt as _;
use rtc_webrtc::libwebrtc::video_frame::{
    EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame, VideoFormatType,
};
use rtc_webrtc::libwebrtc::video_source::native::NativeVideoSource;
use rtc_webrtc::libwebrtc::video_stream::native::NativeVideoStream;
use rtc_webrtc::libwebrtc::video_track::RtcVideoTrack;

/// The largest picture sent (H.264 level 5.1 holds 4096×2304).
const ABS_W: u32 = 4096;
const ABS_H: u32 = 2304;
/// Web viewers get at most this tall a picture, and this much data.
pub(crate) const WEB_MAX_HEIGHT: u32 = 1440;
pub(crate) const WEB_MAX_BPS: u32 = 12_000_000;
/// The sharer's own preview: about this many frames a second.
const PREVIEW_FPS: u32 = 10;
/// At most this many viewers get their own hardware encoder (GPUs limit encoding sessions).
pub(crate) const MAX_HW_VIEWERS: usize = 4;
/// How long a frame round waits for the hardware encoders' output.
const ENCODE_WAIT: Duration = Duration::from_millis(10);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The capture thread's shared settings, locked.
pub(crate) fn lock_shared(m: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    lock(m)
}

/// How the sharer shares: the tallest picture (0: the screen's own size) and frames a second.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenOptions {
    /// Lines (1080 for 1080p), 0 for the screen's own size.
    pub max_height: u32,
    /// 30 or 60.
    pub fps: u32,
}

impl Default for ScreenOptions {
    fn default() -> Self {
        Self {
            max_height: 0,
            fps: 60,
        }
    }
}

/// One picture, BGRA (what GPUI draws).
#[derive(Debug)]
pub struct ScreenFrame {
    /// Pixels across.
    pub width: u32,
    /// Pixels down.
    pub height: u32,
    /// `width * height * 4` bytes.
    pub bgra: Vec<u8>,
}

/// What a screen share looks like as it arrives (or as it's sent, for the sharer).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScreenStats {
    /// The picture's size as sent.
    pub width: u32,
    /// Lines.
    pub height: u32,
    /// Frames in the last second.
    pub fps: u32,
}

#[derive(Debug, Default)]
struct FeedInner {
    count: u64,
    frame: Option<Arc<ScreenFrame>>,
    /// The size it's shown at (physical pixels; 0: as sent).
    target: (u32, u32),
    stats: ScreenStats,
}

/// The latest picture of a screen share, for the UI to draw.
#[derive(Debug, Clone, Default)]
pub struct ScreenFeed(Arc<Mutex<FeedInner>>);

impl PartialEq for ScreenFeed {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl ScreenFeed {
    /// The newest frame and its number (it grows with every new frame).
    #[must_use]
    pub fn latest(&self) -> (u64, Option<Arc<ScreenFrame>>) {
        let g = lock(&self.0);
        (g.count, g.frame.clone())
    }

    /// The size the picture is shown at, in physical pixels: frames come scaled down to it
    /// (never up), so a 4K share in a small window costs little to draw.
    pub fn set_target(&self, width: u32, height: u32) {
        lock(&self.0).target = (width, height);
    }

    /// Size and frames a second as it arrives.
    #[must_use]
    pub fn stats(&self) -> ScreenStats {
        lock(&self.0).stats
    }

    fn target(&self) -> (u32, u32) {
        lock(&self.0).target
    }

    fn put(&self, f: ScreenFrame) {
        let mut g = lock(&self.0);
        g.count += 1;
        g.frame = Some(Arc::new(f));
    }

    fn set_stats(&self, s: ScreenStats) {
        lock(&self.0).stats = s;
    }
}

/// A screen or a window that can be shared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenSource {
    /// The capturer's id for it.
    pub id: u64,
    /// "Screen 1", or the window's title.
    pub title: String,
    /// A window (not a whole screen).
    pub window: bool,
}

fn capturer(window: bool) -> Option<DesktopCapturer> {
    let mut o = DesktopCapturerOptions::new(if window {
        DesktopCaptureSourceType::Window
    } else {
        DesktopCaptureSourceType::Screen
    });
    o.set_include_cursor(true);
    DesktopCapturer::new(o)
}

/// The screens, then the windows, that can be shared.
#[must_use]
pub fn screen_sources() -> Vec<ScreenSource> {
    let mut out = Vec::new();
    // windows too on Windows; on Linux (X11) listing windows can kill the process with an X error
    let kinds: &[bool] = if cfg!(windows) { &[false, true] } else { &[false] };
    for &window in kinds {
        let Some(c) = capturer(window) else { continue };
        for (n, s) in c.get_source_list().into_iter().enumerate() {
            let title = s.title();
            if window && title.trim().is_empty() {
                continue;
            }
            out.push(ScreenSource {
                id: s.id(),
                title: if window {
                    title
                } else if title.trim().is_empty() || title.trim().eq_ignore_ascii_case("screen") {
                    format!("Screen {}", n + 1)
                } else {
                    title
                },
                window,
            });
        }
    }
    out
}

/// Fits `w`×`h` within `max_w`×`max_h` (0: no limit that way), keeping the shape; even sizes
/// (I420 and H.264 want them). Never larger than it was.
pub(crate) fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let lim = |v: u32| if v == 0 { u32::MAX } else { v };
    let (mw, mh) = (lim(max_w), lim(max_h));
    if w <= mw && h <= mh {
        return ((w & !1).max(2), (h & !1).max(2));
    }
    let s = (f64::from(mw) / f64::from(w)).min(f64::from(mh) / f64::from(h));
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let scale = |v: u32| ((f64::from(v) * s).round() as u32) & !1;
    (scale(w).max(2), scale(h).max(2))
}

/// The tallest picture a viewer gets (0: no limit beyond the screen).
pub(crate) fn viewer_height(sharer: u32, desktop: bool, wanted: u32) -> u32 {
    [sharer, wanted, if desktop { 0 } else { WEB_MAX_HEIGHT }]
        .into_iter()
        .filter(|&v| v > 0)
        .min()
        .unwrap_or(0)
}

/// The most data a picture this size gets: about 0.1 bit a pixel (screens are mostly still,
/// but scrolling text needs it), from 2 Mbit/s up to 50.
pub(crate) fn bitrate_for(width: u32, height: u32, fps: u32) -> u32 {
    let bits = f64::from(width) * f64::from(height) * f64::from(fps.max(1)) * 0.1;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let b = bits as u32;
    b.clamp(2_000_000, 50_000_000)
}

/// How one viewer is sent our screen (the engine decides; the capture thread follows).
#[derive(Clone)]
pub(crate) struct Route {
    /// Who.
    pub(crate) peer: String,
    /// The tallest picture they get (0: as captured).
    pub(crate) max_height: u32,
    /// The most data a second.
    pub(crate) max_bps: u32,
    /// Hardware: their own pass-through source, which we encode for. `None`: software.
    pub(crate) encoded: Option<NativeVideoSource>,
}

/// What the engine and the capture thread share.
#[derive(Default)]
pub(crate) struct Shared {
    pub(crate) options: ScreenOptions,
    pub(crate) routes: Vec<Route>,
    /// The picture as captured, after the sharer's limit.
    pub(crate) size: (u32, u32),
    /// Whether this computer can encode with its GPU (known once tried).
    pub(crate) hardware: Option<bool>,
    /// The encoder's name ("NVIDIA H.264 Encoder MFT").
    pub(crate) encoder: String,
    /// Viewers whose hardware encoding failed: they go back to software.
    pub(crate) failed: HashSet<String>,
}

/// An H.264 encoder for one viewer.
trait Encoder {
    fn submit(&mut self, nv12: &[u8], timestamp_us: i64, keyframe: bool) -> Result<bool, String>;
    fn poll(&mut self) -> Result<Vec<EncodedUnit>, String>;
    fn set_bitrate(&mut self, bps: u32);
    fn size(&self) -> (u32, u32);
}

impl Encoder for H264Encoder {
    fn submit(&mut self, nv12: &[u8], timestamp_us: i64, keyframe: bool) -> Result<bool, String> {
        Self::submit(self, nv12, timestamp_us, keyframe)
    }
    fn poll(&mut self) -> Result<Vec<EncodedUnit>, String> {
        Self::poll(self)
    }
    fn set_bitrate(&mut self, bps: u32) {
        Self::set_bitrate(self, bps);
    }
    fn size(&self) -> (u32, u32) {
        Self::size(self)
    }
}

/// For tests (`RTC_TEST_H264=file.h264@1280x720`): plays an H.264 Annex B file's access units
/// (split at access unit delimiters, `-x264-params aud=1`) instead of encoding, in a loop.
struct FileEncoder {
    units: Vec<EncodedUnit>,
    at: usize,
    size: (u32, u32),
    ready: Vec<EncodedUnit>,
}

impl FileEncoder {
    fn open(spec: &str) -> Result<Self, String> {
        let (path, size) = spec.rsplit_once('@').ok_or("RTC_TEST_H264 is file@WxH")?;
        let (w, h) = size.split_once('x').ok_or("RTC_TEST_H264 is file@WxH")?;
        let size = (
            w.parse().map_err(|_| "bad width")?,
            h.parse().map_err(|_| "bad height")?,
        );
        let data = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        let units = split_access_units(&data);
        if units.is_empty() {
            return Err(format!("{path}: no access units"));
        }
        Ok(Self {
            units,
            at: 0,
            size,
            ready: Vec::new(),
        })
    }
}

impl Encoder for FileEncoder {
    fn submit(&mut self, _nv12: &[u8], _timestamp_us: i64, keyframe: bool) -> Result<bool, String> {
        if keyframe {
            // on to the next keyframe
            let n = self.units.len();
            if let Some(k) = (0..n).map(|i| (self.at + i) % n).find(|&i| self.units[i].key) {
                self.at = k;
            }
        }
        self.ready.push(self.units[self.at].clone());
        self.at = (self.at + 1) % self.units.len();
        Ok(true)
    }
    fn poll(&mut self) -> Result<Vec<EncodedUnit>, String> {
        Ok(std::mem::take(&mut self.ready))
    }
    fn set_bitrate(&mut self, _bps: u32) {}
    fn size(&self) -> (u32, u32) {
        self.size
    }
}

/// The NAL units of an Annex B access unit: (type, bytes with their start code).
fn nal_units(data: &[u8]) -> Vec<(u8, &[u8])> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            let code = if i > 0 && data[i - 1] == 0 { i - 1 } else { i };
            starts.push((code, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (n, &(code, body)) in starts.iter().enumerate() {
        let end = starts.get(n + 1).map_or(data.len(), |&(c, _)| c);
        if let Some(&b) = data.get(body) {
            out.push((b & 0x1f, &data[code..end]));
        }
    }
    out
}

/// A keyframe from the GPU must carry its parameter sets (SPS, PPS) so a viewer can start there;
/// some encoders send them only once. Those seen are kept and put in front of keyframes without
/// them. A unit with an IDR slice is a keyframe whatever the encoder said.
fn with_parameter_sets(mut u: EncodedUnit, params: &mut Vec<u8>) -> EncodedUnit {
    let nals = nal_units(&u.data);
    let idr = nals.iter().any(|(t, _)| *t == 5);
    let has_sets = nals.iter().any(|(t, _)| *t == 7) && nals.iter().any(|(t, _)| *t == 8);
    if has_sets {
        *params = nals
            .iter()
            .filter(|(t, _)| *t == 7 || *t == 8)
            .flat_map(|(_, b)| b.iter().copied())
            .collect();
    }
    u.key = u.key || idr;
    if u.key && !has_sets && !params.is_empty() {
        // after an access unit delimiter, if there is one
        let at = nals.first().filter(|(t, _)| *t == 9).map_or(0, |(_, b)| b.len());
        let mut data = Vec::with_capacity(u.data.len() + params.len());
        data.extend_from_slice(&u.data[..at]);
        data.extend_from_slice(params);
        data.extend_from_slice(&u.data[at..]);
        u.data = data;
    }
    u
}

/// Splits an Annex B stream into access units at its delimiters (NAL type 9); an access unit
/// with an IDR slice (type 5) is a keyframe.
fn split_access_units(data: &[u8]) -> Vec<EncodedUnit> {
    // NAL unit starts: the byte after each 00 00 01
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out: Vec<EncodedUnit> = Vec::new();
    let mut unit_from: Option<usize> = None;
    let mut key = false;
    for &s in &starts {
        let Some(&b) = data.get(s) else { continue };
        let kind = b & 0x1f;
        // where this NAL's start code begins (3 or 4 bytes)
        let code = if s >= 4 && data[s - 4] == 0 { s - 4 } else { s - 3 };
        if kind == 9 {
            if let Some(from) = unit_from {
                out.push(EncodedUnit {
                    data: data[from..code].to_vec(),
                    key,
                });
            }
            unit_from = Some(code);
            key = false;
        } else if kind == 5 {
            key = true;
        }
    }
    if let Some(from) = unit_from {
        out.push(EncodedUnit {
            data: data[from..].to_vec(),
            key,
        });
    }
    out
}

fn open_encoder(width: u32, height: u32, fps: u32, bps: u32) -> Result<(Box<dyn Encoder>, String), String> {
    if let Ok(spec) = std::env::var("RTC_TEST_H264") {
        return FileEncoder::open(&spec).map(|e| (Box::new(e) as Box<dyn Encoder>, "test file".to_owned()));
    }
    let e = H264Encoder::new(width, height, fps, bps)?;
    let name = e.name().to_owned();
    Ok((Box::new(e), name))
}

/// One viewer's hardware encoder.
struct Out {
    enc: Box<dyn Encoder>,
    source: NativeVideoSource,
    /// The size asked for (the encoder's may differ: the test file).
    want: (u32, u32),
    fps: u32,
    cap: u32,
    rate: u32,
    key: bool,
    /// The last parameter sets (SPS and PPS) the encoder gave, for keyframes without them.
    params: Vec<u8>,
}

/// Our screen being captured (dropping it stops).
pub(crate) struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    /// Our own picture, for the preview (its stats: what we send).
    pub(crate) preview: ScreenFeed,
    /// Viewers and settings, shared with the capture thread.
    pub(crate) shared: Arc<Mutex<Shared>>,
}

impl Capture {
    /// Starts capturing `what` (software viewers get it through `source`).
    pub(crate) fn start(
        what: &ScreenSource,
        source: NativeVideoSource,
        options: ScreenOptions,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let preview = ScreenFeed::default();
        let shared = Arc::new(Mutex::new(Shared {
            options,
            ..Shared::default()
        }));
        let (flag, feed, id, window, sh) = (
            Arc::clone(&stop),
            preview.clone(),
            what.id,
            what.window,
            Arc::clone(&shared),
        );
        let (ready, started) = std::sync::mpsc::channel::<Result<(), String>>();
        let thread = std::thread::Builder::new()
            .name("3rtc-screen".to_owned())
            .spawn(move || capture_loop(id, window, &source, &flag, &feed, &sh, &ready))
            .map_err(|e| e.to_string())?;
        match started.recv_timeout(Duration::from_secs(6)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(thread),
                preview,
                shared,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                stop.store(true, Ordering::Relaxed);
                Err("the screen capture didn't start".to_owned())
            }
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// BGRA (libyuv's "ARGB") → I420 at the frame's size.
fn to_i420(data: &[u8], stride: u32, w: u32, h: u32) -> I420Buffer {
    let mut full = I420Buffer::new(w, h);
    let (sy, su, sv) = full.strides();
    {
        let (y, u, v) = full.data_mut();
        #[allow(clippy::cast_possible_wrap)]
        yuv_helper::argb_to_i420(data, stride, y, sy, u, su, v, sv, w as i32, h as i32);
    }
    full
}

fn to_nv12(b: &I420Buffer) -> Vec<u8> {
    let (w, h) = (b.width(), b.height());
    let ysize = (w * h) as usize;
    let mut out = vec![0u8; ysize + ysize / 2];
    let (dy, duv) = out.split_at_mut(ysize);
    let (sy, su, sv) = b.strides();
    let (y, u, v) = b.data();
    #[allow(clippy::cast_possible_wrap)]
    yuv_helper::i420_to_nv12(y, sy, u, su, v, sv, dy, w, duv, w, w as i32, h as i32);
    out
}

fn bgra_of(b: &I420Buffer) -> ScreenFrame {
    let (w, h) = (b.width(), b.height());
    let mut bgra = vec![0u8; (w * h * 4) as usize];
    #[allow(clippy::cast_possible_wrap)]
    b.to_argb(VideoFormatType::ARGB, &mut bgra, w * 4, w as i32, h as i32);
    ScreenFrame {
        width: w,
        height: h,
        bgra,
    }
}

#[allow(clippy::too_many_lines)]
fn capture_loop(
    id: u64,
    window: bool,
    source: &NativeVideoSource,
    stop: &AtomicBool,
    preview: &ScreenFeed,
    shared: &Mutex<Shared>,
    ready: &std::sync::mpsc::Sender<Result<(), String>>,
) {
    let Some(mut c) = capturer(window) else {
        let _ = ready.send(Err("screen capture isn't available on this computer".to_owned()));
        return;
    };
    let chosen: Option<CaptureSource> = c.get_source_list().into_iter().find(|s| s.id() == id);
    if chosen.is_none() {
        let _ = ready.send(Err("that screen or window is gone".to_owned()));
        return;
    }
    // the capturer's callback (called inside `capture_frame`) leaves the picture here
    let slot: Arc<Mutex<Option<I420Buffer>>> = Arc::default();
    let failed = Arc::new(AtomicBool::new(false));
    let (put, fail) = (Arc::clone(&slot), Arc::clone(&failed));
    let opts = Arc::new(Mutex::new(lock(shared).options));
    let cb_opts = Arc::clone(&opts);
    c.start_capture(chosen, move |result| {
        let frame = match result {
            Ok(f) => f,
            Err(e) => {
                if e == rtc_webrtc::libwebrtc::desktop_capturer::CaptureError::Permanent {
                    fail.store(true, Ordering::Relaxed);
                }
                return;
            }
        };
        let (Ok(w), Ok(h)) = (u32::try_from(frame.width()), u32::try_from(frame.height())) else {
            return;
        };
        if w < 2 || h < 2 {
            return;
        }
        let stride = frame.stride();
        let mut full = to_i420(frame.data(), stride, w & !1, h & !1);
        let max_h = lock(&cb_opts).max_height;
        let (tw, th) = fit(w, h, ABS_W, if max_h == 0 { ABS_H } else { max_h.min(ABS_H) });
        if (tw, th) != (full.width(), full.height()) {
            full = full.scale(i32::try_from(tw).unwrap_or(2), i32::try_from(th).unwrap_or(2));
        }
        *lock(&put) = Some(full);
    });
    // can this computer encode with its GPU? (a small trial encoder)
    let probe = if let Ok(spec) = std::env::var("RTC_TEST_H264") {
        FileEncoder::open(&spec).map(|_| "test file".to_owned())
    } else {
        H264Encoder::new(1280, 720, 30, 2_000_000).map(|e| e.name().to_owned())
    };
    {
        let mut s = lock(shared);
        match probe {
            Ok(name) => {
                tracing::info!("screen: hardware encoding with {name}");
                s.hardware = Some(true);
                s.encoder = name;
            }
            Err(e) => {
                tracing::info!("screen: software encoding ({e})");
                s.hardware = Some(false);
            }
        }
    }
    let _ = ready.send(Ok(()));
    let started = Instant::now();
    let mut outs: HashMap<String, Out> = HashMap::new();
    let mut count: u64 = 0;
    let (mut second, mut in_second) = (Instant::now(), 0u32);
    while !stop.load(Ordering::Relaxed) && !failed.load(Ordering::Relaxed) {
        let t = Instant::now();
        let (options, routes) = {
            let s = lock(shared);
            (s.options, s.routes.clone())
        };
        *lock(&opts) = options;
        c.capture_frame();
        let Some(mut full) = lock(&slot).take() else {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        };
        count += 1;
        in_second += 1;
        let (fw, fh) = (full.width(), full.height());
        let ts = i64::try_from(started.elapsed().as_micros()).unwrap_or(0);
        lock(shared).size = (fw, fh);
        if second.elapsed() >= Duration::from_secs(1) {
            preview.set_stats(ScreenStats {
                width: fw,
                height: fh,
                fps: in_second,
            });
            (second, in_second) = (Instant::now(), 0);
        }
        let every = u64::from((options.fps / PREVIEW_FPS).max(1));
        if count % every == 1 || every == 1 {
            let small = fit(fw, fh, 1280, 720);
            let p = if small == (fw, fh) {
                bgra_of(&full)
            } else {
                bgra_of(&full.scale(
                    i32::try_from(small.0).unwrap_or(2),
                    i32::try_from(small.1).unwrap_or(2),
                ))
            };
            preview.put(p);
        }

        // ---- hardware viewers: each encoded at their size ----
        outs.retain(|peer, _| routes.iter().any(|r| r.encoded.is_some() && r.peer == *peer));
        let mut nv12_by_size: HashMap<(u32, u32), Vec<u8>> = HashMap::new();
        let mut gave: Vec<String> = Vec::new();
        for r in routes.iter().filter(|r| r.encoded.is_some()) {
            let want = fit(fw, fh, 0, r.max_height);
            let fps = options.fps;
            let rebuild = outs.get(&r.peer).is_none_or(|o| o.want != want || o.fps != fps);
            if rebuild {
                outs.remove(&r.peer);
                let rate = r.max_bps.min(6_000_000);
                match open_encoder(want.0, want.1, fps, rate) {
                    Ok((enc, name)) => {
                        lock(shared).encoder = name;
                        let Some(src) = r.encoded.clone() else { continue };
                        outs.insert(
                            r.peer.clone(),
                            Out {
                                enc,
                                source: src,
                                want,
                                fps,
                                cap: r.max_bps,
                                rate,
                                key: true,
                                params: Vec::new(),
                            },
                        );
                    }
                    Err(e) => {
                        tracing::info!("screen: no hardware encoder for {} ({e}); software", r.peer);
                        lock(shared).failed.insert(r.peer.clone());
                        continue;
                    }
                }
            }
            let Some(o) = outs.get_mut(&r.peer) else { continue };
            if o.cap != r.max_bps {
                o.cap = r.max_bps;
                o.rate = o.rate.min(o.cap);
                o.enc.set_bitrate(o.rate);
            }
            if o.source.take_keyframe_request() {
                o.key = true;
            }
            if let Some(rc) = o.source.take_rate_control_request() {
                #[allow(clippy::cast_possible_truncation)]
                let target = u32::try_from(rc.target_bitrate_bps)
                    .unwrap_or(u32::MAX)
                    .min(o.cap)
                    .max(300_000);
                if target.abs_diff(o.rate) > o.rate / 20 {
                    o.rate = target;
                    o.enc.set_bitrate(target);
                }
            }
            let nv12 = nv12_by_size.entry(want).or_insert_with(|| {
                if want == (fw, fh) {
                    to_nv12(&full)
                } else {
                    to_nv12(&full.scale(
                        i32::try_from(want.0).unwrap_or(2),
                        i32::try_from(want.1).unwrap_or(2),
                    ))
                }
            });
            match o.enc.submit(nv12, ts, o.key) {
                Ok(true) => {
                    o.key = false;
                    gave.push(r.peer.clone());
                }
                Ok(false) => {}
                Err(e) => {
                    tracing::warn!("screen: hardware encoder failed for {}: {e}", r.peer);
                    lock(shared).failed.insert(r.peer.clone());
                    outs.remove(&r.peer);
                }
            }
        }
        // collect what's done (the frames just given usually finish within a few ms)
        let wait_from = Instant::now();
        loop {
            let mut broken = Vec::new();
            for (peer, o) in &mut outs {
                match o.enc.poll() {
                    Ok(units) => {
                        if !units.is_empty() {
                            gave.retain(|p| p != peer);
                        }
                        let (w, h) = o.enc.size();
                        for u in units {
                            let u = with_parameter_sets(u, &mut o.params);
                            o.source.capture_encoded_frame(&EncodedVideoFrame {
                                codec: EncodedVideoCodec::H264,
                                payload: &u.data,
                                timestamp_us: ts,
                                frame_type: if u.key {
                                    EncodedFrameType::Key
                                } else {
                                    EncodedFrameType::Delta
                                },
                                resolution: VideoResolution { width: w, height: h },
                                frame_metadata: None,
                            });
                        }
                    }
                    Err(e) => {
                        tracing::warn!("screen: hardware encoder failed for {peer}: {e}");
                        broken.push(peer.clone());
                    }
                }
            }
            for p in broken {
                outs.remove(&p);
                gave.retain(|g| *g != p);
                lock(shared).failed.insert(p);
            }
            if gave.is_empty() || wait_from.elapsed() >= ENCODE_WAIT {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }

        // ---- software viewers: libwebrtc encodes the shared picture ----
        if routes.iter().any(|r| r.encoded.is_none()) {
            let mut vf = VideoFrame::new(VideoRotation::VideoRotation0, full);
            vf.timestamp_us = ts;
            source.capture_frame(&vf);
        } else {
            drop(full);
        }
        let tick = Duration::from_micros(1_000_000 / u64::from(options.fps.clamp(1, 60)));
        std::thread::sleep(tick.saturating_sub(t.elapsed()));
    }
    if failed.load(Ordering::Relaxed) {
        tracing::warn!("screen: the capture stopped (the window closed?)");
    }
}

/// A source for our screen (one per app; software viewers' senders carry its track).
pub(crate) fn new_source() -> NativeVideoSource {
    NativeVideoSource::new(
        VideoResolution {
            width: 1920,
            height: 1080,
        },
        true,
    )
}

/// A pass-through source for one hardware viewer.
pub(crate) fn new_encoded_source() -> NativeVideoSource {
    NativeVideoSource::new_encoded(VideoResolution {
        width: 1920,
        height: 1080,
    })
}

/// Decodes someone's shared screen into `feed` until dropped.
pub(crate) struct Watch {
    task: tokio::task::JoinHandle<()>,
}

impl Watch {
    pub(crate) fn start(track: RtcVideoTrack, feed: ScreenFeed) -> Self {
        let task = tokio::spawn(async move {
            use futures_util::StreamExt as _;
            let mut stream = NativeVideoStream::new(track);
            let (mut second, mut in_second) = (Instant::now(), 0u32);
            while let Some(frame) = stream.next().await {
                let b = &frame.buffer;
                let (w, h) = (b.width(), b.height());
                if w < 2 || h < 2 {
                    continue;
                }
                in_second += 1;
                if second.elapsed() >= Duration::from_secs(1) {
                    feed.set_stats(ScreenStats {
                        width: w,
                        height: h,
                        fps: in_second,
                    });
                    (second, in_second) = (Instant::now(), 0);
                }
                let (tw, th) = feed.target();
                let (sw, sh) = if tw >= 2 && th >= 2 {
                    fit(w, h, tw, th)
                } else {
                    (w, h)
                };
                let out = if (sw, sh) == (w & !1, h & !1) || (sw >= w && sh >= h) {
                    let mut bgra = vec![0u8; (w * h * 4) as usize];
                    #[allow(clippy::cast_possible_wrap)]
                    b.to_argb(VideoFormatType::ARGB, &mut bgra, w * 4, w as i32, h as i32);
                    ScreenFrame {
                        width: w,
                        height: h,
                        bgra,
                    }
                } else {
                    let mut i = b.to_i420();
                    bgra_of(&i.scale(i32::try_from(sw).unwrap_or(2), i32::try_from(sh).unwrap_or(2)))
                };
                feed.put(out);
            }
        });
        Self { task }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pictures_fit_keeping_their_shape() {
        assert_eq!(fit(1280, 720, 1920, 1080), (1280, 720));
        assert_eq!(fit(1281, 721, 1920, 1080), (1280, 720));
        assert_eq!(fit(3840, 2160, 1920, 1080), (1920, 1080));
        assert_eq!(fit(2560, 1600, 1920, 1080), (1728, 1080));
        assert_eq!(fit(5120, 1440, 1920, 1080), (1920, 540));
        // a height limit alone
        assert_eq!(fit(3840, 2160, 0, 1440), (2560, 1440));
        assert_eq!(fit(3840, 2160, 0, 0), (3840, 2160));
        assert_eq!(fit(1920, 1080, 0, 1440), (1920, 1080));
    }

    #[test]
    fn each_viewer_gets_the_smallest_limit() {
        // nobody limits a desktop viewer: the screen's own size
        assert_eq!(viewer_height(0, true, 0), 0);
        // the sharer says 1080p
        assert_eq!(viewer_height(1080, true, 0), 1080);
        // the viewer says 720p
        assert_eq!(viewer_height(1080, true, 720), 720);
        assert_eq!(viewer_height(0, true, 1440), 1440);
        // web viewers: 1440p at most
        assert_eq!(viewer_height(0, false, 0), WEB_MAX_HEIGHT);
        assert_eq!(viewer_height(1080, false, 0), 1080);
    }

    #[test]
    fn bigger_pictures_get_more_data() {
        assert_eq!(bitrate_for(3840, 2160, 60), 49_766_400);
        assert_eq!(bitrate_for(1920, 1080, 30), 6_220_800);
        assert_eq!(bitrate_for(1280, 720, 30), 2_764_800);
        assert_eq!(bitrate_for(640, 360, 30), 2_000_000);
        assert_eq!(bitrate_for(7680, 4320, 60), 50_000_000);
    }

    #[test]
    fn annex_b_splits_into_access_units() {
        let aud = [0u8, 0, 0, 1, 9, 0xf0];
        let sps = [0u8, 0, 0, 1, 0x67, 1, 2];
        let idr = [0u8, 0, 1, 0x65, 9, 9];
        let p = [0u8, 0, 0, 1, 0x41, 7, 7];
        let stream: Vec<u8> = [&aud[..], &sps, &idr, &aud, &p, &aud, &p].concat();
        let units = split_access_units(&stream);
        assert_eq!(units.len(), 3);
        assert!(units[0].key && !units[1].key && !units[2].key);
        assert_eq!(units[0].data, [&aud[..], &sps, &idr].concat());
        assert_eq!(units[1].data, [&aud[..], &p].concat());
    }

    #[test]
    fn keyframes_get_their_parameter_sets() {
        let aud = [0u8, 0, 0, 1, 9, 0xf0];
        let sps = [0u8, 0, 0, 1, 0x67, 1, 2];
        let pps = [0u8, 0, 0, 1, 0x68, 3];
        let idr = [0u8, 0, 0, 1, 0x65, 9, 9];
        let p = [0u8, 0, 0, 1, 0x41, 7, 7];
        let mut params = Vec::new();
        // the first keyframe has them: kept
        let first = EncodedUnit {
            data: [&aud[..], &sps, &pps, &idr].concat(),
            key: true,
        };
        let out = with_parameter_sets(first.clone(), &mut params);
        assert_eq!(out.data, first.data);
        assert_eq!(params, [&sps[..], &pps].concat());
        // a delta frame: as it was
        let d = with_parameter_sets(
            EncodedUnit {
                data: [&aud[..], &p].concat(),
                key: false,
            },
            &mut params,
        );
        assert!(!d.key && d.data == [&aud[..], &p].concat());
        // a later keyframe without them (and not flagged): they go in after the delimiter
        let k = with_parameter_sets(
            EncodedUnit {
                data: [&aud[..], &idr].concat(),
                key: false,
            },
            &mut params,
        );
        assert!(k.key);
        assert_eq!(k.data, [&aud[..], &sps, &pps, &idr].concat());
        // without a delimiter: in front
        let k = with_parameter_sets(
            EncodedUnit {
                data: idr.to_vec(),
                key: true,
            },
            &mut params,
        );
        assert_eq!(k.data, [&sps[..], &pps, &idr].concat());
    }
}
