//! The app's own sounds, played through our mixer (the chosen speakers) or, on the classic
//! audio path, through Windows: the soundboard clips (`utils/soundboard.ts`, the web app's own
//! files decoded to 48 kHz mono) and the little synthesized ones (`utils/sound.ts`).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

/// The sample rate everything here is made at.
const RATE: f64 = 48_000.0;

/// A soundboard clip, as the web app lists it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Clip {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) emoji: &'static str,
    /// Its colour (`#rrggbb` as a number).
    pub(crate) color: u32,
    pub(crate) category: &'static str,
    /// The web app's tooltip text.
    #[allow(dead_code)]
    pub(crate) description: &'static str,
    pcm: &'static [u8],
}

/// `SOUNDBOARD_CLIPS`, in order. The "Synth" ones are made by `packaging/make-sounds.py`
/// (synthesised from scratch, CC0), decoded from the web app's MP3s like the others.
pub(crate) const CLIPS: [Clip; 23] = [
    Clip {
        id: "quack",
        name: "Quack",
        emoji: "🦆",
        color: 0x00ea_b308,
        category: "Soundboard",
        description: "Official Discord rubber duck quack",
        pcm: include_bytes!("../assets/sounds/quack.pcm"),
    },
    Clip {
        id: "airhorn",
        name: "Airhorn",
        emoji: "📢",
        color: 0x00ef_4444,
        category: "Soundboard",
        description: "Official Discord DJ reggae airhorn blast",
        pcm: include_bytes!("../assets/sounds/airhorn.pcm"),
    },
    Clip {
        id: "cricket",
        name: "Crickets",
        emoji: "🦗",
        color: 0x0010_b981,
        category: "Soundboard",
        description: "Official Discord awkward silence crickets",
        pcm: include_bytes!("../assets/sounds/cricket.pcm"),
    },
    Clip {
        id: "golfclap",
        name: "Golf Clap",
        emoji: "👏",
        color: 0x00f5_9e0b,
        category: "Soundboard",
        description: "Official Discord polite golf clapping",
        pcm: include_bytes!("../assets/sounds/golfclap.pcm"),
    },
    Clip {
        id: "sadhorn",
        name: "Sad Horn",
        emoji: "🎺",
        color: 0x0064_748b,
        category: "Soundboard",
        description: "Official Discord fail sad horn (womp womp)",
        pcm: include_bytes!("../assets/sounds/sadhorn.pcm"),
    },
    Clip {
        id: "badumtss",
        name: "Ba-Dum-Tss",
        emoji: "🥁",
        color: 0x00ec_4899,
        category: "Soundboard",
        description: "Official Discord punchline comedy rimshot",
        pcm: include_bytes!("../assets/sounds/badumtss.pcm"),
    },
    Clip {
        id: "discord_ping",
        name: "Discord Ping",
        emoji: "🔔",
        color: 0x0058_65f2,
        category: "Discord SFX",
        description: "Official Discord message ping notification",
        pcm: include_bytes!("../assets/sounds/discord_ping.pcm"),
    },
    Clip {
        id: "boing",
        name: "Boing",
        emoji: "🦘",
        color: 0x00f9_7316,
        category: "Synth",
        description: "A springy boing (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/boing.pcm"),
    },
    Clip {
        id: "laser",
        name: "Laser",
        emoji: "🛸",
        color: 0x0022_d3ee,
        category: "Synth",
        description: "Pew! A sci-fi laser zap (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/laser.pcm"),
    },
    Clip {
        id: "tada",
        name: "Ta-da",
        emoji: "🎉",
        color: 0x00f4_3f5e,
        category: "Synth",
        description: "Ta-da! A little fanfare (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/tada.pcm"),
    },
    Clip {
        id: "ding",
        name: "Ding",
        emoji: "🛎️",
        color: 0x00fa_cc15,
        category: "Synth",
        description: "A service bell ding (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/ding.pcm"),
    },
    Clip {
        id: "whoosh",
        name: "Whoosh",
        emoji: "💨",
        color: 0x0094_a3b8,
        category: "Synth",
        description: "Something flies past (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/whoosh.pcm"),
    },
    Clip {
        id: "bubble",
        name: "Bubble Pop",
        emoji: "🫧",
        color: 0x0038_bdf8,
        category: "Synth",
        description: "Pop, pop, pop (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/bubble.pcm"),
    },
    Clip {
        id: "coin",
        name: "Coin",
        emoji: "🪙",
        color: 0x00ea_b308,
        category: "Synth",
        description: "A coin picked up (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/coin.pcm"),
    },
    Clip {
        id: "levelup",
        name: "Level Up",
        emoji: "⭐",
        color: 0x00a8_55f7,
        category: "Synth",
        description: "A rising level-up arpeggio (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/levelup.pcm"),
    },
    Clip {
        id: "buzzer",
        name: "Wrong",
        emoji: "❌",
        color: 0x00dc_2626,
        category: "Synth",
        description: "Wrong answer buzzer (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/buzzer.pcm"),
    },
    Clip {
        id: "correct",
        name: "Correct",
        emoji: "✅",
        color: 0x0022_c55e,
        category: "Synth",
        description: "Right answer chime (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/correct.pcm"),
    },
    Clip {
        id: "slidewhistle",
        name: "Slide Whistle",
        emoji: "🎶",
        color: 0x00ec_4899,
        category: "Synth",
        description: "Wheee, up and down (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/slidewhistle.pcm"),
    },
    Clip {
        id: "heartbeat",
        name: "Heartbeat",
        emoji: "💓",
        color: 0x00e1_1d48,
        category: "Synth",
        description: "Lub-dub: the suspense (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/heartbeat.pcm"),
    },
    Clip {
        id: "siren",
        name: "Siren",
        emoji: "🚨",
        color: 0x00ef_4444,
        category: "Synth",
        description: "Nee-naw alarm (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/siren.pcm"),
    },
    Clip {
        id: "ticktock",
        name: "Tick Tock",
        emoji: "⏰",
        color: 0x0064_748b,
        category: "Synth",
        description: "The clock is ticking (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/ticktock.pcm"),
    },
    Clip {
        id: "doorbell",
        name: "Doorbell",
        emoji: "🚪",
        color: 0x0014_b8a6,
        category: "Synth",
        description: "Ding-dong, who's there? (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/doorbell.pcm"),
    },
    Clip {
        id: "thunder",
        name: "Thunder",
        emoji: "⛈️",
        color: 0x0063_66f1,
        category: "Synth",
        description: "A dramatic thunderclap (made in 3RTC)",
        pcm: include_bytes!("../assets/sounds/thunder.pcm"),
    },
];

