//! Per-app sound (BUILD_SPEC §9 feature 8): one program's sound only (a game, a music player),
//! captured with WASAPI process loopback (Windows 10 2004 and later), so the room hears it
//! without hearing everything else on this computer. Nothing is installed (no virtual cable).
//!
//! [`audio_apps`] lists the programs that have sound open; [`AppSound::start`] captures one
//! (with its child processes, as browsers play from helper processes) as 48 kHz mono.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, eConsole, eRender,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::{Interface, PWSTR};

use crate::AudioApp;

/// What the capture delivers: 48 kHz.
const RATE: u32 = 48_000;
/// 20 ms, in 100 ns units.
const BUFFER_HNS: i64 = 200_000;
const CHANNELS: u16 = 2;

/// COM on this thread for as long as it lives.
struct Com(bool);

impl Com {
    fn init() -> Self {
        // SAFETY: balanced by `CoUninitialize` in `drop` when it succeeded, on the same thread
        // (a thread already in another apartment keeps it, and isn't uninitialised).
        Self(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful `CoInitializeEx` in `init`, same thread.
            unsafe { CoUninitialize() };
        }
    }
}

fn process_name(pid: u32) -> Option<String> {
    // SAFETY: opens a process for name lookup only; closed below.
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buf = [0u16; 512];
    let mut len = u32::try_from(buf.len()).unwrap_or(0);
    // SAFETY: `buf` holds `len` UTF-16 units; Windows writes at most that many and updates `len`.
    let ok =
        unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &raw mut len) };
    // SAFETY: the handle opened above.
    let _ = unsafe { CloseHandle(h) };
    ok.ok()?;
    let path = String::from_utf16_lossy(&buf[..usize::try_from(len).unwrap_or(0).min(buf.len())]);
    let file = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_owned();
    Some(
        file.strip_suffix(".exe")
            .or_else(|| file.strip_suffix(".EXE"))
            .unwrap_or(&file)
            .to_owned(),
    )
}

