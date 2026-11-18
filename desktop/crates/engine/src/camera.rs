//! Webcam (`features/camera/useCamera.ts`, `webrtc/cameraLine.ts`; ADR 0010).
//!
//! **On the wire** (as the web app): `camera: true` in `peer-identity`; between two such apps the
//! side that made the connection adds a second video line once (`peers.rs`), and turning the
//! camera on or off only starts or stops the pictures on it. `camera-status { on }` (the room
//! logic) says whose camera is on. A tile shows when the status says on and the picture is here.
//!
//! **Sending**: one camera source for the app (its track is on every camera line). The camera is
//! read by `rtc_platform_win::Camera` (Media Foundation) at up to 1080p, 30 fps, as NV12; the
//! headless test client uses a moving test pattern instead. libwebrtc encodes it per viewer:
//! - **desktop viewers** get it at full size and frame rate, the rate cap growing with the picture
//!   (owner's choice, 18 Nov: no compromise between desktop apps);
//! - **web viewers** get what the web app sends: at most 640×360, 24 fps, 350 kbps (scaled down
//!   for them by their sender's settings).
//!
//! **Our own tile**: a small mirrored copy of the pictures, about 15 a second.
//!
//! **Watching**: each person's camera track is decoded (only while their status says on) into a
//! [`ScreenFeed`], scaled down to the size it's shown at.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rtc_platform_win::{CameraError, CameraEvent, CameraFrame, CameraWant};
use rtc_webrtc::libwebrtc::prelude::{
    I420Buffer, NV12Buffer, VideoBuffer, VideoFrame, VideoResolution, VideoRotation,
};
use rtc_webrtc::libwebrtc::video_frame::native::VideoFrameBufferExt;
use rtc_webrtc::libwebrtc::video_source::native::NativeVideoSource;

use crate::screen::{ScreenFeed, ScreenFrame, bgra_of};

/// What a web viewer gets (`CAMERA_LIMITS` in `cameraLine.ts`).
pub(crate) const WEB_HEIGHT: u32 = 360;
pub(crate) const WEB_FPS: f64 = 24.0;
pub(crate) const WEB_BPS: u64 = 350_000;
/// What we ask the camera for: its best picture up to this (desktop viewers get all of it).
pub(crate) const WANT: CameraWant = CameraWant {
    width: 1920,
    height: 1080,
    fps: 30,
};
/// Our own tile's copy: about this many pictures a second, this wide at most.
const PREVIEW_FPS: u32 = 15;
const PREVIEW_WIDTH: u32 = 480;

/// Where the camera's pictures come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CameraChoice {
    /// A camera on this PC, by its id (`""`: the first one, the default).
    Device(String),
    /// A moving test pattern this size (the headless test client; no camera needed).
    TestPattern {
        /// Pixels across.
        width: u32,
        /// Lines.
        height: u32,
    },
}

/// The toast for a camera that wouldn't open (the web app's `cameraErrorText`; the blocked one in
/// Windows' words, ADR 0010).
#[must_use]
pub(crate) fn error_text(e: &CameraError) -> &'static str {
    match e {
        CameraError::NotFound => "No camera found",
        CameraError::Busy => "The camera is busy in another app",
        CameraError::Blocked => "Camera blocked: allow it in Windows Settings → Privacy → Camera",
        CameraError::Failed(_) => "Couldn’t start the camera",
    }
}

/// The data a desktop viewer's camera may use: grows with the picture (about 3 Mbit/s at 1080p30),
/// within 0.5–4 Mbit/s. The network's estimate decides within it.
#[must_use]
pub(crate) fn desktop_bitrate(width: u32, height: u32, fps: u32) -> u64 {
    let bits = u64::from(width) * u64::from(height) * u64::from(fps.clamp(1, 60)) / 20;
    bits.clamp(500_000, 4_000_000)
}

/// How much a web viewer's picture is scaled down: to 360 lines at most, never up.
#[must_use]
pub(crate) fn web_scale(height: u32) -> f64 {
    (f64::from(height) / f64::from(WEB_HEIGHT)).max(1.0)
}

/// What the capture says to the engine.
#[derive(Debug)]
pub(crate) enum Back {
    /// Pictures are coming: this size and frame rate, from this camera.
    Started {
        /// Pixels across.
        width: u32,
        /// Lines.
        height: u32,
        /// Frames a second.
        fps: u32,
    },
    /// It stopped: unplugged, taken by Windows, or never opened (why).
    Ended(Option<CameraError>),
}