/// The clip for an id, with the web app's old names (`SOUND_URL_MAP`).
pub(crate) fn clip(id: &str) -> Option<&'static Clip> {
    let id = id.to_ascii_lowercase();
    let id = match id.as_str() {
        "wompwomp" => "sadhorn",
        "applause" => "golfclap",
        "drumroll" => "badumtss",
        other => other,
    };
    CLIPS.iter().find(|c| c.id == id)
}

fn decode(pcm: &[u8]) -> Vec<i16> {
    pcm.chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect()
}

/// Each clip's samples, decoded once.
static SAMPLES: LazyLock<HashMap<&'static str, Arc<[f32]>>> = LazyLock::new(|| {
    CLIPS
        .iter()
        .map(|c| {
            let s: Arc<[f32]> = decode(c.pcm)
                .into_iter()
                .map(|v| f32::from(v) / 32_768.0)
                .collect();
            (c.id, s)
        })
        .collect()
});

/// Each clip as a WAV file (the classic audio path plays these through Windows).
static WAVS: LazyLock<HashMap<&'static str, Vec<u8>>> = LazyLock::new(|| {
    CLIPS
        .iter()
        .map(|c| (c.id, rtc_platform_win::art::wav(&decode(c.pcm))))
        .collect()
});

/// How loud soundboard clips play here: nothing when muted or at 0% (`useSoundboard.ts`
/// `playLocally`), else the soundboard volume.
pub(crate) fn clip_gain(muted: bool, volume: f32) -> f32 {
    if muted || volume <= 0.0 {
        0.0
    } else {
        volume.min(1.0)
    }
}

/// A clip's samples (48 kHz mono, −1..1).
pub(crate) fn clip_samples(clip: &Clip) -> Option<Arc<[f32]>> {
    SAMPLES.get(clip.id).cloned()
}

/// A clip as a WAV file.
pub(crate) fn clip_wav(clip: &Clip) -> Option<&'static [u8]> {
    WAVS.get(clip.id).map(Vec::as_slice)
}

