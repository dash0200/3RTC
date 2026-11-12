//! The sound card through `cpal` (WASAPI shared mode on Windows): listing devices, and the
//! capture and render streams. The callbacks only convert, resample and move samples through
//! lock-free queues; everything else happens on the pipeline's own thread.

use std::str::FromStr as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread::Thread;

use cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};

use crate::dsp::{FRAME, RATE, Resampler, downmix};

/// A microphone or speaker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    /// Stable id (survives unplugging and restarts).
    pub id: String,
    /// What Windows calls it.
    pub name: String,
}

/// The microphones and speakers there are now.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Devices {
    /// Microphones.
    pub inputs: Vec<DeviceInfo>,
    /// Speakers and headphones.
    pub outputs: Vec<DeviceInfo>,
}

fn info(d: &cpal::Device) -> Option<DeviceInfo> {
    Some(DeviceInfo {
        id: d.id().ok()?.to_string(),
        name: d.description().ok()?.name().to_owned(),
    })
}

/// Lists the microphones and speakers.
#[must_use]
pub fn devices() -> Devices {
    let host = cpal::default_host();
    Devices {
        inputs: host
            .input_devices()
            .map(|ds| ds.filter_map(|d| info(&d)).collect())
            .unwrap_or_default(),
        outputs: host
            .output_devices()
            .map(|ds| ds.filter_map(|d| info(&d)).collect())
            .unwrap_or_default(),
    }
}

/// The id of the device Windows uses by default now.
pub(crate) fn default_id(input: bool) -> Option<String> {
    let host = cpal::default_host();
    let d = if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    }?;
    d.id().ok().map(|i| i.to_string())
}

/// The device with this id is plugged in.
pub(crate) fn exists(id: &str, input: bool) -> bool {
    let host = cpal::default_host();
    cpal::DeviceId::from_str(id)
        .ok()
        .and_then(|id| host.device_by_id(&id))
        .is_some_and(|d| {
            if input {
                d.supports_input()
            } else {
                d.supports_output()
            }
        })
}

/// The chosen device (by id) if it's there, else the default one.
fn pick(id: Option<&str>, input: bool) -> Option<cpal::Device> {
    let host = cpal::default_host();
    let chosen = id
        .and_then(|id| cpal::DeviceId::from_str(id).ok())
        .and_then(|id| host.device_by_id(&id));
    chosen.or_else(|| {
        if input {
            host.default_input_device()
        } else {
            host.default_output_device()
        }
    })
}

/// What a stream tells the pipeline: how late its samples are, and whether it broke.
#[derive(Debug, Default)]
pub(crate) struct StreamState {
    /// Device latency, in microseconds (capture: sound → callback; render: callback → sound).
    pub(crate) latency_us: AtomicU32,
    /// The device went away or failed: rebuild.
    pub(crate) broken: AtomicBool,
    /// Late callbacks (each a short glitch) so far.
    pub(crate) glitches: AtomicU32,
}

/// An open capture: the stream (keep it alive) and 48 kHz mono samples coming out of it.
pub(crate) struct Capture {
    _stream: cpal::Stream,
    pub(crate) samples: rtrb::Consumer<f32>,
    pub(crate) state: Arc<StreamState>,
    /// The device's own id (to notice a new default).
    pub(crate) device_id: Option<String>,
    pub(crate) name: String,
}

/// An open render: the stream (keep it alive) and the queue of 48 kHz mono samples it plays.
pub(crate) struct Render {
    _stream: cpal::Stream,
    pub(crate) samples: rtrb::Producer<f32>,
    pub(crate) state: Arc<StreamState>,
    pub(crate) device_id: Option<String>,
    pub(crate) name: String,
}

