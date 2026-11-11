//! Our voice: one audio track shared by every peer connection.
//!
//! On a real PC it uses libwebrtc's own platform audio device (WASAPI on Windows): capture,
//! echo cancellation, noise suppression, gain control and playback on one clock, exactly as in
//! Chrome. Where there is no sound card (CI, tests) it sends a tone or silence instead, so the
//! rest of the app behaves the same. See `docs/adr/0002-voice.md`.

use std::f64::consts::TAU;

use libwebrtc::audio_frame::AudioFrame;
use libwebrtc::audio_source::AudioSourceOptions;
use libwebrtc::audio_source::native::NativeAudioSource;
use libwebrtc::audio_track::RtcAudioTrack;
use libwebrtc::media_stream_track::MediaStreamTrack;
use libwebrtc::peer_connection_factory::PeerConnectionFactory;
use libwebrtc::peer_connection_factory::native::PeerConnectionFactoryExt as _;

use crate::factory::Factory;

/// Where our voice comes from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MicSource {
    /// The PC's microphone and speakers (libwebrtc's platform audio device).
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
    tone: Option<tokio::task::JoinHandle<()>>,
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
                    tone: None,
                };
            }
            tracing::warn!(
                "audio: the sound card could not be opened, so others hear silence and you hear nothing"
            );
        }
        let source = NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 100);
        let track = pcf.create_audio_track("voice", source.clone());
        track.set_enabled(false);
        let tone = match mic {
            MicSource::Tone(hz) => Some(tokio::spawn(play_tone(source, hz))),
            MicSource::Device | MicSource::Silence => None,
        };
        Self {
            factory: pcf,
            track,
            platform: false,
            deafened: false,
            tone,
        }
    }

    /// The track to add to each peer connection.
    #[must_use]
    pub fn track(&self) -> MediaStreamTrack {
        MediaStreamTrack::Audio(self.track.clone())
    }

    /// It's the real microphone and speakers.
    #[must_use]
    pub const fn is_device(&self) -> bool {
        self.platform
    }

    /// Send our voice (`true`) or silence.
    pub fn set_sending(&self, on: bool) {
        self.track.set_enabled(on);
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
    pub fn set_input(&self, id: &str) -> bool {
        if !self.platform {
            return false;
        }
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
    pub fn set_output(&self, id: &str) -> bool {
        if !self.platform {
            return false;
        }
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

impl Drop for Voice {
    fn drop(&mut self) {
        if let Some(t) = self.tone.take() {
            t.abort();
        }
        if self.platform {
            self.factory.release_platform_adm();
        }
    }
}

/// Pushes a sine tone into `source`, 10 ms at a time, in real time.
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
