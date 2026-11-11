//! What the app remembers between launches: the display name and this install's id.
//! Stored as JSON in the user's own app-data folder (no admin rights, no registry).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Settings {
    pub(crate) username: String,
    pub(crate) client_id: String,
}

fn path() -> Option<PathBuf> {
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
        saved
            .filter(|s| rtc_protocol::ClientId::new(&s.client_id).is_ok())
            .unwrap_or_else(|| {
                let fresh = Self {
                    username: String::new(),
                    client_id: format!("dk-{:016x}", rand::random::<u64>()),
                };
                fresh.save();
                fresh
            })
    }

    /// Best effort: a read-only profile just means the name isn't remembered.
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
}
