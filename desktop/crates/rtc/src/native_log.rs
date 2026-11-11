//! libwebrtc's own log lines about the sound card, in our log.
//!
//! LiveKit's bindings pass every native line on at `debug`, which is far too much to leave
//! on. This picks out the few that say what the audio device is doing (opened or not, which
//! mic and speaker, how many callbacks per 10 s and how loud) and logs them at `info`, so a
//! "can't hear anything" report comes with the answer in the console.

use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};

use webrtc_sys::webrtc::ffi::{LoggingSeverity, new_log_sink};

/// Native files and words that are about the sound card.
const AUDIO_WORDS: [&str; 10] = [
    "audio_device",
    "AudioDevice",
    "AdmProxy",
    "adm_helpers",
    "audio_state",
    "Core Audio",
    "core_audio",
    "webrtc_voice_engine",
    "[REC",
    "[PLAY",
];

/// Set when libwebrtc says its recording or playback thread stopped (the device went away).
static DEVICE_LOST: AtomicBool = AtomicBool::new(false);

/// Whether the sound card stopped since the last call: a headset was plugged in or out, or
/// Windows switched the default device. libwebrtc's Windows audio doesn't recover on its own.
pub fn take_device_lost() -> bool {
    DEVICE_LOST.swap(false, Ordering::AcqRel)
}

/// Starts passing the sound card's native log lines on (once; later calls do nothing).
pub fn forward_audio_logs() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // The sink lives as long as the app: libwebrtc logs from its own threads until exit.
        std::mem::forget(new_log_sink(on_line));
    });
}

#[allow(clippy::needless_pass_by_value)] // the binding hands each line over by value
fn on_line(line: String, severity: LoggingSeverity) {
    if !is_audio(&line) {
        return;
    }
    let line = line.trim_end();
    if is_device_lost(line) {
        DEVICE_LOST.store(true, Ordering::Release);
    }
    match severity {
        LoggingSeverity::Error => tracing::error!(target: "rtc_webrtc::native", "{line}"),
        LoggingSeverity::Warning => tracing::warn!(target: "rtc_webrtc::native", "{line}"),
        LoggingSeverity::Info => tracing::info!(target: "rtc_webrtc::native", "{line}"),
        _ => tracing::trace!(target: "rtc_webrtc::native", "{line}"),
    }
}

/// libwebrtc's Windows audio says this when a capture or render thread died, which after
/// `AUDCLNT_E_DEVICE_INVALIDATED` (the endpoint changed or disappeared) it never restarts.
fn is_device_lost(line: &str) -> bool {
    line.contains("ended pre-maturely")
}

fn is_audio(line: &str) -> bool {
    AUDIO_WORDS.iter().any(|w| line.contains(w))
}

#[cfg(test)]
mod tests {
    use super::is_audio;

    #[test]
    fn picks_the_sound_card_lines() {
        assert!(is_audio(
            "(audio_device_buffer.cc:380): [REC : 10000msec, 48kHz] callbacks: 1000"
        ));
        assert!(is_audio(
            "(audio_device_core_win.cc:500): Windows Core Audio is supported"
        ));
        assert!(is_audio("[PLAY: 10000msec, 48kHz] callbacks: 1000"));
        assert!(!is_audio("(p2p_transport_channel.cc:100): Set ICE ufrag"));
    }

    #[test]
    fn notices_a_lost_device() {
        use super::is_device_lost;
        assert!(is_device_lost(
            "(audio_device_core_win.cc:3338): Recording error: capturing thread has ended pre-maturely"
        ));
        assert!(is_device_lost(
            "(audio_device_core_win.cc:2907): Playout error: rendering thread has ended pre-maturely"
        ));
        assert!(!is_device_lost(
            "(audio_device_buffer.cc:480): [REC : 10000msec, 48kHz] callbacks: 1000"
        ));
    }
}
