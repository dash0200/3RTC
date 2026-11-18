//! The webcam through Media Foundation (ADR 0010).
//!
//! A source reader on the chosen camera, with its advanced video processing on: whatever the
//! camera gives (MJPG, YUY2, NV12) comes out as NV12, so the rest of the app sees one format. The
//! camera's own mode is picked first ([`best_mode`]: the biggest picture up to what was asked, at
//! a smooth frame rate), so a 4K camera isn't asked for 4K. One thread per capture reads samples
//! in a loop until stopped; it owns every Media Foundation object it makes.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Foundation::E_ACCESSDENIED;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFMediaSource, IMFMediaType, IMFSample, IMFSourceReader,
    MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
    MF_E_HW_MFT_FAILED_START_STREAMING, MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR, MF_VERSION, MFCreateAttributes,
    MFCreateMediaType, MFCreateSourceReaderFromMediaSource, MFEnumDeviceSources, MFMediaType_Video,
    MFSTARTUP_LITE, MFShutdown, MFStartup, MFVideoFormat_NV12,
};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize};
use windows::core::{GUID, HRESULT, PWSTR};

use crate::camera_types::{
    CameraError, CameraEvent, CameraEvents, CameraFrame, CameraFrames, CameraInfo, CameraWant, best_mode,
};

/// `ERROR_SHARING_VIOLATION` as an HRESULT: another app holds the camera.
const SHARING_VIOLATION: HRESULT = HRESULT(0x8007_0020_u32.cast_signed());
/// `MF_E_VIDEO_RECORDING_DEVICE_PREEMPTED`: another app took the camera.
const PREEMPTED: HRESULT = HRESULT(0xC00D_3EA3_u32.cast_signed());

/// The source reader's first video stream.
#[allow(clippy::cast_sign_loss)]
const STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

/// What a Media Foundation error means for the user.
fn error_of(e: &windows::core::Error) -> CameraError {
    let code = e.code();
    if code == E_ACCESSDENIED {
        CameraError::Blocked
    } else if code == SHARING_VIOLATION || code == MF_E_HW_MFT_FAILED_START_STREAMING || code == PREEMPTED {
        CameraError::Busy
    } else if code == MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED {
        CameraError::NotFound
    } else {
        CameraError::Failed(e.to_string())
    }
}

fn pack(hi: u32, lo: u32) -> u64 {
    (u64::from(hi) << 32) | u64::from(lo)
}

#[allow(clippy::cast_possible_truncation)]
const fn unpack(v: u64) -> (u32, u32) {
    ((v >> 32) as u32, v as u32)
}

/// Media Foundation (and COM) started on this thread; undone when dropped.
struct MfThread {
    com: bool,
}

impl MfThread {
    fn start() -> Result<Self, CameraError> {
        // SAFETY: a plain call; balanced in drop when it succeeded.
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        // SAFETY: balanced by MFShutdown in drop (Media Foundation counts start-ups).
        if let Err(e) = unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) } {
            if com {
                // SAFETY: balances the CoInitializeEx above.
                unsafe { CoUninitialize() };
            }
            return Err(CameraError::Failed(format!(
                "Media Foundation didn't start ({e})"
            )));
        }
        Ok(Self { com })
    }
}

impl Drop for MfThread {
    fn drop(&mut self) {
        // SAFETY: balances the MFStartup in `start`.
        let _ = unsafe { MFShutdown() };
        if self.com {
            // SAFETY: balances the CoInitializeEx in `start`.
            unsafe { CoUninitialize() };
        }
    }
}

fn string_of(a: &IMFActivate, key: &GUID) -> Option<String> {
    let mut p = PWSTR::null();
    let mut len = 0u32;
    // SAFETY: Media Foundation allocates the string; we copy it and free it.
    unsafe { a.GetAllocatedString(key, &raw mut p, &raw mut len) }.ok()?;
    // SAFETY: a valid NUL-terminated string from Media Foundation.
    let s = unsafe { p.to_string() }.unwrap_or_default();
    // SAFETY: allocated by Media Foundation with CoTaskMemAlloc.
    unsafe { CoTaskMemFree(Some(p.0.cast())) };
    Some(s)
}

/// The video capture devices, in Windows' order (the first is the default).
fn devices() -> Result<Vec<IMFActivate>, CameraError> {
    let mut attrs: Option<IMFAttributes> = None;
    // SAFETY: Media Foundation makes the attribute store into `attrs`.
    unsafe { MFCreateAttributes(&raw mut attrs, 1) }.map_err(|e| error_of(&e))?;
    let attrs = attrs.ok_or_else(|| CameraError::Failed("no attribute store".into()))?;
    // SAFETY: a plain COM setter; both GUIDs are read during the call.
    unsafe {
        attrs.SetGUID(
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        )
    }
    .map_err(|e| error_of(&e))?;
    let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: Media Foundation fills `list` with `count` activation objects, freed below.
    unsafe { MFEnumDeviceSources(&attrs, &raw mut list, &raw mut count) }.map_err(|e| error_of(&e))?;
    let mut out = Vec::new();
    if list.is_null() {
        return Ok(out);
    }
    for i in 0..usize::try_from(count).unwrap_or(0) {
        // SAFETY: `i` is below the count Media Foundation gave.
        let slot = unsafe { list.add(i) };
        // SAFETY: a valid entry, taken out once (the array itself is freed below).
        let item = unsafe { std::ptr::read(slot) };
        if let Some(a) = item {
            out.push(a);
        }
    }
    // SAFETY: the array MFEnumDeviceSources allocated (its entries were moved out above).
    unsafe { CoTaskMemFree(Some(list.cast())) };
    Ok(out)
}

