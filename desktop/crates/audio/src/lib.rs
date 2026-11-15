//! Our own audio path (ADR 0003): the app captures the microphone and plays everyone itself,
//! and libwebrtc only carries the sound (Opus, jitter buffer, congestion control).
//!
//! ```text
//! mic ─► capture (cpal) ─► 48 kHz mono 10 ms ─► echo cancel (APM; reference = what we play)
//!     ─► RNNoise (Voice Isolation) ─► noise gate ─► level ─► the call
//!
//! person A ─► queue ─► volume A ┐
//! person B ─► queue ─► volume B ├► mix (stereo) ─► limiter ─► echo reference (mono)
//! screen sound (stereo) ────────┤                          ─► render (cpal) ─► speakers
//! test sound ───────────────────┘
//! ```
//!
//! The device callbacks only convert, resample and queue (lock-free, no allocation). The
//! processing runs on the pipeline's own thread, woken by the microphone and paced by the
//! speakers; with no speakers it keeps time on its own.

mod device;
pub mod dsp;
mod mix;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub use device::{DeviceInfo, Devices, devices};
pub use mix::{PeerControl, PeerFeed};

use device::{Capture, Render};
use dsp::{FRAME, NoiseGate, RATE, peak, to_f32, to_i16};

/// The echo canceller (libwebrtc's APM, from the `rtc` crate; a stand-in in tests). Both calls
/// come from the pipeline thread, one 10 ms frame at a time.
pub trait Echo: Send {
    /// What's about to be played (the reference to cancel).
    fn render(&mut self, frame: &mut [i16]);
    /// The microphone, cleaned in place; `delay_ms` is how long played sound takes to come back.
    fn capture(&mut self, frame: &mut [i16], delay_ms: i32);
}

/// Where the cleaned-up microphone goes (the call), one 10 ms frame at a time.
pub type Sink = Box<dyn FnMut(&[i16]) + Send>;

/// The speakers stay this far ahead (60 ms, stereo samples): enough to ride out a late wake-up.
const RENDER_AHEAD: usize = mix::OUT * 6;
/// How often the default devices are checked (to follow Windows when they change).
const DEFAULT_CHECK: Duration = Duration::from_secs(2);
/// Speakers whose queue stays full this long have stopped: reopen them.
const STALLED: Duration = Duration::from_millis(300);
/// Wait this long before reopening a device that broke.
const REOPEN_AFTER: Duration = Duration::from_millis(500);

enum Cmd {
    Active(bool),
    Live(bool),
    Deafened(bool),
    Isolation(bool),
    Input(Option<String>),
    Output(Option<String>),
    AddPeer(mix::PeerIn),
    RemovePeer(u64),
    Play(Arc<[f32]>, f32, bool),
    Stop,
}

/// What the app reads back.
#[derive(Debug, Default)]
struct Shared {
    /// The microphone's level after cleaning, 0..1, as `f32` bits (the meter).
    mic_level: AtomicU32,
    /// The microphone and speakers are open.
    capturing: AtomicBool,
    rendering: AtomicBool,
    /// The names of the open devices.
    names: Mutex<(String, String)>,
    /// One program's sound, mixed into what we send (BUILD_SPEC §9 feature 8).
    app: Mutex<AppBuf>,
}

/// One program's sound waiting to be sent (48 kHz mono).
#[derive(Debug, Default)]
struct AppBuf {
    on: bool,
    gain: f32,
    /// Enough has arrived to start (two frames), so short gaps don't stutter.
    primed: bool,
    samples: std::collections::VecDeque<f32>,
}

/// Most app sound kept waiting (300 ms): older goes, so it never lags behind.
const APP_MAX: usize = FRAME * 30;

/// Feeds one program's sound into what we send (the call hears it with our voice, also while
/// the microphone is muted).
#[derive(Clone)]
pub struct AppFeed(Arc<Shared>);

impl std::fmt::Debug for AppFeed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppFeed").finish_non_exhaustive()
    }
}

impl AppFeed {
    /// Sharing on or off, at `gain` (0..1).
    pub fn set(&self, on: bool, gain: f32) {
        let mut b = self.0.app.lock().unwrap_or_else(PoisonError::into_inner);
        b.on = on;
        b.gain = gain.clamp(0.0, 1.5);
        if !on {
            b.samples.clear();
            b.primed = false;
        }
    }

