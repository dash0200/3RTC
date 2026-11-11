//! What the app remembers between launches. JSON in the user's own app-data folder
//! (`%APPDATA%\3RTC\settings.json`), or next to the exe when a file named `portable` sits beside
//! it. No admin rights, no registry.

use std::path::PathBuf;

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
