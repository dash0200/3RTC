//! Our voice: one audio track shared by every peer connection, and everyone else's voice.
//!
//! Three ways, by [`MicSource`]:
//! - `Pipeline` (the default, ADR 0003): our own audio path (`rtc_audio`). We capture the mic,
//!   libwebrtc's APM cancels the echo of what we play, RNNoise removes noise, and the frames go
//!   into a `NativeAudioSource`; each person's decoded voice comes out of a `NativeAudioStream`
//!   into their own queue, with their own volume, and we mix and play it. libwebrtc's audio
//!   device stays synthetic (it never opens the sound card).
//! - `Device` ("classic", ADR 0002, kept as a fallback): libwebrtc's own platform audio device
//!   does capture and playback, as in Chrome.
//! - `Tone` / `Silence`: no sound card (CI, tests).

use std::f64::consts::TAU;

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::StreamExt as _;
use libwebrtc::audio_frame::AudioFrame;
use libwebrtc::audio_source::AudioSourceOptions;
use libwebrtc::audio_source::native::NativeAudioSource;
use libwebrtc::audio_stream::native::NativeAudioStream;
use libwebrtc::audio_track::RtcAudioTrack;
use libwebrtc::media_stream_track::MediaStreamTrack;
use libwebrtc::native::apm::AudioProcessingModule;
use libwebrtc::peer_connection_factory::PeerConnectionFactory;
use libwebrtc::peer_connection_factory::native::PeerConnectionFactoryExt as _;
use rtc_audio::{Audio, PeerControl};

use crate::factory::Factory;

/// Where our voice comes from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MicSource {
    /// The PC's microphone and speakers through our own audio path (ADR 0003).
    Pipeline,
    /// The PC's microphone and speakers through libwebrtc's platform audio device ("classic").
    Device,
    /// A sine tone at this frequency (tests: the other side can hear something).
    Tone(f64),
    /// Nothing.
    Silence,
}

/// A microphone or speaker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    /// Stable id (survives unplugging).
    pub id: String,
    /// Name to show.
    pub name: String,
}

/// The audio devices on this PC.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Devices {
    /// Microphones.
    pub inputs: Vec<Device>,
    /// Speakers and headsets.
    pub outputs: Vec<Device>,
}

/// Our voice track and the audio device behind it.
pub struct Voice {
    factory: PeerConnectionFactory,
    track: RtcAudioTrack,
    platform: bool,
    deafened: bool,
    /// The microphone and speaker picked in settings (`""` = the system default).
    input: String,
    output: String,
    tone: Option<tokio::task::JoinHandle<()>>,
    /// Our own audio path (`MicSource::Pipeline`).
    pipeline: Option<Audio>,
    /// Each person's voice going into the pipeline: their key and the task feeding it.
    remote: HashMap<String, (u64, tokio::task::JoinHandle<()>)>,
    /// Volumes set for people, kept for when their voice (re)arrives.
    gains: HashMap<String, f32>,
    next_key: u64,
    /// The sound of someone's shared screen (stereo), by person: key and feeding task.
    screen_remote: HashMap<String, (u64, tokio::task::JoinHandle<()>)>,
    /// The volume of shared screens' sound.
    screen_gain: f32,
}

impl std::fmt::Debug for Voice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Voice")
            .field("platform", &self.platform)
            .field("deafened", &self.deafened)
            .finish()
    }
}

/// 10 ms at 48 kHz, mono.
const FRAME: usize = 480;