/// What a stream error means: a glitch to count, or a device to reopen.
fn on_stream_error(which: &str, e: &cpal::Error, state: &StreamState) {
    use cpal::ErrorKind;
    match e.kind() {
        // a late callback: one glitch, the stream carries on
        ErrorKind::Xrun => {
            let n = state.glitches.fetch_add(1, Ordering::Relaxed) + 1;
            if n == 1 || n.is_multiple_of(100) {
                tracing::info!("audio: {which}: {n} glitches (late audio callbacks) so far");
            }
        }
        // Windows moved the default stream to the new device by itself
        ErrorKind::DeviceChanged | ErrorKind::RealtimeDenied => {
            tracing::info!("audio: {which}: {e}");
        }
        _ => {
            tracing::warn!("audio: {which} stream: {e}");
            state.broken.store(true, Ordering::Relaxed);
        }
    }
}

/// Samples the capture and render queues hold (200 ms).
pub(crate) const RING: usize = FRAME * 20;
/// The most frames one callback is converted in at a time (no allocation in the callback).
const PIECE: usize = 1024;

/// Opens the microphone (`id`, or the default) and starts it.
pub(crate) fn open_capture(id: Option<&str>, worker: Thread) -> Result<Capture, String> {
    let device = pick(id, true).ok_or("no microphone")?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let config: StreamConfig = supported.config();
    let (tx, rx) = rtrb::RingBuffer::new(RING);
    let state = Arc::new(StreamState::default());
    let stream = match supported.sample_format() {
        SampleFormat::F32 => capture_stream::<f32>(&device, &config, tx, &state, worker),
        SampleFormat::I16 => capture_stream::<i16>(&device, &config, tx, &state, worker),
        SampleFormat::I32 => capture_stream::<i32>(&device, &config, tx, &state, worker),
        SampleFormat::U16 => capture_stream::<u16>(&device, &config, tx, &state, worker),
        other => return Err(format!("unsupported microphone format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    let name = device
        .description()
        .map(|d| d.name().to_owned())
        .unwrap_or_default();
    tracing::info!(
        "audio: microphone {name} ({} Hz, {} channels, {:?})",
        config.sample_rate,
        config.channels,
        supported.sample_format()
    );
    Ok(Capture {
        _stream: stream,
        samples: rx,
        state,
        device_id: device.id().ok().map(|i| i.to_string()),
        name,
    })
}

fn capture_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut tx: rtrb::Producer<f32>,
    state: &Arc<StreamState>,
    worker: Thread,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels.max(1));
    let mut resampler = Resampler::new(config.sample_rate, RATE);
    let mut mono = [0.0f32; PIECE];
    let mut wide = vec![0.0f32; PIECE * channels];
    let (on_data, on_error) = (Arc::clone(state), Arc::clone(state));
    device
        .build_input_stream::<T, _, _>(
            *config,
            move |data: &[T], info| {
                let ts = info.timestamp();
                let late = ts.callback.duration_since(ts.capture);
                on_data.latency_us.store(
                    u32::try_from(late.as_micros()).unwrap_or(u32::MAX),
                    Ordering::Relaxed,
                );
                for piece in data.chunks(PIECE * channels) {
                    for (w, s) in wide.iter_mut().zip(piece) {
                        *w = s.to_sample::<f32>();
                    }
                    let mut n = 0;
                    downmix(&wide[..piece.len()], channels, &mut |s| {
                        mono[n] = s;
                        n += 1;
                    });
                    resampler.process(&mono[..n], |s| {
                        let _ = tx.push(s);
                    });
                }
                worker.unpark();
            },
            move |e| on_stream_error("microphone", &e, &on_error),
            None,
        )
        .map_err(|e| e.to_string())
}

/// Opens the speakers (`id`, or the default) and starts them.
pub(crate) fn open_render(id: Option<&str>) -> Result<Render, String> {
    let device = pick(id, false).ok_or("no speakers")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let (tx, rx) = rtrb::RingBuffer::new(RING);
    let state = Arc::new(StreamState::default());
    // Windows converts any rate and format for us; ask for ours (no resampling here)
    let ours = StreamConfig {
        channels: supported.channels(),
        sample_rate: RATE,
        buffer_size: cpal::BufferSize::Default,
    };
    let stream = match render_stream::<f32>(&device, &ours, rx, &state) {
        Ok(s) => s,
        Err((rx, e)) => {
            // some drivers (and Linux) only take their own format: resample to it
            tracing::info!("audio: speakers want their own format ({e})");
            let native = supported.config();
            match supported.sample_format() {
                SampleFormat::F32 => render_stream::<f32>(&device, &native, rx, &state),
                SampleFormat::I16 => render_stream::<i16>(&device, &native, rx, &state),
                SampleFormat::I32 => render_stream::<i32>(&device, &native, rx, &state),
                other => return Err(format!("unsupported speaker format {other:?}")),
            }
            .map_err(|(_, e)| e)?
        }
    };
    stream.play().map_err(|e| e.to_string())?;
    let name = device
        .description()
        .map(|d| d.name().to_owned())
        .unwrap_or_default();
    tracing::info!("audio: speakers {name} ({} channels)", supported.channels());
    Ok(Render {
        _stream: stream,
        samples: tx,
        state,
        device_id: device.id().ok().map(|i| i.to_string()),
        name,
    })
}

/// A small first-in-first-out buffer of resampled samples for the render callback.
struct Fifo {
    buf: Vec<f32>,
    read: usize,
}

impl Fifo {
    fn len(&self) -> usize {
        self.buf.len() - self.read
    }

    fn pop(&mut self) -> f32 {
        let s = self.buf.get(self.read).copied().unwrap_or(0.0);
        self.read += 1;
        if self.read >= self.buf.len() {
            self.buf.clear();
            self.read = 0;
        }
        s
    }
}

fn render_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut rx: rtrb::Consumer<f32>,
    state: &Arc<StreamState>,
) -> Result<cpal::Stream, (rtrb::Consumer<f32>, String)>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels.max(1));
    let rate = config.sample_rate;
    let (on_data, on_error) = (Arc::clone(state), Arc::clone(state));
    // try it first with a throwaway queue, so the real one comes back on failure
    let probe = device.build_output_stream::<T, _, _>(*config, |_: &mut [T], _| {}, |_| {}, None);
    if let Err(e) = probe {
        return Err((rx, e.to_string()));
    }
    drop(probe);
    let mut resampler = (rate != RATE).then(|| Resampler::new(RATE, rate));
    let mut fifo = Fifo {
        buf: Vec::with_capacity(FRAME * 4),
        read: 0,
    };
    let mut frame = [0.0f32; FRAME];
    device
        .build_output_stream::<T, _, _>(
            *config,
            move |data: &mut [T], info| {
                let ts = info.timestamp();
                let ahead = ts.playback.duration_since(ts.callback);
                on_data.latency_us.store(
                    u32::try_from(ahead.as_micros()).unwrap_or(u32::MAX),
                    Ordering::Relaxed,
                );
                for out in data.chunks_mut(channels) {
                    let s = if let Some(r) = &mut resampler {
                        if fifo.len() == 0 {
                            // next 10 ms from the pipeline (silence if it's behind), resampled
                            for f in &mut frame {
                                *f = rx.pop().unwrap_or(0.0);
                            }
                            fifo.buf.clear();
                            fifo.read = 0;
                            r.process(&frame, |s| {
                                if fifo.buf.len() < fifo.buf.capacity() {
                                    fifo.buf.push(s);
                                }
                            });
                        }
                        fifo.pop()
                    } else {
                        rx.pop().unwrap_or(0.0)
                    };
                    let v = T::from_sample(s);
                    for c in out {
                        *c = v;
                    }
                }
            },
            move |e| on_stream_error("speakers", &e, &on_error),
            None,
        )
        .map_err(|e| (rtrb::RingBuffer::new(1).1, e.to_string()))
}
