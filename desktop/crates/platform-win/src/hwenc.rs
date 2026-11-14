//! Hardware H.264 encoding for screen sharing (BUILD_SPEC 6.9: "hardware encode"): the GPU's
//! own encoder (NVIDIA NVENC, AMD AMF, Intel Quick Sync) through Media Foundation, so a 4K
//! screen at 60 frames a second costs the CPU almost nothing. Frames go in as NV12 (a full-size
//! luma plane, then half-size interleaved chroma); access units come out in Annex B form, ready
//! for libwebrtc's pass-through sender.
//!
//! Hardware encoders are asynchronous MFTs: they ask for input (`METransformNeedInput`) and say
//! when output is ready (`METransformHaveOutput`). [`H264Encoder::submit`] hands a frame over when
//! the encoder wants one (else drops it: the encoder is behind); [`H264Encoder::poll`] collects
//! what's finished, so one thread can drive several encoders at once. Use each from one thread.

use std::mem::ManuallyDrop;

use windows::Win32::Media::MediaFoundation::{
    CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonRateControlMode,
    CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize, CODECAPI_AVEncVideoForceKeyFrame,
    CODECAPI_AVLowLatencyMode, ICodecAPI, IMFActivate, IMFAttributes, IMFMediaEventGenerator, IMFMediaType,
    IMFSample, IMFTransform, METransformHaveOutput, METransformNeedInput, MF_E_NO_EVENTS_AVAILABLE,
    MF_E_TRANSFORM_NEED_MORE_INPUT, MF_E_TRANSFORM_STREAM_CHANGE, MF_EVENT_FLAG_NO_WAIT, MF_MT_AVG_BITRATE,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE,
    MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION,
    MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFMediaType_Video, MFSTARTUP_LITE,
    MFSampleExtension_CleanPoint, MFShutdown, MFStartup, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE,
    MFT_ENUM_FLAG_SORTANDFILTER, MFT_FRIENDLY_NAME_Attribute, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES,
    MFT_REGISTER_TYPE_INFO, MFTEnumEx, MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
    eAVEncCommonRateControlMode_CBR, eAVEncH264VProfile_High,
};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoTaskMemFree};
use windows::Win32::System::Variant::VARIANT;
use windows::core::{GUID, Interface, PWSTR};

use crate::video::EncodedUnit;

/// The GPU's H.264 encoder (dropping it stops it).
pub struct H264Encoder {
    mft: IMFTransform,
    events: Option<IMFMediaEventGenerator>,
    codec: Option<ICodecAPI>,
    name: String,
    width: u32,
    height: u32,
    fps: u32,
    /// Inputs the (asynchronous) encoder asked for and hasn't had yet.
    wanted: u32,
    provides_samples: bool,
    out_size: u32,
    /// Finished access units not yet collected.
    ready: Vec<EncodedUnit>,
}

impl std::fmt::Debug for H264Encoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("H264Encoder")
            .field("name", &self.name)
            .field("size", &(self.width, self.height))
            .finish_non_exhaustive()
    }
}

fn hr(what: &str, e: &windows::core::Error) -> String {
    format!("{what} ({e})")
}

fn pack(hi: u32, lo: u32) -> u64 {
    (u64::from(hi) << 32) | u64::from(lo)
}

/// The hardware H.264 encoders on this computer, best first.
fn hardware_encoders() -> Vec<IMFActivate> {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: Media Foundation fills `list` with `count` activation objects, freed below.
    let found = unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            None,
            Some(&raw const output),
            &raw mut list,
            &raw mut count,
        )
    };
    let mut out = Vec::new();
    if found.is_err() || list.is_null() {
        return out;
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
    // SAFETY: the array MFTEnumEx allocated (its entries were moved out above).
    unsafe { CoTaskMemFree(Some(list.cast())) };
    out
}

fn friendly_name(a: &IMFActivate) -> String {
    let mut p = PWSTR::null();
    let mut len = 0u32;
    // SAFETY: Media Foundation allocates the string; we copy it and free it.
    if unsafe { a.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &raw mut p, &raw mut len) }.is_err() {
        return "hardware H.264 encoder".to_owned();
    }
    // SAFETY: a valid NUL-terminated string from Media Foundation.
    let s = unsafe { p.to_string() }.unwrap_or_default();
    // SAFETY: allocated by Media Foundation with CoTaskMemAlloc.
    unsafe { CoTaskMemFree(Some(p.0.cast())) };
    s
}

fn set_guid(a: &IMFAttributes, key: &GUID, value: &GUID) -> windows::core::Result<()> {
    // SAFETY: a plain COM setter; both GUIDs are read during the call.
    unsafe { a.SetGUID(key, value) }
}