impl Voice {
    /// Our voice from `mic`, starting muted. A tone needs a tokio runtime to run on.
    #[must_use]
    pub fn new(factory: &Factory, mic: MicSource) -> Self {
        let pcf = factory.inner().clone();
        if mic == MicSource::Device {
            if pcf.acquire_platform_adm() {
                pcf.set_adm_recording_enabled(true);
                pcf.set_adm_playout_enabled(true);
                let track = pcf.create_device_audio_track("voice");
                track.set_enabled(false);
                log_sound_card(&pcf);
                return Self {
                    factory: pcf,
                    track,
                    platform: true,
                    deafened: false,
                    input: String::new(),
                    output: String::new(),
                    tone: None,
                    pipeline: None,
                    remote: HashMap::new(),
                    gains: HashMap::new(),
                    next_key: 1,
                    screen_remote: HashMap::new(),
                    screen_gain: 1.0,
                };
            }
            tracing::warn!(
                "audio: the sound card could not be opened, so others hear silence and you hear nothing"
            );
        }
        if mic == MicSource::Pipeline {
            return Self::pipeline(pcf);
        }
        let source = NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 100);
        let track = pcf.create_audio_track("voice", source.clone());
        track.set_enabled(false);
        let tone = match mic {
            MicSource::Tone(hz) => Some(tokio::spawn(play_tone(source, hz))),
            MicSource::Pipeline | MicSource::Device | MicSource::Silence => None,
        };
        Self {
            factory: pcf,
            track,
            platform: false,
            deafened: false,
            input: String::new(),
            output: String::new(),
            tone,
            pipeline: None,
            remote: HashMap::new(),
            gains: HashMap::new(),
            next_key: 1,
            screen_remote: HashMap::new(),
            screen_gain: 1.0,
        }
    }

    /// Our own audio path: frames we clean ourselves go straight into the track (no processing
    /// of libwebrtc's own on the way: the source's options are all off).
    fn pipeline(pcf: PeerConnectionFactory) -> Self {
        let options = AudioSourceOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
        };
        // queue 0: each 10 ms frame goes to the encoder as it's handed over
        let source = NativeAudioSource::new(options, 48_000, 1, 0);
        let track = pcf.create_audio_track("voice", source.clone());
        track.set_enabled(false);
        let sink: rtc_audio::Sink = Box::new(move |pcm: &[i16]| {
            let frame = AudioFrame {
                data: pcm.into(),
                sample_rate: 48_000,
                num_channels: 1,
                samples_per_channel: u32::try_from(pcm.len()).unwrap_or(0),
            };
            // with no queue the frame is taken at once: one poll finishes it
            let mut done = std::pin::pin!(source.capture_frame(&frame));
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            let _ = done.as_mut().poll(&mut cx);
        });
        let audio = Audio::start(
            rtc_audio::Config {
                isolation: true,
                ..rtc_audio::Config::default()
            },
            Box::new(ApmEcho::new()),
            sink,
        );
        tracing::info!("audio: our own audio path (capture, echo cancelling, RNNoise, mixing)");
        Self {
            factory: pcf,
            track,
            platform: false,
            deafened: false,
            input: String::new(),
            output: String::new(),
            tone: None,
            pipeline: Some(audio),
            remote: HashMap::new(),
            gains: HashMap::new(),
            next_key: 1,
            screen_remote: HashMap::new(),
            screen_gain: 1.0,
        }
    }

    /// Open the sound card (in a room, or while voice settings are open) or close it. Only
    /// our own audio path opens and closes it; libwebrtc's device stays as it is.
    pub fn set_active(&self, on: bool) {
        if let Some(p) = &self.pipeline {
            p.set_active(on);
        }
    }

    /// Plays this person's voice (their incoming audio track) through our mixer.
    pub fn add_remote(&mut self, peer: &str, track: RtcAudioTrack) {
        if self.pipeline.is_none() {
            return;
        }
        self.remove_remote(peer);
        let Some(p) = &self.pipeline else { return };
        let key = self.next_key;
        self.next_key += 1;
        tracing::debug!("audio: {peer} sends voice track {} (key {key})", track.id());
        let (mut feed, control) = p.add_peer(key);
        if let Some(g) = self.gains.get(peer) {
            control.set_gain(*g);
        }
        let mut stream = NativeAudioStream::new(track, 48_000, 1);
        let who = peer.to_owned();
        let task = tokio::spawn(async move {
            let mut frames = 0u64;
            let mut loudest = 0u16;
            while let Some(frame) = stream.next().await {
                if frames == 0 {
                    tracing::info!(
                        "audio: hearing {who} ({} Hz, {} channels, {} samples a frame)",
                        frame.sample_rate,
                        frame.num_channels,
                        frame.samples_per_channel
                    );
                }
                frames += 1;
                loudest = loudest.max(frame.data.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0));
                if frames.is_multiple_of(100) {
                    // the cross-app test reads this line (RUST_LOG=rtc_webrtc::voice=debug)
                    tracing::debug!(
                        "audio: {who} (key {key}): {frames} frames, loudest {loudest} in the last second"
                    );
                    loudest = 0;
                }
                feed.push(&frame.data);
            }
            tracing::info!("audio: {who}'s voice ended after {frames} frames");
        });
        self.remote.insert(peer.to_owned(), (key, task));
    }

    /// Plays the sound of this person's shared screen (their stereo `screen-audio` track).
    pub fn add_remote_screen(&mut self, peer: &str, track: RtcAudioTrack) {
        self.remove_remote_screen(peer);
        let Some(p) = &self.pipeline else { return };
        let key = self.next_key;
        self.next_key += 1;
        let (mut feed, control) = p.add_stereo_peer(key);
        control.set_gain(self.screen_gain);
        let mut stream = NativeAudioStream::new(track, 48_000, 2);
        let who = peer.to_owned();
        let task = tokio::spawn(async move {
            let mut frames = 0u64;
            while let Some(frame) = stream.next().await {
                if frames == 0 {
                    tracing::info!(
                        "audio: hearing {who}'s screen ({} Hz, {} channels)",
                        frame.sample_rate,
                        frame.num_channels
                    );
                }
                frames += 1;
                if frames.is_multiple_of(500) {
                    // the screen sound test reads this line
                    let (l, r) = side_levels(&frame.data, frame.num_channels);
                    // every few seconds: the console only, not the log file
                    tracing::info!(
                        target: "rtc_engine::periodic",
                        "audio: {who}'s screen: {frames} frames, left {l:.2}, right {r:.2}"
                    );
                }
                if frame.num_channels == 2 {
                    feed.push(&frame.data);
                } else {
                    let both: Vec<i16> = frame.data.iter().flat_map(|s| [*s, *s]).collect();
                    feed.push(&both);
                }
            }
        });
        self.screen_remote.insert(peer.to_owned(), (key, task));
    }

    /// Stops playing this person's shared screen's sound.
    pub fn remove_remote_screen(&mut self, peer: &str) {
        if let Some((key, task)) = self.screen_remote.remove(peer) {
            task.abort();
            if let Some(p) = &self.pipeline {
                p.remove_peer(key);
            }
        }
    }

    /// The volume of shared screens' sound (0 mutes it, 1 as sent, up to 2).
    pub fn set_screen_volume(&mut self, gain: f32) {
        self.screen_gain = gain;
        if let Some(p) = &self.pipeline {
            for (key, _) in self.screen_remote.values() {
                if let Some(c) = p.peer(*key) {
                    c.set_gain(gain);
                }
            }
        }
    }

    /// Stops playing this person.
    pub fn remove_remote(&mut self, peer: &str) {
        if let Some((key, task)) = self.remote.remove(peer) {
            task.abort();
            if let Some(p) = &self.pipeline {
                p.remove_peer(key);
            }
        }
    }

    /// This person's volume (0 = muted for me, 1 = as sent, up to 2).
    pub fn set_volume(&mut self, peer: &str, gain: f32) {
        self.gains.insert(peer.to_owned(), gain);
        if let Some(c) = self.control(peer) {
            c.set_gain(gain);
        }
    }

    fn control(&self, peer: &str) -> Option<Arc<PeerControl>> {
        let (key, _) = self.remote.get(peer)?;
        self.pipeline.as_ref()?.peer(*key)
    }

    /// How loud this person is right now (0..1), from our own mixer.
    #[must_use]
    pub fn level(&self, peer: &str) -> Option<f32> {
        self.control(peer).map(|c| c.level())
    }

    /// Our microphone's level after cleaning (0..1), for the meter.
    #[must_use]
    pub fn mic_level(&self) -> f32 {
        self.pipeline.as_ref().map_or(0.0, Audio::mic_level)
    }

    /// A handle to read the microphone's level from the window (our own audio path only).
    #[must_use]
    pub fn meter(&self) -> Option<rtc_audio::Meter> {
        self.pipeline.as_ref().map(Audio::meter)
    }

    /// Feeds one program's sound into what we send (our own audio path only).
    #[must_use]
    pub fn app_feed(&self) -> Option<rtc_audio::AppFeed> {
        self.pipeline.as_ref().map(Audio::app_feed)
    }

    /// Tells the echo canceller about sound 3RTC plays outside our audio path (the web video
    /// player), so the microphone doesn't send it on (our own audio path only).
    #[must_use]
    pub fn echo_feed(&self) -> Option<rtc_audio::EchoFeed> {
        self.pipeline.as_ref().map(Audio::echo_feed)
    }

    /// RNNoise ("Voice Isolation") on or off.
    pub fn set_isolation(&self, on: bool) {
        if let Some(p) = &self.pipeline {
            p.set_isolation(on);
        }
    }

    /// Plays the test sound.
    pub fn play_test_sound(&self) {
        if let Some(p) = &self.pipeline {
            p.play(rtc_audio::test_sound(), 1.0, false);
        }
    }

    /// Plays a sound of ours (soundboard, reaction pop) through our mixer; nothing on the
    /// classic path (the app plays it through Windows there).
    pub fn play_samples(&self, samples: std::sync::Arc<[f32]>, gain: f32, replace: bool) {
        if let Some(p) = &self.pipeline {
            p.play(samples, gain, replace);
        }
    }

    /// It's our own audio path.
    #[must_use]
    pub const fn is_pipeline(&self) -> bool {
        self.pipeline.is_some()
    }

    /// The track to add to each peer connection.
    #[must_use]
    pub fn track(&self) -> MediaStreamTrack {
        MediaStreamTrack::Audio(self.track.clone())
    }

    /// It's the real microphone and speakers (either way).
    #[must_use]
    pub const fn is_device(&self) -> bool {
        self.platform || self.pipeline.is_some()
    }

    /// Send our voice (`true`) or silence.
    pub fn set_sending(&self, on: bool) {
        self.track.set_enabled(on);
        if let Some(p) = &self.pipeline {
            p.set_live(on);
        }
        if self.platform {
            tracing::info!(
                "audio: microphone {} (recording initialised: {})",
                if on { "live" } else { "muted" },
                self.factory.recording_is_initialized(),
            );
        }
    }

    /// Stop or start playing everyone's voice.
    pub fn set_deafened(&mut self, deafened: bool) {
        if self.deafened == deafened {
            return;
        }
        self.deafened = deafened;
        if let Some(p) = &self.pipeline {
            p.set_deafened(deafened);
        }
        if !self.platform {
            return;
        }
        if deafened {
            self.factory.stop_playout();
        } else {
            self.factory.init_playout();
            self.factory.start_playout();
        }
    }

    /// The PC's microphones and speakers (empty without a real audio device).
    #[must_use]
    pub fn devices(&self) -> Devices {
        if self.pipeline.is_some() {
            let d = rtc_audio::devices();
            let map = |v: Vec<rtc_audio::DeviceInfo>| {
                v.into_iter()
                    .map(|d| Device {
                        id: d.id,
                        name: d.name,
                    })
                    .collect()
            };
            return Devices {
                inputs: map(d.inputs),
                outputs: map(d.outputs),
            };
        }
        if !self.platform {
            return Devices::default();
        }
        let f = &self.factory;
        let count = |n: i16| u16::try_from(n.max(0)).unwrap_or(0);
        Devices {
            inputs: (0..count(f.recording_devices()))
                .map(|i| Device {
                    id: f.recording_device_guid(i),
                    name: f.recording_device_name(i),
                })
                .collect(),
            outputs: (0..count(f.playout_devices()))
                .map(|i| Device {
                    id: f.playout_device_guid(i),
                    name: f.playout_device_name(i),
                })
                .collect(),
        }
    }

    /// Uses this microphone (by [`Device::id`]); `""` means the system default.
    pub fn set_input(&mut self, id: &str) -> bool {
        if let Some(p) = &self.pipeline {
            id.clone_into(&mut self.input);
            p.set_input((!id.is_empty()).then(|| id.to_owned()));
            return true;
        }
        if !self.platform {
            return false;
        }
        id.clone_into(&mut self.input);
        let f = &self.factory;
        let was_recording = f.recording_is_initialized();
        f.stop_recording();
        let ok = if id.is_empty() {
            f.set_recording_device(0)
        } else {
            f.set_recording_device_by_guid(id)
        };
        if was_recording {
            f.init_recording();
            f.start_recording();
        }
        ok
    }

    /// Plays through this speaker (by [`Device::id`]); `""` means the system default.
    pub fn set_output(&mut self, id: &str) -> bool {
        if let Some(p) = &self.pipeline {
            id.clone_into(&mut self.output);
            p.set_output((!id.is_empty()).then(|| id.to_owned()));
            return true;
        }
        if !self.platform {
            return false;
        }
        id.clone_into(&mut self.output);
        let f = &self.factory;
        f.stop_playout();
        let ok = if id.is_empty() {
            f.set_playout_device(0)
        } else {
            f.set_playout_device_by_guid(id)
        };
        if !self.deafened {
            f.init_playout();
            f.start_playout();
        }
        ok
    }
}

