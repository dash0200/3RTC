//! The log file, for working out afterwards what went wrong: `logs\3rtc-<date>.log` in the folder
//! 3rtc.exe runs from (`%LOCALAPPDATA%\Programs\3RTC` when installed), or
//! `%LOCALAPPDATA%\3RTC\logs` when that folder can't be written to.
//!
//! Only what helps: errors and warnings, our own notes about connections, the signaling server,
//! audio devices, screen sharing and transfers, the room's connection events, and a crash's
//! place and message ([`wanted`]). Not saved: debug chatter, the every-few-seconds statistics
//! (the engine's `rtc_engine::periodic` target; poor connections are logged on their own),
//! playback and soundboard events (`rtc_engine::activity`), libwebrtc's own info lines.
//! The same line over and over is written once with a count, and at most [`MAX_PER_MINUTE`]
//! lines a minute are kept ([`Gate`]). One file a day, at most [`MAX_FILE_BYTES`]; files older
//! than [`KEEP_DAYS`] days are deleted.
//!
//! A run that never closed properly (a crash, the process ended in Task Manager, the PC turned
//! off) is noticed at the next start: the `running` marker is still there ([`session_start`]).

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use tracing::Level;
use tracing_subscriber::fmt::MakeWriter;

/// Days of logs kept.
pub(crate) const KEEP_DAYS: i64 = 14;
/// One day's file stops growing here.
pub(crate) const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// Lines kept a minute (a burst past this is counted, not written).
pub(crate) const MAX_PER_MINUTE: u32 = 120;
/// There while 3RTC runs; left behind by a run that didn't close properly.
const MARKER: &str = "running";
const PREFIX: &str = "3rtc-";

/// Where the logs go (chosen once).
static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The logs folder: next to the exe if it can be written to, else under `%LOCALAPPDATA%`.
pub(crate) fn dir() -> Option<&'static Path> {
    DIR.get_or_init(|| {
        let beside_exe = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.join("logs")));
        let local = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("3RTC").join("logs"));
        [beside_exe, local].into_iter().flatten().find(|d| writable(d))
    })
    .as_deref()
}

fn writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    let ok = File::create(&probe).is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

/// Whether an event belongs in the file.
pub(crate) fn wanted(level: &Level, target: &str) -> bool {
    // statistics every few seconds, playback and soundboard events: the Logs tab has those
    if target.starts_with("rtc_engine::periodic") || target.starts_with("rtc_engine::activity") {
        return false;
    }
    if *level == Level::ERROR {
        return true;
    }
    if *level == Level::WARN {
        // torrent swarms: peers come and go all the time
        return !target.starts_with("librqbit");
    }
    if *level == Level::INFO {
        // libwebrtc's own info lines are its internals
        if target.starts_with("rtc_webrtc::native") {
            return false;
        }
        let ours = [
            "rtc_engine",
            "rtc_signaling",
            "rtc_webrtc",
            "rtc_audio",
            "rtc_platform_win",
            env!("CARGO_CRATE_NAME"),
        ];
        return ours.iter().any(|p| target.starts_with(p));
    }
    false
}

/// Keeps the file readable: the same line again is counted instead of written, and past
/// [`MAX_PER_MINUTE`] lines in a minute the rest are counted.
#[derive(Debug, Default)]
pub(crate) struct Gate {
    last: Option<String>,
    repeats: u32,
    minute: u64,
    in_minute: u32,
    dropped: u32,
}

impl Gate {
    /// The lines to write for `text`, logged in `minute` (minutes since 1970).
    pub(crate) fn pass(&mut self, minute: u64, text: &str) -> Vec<String> {
        let mut out = Vec::new();
        if self.last.as_deref() == Some(text) {
            self.repeats += 1;
            return out;
        }
        if self.repeats > 0 {
            out.push(format!("… the line above came {} more times", self.repeats));
            self.repeats = 0;
        }
        self.last = Some(text.to_owned());
        if minute != self.minute {
            if self.dropped > 0 {
                out.push(format!("… {} more lines that minute were left out", self.dropped));
            }
            self.minute = minute;
            self.in_minute = 0;
            self.dropped = 0;
        }
        if self.in_minute >= MAX_PER_MINUTE {
            self.dropped += 1;
        } else {
            self.in_minute += 1;
            out.push(text.to_owned());
        }
        out
    }
}