    /// More sound (48 kHz mono, -1..1), from the capture thread.
    pub fn push(&self, samples: &[f32]) {
        let mut b = self.0.app.lock().unwrap_or_else(PoisonError::into_inner);
        if !b.on {
            return;
        }
        b.samples.extend(samples.iter().copied());
        let extra = b.samples.len().saturating_sub(APP_MAX);
        b.samples.drain(..extra);
    }
}

impl Shared {
    /// The next 10 ms of app sound, if sharing and enough has arrived.
    fn app_frame(&self, out: &mut [f32; FRAME]) -> bool {
        let mut b = self.app.lock().unwrap_or_else(PoisonError::into_inner);
        if !b.on {
            return false;
        }
        if !b.primed {
            if b.samples.len() < FRAME * 2 {
                return false;
            }
            b.primed = true;
            tracing::info!("audio: app sound flowing into the call");
        }
        if b.samples.len() < FRAME {
            b.primed = false;
            return false;
        }
        let gain = b.gain;
        for (o, s) in out.iter_mut().zip(b.samples.drain(..FRAME)) {
            *o = s * gain;
        }
        true
    }
}

/// The audio pipeline. Dropping it stops everything.
pub struct Audio {
    cmds: Sender<Cmd>,
    shared: Arc<Shared>,
    peers: Mutex<HashMap<u64, Arc<PeerControl>>>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Audio {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Audio").finish_non_exhaustive()
    }
}

/// How the pipeline starts.
#[derive(Debug, Clone, Default)]
pub struct Config {
    /// Microphone id (`None`: the system default, followed when it changes).
    pub input: Option<String>,
    /// Speaker id (`None`: the system default, followed when it changes).
    pub output: Option<String>,
    /// RNNoise and the noise gate on the microphone.
    pub isolation: bool,
}

impl Audio {
    /// Starts the pipeline thread (devices open once [`Audio::set_active`] says so).
    #[must_use]
    pub fn start(config: Config, echo: Box<dyn Echo>, sink: Sink) -> Self {
        let (tx, rx) = channel();
        let shared = Arc::new(Shared::default());
        let thread = {
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("3rtc-audio".to_owned())
                .spawn(move || Pipeline::new(config, echo, sink, shared).run(&rx))
                .ok()
        };
        if thread.is_none() {
            tracing::error!("audio: couldn't start the pipeline thread");
        }
        Self {
            cmds: tx,
            shared,
            peers: Mutex::new(HashMap::new()),
            thread,
        }
    }

    fn send(&self, c: Cmd) {
        let _ = self.cmds.send(c);
        if let Some(t) = &self.thread {
            t.thread().unpark();
        }
    }

    /// Open the devices (in a room, or while Voice settings is open) or close them.
    pub fn set_active(&self, on: bool) {
        self.send(Cmd::Active(on));
    }

    /// Send the microphone to the call (unmuted) or not.
    pub fn set_live(&self, on: bool) {
        self.send(Cmd::Live(on));
    }

    /// Play nobody (our own sounds still play).
    pub fn set_deafened(&self, on: bool) {
        self.send(Cmd::Deafened(on));
    }

    /// RNNoise and the noise gate on or off.
    pub fn set_isolation(&self, on: bool) {
        self.send(Cmd::Isolation(on));
    }

    /// Use this microphone (`None`: the default).
    pub fn set_input(&self, id: Option<String>) {
        self.send(Cmd::Input(id));
    }

    /// Use these speakers (`None`: the default).
    pub fn set_output(&self, id: Option<String>) {
        self.send(Cmd::Output(id));
    }