/// Says in the log what the sound card looks like: what we capture from and play to.
fn log_sound_card(pcf: &PeerConnectionFactory) {
    let mics = pcf.recording_devices();
    let speakers = pcf.playout_devices();
    tracing::info!(
        "audio: sound card open ({mics} microphones, {speakers} speakers; recording {}, playout {}, active {})",
        on_off(pcf.adm_recording_enabled()),
        on_off(pcf.adm_playout_enabled()),
        pcf.is_platform_adm_active(),
    );
    for i in 0..u16::try_from(mics.max(0)).unwrap_or(0) {
        tracing::info!("audio:   microphone {i}: {}", pcf.recording_device_name(i));
    }
    for i in 0..u16::try_from(speakers.max(0)).unwrap_or(0) {
        tracing::info!("audio:   speaker {i}: {}", pcf.playout_device_name(i));
    }
    if mics <= 0 {
        tracing::warn!("audio: no microphone found, so others will hear silence");
    }
    if speakers <= 0 {
        tracing::warn!("audio: no speakers found, so you won't hear anyone");
    }
}

const fn on_off(on: bool) -> &'static str {
    if on { "on" } else { "off" }
}

impl Voice {
    /// Starts the microphone and speakers again after the device went away (a headset plugged
    /// in or out, the default device changed): picks the chosen device, or the new default.
    pub fn restart(&mut self) {
        if !self.platform {
            return;
        }
        let f = &self.factory;
        let recording = f.recording_is_initialized();
        f.stop_recording();
        f.stop_playout();
        if !self.input.is_empty() {
            f.set_recording_device_by_guid(&self.input);
        }
        if !self.output.is_empty() {
            f.set_playout_device_by_guid(&self.output);
        }
        if !self.deafened {
            f.init_playout();
            f.start_playout();
        }
        if recording {
            f.init_recording();
            f.start_recording();
        }
        tracing::info!(
            "audio: device changed, restarted (playout {}, recording {})",
            on_off(f.playout_is_initialized()),
            on_off(f.recording_is_initialized()),
        );
    }
}