/// A log file older than `keep` days before `today` (`3rtc-YYYY-MM-DD.log`); other files are
/// never touched.
pub(crate) fn expired(name: &str, today: chrono::NaiveDate, keep: i64) -> bool {
    let Some(date) = name.strip_prefix(PREFIX).and_then(|n| n.strip_suffix(".log")) else {
        return false;
    };
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok_and(|d| (today - d).num_days() > keep)
}

/// Today's log file to show in Explorer (the folder until something is written today).
pub(crate) fn to_show() -> Option<PathBuf> {
    let dir = dir()?;
    let today = dir.join(file_name(&chrono::Local::now().format("%Y-%m-%d").to_string()));
    Some(if today.exists() { today } else { dir.to_path_buf() })
}

fn file_name(day: &str) -> String {
    format!("{PREFIX}{day}.log")
}

/// The open day's file.
struct Sink {
    dir: PathBuf,
    day: String,
    file: Option<File>,
    written: u64,
    full: bool,
    gate: Gate,
}

impl Sink {
    fn event(&mut self, text: &str) {
        let now = chrono::Local::now();
        let day = now.format("%Y-%m-%d").to_string();
        if day != self.day || self.file.is_none() {
            let path = self.dir.join(file_name(&day));
            self.file = OpenOptions::new().create(true).append(true).open(&path).ok();
            self.written = self
                .file
                .as_ref()
                .and_then(|f| f.metadata().ok())
                .map_or(0, |m| m.len());
            self.full = false;
            self.day = day;
        }
        let minute = u64::try_from(now.timestamp() / 60).unwrap_or(0);
        let time = now.format("%H:%M:%S%.3f").to_string();
        for line in self.gate.pass(minute, text) {
            let Some(file) = self.file.as_mut() else { return };
            if self.written >= MAX_FILE_BYTES {
                if !self.full {
                    self.full = true;
                    let note =
                        format!("{time} … today's log is full; nothing more is saved until tomorrow\r\n");
                    let _ = file.write_all(note.as_bytes());
                }
                continue;
            }
            // later lines of one entry are indented under its time
            let body = line.replace("\r\n", "\n").replace('\n', "\r\n             ");
            let entry = format!("{time} {body}\r\n");
            if file.write_all(entry.as_bytes()).is_ok() {
                self.written += entry.len() as u64;
            }
        }
    }
}

std::thread_local! {
    /// This thread is writing a line (a panic in there must not log again: it would wait on itself).
    static WRITING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Hands `tracing_subscriber::fmt` a writer per event; the event goes to the file whole.
#[derive(Clone)]
pub(crate) struct LogFile(Arc<Mutex<Sink>>);

/// One event's text, written when it's dropped.
pub(crate) struct Entry {
    sink: Arc<Mutex<Sink>>,
    buf: Vec<u8>,
}

impl std::io::Write for Entry {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        let text = String::from_utf8_lossy(&self.buf);
        let text = text.trim_end();
        if text.is_empty() || WRITING.with(std::cell::Cell::get) {
            return;
        }
        WRITING.with(|w| w.set(true));
        self.sink
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .event(text);
        WRITING.with(|w| w.set(false));
    }
}

impl<'a> MakeWriter<'a> for LogFile {
    type Writer = Entry;

    fn make_writer(&'a self) -> Self::Writer {
        Entry {
            sink: Arc::clone(&self.0),
            buf: Vec::new(),
        }
    }
}

/// The file writer (and old files tidied away), or `None` when no folder can be written to.
pub(crate) fn open() -> Option<LogFile> {
    let dir = dir()?.to_path_buf();
    let today = chrono::Local::now().date_naive();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            if expired(&e.file_name().to_string_lossy(), today, KEEP_DAYS) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    Some(LogFile(Arc::new(Mutex::new(Sink {
        dir,
        day: String::new(),
        file: None,
        written: 0,
        full: false,
        gate: Gate::default(),
    }))))
}

