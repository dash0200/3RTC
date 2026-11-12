//! Updates in place, without admin rights or a signed installer: the app reads
//! `https://3rtc.me/desktop/latest.json`, downloads a newer `3rtc.exe` next to itself, checks
//! its SHA-256, and swaps it in (a running exe can be renamed on Windows, not overwritten): the
//! old one becomes `3rtc.old.exe` and is deleted on the next start. The new version runs from the
//! next launch, or at once with "Restart now".
//!
//! `latest.json` (written by `packaging/package.ps1`):
//! `{"build": "261112.1430", "notes": "…", "exe": {"url": "https://…/3rtc.exe", "sha256": "…", "size": 123}}`

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest as _, Sha256};

/// Where the newest version is described (`RTC_UPDATE_FEED` overrides it, for tests).
pub(crate) const FEED: &str = "https://3rtc.me/desktop/latest.json";
/// First check this long after starting, then every [`EVERY`].
pub(crate) const FIRST: Duration = Duration::from_secs(15);
pub(crate) const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// The largest download accepted (the exe is far smaller).
const MAX_BYTES: u64 = 400 * 1024 * 1024;

/// What the update check is doing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Status {
    /// Not checked yet.
    Idle,
    Checking,
    UpToDate,
    /// Downloading this build: percent.
    Downloading(String, u8),
    /// This build is in place: it runs from the next start.
    Ready(String),
    Failed(String),
    /// A build without a number (from source): updates are off.
    Dev,
}

/// `latest.json`.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) build: String,
    #[serde(default)]
    pub(crate) notes: String,
    pub(crate) exe: Asset,
}

/// A file to download.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Asset {
    pub(crate) url: String,
    pub(crate) sha256: String,
    #[serde(default)]
    pub(crate) size: u64,
}

/// A real build number (`YYMMDD.HHMM`).
pub(crate) fn is_release(build: &str) -> bool {
    let b = build.as_bytes();
    b.len() == 11 && b[6] == b'.' && b.iter().enumerate().all(|(i, c)| i == 6 || c.is_ascii_digit())
}

/// `remote` is newer than `local` (both `YYMMDD.HHMM`, which sort as text).
pub(crate) fn newer(remote: &str, local: &str) -> bool {
    is_release(remote) && is_release(local) && remote > local
}

fn feed() -> String {
    std::env::var("RTC_UPDATE_FEED").unwrap_or_else(|_| FEED.to_owned())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(600)))
        .timeout_connect(Some(Duration::from_secs(15)))
        .build()
        .into()
}

/// Reads `latest.json` (blocking: call it off the UI thread).
pub(crate) fn check() -> Result<Manifest, String> {
    let body = agent()
        .get(&feed())
        .call()
        .map_err(|e| format!("couldn't reach the update server ({e})"))?
        .into_body()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .map_err(|e| format!("couldn't read the update info ({e})"))?;
    serde_json::from_str(body.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("the update info is unreadable ({e})"))
}

/// Downloads `asset`, checks it, and swaps it in for the running exe. `progress` gets percents.
pub(crate) fn install(asset: &Asset, progress: &dyn Fn(u8)) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("no folder for the app")?.to_path_buf();
    let new = dir.join("3rtc.new.exe");
    let bytes = download(asset, progress)?;
    std::fs::write(&new, &bytes)
        .map_err(|e| format!("couldn't save the update in {} ({e})", dir.display()))?;
    swap(&exe, &new)
}

fn download(asset: &Asset, progress: &dyn Fn(u8)) -> Result<Vec<u8>, String> {
    if !asset.url.starts_with("https://") && std::env::var_os("RTC_UPDATE_FEED").is_none() {
        return Err("the update isn't on a secure address".to_owned());
    }
    let response = agent()
        .get(&asset.url)
        .call()
        .map_err(|e| format!("couldn't download the update ({e})"))?;
    let total = if asset.size > 0 {
        asset.size
    } else {
        response.body().content_length().unwrap_or(0)
    };
    let mut reader = response.into_body().into_with_config().limit(MAX_BYTES).reader();
    let mut out = Vec::with_capacity(usize::try_from(total).unwrap_or(0));
    let mut buf = vec![0u8; 256 * 1024];
    let mut last = 0u8;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("the download stopped ({e})"))?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        if total > 0 {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                clippy::cast_precision_loss
            )]
            let pct = ((out.len() as f64 / total as f64) * 100.0).min(100.0) as u8;
            if pct != last {
                last = pct;
                progress(pct);
            }
        }
    }
    let got = hex(&Sha256::digest(&out));
    if !got.eq_ignore_ascii_case(asset.sha256.trim()) {
        return Err("the download doesn't match its checksum (not installed)".to_owned());
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `exe` → `3rtc.old.exe`, `new` → `exe`; put back on any failure.
fn swap(exe: &Path, new: &Path) -> Result<(), String> {
    let old = old_path(exe);
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old).map_err(|e| format!("couldn't make room for the update ({e})"))?;
    if let Err(e) = std::fs::rename(new, exe) {
        let _ = std::fs::rename(&old, exe);
        return Err(format!("couldn't put the update in place ({e})"));
    }
    Ok(())
}

fn old_path(exe: &Path) -> PathBuf {
    exe.with_file_name("3rtc.old.exe")
}

/// Deletes the version an update replaced (at start; it may still be running for a moment).
pub(crate) fn clean_up() {
    if let Ok(exe) = std::env::current_exe() {
        let old = old_path(&exe);
        for _ in 0..10 {
            if !old.exists() || std::fs::remove_file(&old).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        let _ = std::fs::remove_file(exe.with_file_name("3rtc.new.exe"));
    }
}

/// Starts the updated app (it waits for this one to close) .
pub(crate) fn restart() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe)
        .arg("--after-update")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("couldn't start the new version ({e})"))
}

#[cfg(test)]
mod tests {
    use super::{Manifest, hex, is_release, newer, swap};

    #[test]
    fn build_numbers() {
        assert!(is_release("261112.1430"));
        assert!(!is_release("Development build"));
        assert!(!is_release("57"));
        assert!(newer("261112.1430", "261112.1200"));
        assert!(newer("270101.0000", "261231.2359"));
        assert!(!newer("261112.1200", "261112.1200"));
        assert!(
            !newer("261112.1430", "Development build"),
            "no updates for builds from source"
        );
    }

    #[test]
    fn reads_the_feed() {
        let m: Manifest = serde_json::from_str(
            r#"{"build":"261112.1430","notes":"Reactions","exe":{"url":"https://3rtc.me/desktop/3rtc.exe","sha256":"ab","size":9}}"#,
        )
        .unwrap_or_else(|e| unreachable!("{e}"));
        assert_eq!((m.build.as_str(), m.exe.size), ("261112.1430", 9));
        assert_eq!(hex(&[0, 255, 16]), "00ff10");
    }

    #[test]
    fn the_swap_keeps_the_old_one_aside() {
        let dir = std::env::temp_dir().join(format!("3rtc-update-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let exe = dir.join("3rtc.exe");
        let new = dir.join("3rtc.new.exe");
        std::fs::write(&exe, b"old").unwrap_or_default();
        std::fs::write(&new, b"new").unwrap_or_default();
        assert!(swap(&exe, &new).is_ok());
        assert_eq!(std::fs::read(&exe).unwrap_or_default(), b"new");
        assert_eq!(
            std::fs::read(dir.join("3rtc.old.exe")).unwrap_or_default(),
            b"old"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
