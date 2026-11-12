//! What the app remembers between launches. JSON in the user's own app-data folder
//! (`%APPDATA%\3RTC\settings.json`), or next to the exe when a file named `portable` sits beside
//! it. No admin rights. (Start with Windows and `3rtc://` links live in the user's own registry
//! key, because that's where Windows looks: `rtc_platform_win::autostart` and `links`.)

use std::path::PathBuf;

use rtc_platform_win::keys::{Binding, Key};
use serde::{Deserialize, Serialize};

/// The real servers (`client-ts/src/App.tsx`): Oracle first, then the backups in order.
pub(crate) const ORACLE: &str = "wss://orc.3rtc.me";
pub(crate) const GCP: &str = "wss://gcp.3rtc.me";
pub(crate) const BACKUPS: [&str; 2] = ["wss://signal.3rtc.me", "wss://34.57.36.145.sslip.io:443"];
pub(crate) const LOCAL: &str = "ws://localhost:8080";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Settings {
    pub(crate) settings_version: u32,
    pub(crate) username: String,
    pub(crate) client_id: String,
    /// The signaling server picked in Server settings (`""`: the default, Oracle).
    pub(crate) signal_url: String,
    /// Microphone and speaker ids (`""`: the system default).
    pub(crate) input_device_id: String,
    pub(crate) input_device_label: String,
    pub(crate) output_device_id: String,
    pub(crate) output_device_label: String,
    /// Side panel open.
    pub(crate) panel_open: bool,
    /// Voice: open mic, or push-to-talk.
    pub(crate) voice_mode: VoiceMode,
    /// The push-to-talk key (works while other apps are in front).
    pub(crate) ptt_keys: Binding,
    /// How long the mic stays open after the key is let go (ms).
    pub(crate) ptt_release_ms: u32,
    /// The little chirps when push-to-talk opens and closes the mic.
    pub(crate) ptt_chime: bool,
    /// Global hotkey: mute or unmute (none by default).
    pub(crate) mute_keys: Binding,
    /// Global hotkey: deafen or undeafen (none by default).
    pub(crate) deafen_keys: Binding,
    /// Closing the window keeps 3RTC running in the tray (while the tray works).
    pub(crate) close_to_tray: bool,
    /// We told the user once that closing keeps the app in the tray.
    pub(crate) told_about_tray: bool,
    /// Windows notifications when someone joins or mentions you, while 3RTC isn't in front.
    pub(crate) notifications: bool,
    /// `3rtc://` links open this app.
    pub(crate) open_links: bool,
    /// The room you were last in (the rejoin card).
    pub(crate) last_room: Option<LastRoom>,
    /// RNNoise on the microphone ("Voice Isolation").
    pub(crate) voice_isolation: bool,
    /// libwebrtc's own device path instead of ours (the fallback while ours is new).
    pub(crate) classic_audio: bool,
    /// Each person's volume for you (0 = muted for you; 1 = as sent; up to 2), by their app's
    /// install id, so it sticks across rooms. Only people you changed are here.
    pub(crate) volumes: std::collections::BTreeMap<String, f32>,
    /// Your quick reactions, up to 10 emoji (keys 1–9 and 0) (`3rtc_quick_reactions`).
    pub(crate) quick_reactions: Vec<String>,
    /// Soundboard volume, 0–1 (`3rtc_soundboard_volume`).
    pub(crate) soundboard_volume: f32,
    /// Soundboard muted for you (`3rtc_soundboard_muted`).
    pub(crate) soundboard_muted: bool,
    /// Low-power mode: calmer animations, no Voice Isolation, connections checked less often.
    pub(crate) low_power: bool,
    /// Download and put in place new versions by itself.
    pub(crate) auto_update: bool,
    /// "Trending in…": the quick picks' country (`3rtc_qp_region`; empty: worldwide).
    pub(crate) qp_region: String,
    /// The in-game overlay: who's talking, over games in borderless windows.
    pub(crate) overlay: bool,
    /// Where the overlay sits: 0 top left, 1 top right, 2 bottom left, 3 bottom right.
    pub(crate) overlay_corner: u8,
}

/// The settings file's format now. Each change that needs more than new fields with defaults
/// gets a step in [`Settings::migrate`].
pub(crate) const SETTINGS_VERSION: u32 = 2;

/// The reactions everyone starts with (`DEFAULT_REACTIONS`).
pub(crate) const DEFAULT_REACTIONS: [&str; 6] = ["👍", "❤️", "🔥", "👏", "😂", "🎉"];
/// At most this many quick reactions.
pub(crate) const MAX_REACTIONS: usize = 10;