/// This run starts (the one 3RTC of this user, after the single-instance check): a header line,
/// and a warning if the last run never closed properly.
pub(crate) fn session_start(build: &str) {
    let Some(dir) = dir() else { return };
    let marker = dir.join(MARKER);
    if let Ok(last) = fs::read_to_string(&marker) {
        tracing::warn!(
            "The last run ({}) didn't close properly: it crashed, was ended in Task Manager, or the PC \
             shut down with it open. The lines before this one are its last.",
            last.trim()
        );
    }
    let started = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    tracing::info!(
        "──── 3RTC {build} started ({exe}, process {}, {}) ────",
        std::process::id(),
        windows_version()
    );
    let _ = fs::write(
        &marker,
        format!(
            "started {started}, version {build}, process {}",
            std::process::id()
        ),
    );
    install_panic_hook();
}

/// This run closes properly.
pub(crate) fn session_end() {
    static ENDED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if ENDED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let Some(dir) = dir() else { return };
    if fs::remove_file(dir.join(MARKER)).is_ok() {
        tracing::info!("──── 3RTC closed ────");
    }
}

/// A panic (the release app stops right after) goes in the file with where it happened.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".to_owned());
        let place = info
            .location()
            .map_or_else(|| "an unknown place".to_owned(), ToString::to_string);
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed");
        tracing::error!("CRASH on thread '{name}' at {place}: {what}");
        if cfg!(debug_assertions) {
            tracing::error!("{}", std::backtrace::Backtrace::force_capture());
        }
        previous(info);
    }));
}

fn windows_version() -> String {
    rtc_platform_win::windows_version().unwrap_or_else(|| "Windows version unknown".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{Gate, MAX_PER_MINUTE, expired, wanted};
    use tracing::Level;

    #[test]
    fn keeps_problems_and_our_notes_not_chatter() {
        assert!(wanted(&Level::ERROR, "anything"));
        assert!(wanted(&Level::WARN, "gpui"));
        assert!(
            !wanted(&Level::WARN, "librqbit::peer_connection"),
            "swarm peers come and go"
        );
        assert!(wanted(&Level::ERROR, "librqbit::session"));
        assert!(wanted(&Level::INFO, "rtc_signaling"));
        assert!(wanted(&Level::INFO, "rtc_engine::peers"));
        assert!(wanted(&Level::INFO, "rtc_engine::quality"));
        assert!(!wanted(&Level::INFO, "rtc_engine::periodic"));
        assert!(!wanted(&Level::WARN, "rtc_engine::activity"));
        assert!(!wanted(&Level::INFO, "rtc_webrtc::native"));
        assert!(wanted(&Level::WARN, "rtc_webrtc::native"));
        assert!(!wanted(&Level::INFO, "wgpu_core::device"));
        assert!(!wanted(&Level::DEBUG, "rtc_engine::peers"));
        assert!(wanted(
            &Level::INFO,
            concat!(env!("CARGO_CRATE_NAME"), "::torrent")
        ));
    }

    #[test]
    fn the_same_line_again_is_counted_not_written() {
        let mut g = Gate::default();
        assert_eq!(g.pass(1, "a"), vec!["a"]);
        assert!(g.pass(1, "a").is_empty());
        assert!(g.pass(1, "a").is_empty());
        assert_eq!(g.pass(1, "b"), vec!["… the line above came 2 more times", "b"]);
        assert_eq!(g.pass(1, "a"), vec!["a"]);
    }

    #[test]
    fn a_burst_is_cut_and_counted() {
        let mut g = Gate::default();
        let mut written = 0;
        for i in 0..(MAX_PER_MINUTE + 30) {
            written += g.pass(5, &format!("line {i}")).len();
        }
        assert_eq!(written, MAX_PER_MINUTE as usize);
        assert_eq!(
            g.pass(6, "next minute"),
            vec!["… 30 more lines that minute were left out", "next minute"]
        );
    }

    #[test]
    fn only_old_log_files_are_deleted() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 20).unwrap();
        assert!(expired("3rtc-2026-11-01.log", today, 14));
        assert!(!expired("3rtc-2026-11-06.log", today, 14));
        assert!(!expired("3rtc-2026-11-20.log", today, 14));
        assert!(!expired("notes.txt", today, 14));
        assert!(!expired("3rtc-garbage.log", today, 14));
        assert!(!expired("running", today, 14));
    }
}