    /// Someone to play: their feed (push their decoded voice into it) and their volume.
    pub fn add_peer(&self, key: u64) -> (PeerFeed, Arc<PeerControl>) {
        let (feed, input) = mix::peer(key);
        let control = Arc::clone(&input.control);
        self.peers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, Arc::clone(&control));
        self.send(Cmd::AddPeer(input));
        (feed, control)
    }

    /// A shared screen's sound to play, in stereo: its feed (push left and right interleaved)
    /// and its volume. Removed with [`Self::remove_peer`].
    pub fn add_stereo_peer(&self, key: u64) -> (PeerFeed, Arc<PeerControl>) {
        let (feed, input) = mix::stereo_peer(key);
        let control = Arc::clone(&input.control);
        self.peers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, Arc::clone(&control));
        self.send(Cmd::AddPeer(input));
        (feed, control)
    }

    /// Stop playing someone.
    pub fn remove_peer(&self, key: u64) {
        self.peers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key);
        self.send(Cmd::RemovePeer(key));
    }

    /// Someone's volume and level.
    #[must_use]
    pub fn peer(&self, key: u64) -> Option<Arc<PeerControl>> {
        self.peers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .cloned()
    }

    /// Plays `sound` (48 kHz mono) once at `gain`, mixed in, while deafened too. With
    /// `replace`, the last sound played with `replace` stops first (the soundboard).
    pub fn play(&self, sound: Arc<[f32]>, gain: f32, replace: bool) {
        self.send(Cmd::Play(sound, gain, replace));
    }

    /// The microphone's level after cleaning, 0..1 (for the meter).
    #[must_use]
    pub fn mic_level(&self) -> f32 {
        f32::from_bits(self.shared.mic_level.load(Ordering::Relaxed))
    }

    /// A handle that reads the microphone's level from anywhere (the window's meter).
    #[must_use]
    pub fn meter(&self) -> Meter {
        Meter(Arc::clone(&self.shared))
    }

    /// A handle that feeds one program's sound into what we send.
    #[must_use]
    pub fn app_feed(&self) -> AppFeed {
        AppFeed(Arc::clone(&self.shared))
    }

    /// Whether the microphone and the speakers are open.
    #[must_use]
    pub fn open(&self) -> (bool, bool) {
        (
            self.shared.capturing.load(Ordering::Relaxed),
            self.shared.rendering.load(Ordering::Relaxed),
        )
    }

    /// The names of the microphone and speakers in use.
    #[must_use]
    pub fn device_names(&self) -> (String, String) {
        self.shared
            .names
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.send(Cmd::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Reads the microphone's level (cheap: one atomic load).
#[derive(Clone)]
pub struct Meter(Arc<Shared>);

impl std::fmt::Debug for Meter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Meter").finish_non_exhaustive()
    }
}

impl Meter {
    /// The microphone's level after cleaning, 0..1 (0 when it's closed).
    #[must_use]
    pub fn level(&self) -> f32 {
        f32::from_bits(self.0.mic_level.load(Ordering::Relaxed))
    }
}

/// The pipeline thread's state.
struct Pipeline {
    config: Config,
    echo: Box<dyn Echo>,
    sink: Sink,
    shared: Arc<Shared>,
    mixer: mix::Mixer,
    denoise: Box<nnnoiseless::DenoiseState<'static>>,
    gate: NoiseGate,
    capture: Option<Capture>,
    render: Option<Render>,
    active: bool,
    live: bool,
    deafened: bool,
    /// When the devices may be (re)opened next.
    retry_at: Instant,
    checked_defaults: Instant,
    /// With no speakers: when the next frame is due.
    clock: Instant,
    /// Since when the speakers' queue has been full (they stopped taking sound).
    stalled_since: Option<Instant>,
}

impl Pipeline {
    fn new(config: Config, echo: Box<dyn Echo>, sink: Sink, shared: Arc<Shared>) -> Self {
        let now = Instant::now();
        Self {
            config,
            echo,
            sink,
            shared,
            mixer: mix::Mixer::new(),
            denoise: nnnoiseless::DenoiseState::new(),
            gate: NoiseGate::default(),
            capture: None,
            render: None,
            active: false,
            live: false,
            deafened: false,
            retry_at: now,
            checked_defaults: now,
            clock: now,
            stalled_since: None,
        }
    }

    fn run(mut self, cmds: &Receiver<Cmd>) {
        loop {
            loop {
                match cmds.try_recv() {
                    Ok(Cmd::Stop) | Err(TryRecvError::Disconnected) => return,
                    Ok(c) => self.command(c),
                    Err(TryRecvError::Empty) => break,
                }
            }
            if self.active {
                self.keep_devices_open();
            }
            self.render_frames();
            self.capture_frames();
            // woken by the microphone's callback or a command; 5 ms at most otherwise
            std::thread::park_timeout(Duration::from_millis(5));
        }
    }