/// Programs with sound open on the default speakers (playing now first), not 3RTC itself.
#[must_use]
pub fn audio_apps() -> Vec<AudioApp> {
    let _com = Com::init();
    let me = std::process::id();
    let mut out: Vec<AudioApp> = Vec::new();
    let found = (|| -> windows::core::Result<()> {
        // SAFETY: creates the system's device enumerator (COM is initialised above).
        let devices: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }?;
        // SAFETY: a plain COM call on a valid interface.
        let speakers = unsafe { devices.GetDefaultAudioEndpoint(eRender, eConsole) }?;
        // SAFETY: as above.
        let sessions: IAudioSessionManager2 = unsafe { speakers.Activate(CLSCTX_ALL, None) }?;
        // SAFETY: as above.
        let list = unsafe { sessions.GetSessionEnumerator() }?;
        // SAFETY: as above.
        let n = unsafe { list.GetCount() }?;
        for i in 0..n {
            // SAFETY: `i` is below the count just read.
            let Ok(s) = (unsafe { list.GetSession(i) }) else {
                continue;
            };
            let Ok(s2) = s.cast::<IAudioSessionControl2>() else {
                continue;
            };
            // SAFETY: a plain COM call on a valid interface.
            let Ok(pid) = (unsafe { s2.GetProcessId() }) else {
                continue;
            };
            if pid == 0 || pid == me {
                continue;
            }
            // SAFETY: as above.
            let playing = unsafe { s.GetState() }.is_ok_and(|st| st == AudioSessionStateActive);
            let Some(name) = process_name(pid) else { continue };
            match out.iter_mut().find(|a| a.name.eq_ignore_ascii_case(&name)) {
                Some(a) => a.playing |= playing,
                None => out.push(AudioApp { pid, name, playing }),
            }
        }
        Ok(())
    })();
    if let Err(e) = found {
        tracing::debug!("audio apps: {e}");
    }
    out.sort_by(|a, b| {
        b.playing
            .cmp(&a.playing)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

/// Captures `pid`'s sound until `stop`, through the `wasapi` crate (its process-loopback client
/// is the tested one; an earlier hand-written version corrupted the heap on activation).
fn capture(
    pid: u32,
    stop: &AtomicBool,
    on_samples: &mut dyn FnMut(&[f32]),
    ready: &Sender<Result<(), String>>,
) -> Result<(), String> {
    use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};
    let err = |what: &str, e: &dyn std::fmt::Display| {
        tracing::warn!("app sound: {what}: {e}");
        format!("{what} ({e})")
    };
    tracing::info!("app sound: activating process loopback for pid {pid}");
    let mut client = AudioClient::new_application_loopback_client(pid, true)
        .map_err(|e| err("Windows refused to capture that app", &e))?;
    tracing::info!("app sound: activated");
    let format = WaveFormat::new(
        16,
        16,
        SampleType::Int,
        usize::try_from(RATE).unwrap_or(48_000),
        usize::from(CHANNELS),
        None,
    );
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: BUFFER_HNS,
    };
    client
        .initialize_client(&format, Direction::Capture, mode, None)
        .map_err(|e| err("couldn't set up the capture", &e))?;
    tracing::info!("app sound: initialised");
    let event = client
        .set_get_eventhandle()
        .map_err(|e| err("no capture event", &e))?;
    let reader = client
        .get_audiocaptureclient()
        .map_err(|e| err("no capture client", &e))?;
    client.start_stream().map_err(|e| err("couldn't start", &e))?;
    tracing::info!("app sound: capturing");
    let _ = ready.send(Ok(()));
    let mut bytes: VecDeque<u8> = VecDeque::with_capacity(48_000);
    let mut mono: Vec<f32> = Vec::with_capacity(4800);
    let mut first = true;
    while !stop.load(Ordering::Relaxed) {
        if event.wait_for_event(100).is_err() {
            continue;
        }
        if let Err(e) = reader.read_from_device_to_deque(&mut bytes) {
            let _ = client.stop_stream();
            return Err(err("the capture stopped", &e));
        }
        // 16-bit stereo: 4 bytes a frame, little-endian
        mono.clear();
        while bytes.len() >= 4 {
            let mut b = [0u8; 4];
            for x in &mut b {
                *x = bytes.pop_front().unwrap_or(0);
            }
            let l = i16::from_le_bytes([b[0], b[1]]);
            let r = i16::from_le_bytes([b[2], b[3]]);
            mono.push((f32::from(l) + f32::from(r)) / (2.0 * 32_768.0));
        }
        if mono.is_empty() {
            continue;
        }
        if first {
            first = false;
            tracing::info!("app sound: first {} frames", mono.len());
        }
        on_samples(&mono);
    }
    let _ = client.stop_stream();
    Ok(())
}

/// One program's sound being captured (dropping it stops).
pub struct AppSound {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for AppSound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppSound").finish_non_exhaustive()
    }
}

impl AppSound {
    /// Captures `pid`'s sound (and its child processes'): `on_samples` gets 48 kHz mono, about
    /// every 10 ms, on the capture thread.
    ///
    /// # Errors
    /// Windows older than 10 2004, the program is gone, or Windows refused.
    pub fn start(pid: u32, on_samples: impl FnMut(&[f32]) + Send + 'static) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let (ready, started) = channel();
        let thread = std::thread::Builder::new()
            .name("3rtc-app-sound".to_owned())
            .spawn(move || {
                let _com = Com::init();
                let mut on_samples = on_samples;
                if let Err(e) = capture(pid, &flag, &mut on_samples, &ready) {
                    let _ = ready.send(Err(e));
                }
            })
            .map_err(|e| e.to_string())?;
        match started.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(thread),
            }),
            Ok(Err(e)) => Err(if e.is_empty() {
                "Windows refused".to_owned()
            } else {
                e
            }),
            Err(_) => {
                stop.store(true, Ordering::Relaxed);
                Err("Windows didn't answer".to_owned())
            }
        }
    }
}

impl Drop for AppSound {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