fn set_u32(a: &IMFAttributes, key: &GUID, value: u32) -> windows::core::Result<()> {
    // SAFETY: as above.
    unsafe { a.SetUINT32(key, value) }
}

fn set_u64(a: &IMFAttributes, key: &GUID, value: u64) -> windows::core::Result<()> {
    // SAFETY: as above.
    unsafe { a.SetUINT64(key, value) }
}

fn set_codec(codec: &ICodecAPI, api: &GUID, value: &VARIANT) {
    // SAFETY: a plain COM call; the encoder copies the value.
    if let Err(e) = unsafe { codec.SetValue(api, value) } {
        tracing::debug!("hwenc: codec setting {api:?}: {e}");
    }
}

impl H264Encoder {
    /// Opens the GPU's H.264 encoder for `width`×`height` at `fps`, starting at `bitrate` bits a
    /// second. `width` and `height` must be even.
    ///
    /// # Errors
    /// No hardware encoder (or none that takes this size).
    pub fn new(width: u32, height: u32, fps: u32, bitrate: u32) -> Result<Self, String> {
        // Media Foundation needs COM on this thread (already started is fine)
        // SAFETY: a plain call; the matching CoUninitialize is left to the thread's end.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        // SAFETY: balanced by MFShutdown in drop (Media Foundation counts start-ups).
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) }
            .map_err(|e| hr("Media Foundation didn't start", &e))?;
        let mut last = "no hardware H.264 encoder on this computer".to_owned();
        for a in hardware_encoders() {
            let name = friendly_name(&a);
            match Self::open(&a, &name, width, height, fps, bitrate) {
                Ok(enc) => {
                    tracing::info!("hwenc: {name} for {width}x{height} at {fps} fps");
                    return Ok(enc);
                }
                Err(e) => {
                    tracing::info!("hwenc: {name} refused: {e}");
                    last = format!("{name}: {e}");
                }
            }
        }
        // SAFETY: balances the MFStartup above (no encoder holds it).
        let _ = unsafe { MFShutdown() };
        Err(last)
    }

    fn open(
        a: &IMFActivate,
        name: &str,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
    ) -> Result<Self, String> {
        // SAFETY: creates the encoder this activation object describes.
        let mft: IMFTransform = unsafe { a.ActivateObject() }.map_err(|e| hr("couldn't start it", &e))?;
        // asynchronous encoders must be unlocked before use
        // SAFETY: plain COM calls on a live encoder.
        let attrs = unsafe { mft.GetAttributes() }.ok();
        let is_async = attrs
            .as_ref()
            // SAFETY: as above.
            .and_then(|at| unsafe { at.GetUINT32(&MF_TRANSFORM_ASYNC) }.ok())
            .is_some_and(|v| v != 0);
        if is_async && let Some(at) = &attrs {
            // SAFETY: as above.
            unsafe { at.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1) }
                .map_err(|e| hr("couldn't unlock it", &e))?;
        }
        let codec = mft.cast::<ICodecAPI>().ok();
        if let Some(c) = &codec {
            set_codec(c, &CODECAPI_AVLowLatencyMode, &VARIANT::from(true));
            #[allow(clippy::cast_sign_loss)]
            set_codec(
                c,
                &CODECAPI_AVEncCommonRateControlMode,
                &VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32),
            );
            set_codec(c, &CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate));
            set_codec(c, &CODECAPI_AVEncMPVDefaultBPictureCount, &VARIANT::from(0u32));
            // a keyframe every few seconds (and whenever a viewer asks)
            set_codec(
                c,
                &CODECAPI_AVEncMPVGOPSize,
                &VARIANT::from(fps.saturating_mul(4)),
            );
        }
        // output first (H.264 encoders want that order), then input
        // SAFETY: creates an empty media type.
        let out: IMFMediaType = unsafe { MFCreateMediaType() }.map_err(|e| hr("no media type", &e))?;
        let set = set_guid(&out, &MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .and_then(|()| set_guid(&out, &MF_MT_SUBTYPE, &MFVideoFormat_H264))
            .and_then(|()| set_u32(&out, &MF_MT_AVG_BITRATE, bitrate))
            .and_then(|()| set_u64(&out, &MF_MT_FRAME_SIZE, pack(width, height)))
            .and_then(|()| set_u64(&out, &MF_MT_FRAME_RATE, pack(fps, 1)))
            .and_then(|()| {
                set_u32(
                    &out,
                    &MF_MT_INTERLACE_MODE,
                    MFVideoInterlace_Progressive.0.cast_unsigned(),
                )
            })
            .and_then(|()| {
                set_u32(
                    &out,
                    &MF_MT_MPEG2_PROFILE,
                    eAVEncH264VProfile_High.0.cast_unsigned(),
                )
            });
        set.map_err(|e| hr("couldn't describe the output", &e))?;
        // SAFETY: a plain COM call; the encoder copies the type.
        unsafe { mft.SetOutputType(0, &out, 0) }.map_err(|e| hr("output type refused", &e))?;
        // SAFETY: as above.
        let input: IMFMediaType = unsafe { MFCreateMediaType() }.map_err(|e| hr("no media type", &e))?;
        let set = set_guid(&input, &MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .and_then(|()| set_guid(&input, &MF_MT_SUBTYPE, &MFVideoFormat_NV12))
            .and_then(|()| set_u64(&input, &MF_MT_FRAME_SIZE, pack(width, height)))
            .and_then(|()| set_u64(&input, &MF_MT_FRAME_RATE, pack(fps, 1)))
            .and_then(|()| set_u64(&input, &MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)))
            .and_then(|()| {
                set_u32(
                    &input,
                    &MF_MT_INTERLACE_MODE,
                    MFVideoInterlace_Progressive.0.cast_unsigned(),
                )
            });
        set.map_err(|e| hr("couldn't describe the input", &e))?;
        // SAFETY: as above.
        unsafe { mft.SetInputType(0, &input, 0) }.map_err(|e| hr("NV12 input refused", &e))?;
        // SAFETY: plain COM calls.
        let info = unsafe { mft.GetOutputStreamInfo(0) }.map_err(|e| hr("no output info", &e))?;
        #[allow(clippy::cast_sign_loss)]
        let provides_samples = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32) != 0;
        // SAFETY: as above.
        unsafe { mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0) }
            .map_err(|e| hr("couldn't start streaming", &e))?;
        // SAFETY: as above.
        unsafe { mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0) }
            .map_err(|e| hr("couldn't start streaming", &e))?;
        let events = if is_async {
            mft.cast::<IMFMediaEventGenerator>().ok()
        } else {
            None
        };
        Ok(Self {
            mft,
            events,
            codec,
            name: name.to_owned(),
            width,
            height,
            fps,
            wanted: 0,
            provides_samples,
            out_size: info.cbSize.max(width * height),
            ready: Vec::new(),
        })
    }

    /// Which encoder ("NVIDIA H.264 Encoder MFT", …).
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Frame size.
    #[must_use]
    pub const fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// A new target rate (the network's estimate).
    pub fn set_bitrate(&mut self, bps: u32) {
        if let Some(c) = &self.codec {
            set_codec(
                c,
                &CODECAPI_AVEncCommonMeanBitRate,
                &VARIANT::from(bps.max(100_000)),
            );
        }
    }

    /// Hands one NV12 frame to the encoder (`keyframe`: make it one). `false`: the encoder
    /// is still busy with earlier frames, so this one is dropped. What comes out is collected
    /// by [`Self::poll`] (usually a few milliseconds later).
    ///
    /// # Errors
    /// The encoder failed (the caller should fall back to software encoding).
    pub fn submit(&mut self, nv12: &[u8], timestamp_us: i64, keyframe: bool) -> Result<bool, String> {
        if self.events.is_some() {
            let mut ready = std::mem::take(&mut self.ready);
            let r = self.pump(&mut ready);
            self.ready = ready;
            r?;
            if self.wanted == 0 {
                return Ok(false);
            }
            self.wanted -= 1;
        }
        if keyframe && let Some(c) = &self.codec {
            set_codec(c, &CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
        }
        self.give(nv12, timestamp_us)?;
        if self.events.is_none() {
            while let Some(u) = self.take()? {
                self.ready.push(u);
            }
        }
        Ok(true)
    }

    /// The access units finished since the last call (oldest first).
    ///
    /// # Errors
    /// The encoder failed.
    pub fn poll(&mut self) -> Result<Vec<EncodedUnit>, String> {
        let mut ready = std::mem::take(&mut self.ready);
        self.pump(&mut ready)?;
        Ok(ready)
    }

    /// Handles the asynchronous encoder's events (input wanted, output ready).
    fn pump(&mut self, out: &mut Vec<EncodedUnit>) -> Result<(), String> {
        let Some(events) = self.events.clone() else {
            return Ok(());
        };
        loop {
            // SAFETY: a plain COM call; NO_WAIT returns at once.
            let ev = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(ev) => ev,
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                Err(e) => return Err(hr("encoder event", &e)),
            };
            // SAFETY: as above.
            let kind = unsafe { ev.GetType() }.map_err(|e| hr("event type", &e))?;
            #[allow(clippy::cast_sign_loss)]
            if kind == METransformNeedInput.0 as u32 {
                self.wanted += 1;
            } else if kind == METransformHaveOutput.0 as u32
                && let Some(u) = self.take()?
            {
                out.push(u);
            }
        }
    }

    fn give(&self, nv12: &[u8], timestamp_us: i64) -> Result<(), String> {
        let len = u32::try_from(nv12.len()).map_err(|_| "frame too big".to_owned())?;
        // SAFETY: a new buffer of `len` bytes.
        let buffer = unsafe { MFCreateMemoryBuffer(len) }.map_err(|e| hr("no buffer", &e))?;
        let mut p: *mut u8 = std::ptr::null_mut();
        // SAFETY: locks the buffer for writing; unlocked right after the copy.
        unsafe { buffer.Lock(&raw mut p, None, None) }.map_err(|e| hr("buffer lock", &e))?;
        // SAFETY: `p` points at `len` writable bytes until Unlock.
        unsafe { std::ptr::copy_nonoverlapping(nv12.as_ptr(), p, nv12.len()) };
        // SAFETY: balances the Lock above.
        let _ = unsafe { buffer.Unlock() };
        // SAFETY: plain COM calls on new objects.
        let sample: IMFSample = unsafe { MFCreateSample() }.map_err(|e| hr("no sample", &e))?;
        let ts = timestamp_us.saturating_mul(10);
        let dur = 10_000_000 / i64::from(self.fps.max(1));
        // SAFETY: plain COM calls on objects we own.
        unsafe { buffer.SetCurrentLength(len) }.map_err(|e| hr("sample setup", &e))?;
        // SAFETY: as above.
        unsafe { sample.AddBuffer(&buffer) }.map_err(|e| hr("sample setup", &e))?;
        // SAFETY: as above.
        unsafe { sample.SetSampleTime(ts) }.map_err(|e| hr("sample setup", &e))?;
        // SAFETY: as above.
        unsafe { sample.SetSampleDuration(dur) }.map_err(|e| hr("sample setup", &e))?;
        // SAFETY: the encoder takes its own reference to the sample.
        match unsafe { self.mft.ProcessInput(0, &sample, 0) } {
            Ok(()) => Ok(()),
            Err(e) => Err(hr("the encoder refused a frame", &e)),
        }
    }

    /// One finished access unit, if there is one.
    fn take(&mut self) -> Result<Option<EncodedUnit>, String> {
        let sample = if self.provides_samples {
            None
        } else {
            // SAFETY: new objects for the encoder to fill.
            let s: IMFSample = unsafe { MFCreateSample() }.map_err(|e| hr("no sample", &e))?;
            // SAFETY: as above.
            let b = unsafe { MFCreateMemoryBuffer(self.out_size) }.map_err(|e| hr("no buffer", &e))?;
            // SAFETY: as above.
            unsafe { s.AddBuffer(&b) }.map_err(|e| hr("sample setup", &e))?;
            Some(s)
        };
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        // SAFETY: one output buffer description for stream 0; its sample and events are taken
        // back below (ManuallyDrop, so they're released exactly once).
        let r = unsafe { self.mft.ProcessOutput(0, &mut buffers, &raw mut status) };
        let [b] = buffers;
        let sample = ManuallyDrop::into_inner(b.pSample);
        drop(ManuallyDrop::into_inner(b.pEvents));
        match r {
            Ok(()) => {}
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(None),
            Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                // the encoder changed its output format: take the one it offers
                // SAFETY: plain COM calls.
                if let Ok(t) = unsafe { self.mft.GetOutputAvailableType(0, 0) } {
                    // SAFETY: as above.
                    let _ = unsafe { self.mft.SetOutputType(0, &t, 0) };
                }
                return Ok(None);
            }
            Err(e) => return Err(hr("the encoder failed", &e)),
        }
        let Some(sample) = sample else { return Ok(None) };
        // SAFETY: plain COM calls on the finished sample.
        let key = unsafe { sample.GetUINT32(&MFSampleExtension_CleanPoint) }.is_ok_and(|v| v != 0);
        // SAFETY: as above.
        let buffer = unsafe { sample.ConvertToContiguousBuffer() }.map_err(|e| hr("output buffer", &e))?;
        let mut p: *mut u8 = std::ptr::null_mut();
        let mut len = 0u32;
        // SAFETY: locks the buffer for reading; unlocked after the copy.
        unsafe { buffer.Lock(&raw mut p, None, Some(&raw mut len)) }.map_err(|e| hr("output lock", &e))?;
        let n = usize::try_from(len).unwrap_or(0);
        // SAFETY: `p` points at `len` readable bytes until Unlock.
        let data = unsafe { std::slice::from_raw_parts(p, n) }.to_vec();
        // SAFETY: balances the Lock above.
        let _ = unsafe { buffer.Unlock() };
        Ok((!data.is_empty()).then_some(EncodedUnit { data, key }))
    }
}

impl Drop for H264Encoder {
    fn drop(&mut self) {
        self.events = None;
        self.codec = None;
        // SAFETY: balances the MFStartup in `new` (this encoder's).
        let _ = unsafe { MFShutdown() };
    }
}