    fn command(&mut self, c: Cmd) {
        match c {
            Cmd::Active(on) => {
                self.active = on;
                if !on {
                    self.close();
                }
            }
            Cmd::Live(on) => self.live = on,
            Cmd::Deafened(on) => self.deafened = on,
            Cmd::Isolation(on) => self.config.isolation = on,
            Cmd::Input(id) => {
                self.config.input = id;
                self.capture = None;
                self.retry_at = Instant::now();
            }
            Cmd::Output(id) => {
                self.config.output = id;
                self.render = None;
                self.retry_at = Instant::now();
            }
            Cmd::AddPeer(p) => {
                self.mixer.peers.retain(|q| q.key != p.key);
                self.mixer.peers.push(p);
            }
            Cmd::RemovePeer(key) => self.mixer.peers.retain(|p| p.key != key),
            Cmd::Play(sound, gain, replace) => self.mixer.play(sound, gain, replace),
            Cmd::Stop => {}
        }
    }

    fn close(&mut self) {
        self.capture = None;
        self.render = None;
        self.shared.capturing.store(false, Ordering::Relaxed);
        self.shared.rendering.store(false, Ordering::Relaxed);
        self.shared.mic_level.store(0, Ordering::Relaxed);
    }

    /// Opens what's missing or broken, and follows Windows to a new default device.
    fn keep_devices_open(&mut self) {
        let now = Instant::now();
        if self
            .capture
            .as_ref()
            .is_some_and(|c| c.state.broken.load(Ordering::Relaxed))
        {
            tracing::info!("audio: the microphone went away; reopening");
            self.capture = None;
            self.retry_at = now + REOPEN_AFTER;
        }
        if self
            .render
            .as_ref()
            .is_some_and(|r| r.state.broken.load(Ordering::Relaxed))
        {
            tracing::info!("audio: the speakers went away; reopening");
            self.render = None;
            self.retry_at = now + REOPEN_AFTER;
        }
        if now.duration_since(self.checked_defaults) >= DEFAULT_CHECK {
            self.checked_defaults = now;
            if self.config.input.is_none()
                && let Some(c) = &self.capture
                && device::default_id(true).is_some_and(|d| Some(&d) != c.device_id.as_ref())
            {
                tracing::info!("audio: Windows has a new default microphone; switching");
                self.capture = None;
            }
            if self.config.output.is_none()
                && let Some(r) = &self.render
                && device::default_id(false).is_some_and(|d| Some(&d) != r.device_id.as_ref())
            {
                tracing::info!("audio: Windows has new default speakers; switching");
                self.render = None;
            }
            // the device picked in settings was gone (we fell back to the default): back on it
            if let Some(want) = &self.config.input
                && let Some(c) = &self.capture
                && c.device_id.as_ref() != Some(want)
                && device::exists(want, true)
            {
                tracing::info!("audio: the chosen microphone is back; switching to it");
                self.capture = None;
            }
            if let Some(want) = &self.config.output
                && let Some(r) = &self.render
                && r.device_id.as_ref() != Some(want)
                && device::exists(want, false)
            {
                tracing::info!("audio: the chosen speakers are back; switching to them");
                self.render = None;
            }
        }
        if now < self.retry_at {
            return;
        }
        let mut failed = false;
        if self.capture.is_none() {
            match device::open_capture(self.config.input.as_deref(), std::thread::current()) {
                Ok(c) => self.capture = Some(c),
                Err(e) => {
                    tracing::warn!("audio: couldn't open the microphone: {e}");
                    failed = true;
                }
            }
        }
        if self.render.is_none() {
            match device::open_render(self.config.output.as_deref()) {
                Ok(r) => {
                    self.render = Some(r);
                    self.clock = Instant::now();
                }
                Err(e) => {
                    tracing::warn!("audio: couldn't open the speakers: {e}");
                    failed = true;
                }
            }
        }
        if failed {
            self.retry_at = now + Duration::from_secs(3);
        }
        self.shared
            .capturing
            .store(self.capture.is_some(), Ordering::Relaxed);
        self.shared
            .rendering
            .store(self.render.is_some(), Ordering::Relaxed);
        *self.shared.names.lock().unwrap_or_else(PoisonError::into_inner) = (
            self.capture.as_ref().map(|c| c.name.clone()).unwrap_or_default(),
            self.render.as_ref().map(|r| r.name.clone()).unwrap_or_default(),
        );
    }