impl Drop for Voice {
    fn drop(&mut self) {
        if let Some(t) = self.tone.take() {
            t.abort();
        }
        for (_, (_, task)) in self.remote.drain() {
            task.abort();
        }
        if self.platform {
            self.factory.release_platform_adm();
        }
    }
}

/// Pushes a sine tone into `source`, 10 ms at a time, in real time.
/// The loudest sample on each side (0..1) of an interleaved frame.
fn side_levels(data: &[i16], channels: u32) -> (f32, f32) {
    let ch = usize::try_from(channels).unwrap_or(1).max(1);
    let mut lr = (0u16, 0u16);
    for f in data.chunks_exact(ch) {
        lr.0 = lr.0.max(f[0].unsigned_abs());
        lr.1 = lr.1.max(f[ch - 1].unsigned_abs());
    }
    (f32::from(lr.0) / 32_768.0, f32::from(lr.1) / 32_768.0)
}

/// The sound of our shared screen, sent to desktop viewers: a stereo track of its own (Opus at
/// up to 256 kbps, `sdp::tune_music`), separate from the microphone and its processing.
pub struct ScreenSound {
    source: NativeAudioSource,
    track: RtcAudioTrack,
}

impl std::fmt::Debug for ScreenSound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ScreenSound")
    }
}