/// A running capture (a camera or the test pattern). Dropping it stops it.
pub(crate) struct Capture {
    stop: Arc<AtomicBool>,
    _camera: Option<rtc_platform_win::Camera>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Turns camera pictures into what libwebrtc sends and our own tile shows.
struct Sink {
    source: NativeVideoSource,
    preview: ScreenFeed,
    started: Instant,
    last_preview: Option<Instant>,
}

impl Sink {
    /// One picture as NV12: to the camera track, and now and then to our tile.
    fn nv12(&mut self, f: &CameraFrame<'_>) {
        let (w, h) = (f.width & !1, f.height & !1);
        if w < 2 || h < 2 {
            return;
        }
        let mut buf = NV12Buffer::new(w, h);
        let (sy, suv) = buf.strides();
        {
            let (dy, duv) = buf.data_mut();
            if !copy_plane(f.y, f.stride as usize, dy, sy as usize, w as usize, h as usize)
                || !copy_plane(
                    f.uv,
                    f.stride as usize,
                    duv,
                    suv as usize,
                    w as usize,
                    h as usize / 2,
                )
            {
                return;
            }
        }
        self.preview_of(&buf);
        let mut vf = VideoFrame::new(VideoRotation::VideoRotation0, buf);
        vf.timestamp_us = i64::try_from(self.started.elapsed().as_micros()).unwrap_or(0);
        self.source.capture_frame(&vf);
    }

    /// One picture as I420 (the test pattern).
    fn i420(&mut self, buf: I420Buffer) {
        self.preview_of(&buf);
        let mut vf = VideoFrame::new(VideoRotation::VideoRotation0, buf);
        vf.timestamp_us = i64::try_from(self.started.elapsed().as_micros()).unwrap_or(0);
        self.source.capture_frame(&vf);
    }

    fn preview_of<B: VideoBuffer>(&mut self, b: &B) {
        let every = Duration::from_millis(u64::from(1000 / PREVIEW_FPS));
        if self.last_preview.is_some_and(|t| t.elapsed() < every) {
            return;
        }
        self.last_preview = Some(Instant::now());
        let (w, h) = (b.width(), b.height());
        let (tw, th) = crate::screen::fit(w, h, PREVIEW_WIDTH, 0);
        // (named: the buffer's own sealed trait has a method of the same name)
        let mut i = VideoFrameBufferExt::to_i420(b);
        let small = if (tw, th) == (w & !1, h & !1) {
            i
        } else {
            i.scale(i32::try_from(tw).unwrap_or(2), i32::try_from(th).unwrap_or(2))
        };
        let mut frame = bgra_of(&small);
        mirror(&mut frame);
        self.preview.put(frame);
    }
}

/// Copies `rows` rows of `width` bytes between planes with their own strides; false when either
/// plane is too short (a picture that doesn't add up is skipped, never read past).
fn copy_plane(
    src: &[u8],
    src_stride: usize,
    dst: &mut [u8],
    dst_stride: usize,
    width: usize,
    rows: usize,
) -> bool {
    if rows == 0 {
        return true;
    }
    let need = |stride: usize| stride * (rows - 1) + width;
    if src_stride < width
        || dst_stride < width
        || src.len() < need(src_stride)
        || dst.len() < need(dst_stride)
    {
        return false;
    }
    for r in 0..rows {
        dst[r * dst_stride..r * dst_stride + width]
            .copy_from_slice(&src[r * src_stride..r * src_stride + width]);
    }
    true
}

/// Flips a BGRA picture left to right (our own tile is a mirror, as on the web).
pub(crate) fn mirror(f: &mut ScreenFrame) {
    let row = f.width as usize * 4;
    if row == 0 {
        return;
    }
    for line in f.bgra.chunks_exact_mut(row) {
        let px = line.len() / 4;
        for i in 0..px / 2 {
            let j = px - 1 - i;
            for k in 0..4 {
                line.swap(i * 4 + k, j * 4 + k);
            }
        }
    }
}

/// The camera's source (one for the app; its track goes on every camera line).
pub(crate) fn new_source() -> NativeVideoSource {
    NativeVideoSource::new(
        VideoResolution {
            width: WANT.width,
            height: WANT.height,
        },
        false,
    )
}

/// Starts reading the camera (or the test pattern) into `source` and our tile's `preview`;
/// what happens to it comes back through `back`.
pub(crate) fn start(
    choice: &CameraChoice,
    source: NativeVideoSource,
    preview: ScreenFeed,
    back: impl Fn(Back) + Send + Sync + 'static,
) -> Capture {
    let stop = Arc::new(AtomicBool::new(false));
    let mut sink = Sink {
        source,
        preview,
        started: Instant::now(),
        last_preview: None,
    };
    match choice {
        &CameraChoice::TestPattern { width, height } => {
            let quit = Arc::clone(&stop);
            let size = ((width & !1).clamp(64, 1920), (height & !1).clamp(64, 1080));
            if let Err(e) = std::thread::Builder::new()
                .name("camera-test".into())
                .spawn(move || test_pattern(&mut sink, size, &quit, &back))
            {
                tracing::warn!("camera: no test pattern thread: {e}");
            }
            Capture { stop, _camera: None }
        }
        CameraChoice::Device(id) => {
            let quit = Arc::clone(&stop);
            let camera = rtc_platform_win::Camera::open(
                id,
                WANT,
                Box::new(move |f: &CameraFrame<'_>| {
                    if !quit.load(Ordering::Relaxed) {
                        sink.nv12(f);
                    }
                }),
                Box::new(move |e| {
                    back(match e {
                        CameraEvent::Started { width, height, fps } => Back::Started { width, height, fps },
                        CameraEvent::Stopped(err) => Back::Ended(err),
                    });
                }),
            );
            Capture {
                stop,
                _camera: Some(camera),
            }
        }
    }
}