    /// Mixes as many frames as the speakers have room for (keeping ~30 ms queued). With no
    /// speakers open, one frame per 10 ms of wall time keeps the queues and echo reference moving.
    fn render_frames(&mut self) {
        // speakers that stopped taking sound (a stuck driver): reopen them, and keep time
        // ourselves meanwhile, so everyone's queue and the echo reference keep moving
        let full = self.render.as_ref().is_some_and(|r| r.samples.slots() < mix::OUT);
        match (full, self.stalled_since) {
            (false, _) => self.stalled_since = None,
            (true, None) => self.stalled_since = Some(Instant::now()),
            (true, Some(since)) if since.elapsed() > STALLED => {
                tracing::info!("audio: the speakers stopped taking sound; reopening");
                self.render = None;
                self.stalled_since = None;
                self.clock = Instant::now();
                self.retry_at = Instant::now() + REOPEN_AFTER;
            }
            (true, Some(_)) => {}
        }
        let mut frame = [0.0f32; mix::OUT];
        loop {
            let due = match &self.render {
                Some(r) => r.samples.slots() >= mix::OUT && RING_CAP - r.samples.slots() < RENDER_AHEAD,
                None => {
                    let now = Instant::now();
                    if now.duration_since(self.clock) > Duration::from_millis(200) {
                        self.clock = now; // fell far behind (asleep): don't catch up
                    }
                    if now >= self.clock {
                        self.clock += Duration::from_millis(10);
                        true
                    } else {
                        false
                    }
                }
            };
            if !due {
                return;
            }
            self.mixer.next(self.deafened, &mut frame);
            // the echo canceller hears what's played, both sides together
            let mut reference = [0i16; FRAME];
            for (r, pair) in reference.iter_mut().zip(frame.chunks_exact(2)) {
                *r = to_i16((pair[0] + pair[1]) * 0.5);
            }
            self.echo.render(&mut reference);
            if let Some(r) = &mut self.render {
                let _ = r.samples.push_partial_slice(&frame);
            }
        }
    }

    /// How long played sound takes to come back to the microphone (ms): what's queued for the
    /// speakers, their latency, the microphone's latency and what's queued from it.
    fn echo_delay_ms(&self) -> i32 {
        let queued_out = self.render.as_ref().map_or(0, |r| RING_CAP - r.samples.slots());
        let queued_in = self.capture.as_ref().map_or(0, |c| c.samples.slots());
        let out_us = self
            .render
            .as_ref()
            .map_or(0, |r| r.state.latency_us.load(Ordering::Relaxed));
        let in_us = self
            .capture
            .as_ref()
            .map_or(0, |c| c.state.latency_us.load(Ordering::Relaxed));
        let samples_ms = (queued_out / 2 + queued_in) / (RATE as usize / 1000);
        i32::try_from(samples_ms).unwrap_or(0) + i32::try_from((out_us + in_us) / 1000).unwrap_or(0)
    }

    /// Cleans every full 10 ms frame the microphone has delivered and sends it to the call.
    fn capture_frames(&mut self) {
        let mut raw = [0.0f32; FRAME];
        let mut pcm = [0i16; FRAME];
        let mut clean = [0.0f32; FRAME];
        loop {
            let Some(c) = &mut self.capture else { return };
            let Ok(chunk) = c.samples.read_chunk(FRAME) else {
                return;
            };
            let (a, b) = chunk.as_slices();
            for (r, s) in raw.iter_mut().zip(a.iter().chain(b)) {
                *r = *s;
            }
            chunk.commit_all();
            for (p, s) in pcm.iter_mut().zip(&raw) {
                *p = to_i16(*s);
            }
            let delay = self.echo_delay_ms();
            self.echo.capture(&mut pcm, delay);
            if self.config.isolation {
                // RNNoise works on 480 samples at 48 kHz, in 16-bit units
                let mut input = [0.0f32; FRAME];
                for (i, s) in input.iter_mut().zip(&pcm) {
                    *i = f32::from(*s);
                }
                let voice = self.denoise.process_frame(&mut clean, &input);
                for c in &mut clean {
                    *c /= 32_768.0;
                }
                self.gate.process(&mut clean, voice);
                for (p, s) in pcm.iter_mut().zip(&clean) {
                    *p = to_i16(*s);
                }
            } else {
                for (c, s) in clean.iter_mut().zip(&pcm) {
                    *c = to_f32(*s);
                }
            }
            self.shared
                .mic_level
                .store(peak(&clean).to_bits(), Ordering::Relaxed);
            let mut app = [0.0f32; FRAME];
            let sharing = self.shared.app_frame(&mut app);
            if sharing {
                // the program's sound goes out with our voice, or alone while muted
                for (p, a) in pcm.iter_mut().zip(&app) {
                    let voice = if self.live { to_f32(*p) } else { 0.0 };
                    *p = to_i16((voice + a).clamp(-1.0, 1.0));
                }
            }
            if self.live || sharing {
                (self.sink)(&pcm);
            }
        }
    }
}