/// Up to 10 different single emoji, else the defaults (`clean` in `reactionSet.ts`).
pub(crate) fn clean_reactions(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in list {
        let e = e.trim();
        if rtc_core::fun::is_single_emoji(e) && !out.iter().any(|o| o == e) {
            out.push(e.to_owned());
        }
        if out.len() >= MAX_REACTIONS {
            break;
        }
    }
    if out.is_empty() {
        DEFAULT_REACTIONS.iter().map(|e| (*e).to_owned()).collect()
    } else {
        out
    }
}

/// The key that sends the reaction at `index` (1–9, then 0) (`keyForIndex`).
pub(crate) fn key_for_index(index: usize) -> String {
    if index == 9 {
        "0".to_owned()
    } else {
        (index + 1).to_string()
    }
}

/// How the mic opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum VoiceMode {
    /// Live until muted (M or the mic button).
    #[default]
    Open,
    /// Only while the push-to-talk key is held.
    Ptt,
}

/// The room you were last in (`utils/lastRoom.ts`): offered on the home screen for 30 minutes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LastRoom {
    pub(crate) room_id: String,
    pub(crate) was_host: bool,
    /// The server's proof that we hosted it (to get it back as host).
    pub(crate) host_token: Option<String>,
    /// Last seen in it (ms since 1970).
    pub(crate) at: u64,
}

/// How long the rejoin card is offered after you were last in the room (the web app's 30 min).
pub(crate) const LAST_ROOM_FRESH_MS: u64 = 30 * 60 * 1000;

impl LastRoom {
    /// Still worth offering at `now` (ms since 1970).
    pub(crate) fn fresh(&self, now: u64) -> bool {
        now.saturating_sub(self.at) < LAST_ROOM_FRESH_MS && rtc_protocol::RoomId::parse(&self.room_id).is_ok()
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            settings_version: SETTINGS_VERSION,
            username: String::new(),
            client_id: String::new(),
            signal_url: String::new(),
            input_device_id: String::new(),
            input_device_label: String::new(),
            output_device_id: String::new(),
            output_device_label: String::new(),
            panel_open: true,
            voice_mode: VoiceMode::Open,
            // `~` (left of 1): rarely typed, and it doesn't do anything in most apps
            ptt_keys: Binding::key(Key::BACKQUOTE),
            ptt_release_ms: 200,
            ptt_chime: true,
            mute_keys: Binding::default(),
            deafen_keys: Binding::default(),
            close_to_tray: true,
            told_about_tray: false,
            notifications: true,
            open_links: true,
            last_room: None,
            voice_isolation: true,
            classic_audio: false,
            volumes: std::collections::BTreeMap::new(),
            quick_reactions: DEFAULT_REACTIONS.iter().map(|e| (*e).to_owned()).collect(),
            soundboard_volume: 0.75,
            soundboard_muted: false,
            low_power: false,
            auto_update: true,
            qp_region: String::new(),
            overlay: false,
            overlay_corner: 0,
        }
    }
}

/// The folder the settings live in (also the quick picks list).
pub(crate) fn dir() -> Option<PathBuf> {
    let p = path()?;
    let d = p.parent()?.to_path_buf();
    let _ = std::fs::create_dir_all(&d);
    Some(d)
}

fn path() -> Option<PathBuf> {
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(PathBuf::from))
        && dir.join("portable").exists()
    {
        return Some(dir.join("settings.json"));
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("3RTC").join("settings.json"))
}

impl Settings {
    /// Brings a settings file from an older app up to date; true if anything changed. A file
    /// from a newer app is left as it is (its extra fields are kept by nobody, but nothing of
    /// ours is lost).
    pub(crate) fn migrate(&mut self) -> bool {
        if self.settings_version >= SETTINGS_VERSION {
            return false;
        }
        // 1 → 2 (M3): new fields only (reactions, soundboard, audio path, volumes, low power),
        // which their defaults fill in; the push-to-talk delay is kept within the web app's range
        if self.settings_version < 2 {
            self.ptt_release_ms = self.ptt_release_ms.clamp(0, 2000);
        }
        self.settings_version = SETTINGS_VERSION;
        true
    }