impl ScreenSound {
    /// The track (added to desktop viewers' connections while we share).
    #[must_use]
    pub fn new(factory: &Factory) -> Self {
        let options = AudioSourceOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
        };
        let source = NativeAudioSource::new(options, 48_000, 2, 0);
        let track = factory.inner().create_audio_track("screen-audio", source.clone());
        Self { source, track }
    }

    /// The track to add to a connection.
    #[must_use]
    pub fn track(&self) -> MediaStreamTrack {
        MediaStreamTrack::Audio(self.track.clone())
    }

    /// Something to give the computer's sound to (48 kHz stereo, interleaved, any amount at a
    /// time): it goes out in 10 ms frames.
    pub fn feeder(&self) -> impl FnMut(&[f32]) + Send + 'static {
        let source = self.source.clone();
        let mut pending: Vec<i16> = Vec::with_capacity(FRAME * 4);
        move |samples: &[f32]| {
            pending.extend(samples.iter().map(|s| {
                #[allow(clippy::cast_possible_truncation)]
                let v = (s.clamp(-1.0, 1.0) * 32_767.0) as i16;
                v
            }));
            while pending.len() >= FRAME * 2 {
                let piece: Vec<i16> = pending.drain(..FRAME * 2).collect();
                let frame = AudioFrame {
                    data: piece.into(),
                    sample_rate: 48_000,
                    num_channels: 2,
                    samples_per_channel: u32::try_from(FRAME).unwrap_or(480),
                };
                let mut done = std::pin::pin!(source.capture_frame(&frame));
                let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
                let _ = done.as_mut().poll(&mut cx);
            }
        }
    }
}