/// The cameras on this computer (empty when there are none, or Media Foundation is missing).
#[must_use]
pub fn cameras() -> Vec<CameraInfo> {
    let Ok(_mf) = MfThread::start() else {
        return Vec::new();
    };
    devices()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, a)| CameraInfo {
            id: string_of(a, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK).unwrap_or_default(),
            name: string_of(a, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)
                .unwrap_or_else(|| format!("Camera {}", i + 1)),
        })
        .filter(|c| !c.id.is_empty())
        .collect()
}

/// A camera being read. Dropping it stops it (the thread ends after the picture it waits for).
pub struct Camera {
    stop: Arc<AtomicBool>,
}

impl std::fmt::Debug for Camera {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Camera").finish_non_exhaustive()
    }
}

impl Drop for Camera {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Camera {
    /// Starts reading the camera `id` (from [`cameras`]; `""` or one that's gone: the first) at
    /// the mode closest to `want`, on its own thread. `events` hears `Started`, then `Stopped`
    /// (with why, if it failed); `frames` gets each picture as NV12.
    #[must_use]
    pub fn open(id: &str, want: CameraWant, frames: CameraFrames, events: CameraEvents) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let quit = Arc::clone(&stop);
        let id = id.to_owned();
        let spawned = std::thread::Builder::new().name("camera".into()).spawn(move || {
            let mut frames = frames;
            let result = run(&id, want, &mut frames, &events, &quit);
            events(CameraEvent::Stopped(result.err()));
        });
        if let Err(e) = spawned {
            tracing::warn!("camera: no thread: {e}");
        }
        Self { stop }
    }
}

/// The modes the camera offers: (its media type, width, height, frames a second).
fn native_modes(reader: &IMFSourceReader) -> Vec<(IMFMediaType, u32, u32, u32)> {
    let mut out = Vec::new();
    for i in 0..512 {
        // SAFETY: a plain COM call; an index past the last one is an error, which ends the loop.
        let Ok(t) = (unsafe { reader.GetNativeMediaType(STREAM, i) }) else {
            break;
        };
        // SAFETY: plain COM getters on a media type we hold.
        let (Ok(size), Ok(rate)) = (unsafe { t.GetUINT64(&MF_MT_FRAME_SIZE) }, unsafe {
            t.GetUINT64(&MF_MT_FRAME_RATE)
        }) else {
            continue;
        };
        let (w, h) = unpack(size);
        let (num, den) = unpack(rate);
        if w == 0 || h == 0 || den == 0 {
            continue;
        }
        out.push((t, w, h, num.div_ceil(den)));
    }
    out
}

/// The size the reader gives now.
fn current_size(reader: &IMFSourceReader) -> Option<(u32, u32)> {
    // SAFETY: a plain COM call.
    let t = unsafe { reader.GetCurrentMediaType(STREAM) }.ok()?;
    // SAFETY: a plain COM getter on a media type we hold.
    let size = unsafe { t.GetUINT64(&MF_MT_FRAME_SIZE) }.ok()?;
    Some(unpack(size))
}

fn run(
    id: &str,
    want: CameraWant,
    frames: &mut CameraFrames,
    events: &CameraEvents,
    stop: &AtomicBool,
) -> Result<(), CameraError> {
    let _mf = MfThread::start()?;
    let list = devices()?;
    let chosen = list
        .iter()
        .find(|a| {
            !id.is_empty()
                && string_of(a, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK).as_deref()
                    == Some(id)
        })
        .or_else(|| list.first())
        .ok_or(CameraError::NotFound)?;
    let name = string_of(chosen, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME).unwrap_or_default();
    // SAFETY: a plain COM call; the source is ours until shut down below.
    let source: IMFMediaSource = unsafe { chosen.ActivateObject() }.map_err(|e| error_of(&e))?;
    let result = read(&source, &name, want, frames, events, stop);
    // SAFETY: a plain COM call; the reader is gone, the source is ours to end.
    let _ = unsafe { source.Shutdown() };
    // SAFETY: as above.
    let _ = unsafe { chosen.ShutdownObject() };
    result
}