    /// Saved settings, or new ones (and saved) on first launch.
    pub(crate) fn load() -> Self {
        let saved = path()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<Self>(&b).ok());
        let mut s = saved.unwrap_or_default();
        if s.migrate() {
            s.save();
        }
        s.quick_reactions = clean_reactions(&s.quick_reactions);
        if !(0.0..=1.0).contains(&s.soundboard_volume) {
            s.soundboard_volume = 0.75;
        }
        if rtc_protocol::ClientId::new(&s.client_id).is_err() {
            s.client_id = format!("dk-{:016x}", rand::random::<u64>());
            s.save();
        }
        s
    }

    /// Best effort: a read-only profile just means nothing is remembered.
    pub(crate) fn save(&self) {
        let Some(p) = path() else { return };
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(self)
            && let Err(e) = std::fs::write(&p, json)
        {
            tracing::warn!("couldn't save settings to {}: {e}", p.display());
        }
    }

    /// The servers to try, in order: `RTC_SIGNAL_URL` (development), else the one picked in
    /// Server settings, else Oracle; the real servers follow as fallbacks (`fallbackUrls`).
    pub(crate) fn signaling_urls(&self) -> Vec<String> {
        if let Ok(url) = std::env::var("RTC_SIGNAL_URL") {
            return vec![url];
        }
        let first = if self.signal_url.is_empty() {
            ORACLE
        } else {
            self.signal_url.as_str()
        };
        let mut urls = vec![first.to_owned()];
        let rest: Vec<&str> = match first {
            ORACLE => vec![GCP, BACKUPS[0], BACKUPS[1]],
            GCP => vec![ORACLE, BACKUPS[0], BACKUPS[1]],
            _ => Vec::new(),
        };
        urls.extend(rest.into_iter().map(str::to_owned));
        urls
    }
}

#[cfg(test)]
mod tests {
    use super::{LAST_ROOM_FRESH_MS, LastRoom, Settings, VoiceMode};

    #[test]
    fn old_settings_files_get_the_new_defaults() {
        let s: Settings =
            serde_json::from_str(r#"{"username":"Darshan","panelOpen":false}"#).unwrap_or_default();
        assert_eq!(s.username, "Darshan");
        assert!(!s.panel_open);
        assert_eq!(s.voice_mode, VoiceMode::Open);
        assert_eq!(s.ptt_keys.to_string(), "~");
        assert_eq!(s.ptt_release_ms, 200);
        assert!(s.close_to_tray && s.notifications && s.open_links);
        assert!(s.mute_keys.is_empty());
        assert!(s.voice_isolation && !s.classic_audio && s.volumes.is_empty());
        assert_eq!(s.quick_reactions.len(), 6);
        assert!((s.soundboard_volume - 0.75).abs() < f32::EPSILON && !s.soundboard_muted);
    }

    #[test]
    fn old_files_are_migrated_once() {
        let mut s: Settings =
            serde_json::from_str(r#"{"settingsVersion":1,"username":"D","pttReleaseMs":99999}"#)
                .unwrap_or_default();
        assert!(s.migrate());
        assert_eq!(s.settings_version, super::SETTINGS_VERSION);
        assert_eq!(s.ptt_release_ms, 2000);
        assert!(!s.migrate(), "nothing more to do");
        let mut newer: Settings = serde_json::from_str(r#"{"settingsVersion":9}"#).unwrap_or_default();
        assert!(!newer.migrate());
        assert_eq!(newer.settings_version, 9, "a newer app's file isn't downgraded");
    }

    #[test]
    fn quick_reactions_are_cleaned() {
        let list: Vec<String> = [
            "🔥", "🔥", "nope", "👍", "1", "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
        ]
        .iter()
        .map(|e| (*e).to_owned())
        .collect();
        let c = super::clean_reactions(&list);
        assert_eq!(c.len(), 10);
        assert_eq!(c[..2], ["🔥".to_owned(), "👍".to_owned()]);
        assert_eq!(super::clean_reactions(&[]).len(), 6, "empty: the defaults");
        assert_eq!(super::key_for_index(0), "1");
        assert_eq!(super::key_for_index(9), "0");
    }

    #[test]
    fn the_last_room_is_offered_for_half_an_hour() {
        let r = LastRoom {
            room_id: "12345".into(),
            was_host: false,
            host_token: None,
            at: 1_000,
        };
        assert!(r.fresh(1_000 + LAST_ROOM_FRESH_MS - 1));
        assert!(!r.fresh(1_000 + LAST_ROOM_FRESH_MS));
        let bad = LastRoom {
            room_id: "abc".into(),
            ..r
        };
        assert!(!bad.fresh(1_000));
    }
}