async fn play_tone(source: NativeAudioSource, hz: f64) {
    let mut phase = 0.0_f64;
    let step = TAU * hz / 48_000.0;
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let mut frame = AudioFrame::new(48_000, 1, FRAME as u32);
        let samples = frame.data.to_mut();
        for s in samples.iter_mut() {
            #[allow(clippy::cast_possible_truncation)]
            {
                *s = (phase.sin() * 8_000.0) as i16;
            }
            phase = (phase + step) % TAU;
        }
        if source.capture_frame(&frame).await.is_err() {
            return;
        }
    }
}

/// libwebrtc's audio processing module as our echo canceller (with its high-pass filter,
/// gain control and light noise suppression; RNNoise comes after it).
struct ApmEcho {
    apm: AudioProcessingModule,
    delay_ms: i32,
}

impl ApmEcho {
    fn new() -> Self {
        Self {
            apm: AudioProcessingModule::new(true, true, true, true),
            delay_ms: -1,
        }
    }
}

impl rtc_audio::Echo for ApmEcho {
    fn render(&mut self, frame: &mut [i16]) {
        let _ = self.apm.process_reverse_stream(frame, 48_000, 1);
    }

    fn capture(&mut self, frame: &mut [i16], delay_ms: i32) {
        // a hint for its own delay finder; only told when it moves by more than 5 ms
        if (delay_ms - self.delay_ms).abs() > 5 {
            self.delay_ms = delay_ms;
            let _ = self.apm.set_stream_delay_ms(delay_ms.clamp(0, 500));
        }
        let _ = self.apm.process_stream(frame, 48_000, 1);
    }
}