/// A moving bar on grey, `size` at 24 fps, until stopped.
fn test_pattern(sink: &mut Sink, size: (u32, u32), stop: &AtomicBool, back: &(impl Fn(Back) + Send + Sync)) {
    let (w, h) = size;
    back(Back::Started {
        width: w,
        height: h,
        fps: 24,
    });
    let tick = Duration::from_micros(1_000_000 / 24);
    let mut n: u32 = 0;
    while !stop.load(Ordering::Relaxed) {
        let t = Instant::now();
        let mut b = I420Buffer::new(w, h);
        let (sy, su, sv) = b.strides();
        let (y, u, v) = b.data_mut();
        let bar = (n * 8) % w;
        for row in 0..h as usize {
            for col in 0..w as usize {
                let in_bar = (col as u32).wrapping_sub(bar) < 64;
                y[row * sy as usize + col] = if in_bar { 235 } else { 110 };
            }
        }
        for row in 0..(h / 2) as usize {
            u[row * su as usize..row * su as usize + (w / 2) as usize].fill(128);
            v[row * sv as usize..row * sv as usize + (w / 2) as usize].fill(160);
        }
        sink.i420(b);
        n = n.wrapping_add(1);
        std::thread::sleep(tick.saturating_sub(t.elapsed()));
    }
    back(Back::Ended(None));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_viewers_get_what_the_web_app_sends() {
        assert!((web_scale(1080) - 3.0).abs() < 1e-9);
        assert!((web_scale(720) - 2.0).abs() < 1e-9);
        assert!((web_scale(360) - 1.0).abs() < 1e-9);
        // a smaller camera isn't scaled up
        assert!((web_scale(240) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn desktop_viewers_get_more_data_for_bigger_pictures() {
        assert_eq!(desktop_bitrate(1920, 1080, 30), 3_110_400);
        assert_eq!(desktop_bitrate(1280, 720, 30), 1_382_400);
        assert_eq!(desktop_bitrate(640, 360, 30), 500_000);
        assert_eq!(desktop_bitrate(3840, 2160, 30), 4_000_000);
    }

    #[test]
    fn the_web_apps_error_texts() {
        assert_eq!(error_text(&CameraError::NotFound), "No camera found");
        assert_eq!(
            error_text(&CameraError::Busy),
            "The camera is busy in another app"
        );
        assert_eq!(
            error_text(&CameraError::Failed("x".into())),
            "Couldn’t start the camera"
        );
        assert!(error_text(&CameraError::Blocked).starts_with("Camera blocked"));
    }

    #[test]
    fn our_tile_is_a_mirror() {
        let mut f = ScreenFrame {
            width: 3,
            height: 1,
            bgra: vec![1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3],
        };
        mirror(&mut f);
        assert_eq!(f.bgra, vec![3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1]);
    }

    #[test]
    fn planes_are_copied_with_their_strides_and_never_read_past() {
        let src = [1u8, 2, 9, 3, 4, 9];
        let mut dst = [0u8; 4];
        assert!(copy_plane(&src, 3, &mut dst, 2, 2, 2));
        assert_eq!(dst, [1, 2, 3, 4]);
        // too short: skipped
        assert!(!copy_plane(&src[..4], 3, &mut dst, 2, 2, 2));
    }
}
