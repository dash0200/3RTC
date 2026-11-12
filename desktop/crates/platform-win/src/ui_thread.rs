//! A second UI thread with its own message loop, for things that must not run on GPUI's thread.
//!
//! The YouTube/Vimeo/Twitch player (a WebView2) runs a nested message loop while it starts. On
//! GPUI's thread that loop re-entered GPUI while it was busy (a click being handled) and it
//! panicked ("RefCell already borrowed"). On this thread the web view starts and lives without
//! touching GPUI: its window is a child of the app's window, and every call to it is a job sent
//! here. GPUI's thread never waits on this one: a child window across threads sends messages to
//! its parent's thread, so waiting could deadlock.

use std::sync::mpsc::{Receiver, Sender, channel};

use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW, PostQuitMessage, PostThreadMessageW,
    SetTimer, TranslateMessage, WM_APP, WM_USER,
};

type Job = Box<dyn FnOnce() + Send>;

/// "Jobs are waiting."
const WM_JOBS: u32 = WM_APP + 9;
/// Jobs are also checked this often (a job posted while a nested loop ran isn't lost).
const SWEEP_MS: u32 = 100;

fn run_jobs(jobs: &Receiver<Job>) {
    while let Ok(job) = jobs.try_recv() {
        job();
    }
}

fn thread_main(jobs: &Receiver<Job>, started: &Sender<u32>) {
    // SAFETY: an apartment for this thread (WebView2 needs one), released at the end.
    let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let mut msg = MSG::default();
    // SAFETY: makes this thread's message queue exist before anyone posts to it.
    let _ = unsafe { PeekMessageW(&raw mut msg, None, WM_USER, WM_USER, PM_NOREMOVE) };
    // SAFETY: a thread timer (no window); it lives as long as this thread.
    let _ = unsafe { SetTimer(None, 0, SWEEP_MS, None) };
    // SAFETY: a plain query.
    let _ = started.send(unsafe { GetCurrentThreadId() });
    loop {
        // SAFETY: `msg` is a valid place for the next message of this thread.
        let got = unsafe { GetMessageW(&raw mut msg, None, 0, 0) };
        if got.0 <= 0 {
            break;
        }
        if msg.hwnd.is_invalid() {
            // ours (jobs or the sweep timer)
            run_jobs(jobs);
            if msg.message == WM_JOBS {
                continue;
            }
        }
        // SAFETY: `msg` was filled by GetMessageW above.
        let _ = unsafe { TranslateMessage(&raw const msg) };
        // SAFETY: as above.
        unsafe { DispatchMessageW(&raw const msg) };
    }
    // jobs sent before the end (dropping what lives here)
    run_jobs(jobs);
    if com {
        // SAFETY: balances the CoInitializeEx above, same thread.
        unsafe { CoUninitialize() };
    }
}

/// A UI thread that runs the jobs sent to it, in order.
pub struct UiThread {
    tid: u32,
    jobs: Sender<Job>,
}

impl std::fmt::Debug for UiThread {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UiThread").finish_non_exhaustive()
    }
}

impl UiThread {
    /// Starts it. `None` if the thread couldn't start.
    #[must_use]
    pub fn start(name: &str) -> Option<Self> {
        let (jobs, rx) = channel::<Job>();
        let (started, tid) = channel();
        std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || thread_main(&rx, &started))
            .ok()?;
        // only the thread's start: it touches no window yet
        let tid = tid.recv().ok()?;
        Some(Self { tid, jobs })
    }

    /// Runs `job` on that thread (soon; never waits for it).
    pub fn run(&self, job: impl FnOnce() + Send + 'static) {
        if self.jobs.send(Box::new(job)).is_ok() {
            // SAFETY: posts to our own thread's queue (gone: nothing happens).
            let _ = unsafe { PostThreadMessageW(self.tid, WM_JOBS, WPARAM(0), LPARAM(0)) };
        }
    }
}

impl Drop for UiThread {
    fn drop(&mut self) {
        // after the jobs already sent: end the loop (not waited for, see the module notes)
        self.run(|| {
            // SAFETY: ends this (the UI) thread's message loop.
            unsafe { PostQuitMessage(0) };
        });
    }
}

/// A window to be the parent of one made on another thread (a plain `HWND`, so it can be sent).
#[derive(Debug, Clone, Copy)]
pub struct ParentWindow(std::num::NonZeroIsize);

impl ParentWindow {
    /// The window behind `window` (`None`: not a Win32 window).
    #[must_use]
    pub fn of(window: &impl raw_window_handle::HasWindowHandle) -> Option<Self> {
        match window.window_handle().ok()?.as_raw() {
            raw_window_handle::RawWindowHandle::Win32(h) => Some(Self(h.hwnd)),
            _ => None,
        }
    }
}

impl raw_window_handle::HasWindowHandle for ParentWindow {
    fn window_handle(&self) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        let raw =
            raw_window_handle::RawWindowHandle::Win32(raw_window_handle::Win32WindowHandle::new(self.0));
        // SAFETY: the handle came from a live window (`of`), the app's main window, which outlives
        // the player made under it (the player is closed before the window goes).
        Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(raw) })
    }
}