/// An oscillator whose frequency and gain glide exponentially between breakpoints, as Web
/// Audio's `exponentialRampToValueAtTime` (times in seconds).
fn glide(shape: fn(f64) -> f64, freq: &[(f64, f64)], gain: &[(f64, f64)], secs: f64) -> Vec<f32> {
    let at = |points: &[(f64, f64)], t: f64| -> f64 {
        let mut prev = points[0];
        for &p in points {
            if t <= p.0 {
                if p.0 <= prev.0 {
                    return p.1;
                }
                let k = (t - prev.0) / (p.0 - prev.0);
                return prev.1 * (p.1 / prev.1).powf(k);
            }
            prev = p;
        }
        prev.1
    };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let n = (secs * RATE).round() as usize;
    let mut phase = 0.0f64;
    (0..n)
        .map(|i| {
            #[allow(clippy::cast_precision_loss)]
            let t = i as f64 / RATE;
            phase += at(freq, t) / RATE;
            #[allow(clippy::cast_possible_truncation)]
            let v = (shape(phase.fract()) * at(gain, t)) as f32;
            v
        })
        .collect()
}

fn sine(p: f64) -> f64 {
    (std::f64::consts::TAU * p).sin()
}

fn triangle(p: f64) -> f64 {
    1.0 - 4.0 * (p - 0.5).abs()
}

/// The reaction pop: higher with each step of a combo (`playReactionPop`).
pub(crate) fn reaction_pop(combo: u32, volume: f64) -> Arc<[f32]> {
    let pitch = 1.0 + f64::from(combo.saturating_sub(1).min(12)) * 0.06;
    glide(
        sine,
        &[(0.0, 520.0 * pitch), (0.08, 1040.0 * pitch)],
        &[(0.0, 0.0001), (0.008, 0.045 * volume), (0.09, 0.001)],
        0.09,
    )
    .into()
}

/// A chat message (`playPop`).
pub(crate) static POP: LazyLock<Arc<[f32]>> = LazyLock::new(|| {
    glide(
        sine,
        &[(0.0, 440.0), (0.08, 880.0)],
        &[(0.0, 0.08), (0.08, 0.001)],
        0.08,
    )
    .into()
});

/// A picture on its way (`playChime`): three rising triangle notes.
pub(crate) static CHIME: LazyLock<Arc<[f32]>> = LazyLock::new(|| {
    let mut out = vec![0.0f32; (0.39 * RATE) as usize];
    for (i, f) in [523.25, 659.25, 783.99].into_iter().enumerate() {
        let note = glide(triangle, &[(0.0, f)], &[(0.0, 0.1), (0.25, 0.001)], 0.25);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let start = (i as f64 * 0.07 * RATE) as usize;
        for (o, s) in out[start..].iter_mut().zip(note) {
            *o += s;
        }
    }
    out.into()
});

fn to_wav(samples: &[f32]) -> Vec<u8> {
    #[allow(clippy::cast_possible_truncation)]
    let pcm: Vec<i16> = samples
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32_767.0) as i16)
        .collect();
    rtc_platform_win::art::wav(&pcm)
}

/// The chat pop as a WAV file.
pub(crate) static POP_WAV: LazyLock<Vec<u8>> = LazyLock::new(|| to_wav(&POP));
/// The chime as a WAV file.
pub(crate) static CHIME_WAV: LazyLock<Vec<u8>> = LazyLock::new(|| to_wav(&CHIME));

#[cfg(test)]
mod tests {
    use super::{CHIME, CLIPS, POP, clip, clip_gain, clip_samples, reaction_pop};

    #[test]
    fn muted_or_at_zero_nothing_plays_ours_or_theirs() {
        assert!(clip_gain(true, 0.75) <= 0.0, "muted");
        assert!(clip_gain(true, 1.0) <= 0.0, "muted at full volume");
        assert!(
            clip_gain(false, 0.0) <= 0.0,
            "0% is silent (it used to play at 10%)"
        );
        assert!((clip_gain(false, 0.4) - 0.4).abs() < 1e-6);
        assert!((clip_gain(false, 3.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn every_clip_is_there_and_old_names_work() {
        for c in &CLIPS {
            let s = clip_samples(c).unwrap_or_default();
            assert!(s.len() > 10_000, "{} is {} samples", c.id, s.len());
            assert!(s.iter().any(|v| v.abs() > 0.05), "{} is silent", c.id);
        }
        assert_eq!(clip("WompWomp").map(|c| c.id), Some("sadhorn"));
        assert!(clip("nope").is_none());
    }

    #[test]
    fn the_synthesized_sounds_are_short_and_quiet() {
        let pop = reaction_pop(1, 1.0);
        assert_eq!(pop.len(), 4320, "90 ms");
        let peak = pop.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((0.03..0.05).contains(&peak), "{peak}");
        assert!(reaction_pop(13, 1.0).len() == 4320);
        assert!(POP.iter().fold(0.0f32, |m, v| m.max(v.abs())) <= 0.081);
        assert!(CHIME.len() > 18_000);
    }
}