/// The render queue's size (matches `device::RENDER_RING`: stereo samples).
const RING_CAP: usize = FRAME * 20 * 2;

/// A short, friendly test sound (two soft notes), 48 kHz mono.
#[must_use]
pub fn test_sound() -> Arc<[f32]> {
    let note = |hz: f64, secs: f64| {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let n = (secs * f64::from(RATE)) as usize;
        (0..n).map(move |i| {
            #[allow(clippy::cast_precision_loss)]
            let t = i as f64 / f64::from(RATE);
            let envelope = (t * 40.0).min(1.0) * (1.0 - t / secs).max(0.0);
            #[allow(clippy::cast_possible_truncation)]
            let v = (0.25 * envelope * (std::f64::consts::TAU * hz * t).sin()) as f32;
            v
        })
    };
    note(660.0, 0.25)
        .chain(note(880.0, 0.35))
        .collect::<Vec<_>>()
        .into()
}

#[cfg(test)]
mod tests {
    use super::{Audio, Config, Echo, test_sound};
    use std::sync::{Arc, Mutex};

    struct NoEcho;
    impl Echo for NoEcho {
        fn render(&mut self, _frame: &mut [i16]) {}
        fn capture(&mut self, _frame: &mut [i16], _delay_ms: i32) {}
    }

    #[test]
    fn app_sound_waits_for_two_frames_and_never_lags() {
        let shared = Arc::new(super::Shared::default());
        let feed = super::AppFeed(Arc::clone(&shared));
        let mut out = [0.0f32; super::FRAME];
        feed.push(&[0.5; 480]);
        assert!(!shared.app_frame(&mut out), "off: nothing kept");
        feed.set(true, 0.5);
        feed.push(&[0.5; 480]);
        assert!(!shared.app_frame(&mut out), "one frame isn't enough to start");
        feed.push(&[0.5; 480]);
        assert!(shared.app_frame(&mut out));
        assert!((out[0] - 0.25).abs() < 1e-6, "at its gain");
        assert!(shared.app_frame(&mut out));
        assert!(!shared.app_frame(&mut out), "ran dry: waits again");
        feed.push(&[0.1; super::APP_MAX * 3]);
        assert_eq!(
            shared.app.lock().map(|b| b.samples.len()).unwrap_or(0),
            super::APP_MAX
        );
        feed.set(false, 0.5);
        assert!(!shared.app_frame(&mut out));
    }

    #[test]
    fn people_get_their_own_volume_and_go_away_cleanly() {
        let sent = Arc::new(Mutex::new(0usize));
        let s = Arc::clone(&sent);
        let audio = Audio::start(
            Config::default(),
            Box::new(NoEcho),
            Box::new(move |_f| *s.lock().unwrap_or_else(std::sync::PoisonError::into_inner) += 1),
        );
        let (mut feed, control) = audio.add_peer(7);
        feed.push(&[1000; 4800]);
        control.set_gain(0.5);
        assert_eq!(audio.peer(7).map(|c| c.gain()), Some(0.5));
        // with no devices open (inactive), the pipeline keeps time itself and drains the queue
        std::thread::sleep(std::time::Duration::from_millis(150));
        audio.remove_peer(7);
        assert!(audio.peer(7).is_none());
        assert!(test_sound().len() > 20_000);
        drop(audio);
    }
}