fn read(
    source: &IMFMediaSource,
    name: &str,
    want: CameraWant,
    frames: &mut CameraFrames,
    events: &CameraEvents,
    stop: &AtomicBool,
) -> Result<(), CameraError> {
    let mut attrs: Option<IMFAttributes> = None;
    // SAFETY: Media Foundation makes the attribute store into `attrs`.
    unsafe { MFCreateAttributes(&raw mut attrs, 1) }.map_err(|e| error_of(&e))?;
    let attrs = attrs.ok_or_else(|| CameraError::Failed("no attribute store".into()))?;
    // the reader decodes and converts to NV12 (and scales) itself
    // SAFETY: a plain COM setter.
    unsafe { attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1) }
        .map_err(|e| error_of(&e))?;
    // SAFETY: a plain COM call; the reader holds the source while it lives.
    let reader = unsafe { MFCreateSourceReaderFromMediaSource(source, &attrs) }.map_err(|e| error_of(&e))?;

    // the camera's own mode: the biggest picture up to `want`, at a smooth frame rate
    let modes = native_modes(&reader);
    let sizes: Vec<(u32, u32, u32)> = modes.iter().map(|(_, w, h, f)| (*w, *h, *f)).collect();
    let (w, h, fps) = match best_mode(&sizes, want) {
        Some(i) => {
            let (t, w, h, f) = &modes[i];
            // SAFETY: a plain COM call with a media type the reader gave.
            if let Err(e) = unsafe { reader.SetCurrentMediaType(STREAM, None, t) } {
                tracing::debug!("camera: mode {w}x{h}@{f}: {e}");
            }
            (*w, *h, (*f).min(want.fps))
        }
        None => (want.width, want.height, want.fps),
    };
    // what we take out: NV12 at that size
    // SAFETY: a plain call.
    let out = unsafe { MFCreateMediaType() }.map_err(|e| error_of(&e))?;
    // SAFETY: plain COM setters on a media type we made (each reads its arguments during the call).
    unsafe { out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video) }.map_err(|e| error_of(&e))?;
    // SAFETY: as above.
    unsafe { out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12) }.map_err(|e| error_of(&e))?;
    // SAFETY: as above.
    unsafe { out.SetUINT64(&MF_MT_FRAME_SIZE, pack(w & !1, h & !1)) }.map_err(|e| error_of(&e))?;
    // SAFETY: as above.
    unsafe { out.SetUINT64(&MF_MT_FRAME_RATE, pack(fps.max(1), 1)) }.map_err(|e| error_of(&e))?;
    // SAFETY: a plain COM call.
    unsafe { reader.SetCurrentMediaType(STREAM, None, &out) }.map_err(|e| error_of(&e))?;
    let (mut width, mut height) = current_size(&reader).unwrap_or((w & !1, h & !1));
    tracing::info!("camera: {name}: {width}x{height} at {fps} fps (NV12)");

    let mut started = false;
    while !stop.load(Ordering::Relaxed) {
        let mut flags = 0u32;
        let mut sample: Option<IMFSample> = None;
        // SAFETY: a plain (blocking) COM call writing into our locals.
        unsafe { reader.ReadSample(STREAM, 0, None, Some(&raw mut flags), None, Some(&raw mut sample)) }
            .map_err(|e| error_of(&e))?;
        #[allow(clippy::cast_sign_loss)]
        let has = |f: i32| flags & (f as u32) != 0;
        if has(MF_SOURCE_READERF_ERROR.0) {
            return Err(CameraError::Failed("the camera stopped with an error".into()));
        }
        if has(MF_SOURCE_READERF_ENDOFSTREAM.0) {
            return Ok(());
        }
        if has(MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0)
            && let Some((cw, ch)) = current_size(&reader)
        {
            (width, height) = (cw, ch);
        }
        let Some(sample) = sample else { continue };
        if !started {
            started = true;
            events(CameraEvent::Started { width, height, fps });
        }
        deliver(&sample, width, height, frames);
    }
    Ok(())
}

/// Hands one sample's picture to `frames` (a picture that doesn't add up is skipped).
fn deliver(sample: &IMFSample, width: u32, height: u32, frames: &mut CameraFrames) {
    // SAFETY: a plain COM call.
    let Ok(buffer) = (unsafe { sample.ConvertToContiguousBuffer() }) else {
        return;
    };
    let mut data: *mut u8 = std::ptr::null_mut();
    let mut len = 0u32;
    // SAFETY: locks the buffer; unlocked below before it can go away.
    if unsafe { buffer.Lock(&raw mut data, None, Some(&raw mut len)) }.is_err() || data.is_null() {
        return;
    }
    let (w, h) = (width as usize, height as usize);
    let luma = w * h;
    if len as usize >= luma + luma / 2 {
        // SAFETY: Media Foundation says `len` bytes at `data` are readable while locked; they are
        // only read until the Unlock below.
        let bytes = unsafe { std::slice::from_raw_parts(data, len as usize) };
        frames(&CameraFrame {
            width,
            height,
            stride: width,
            y: &bytes[..luma],
            uv: &bytes[luma..luma + luma / 2],
        });
    }
    // SAFETY: balances the Lock above.
    let _ = unsafe { buffer.Unlock() };
}
