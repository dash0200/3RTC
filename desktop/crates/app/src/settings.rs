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
            settings_version: 1,
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
        }
    }
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
    /// Saved settings, or new ones (and saved) on first launch.
    pub(crate) fn load() -> Self {
        let saved = path()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<Self>(&b).ok());
        let mut s = saved.unwrap_or_default();
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
