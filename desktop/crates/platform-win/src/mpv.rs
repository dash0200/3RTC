//! The local video player (BUILD_SPEC 6.8): libmpv playing a file straight from disk with
//! hardware decoding, drawn by mpv itself into a child window over the stage (like VLC or
//! PotPlayer: no frame passes through the app). The same approach as the web view: the window
//! lives on its own UI thread ([`UiThread`]), and nothing on GPUI's thread waits for it.
//!
//! libmpv is loaded at run time (`libmpv-2.dll` next to `3rtc.exe`, an LGPL build; see
//! `packaging/get-mpv.ps1`), so the app runs without it and says what's missing.
//!
//! Keys and clicks on the video are mpv's (bound below to the web player's shortcuts). What a
//! person does there comes back as [`VideoEvent::User`]; what our own commands cause is
//! expected for a moment and dropped, as `LocalVideoSyncPlayer.tsx` does with `expectEcho`.

use std::cell::Cell;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{BLACK_BRUSH, GetStockObject, HBRUSH};
use windows::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleW, GetProcAddress, LoadLibraryW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, SW_HIDE, SW_SHOWNA, SWP_NOACTIVATE,
    SWP_NOZORDER, SetWindowPos, ShowWindow, WNDCLASSEXW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    WS_EX_NOPARENTNOTIFY,
};
use windows::core::{HSTRING, PCSTR, PCWSTR, w};

use crate::video::{Rect, StreamSource, Track, TrackKind, VideoAction, VideoEvent, VideoSource};
use crate::{ParentWindow, UiThread};

// ---- libmpv, loaded at run time -------------------------------------------------------------

type Handle = *mut c_void;

#[repr(C)]
struct Event {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct EventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct EventEndFile {
    reason: c_int,
    error: c_int,
}

#[repr(C)]
struct EventClientMessage {
    num_args: c_int,
    args: *const *const c_char,
}

#[repr(C)]
struct EventLogMessage {
    prefix: *const c_char,
    level: *const c_char,
    text: *const c_char,
}

// mpv_event_id
const EV_SHUTDOWN: c_int = 1;
const EV_LOG: c_int = 2;
const EV_END_FILE: c_int = 7;
const EV_FILE_LOADED: c_int = 8;
const EV_CLIENT_MESSAGE: c_int = 16;
const EV_SEEK: c_int = 20;
const EV_PLAYBACK_RESTART: c_int = 21;
const EV_PROPERTY_CHANGE: c_int = 22;
// mpv_format
const FMT_NONE: c_int = 0;
const FMT_FLAG: c_int = 3;
const FMT_DOUBLE: c_int = 5;
// mpv_end_file_reason
const END_EOF: c_int = 0;
const END_ERROR: c_int = 4;

struct Lib {
    create: unsafe extern "C" fn() -> Handle,
    initialize: unsafe extern "C" fn(Handle) -> c_int,
    set_option_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    set_property_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    get_property_string: unsafe extern "C" fn(Handle, *const c_char) -> *mut c_char,
    get_property: unsafe extern "C" fn(Handle, *const c_char, c_int, *mut c_void) -> c_int,
    command: unsafe extern "C" fn(Handle, *mut *const c_char) -> c_int,
    observe_property: unsafe extern "C" fn(Handle, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(Handle, f64) -> *mut Event,
    request_log_messages: unsafe extern "C" fn(Handle, *const c_char) -> c_int,
    terminate_destroy: unsafe extern "C" fn(Handle),
    free: unsafe extern "C" fn(*mut c_void),
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    stream_cb_add_ro: unsafe extern "C" fn(Handle, *const c_char, *mut c_void, OpenFn) -> c_int,
}

// ---- reading a shared video (stream_cb.h) ----------------------------------------------------

type ReadFn = unsafe extern "C" fn(*mut c_void, *mut c_char, u64) -> i64;
type SeekFn = unsafe extern "C" fn(*mut c_void, i64) -> i64;
type SizeFn = unsafe extern "C" fn(*mut c_void) -> i64;
type CloseFn = unsafe extern "C" fn(*mut c_void);
type CancelFn = unsafe extern "C" fn(*mut c_void);
type OpenFn = unsafe extern "C" fn(*mut c_void, *mut c_char, *mut StreamCbInfo) -> c_int;

/// `mpv_stream_cb_info`.
#[repr(C)]
struct StreamCbInfo {
    cookie: *mut c_void,
    read_fn: Option<ReadFn>,
    seek_fn: Option<SeekFn>,
    size_fn: Option<SizeFn>,
    close_fn: Option<CloseFn>,
    cancel_fn: Option<CancelFn>,
}

/// mpv's URL for a shared video.
const STREAM_PROTOCOL: &str = "rtcstream";
/// `MPV_ERROR_GENERIC`.
const ERROR_GENERIC: i64 = -20;
/// `MPV_ERROR_LOADING_FAILED`.
const ERROR_LOADING_FAILED: c_int = -13;

/// One open of the stream by mpv: where it reads.
struct Cookie {
    source: Arc<dyn StreamSource>,
    pos: u64,
}

/// What `stream_cb_open` gets as its user data (kept in [`Shared`] while mpv lives).
type Opener = Arc<dyn StreamSource>;

unsafe extern "C" fn stream_cb_open(user: *mut c_void, _uri: *mut c_char, info: *mut StreamCbInfo) -> c_int {
    if user.is_null() || info.is_null() {
        return ERROR_LOADING_FAILED;
    }
    // SAFETY: `user` is the `Box<Opener>` registered in `setup`, alive as long as mpv.
    let source = Arc::clone(unsafe { &*user.cast::<Opener>() });
    let cookie = Box::into_raw(Box::new(Cookie { source, pos: 0 }));
    // SAFETY: mpv hands us a struct to fill.
    unsafe {
        *info = StreamCbInfo {
            cookie: cookie.cast(),
            read_fn: Some(stream_cb_read),
            seek_fn: Some(stream_cb_seek),
            size_fn: Some(stream_cb_size),
            close_fn: Some(stream_cb_close),
            cancel_fn: Some(stream_cb_cancel),
        };
    }
    0
}

unsafe extern "C" fn stream_cb_read(cookie: *mut c_void, buf: *mut c_char, n: u64) -> i64 {
    // SAFETY: the cookie made in `stream_cb_open`; mpv calls one function at a time per open.
    let c = unsafe { &mut *cookie.cast::<Cookie>() };
    let len = usize::try_from(n).unwrap_or(usize::MAX);
    // SAFETY: mpv's buffer of `n` bytes.
    let out = unsafe { std::slice::from_raw_parts_mut(buf.cast::<u8>(), len) };
    match c.source.read_at(c.pos, out) {
        Ok(read) => {
            c.pos += read as u64;
            i64::try_from(read).unwrap_or(-1)
        }
        Err(e) => {
            tracing::warn!("video: stream read at {}: {e}", c.pos);
            -1
        }
    }
}

unsafe extern "C" fn stream_cb_seek(cookie: *mut c_void, offset: i64) -> i64 {
    // SAFETY: as in `stream_cb_read`.
    let c = unsafe { &mut *cookie.cast::<Cookie>() };
    match u64::try_from(offset) {
        Ok(o) if o <= c.source.size() => {
            c.pos = o;
            offset
        }
        _ => ERROR_GENERIC,
    }
}

unsafe extern "C" fn stream_cb_size(cookie: *mut c_void) -> i64 {
    // SAFETY: as in `stream_cb_read`.
    let c = unsafe { &*cookie.cast::<Cookie>() };
    i64::try_from(c.source.size()).unwrap_or(i64::MAX)
}

unsafe extern "C" fn stream_cb_close(cookie: *mut c_void) {
    if !cookie.is_null() {
        // SAFETY: the box made in `stream_cb_open`, closed once by mpv.
        drop(unsafe { Box::from_raw(cookie.cast::<Cookie>()) });
    }
}

unsafe extern "C" fn stream_cb_cancel(cookie: *mut c_void) {
    // SAFETY: as in `stream_cb_read` (cancel may come from another thread; `close` is thread-safe).
    let c = unsafe { &*cookie.cast::<Cookie>() };
    c.source.close();
}

/// The DLL names tried, in order (mpv's builds use the first).
const DLLS: [&str; 2] = ["libmpv-2.dll", "mpv-2.dll"];

fn exe_dir() -> Option<std::path::PathBuf> {
    let mut buf = [0u16; 1024];
    // SAFETY: fills our buffer with this exe's path (at most its length).
    let n = usize::try_from(unsafe { GetModuleFileNameW(None, &mut buf) }).unwrap_or(0);
    let path = std::path::PathBuf::from(String::from_utf16_lossy(&buf[..n.min(buf.len())]));
    path.parent().map(std::path::Path::to_path_buf)
}

fn load_dll() -> Option<HMODULE> {
    let dir = exe_dir();
    for name in DLLS {
        // next to 3rtc.exe first, then the usual search (PATH)
        let candidates = dir
            .iter()
            .map(|d| d.join(name))
            .chain(std::iter::once(std::path::PathBuf::from(name)));
        for path in candidates {
            // SAFETY: loads a DLL by path; it stays loaded for the life of the app.
            if let Ok(m) = unsafe { LoadLibraryW(&HSTRING::from(path.as_os_str())) } {
                tracing::info!("video: libmpv from {}", path.display());
                return Some(m);
            }
        }
    }
    None
}

macro_rules! sym {
    ($module:expr, $name:literal) => {{
        // SAFETY: looks up an exported function by its NUL-terminated name.
        let f = unsafe { GetProcAddress($module, PCSTR(concat!($name, "\0").as_ptr())) };
        let f = f.ok_or(concat!("libmpv has no ", $name))?;
        #[allow(clippy::missing_transmute_annotations)] // the target is the field's own type
        // SAFETY: the export has the C signature mpv's client.h gives it (the field's type),
        // and on x64 Windows "system" and "C" are the same calling convention.
        let f = unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, _>(f) };
        f
    }};
}

fn load() -> Result<Lib, String> {
    let m = load_dll().ok_or_else(|| {
        "The video player (libmpv-2.dll) is missing. Put it next to 3rtc.exe (packaging\\get-mpv.ps1 gets it)."
            .to_owned()
    })?;
    let lib = (|| -> Result<Lib, &'static str> {
        Ok(Lib {
            create: sym!(m, "mpv_create"),
            initialize: sym!(m, "mpv_initialize"),
            set_option_string: sym!(m, "mpv_set_option_string"),
            set_property_string: sym!(m, "mpv_set_property_string"),
            get_property_string: sym!(m, "mpv_get_property_string"),
            get_property: sym!(m, "mpv_get_property"),
            command: sym!(m, "mpv_command"),
            observe_property: sym!(m, "mpv_observe_property"),
            wait_event: sym!(m, "mpv_wait_event"),
            request_log_messages: sym!(m, "mpv_request_log_messages"),
            terminate_destroy: sym!(m, "mpv_terminate_destroy"),
            free: sym!(m, "mpv_free"),
            error_string: sym!(m, "mpv_error_string"),
            stream_cb_add_ro: sym!(m, "mpv_stream_cb_add_ro"),
        })
    })();
    lib.map_err(|e| format!("The video player (libmpv) is too old or broken: {e}"))
}

fn lib() -> Result<&'static Lib, String> {
    static LIB: OnceLock<Result<Lib, String>> = OnceLock::new();
    LIB.get_or_init(load).as_ref().map_err(Clone::clone)
}

/// An mpv instance (its client API is thread-safe: any thread may call into it, one thread
/// waits for events).
#[derive(Clone, Copy)]
struct Mpv(Handle);

// SAFETY: libmpv's client API may be used from any thread (client.h, "Threading"); the one
// call that mustn't run concurrently (`mpv_terminate_destroy` vs `mpv_wait_event`) is only made
// by the event thread itself.
unsafe impl Send for Mpv {}
// SAFETY: as above.
unsafe impl Sync for Mpv {}

fn cstr(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

impl Mpv {
    fn err(lib: &Lib, code: c_int) -> String {
        // SAFETY: mpv returns a static string for any error code.
        let p = unsafe { (lib.error_string)(code) };
        if p.is_null() {
            return format!("error {code}");
        }
        // SAFETY: a NUL-terminated static string.
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }

    fn option(self, lib: &Lib, name: &str, value: &str) {
        let (n, v) = (cstr(name), cstr(value));
        // SAFETY: a live handle and two NUL-terminated strings mpv copies.
        let r = unsafe { (lib.set_option_string)(self.0, n.as_ptr(), v.as_ptr()) };
        if r < 0 {
            tracing::debug!("video: option {name}={value}: {}", Self::err(lib, r));
        }
    }

    fn set(self, lib: &Lib, name: &str, value: &str) {
        let (n, v) = (cstr(name), cstr(value));
        // SAFETY: as in `option`.
        let r = unsafe { (lib.set_property_string)(self.0, n.as_ptr(), v.as_ptr()) };
        if r < 0 {
            tracing::debug!("video: {name}={value}: {}", Self::err(lib, r));
        }
    }

    fn get_string(self, lib: &Lib, name: &str) -> Option<String> {
        let n = cstr(name);
        // SAFETY: a live handle; the result is ours to free with mpv_free.
        let p = unsafe { (lib.get_property_string)(self.0, n.as_ptr()) };
        if p.is_null() {
            return None;
        }
        // SAFETY: mpv returned a NUL-terminated string, freed right after copying.
        let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        // SAFETY: as above.
        unsafe { (lib.free)(p.cast()) };
        Some(s)
    }

    fn get_f64(self, lib: &Lib, name: &str) -> Option<f64> {
        let n = cstr(name);
        let mut v = 0f64;
        // SAFETY: a live handle; mpv writes one double into `v`.
        let r = unsafe { (lib.get_property)(self.0, n.as_ptr(), FMT_DOUBLE, (&raw mut v).cast()) };
        (r >= 0).then_some(v)
    }

    fn get_flag(self, lib: &Lib, name: &str) -> Option<bool> {
        let n = cstr(name);
        let mut v: c_int = 0;
        // SAFETY: a live handle; mpv writes one int (a flag) into `v`.
        let r = unsafe { (lib.get_property)(self.0, n.as_ptr(), FMT_FLAG, (&raw mut v).cast()) };
        (r >= 0).then_some(v != 0)
    }

    fn command(self, lib: &Lib, args: &[&str]) {
        let owned: Vec<CString> = args.iter().map(|a| cstr(a)).collect();
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        // SAFETY: a NULL-terminated array of NUL-terminated strings, alive for the call.
        let r = unsafe { (lib.command)(self.0, ptrs.as_mut_ptr()) };
        if r < 0 {
            tracing::debug!("video: command {args:?}: {}", Self::err(lib, r));
        }
    }

    fn observe(self, lib: &Lib, id: u64, name: &str, format: c_int) {
        let n = cstr(name);
        // SAFETY: a live handle and a name mpv copies.
        let _ = unsafe { (lib.observe_property)(self.0, id, n.as_ptr(), format) };
    }
}

// ---- echo suppression -----------------------------------------------------------------------

#[derive(Default)]
struct Expect {
    play: Option<Instant>,
    pause: Option<Instant>,
    seek: Option<Instant>,
}

impl Expect {
    fn slot(&mut self, a: VideoAction) -> &mut Option<Instant> {
        match a {
            VideoAction::Play => &mut self.play,
            VideoAction::Pause => &mut self.pause,
            VideoAction::Seek => &mut self.seek,
        }
    }

    fn expect(&mut self, a: VideoAction, ms: u64) {
        *self.slot(a) = Some(Instant::now() + Duration::from_millis(ms));
    }

    /// Ours (expected): true, and forgotten.
    fn consume(&mut self, a: VideoAction) -> bool {
        let s = self.slot(a);
        let ours = s.is_some_and(|until| Instant::now() < until);
        *s = None;
        ours
    }
}

type OnEvent = dyn Fn(VideoEvent) + Send + Sync;

struct Shared {
    mpv: Mutex<Option<Mpv>>,
    expect: Mutex<Expect>,
    on_event: Box<OnEvent>,
    /// Handed to the event thread when the player goes, so the video window outlives mpv.
    ui: Mutex<Option<UiThread>>,
    /// A shared video's source, registered with mpv (it must outlive mpv).
    opener: Mutex<Option<Box<Opener>>>,
}

impl Shared {
    fn emit(&self, e: VideoEvent) {
        (self.on_event)(e);
    }

    fn mpv(&self) -> Option<Mpv> {
        *self.mpv.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn expect(&self, a: VideoAction, ms: u64) {
        self.expect
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .expect(a, ms);
    }

    fn consume(&self, a: VideoAction) -> bool {
        self.expect
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .consume(a)
    }
}

// ---- the video window -----------------------------------------------------------------------

thread_local! {
    /// The video's child window, on its UI thread.
    static HOST: Cell<Option<isize>> = const { Cell::new(None) };
}

unsafe extern "system" fn host_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY: the default handling, with the arguments we were given.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn host() -> Option<HWND> {
    HOST.get().map(|h| HWND(h as *mut c_void))
}

fn make_host(parent: ParentWindow, rect: Rect) -> Result<HWND, String> {
    // SAFETY: a null name asks for this exe's own module handle (no reference count).
    let module = unsafe { GetModuleHandleW(PCWSTR::null()) }.map_err(|e| e.to_string())?;
    let class = w!("3RTC.Video");
    let wc = WNDCLASSEXW {
        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
        lpfnWndProc: Some(host_proc),
        hInstance: module.into(),
        // SAFETY: a stock object, never freed.
        hbrBackground: HBRUSH(unsafe { GetStockObject(BLACK_BRUSH) }.0),
        lpszClassName: class,
        ..WNDCLASSEXW::default()
    };
    // SAFETY: `wc` is complete and the class name static (a second registration fails harmlessly).
    let _ = unsafe { RegisterClassExW(&raw const wc) };
    // SAFETY: a black child of the app's window, owned by this thread; no notifications to the
    // parent (its thread may be busy, see `UiThread`).
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_NOPARENTNOTIFY,
            class,
            w!(""),
            WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            rect.x,
            rect.y,
            rect.width.max(1),
            rect.height.max(1),
            Some(parent.hwnd()),
            None,
            Some(module.into()),
            None,
        )
    }
    .map_err(|e| e.to_string())?;
    HOST.set(Some(hwnd.0 as isize));
    Ok(hwnd)
}

/// mpv's keys and clicks: the web player's shortcuts; full screen and Esc come to the app.
const INPUT_CONF: &str = "\
SPACE cycle pause
k cycle pause
MBTN_LEFT cycle pause
MBTN_LEFT_DBL script-message 3rtc fullscreen
f script-message 3rtc fullscreen
ESC script-message 3rtc escape
LEFT seek -5
RIGHT seek 5
j seek -10
l seek 10
UP add volume 5
DOWN add volume -5
WHEEL_UP add volume 5
WHEEL_DOWN add volume -5
m cycle mute
";

fn input_conf() -> Option<String> {
    let path = std::env::temp_dir().join("3rtc-mpv-input.conf");
    std::fs::write(&path, INPUT_CONF).ok()?;
    Some(path.to_string_lossy().into_owned())
}

// observed properties (reply ids)
const P_PAUSE: u64 = 1;
const P_TIME: u64 = 2;
const P_DURATION: u64 = 3;
const P_CACHE: u64 = 4;
const P_EOF: u64 = 5;
const P_TRACKS: u64 = 6;
const P_VOLUME: u64 = 7;
const P_MUTE: u64 = 8;

fn setup(
    shared: &Arc<Shared>,
    parent: ParentWindow,
    rect: Rect,
    visible: bool,
    source: &VideoSource,
    start: f64,
    playing: bool,
) -> Result<(), String> {
    let lib = lib()?;
    let host = make_host(parent, rect)?;
    if visible {
        // SAFETY: our own window, on this thread.
        let _ = unsafe { ShowWindow(host, SW_SHOWNA) };
    }
    // SAFETY: creates an mpv instance (destroyed by the event thread).
    let handle = unsafe { (lib.create)() };
    if handle.is_null() {
        return Err("The video player couldn't start (mpv_create failed).".to_owned());
    }
    let mpv = Mpv(handle);
    for (k, v) in [
        ("config", "no"),
        ("load-scripts", "no"),
        ("terminal", "no"),
        ("ytdl", "no"),
        ("osc", "no"),
        ("input-default-bindings", "no"),
        ("input-vo-keyboard", "yes"),
        ("keep-open", "yes"),
        ("idle", "yes"),
        ("force-window", "yes"),
        ("hwdec", "auto-safe"),
        ("sub-auto", "fuzzy"),
        ("cursor-autohide", "1500"),
        ("audio-display", "no"),
    ] {
        mpv.option(lib, k, v);
    }
    mpv.option(lib, "wid", &(host.0 as isize as i64).to_string());
    if let Some(conf) = input_conf() {
        mpv.option(lib, "input-conf", &conf);
    }
    if start > 0.0 {
        mpv.option(lib, "start", &format!("{start:.3}"));
    }
    mpv.option(lib, "pause", if playing { "no" } else { "yes" });
    // SAFETY: a live handle.
    let r = unsafe { (lib.initialize)(handle) };
    if r < 0 {
        // SAFETY: never initialised: destroy it here (no event thread yet).
        unsafe { (lib.terminate_destroy)(handle) };
        return Err(format!("The video player couldn't start ({}).", Mpv::err(lib, r)));
    }
    let level = cstr("warn");
    // SAFETY: a live handle and a level name mpv copies.
    let _ = unsafe { (lib.request_log_messages)(handle, level.as_ptr()) };
    for (id, name, fmt) in [
        (P_PAUSE, "pause", FMT_FLAG),
        (P_TIME, "time-pos", FMT_DOUBLE),
        (P_DURATION, "duration", FMT_DOUBLE),
        (P_CACHE, "paused-for-cache", FMT_FLAG),
        (P_EOF, "eof-reached", FMT_FLAG),
        (P_TRACKS, "track-list", FMT_NONE),
        (P_VOLUME, "volume", FMT_DOUBLE),
        (P_MUTE, "mute", FMT_FLAG),
    ] {
        mpv.observe(lib, id, name, fmt);
    }
    // the start position is ours, not a person's
    if start > 0.0 {
        shared.expect(VideoAction::Seek, 6000);
    }
    let url = match source {
        VideoSource::File(path) => path.to_string_lossy().into_owned(),
        VideoSource::Stream(s) => {
            let mut opener = Box::new(Arc::clone(s));
            let user: *mut Opener = &raw mut *opener;
            let proto = cstr(STREAM_PROTOCOL);
            // SAFETY: a live handle; `user` stays valid while mpv lives (kept in `shared`, which
            // the event thread holds until after `mpv_terminate_destroy`).
            let r = unsafe { (lib.stream_cb_add_ro)(handle, proto.as_ptr(), user.cast(), stream_cb_open) };
            if r < 0 {
                tracing::warn!("video: stream protocol: {}", Mpv::err(lib, r));
            }
            *shared.opener.lock().unwrap_or_else(PoisonError::into_inner) = Some(opener);
            format!("{STREAM_PROTOCOL}://video")
        }
    };
    *shared.mpv.lock().unwrap_or_else(PoisonError::into_inner) = Some(mpv);
    mpv.command(lib, &["loadfile", &url]);
    let events = Arc::clone(shared);
    let spawned = std::thread::Builder::new()
        .name("3rtc-video-events".to_owned())
        .spawn(move || event_loop(&events, mpv));
    if spawned.is_err() {
        shared.mpv.lock().unwrap_or_else(PoisonError::into_inner).take();
        mpv.command(lib, &["quit"]);
        return Err("The video player couldn't start its event thread.".to_owned());
    }
    Ok(())
}

fn tracks(lib: &Lib, mpv: Mpv) -> Vec<Track> {
    let n = mpv
        .get_string(lib, "track-list/count")
        .and_then(|c| c.parse::<usize>().ok())
        .unwrap_or(0);
    (0..n.min(200))
        .filter_map(|i| {
            let get = |f: &str| {
                mpv.get_string(lib, &format!("track-list/{i}/{f}"))
                    .unwrap_or_default()
            };
            let kind = match get("type").as_str() {
                "video" => TrackKind::Video,
                "audio" => TrackKind::Audio,
                "sub" => TrackKind::Subtitle,
                _ => return None,
            };
            Some(Track {
                id: get("id").parse().ok()?,
                kind,
                title: get("title"),
                lang: get("lang"),
                codec: get("codec"),
                selected: get("selected") == "yes",
                external: get("external") == "yes",
            })
        })
        .collect()
}

#[allow(clippy::too_many_lines)]
fn event_loop(shared: &Arc<Shared>, mpv: Mpv) {
    let Ok(lib) = lib() else { return };
    let mut loaded = false;
    let mut paused = true;
    let mut buffering = false;
    let mut time = 0.0f64;
    let mut duration = 0.0f64;
    let mut seeking = false;
    let mut last_state = Instant::now();
    let state = |time: f64, paused: bool, buffering: bool, duration: f64| VideoEvent::State {
        time,
        playing: !paused,
        buffering,
        duration,
    };
    loop {
        // SAFETY: the one thread waiting on this live handle.
        let ev = unsafe { (lib.wait_event)(mpv.0, -1.0) };
        if ev.is_null() {
            continue;
        }
        // SAFETY: mpv returned a valid event, ours until the next wait.
        let ev = unsafe { &*ev };
        match ev.event_id {
            EV_SHUTDOWN => break,
            EV_LOG => {
                // SAFETY: a log message event carries an mpv_event_log_message.
                let m = unsafe { &*(ev.data as *const EventLogMessage) };
                // SAFETY: a NUL-terminated string owned by mpv until the next wait.
                let prefix = unsafe { CStr::from_ptr(m.prefix) };
                // SAFETY: as above.
                let text = unsafe { CStr::from_ptr(m.text) };
                tracing::warn!(
                    "mpv[{}]: {}",
                    prefix.to_string_lossy(),
                    text.to_string_lossy().trim_end()
                );
            }
            EV_FILE_LOADED => {
                loaded = true;
                duration = mpv.get_f64(lib, "duration").unwrap_or(0.0);
                // `start` was for this file only
                mpv.set(lib, "start", "none");
                shared.emit(VideoEvent::Ready { duration });
                shared.emit(VideoEvent::Tracks(tracks(lib, mpv)));
            }
            EV_END_FILE => {
                // SAFETY: an end-file event carries an mpv_event_end_file.
                let e = unsafe { &*(ev.data as *const EventEndFile) };
                if e.reason == END_ERROR {
                    shared.emit(VideoEvent::Error(format!(
                        "This file can't be played ({}).",
                        Mpv::err(lib, e.error)
                    )));
                } else if e.reason == END_EOF {
                    shared.emit(VideoEvent::Ended);
                }
            }
            EV_SEEK => seeking = true,
            EV_PLAYBACK_RESTART => {
                if seeking {
                    seeking = false;
                    time = mpv.get_f64(lib, "time-pos").unwrap_or(time);
                    if loaded && !shared.consume(VideoAction::Seek) {
                        shared.emit(VideoEvent::User {
                            action: VideoAction::Seek,
                            time,
                        });
                    }
                    shared.emit(state(time, paused, buffering, duration));
                }
            }
            EV_CLIENT_MESSAGE => {
                // SAFETY: a client message event carries an mpv_event_client_message.
                let m = unsafe { &*(ev.data as *const EventClientMessage) };
                let n = usize::try_from(m.num_args).unwrap_or(0);
                let args: Vec<String> = (0..n)
                    .map(|i| {
                        // SAFETY: `args` holds `num_args` pointers: `i` is in range.
                        let at = unsafe { m.args.add(i) };
                        // SAFETY: a valid pointer into that array.
                        let arg = unsafe { *at };
                        // SAFETY: each a NUL-terminated string owned by mpv until the next wait.
                        unsafe { CStr::from_ptr(arg) }.to_string_lossy().into_owned()
                    })
                    .collect();
                if args.first().map(String::as_str) == Some("3rtc") {
                    match args.get(1).map(String::as_str) {
                        Some("fullscreen") => shared.emit(VideoEvent::Fullscreen),
                        Some("escape") => shared.emit(VideoEvent::Escape),
                        _ => {}
                    }
                }
            }
            EV_PROPERTY_CHANGE => {
                // SAFETY: a property-change event carries an mpv_event_property.
                let p = unsafe { &*(ev.data as *const EventProperty) };
                let flag = || {
                    // SAFETY: a FLAG property's data is an int.
                    (p.format == FMT_FLAG && !p.data.is_null())
                        .then(|| unsafe { *(p.data as *const c_int) } != 0)
                };
                let double = || {
                    // SAFETY: a DOUBLE property's data is a double.
                    (p.format == FMT_DOUBLE && !p.data.is_null()).then(|| unsafe { *(p.data as *const f64) })
                };
                match ev.reply_userdata {
                    P_PAUSE => {
                        if let Some(now) = flag()
                            && now != paused
                        {
                            paused = now;
                            let action = if paused {
                                VideoAction::Pause
                            } else {
                                VideoAction::Play
                            };
                            time = mpv.get_f64(lib, "time-pos").unwrap_or(time);
                            if loaded && !shared.consume(action) {
                                shared.emit(VideoEvent::User { action, time });
                            }
                            shared.emit(state(time, paused, buffering, duration));
                        }
                    }
                    P_TIME => {
                        if let Some(t) = double() {
                            time = t;
                            if last_state.elapsed() >= Duration::from_millis(250) {
                                last_state = Instant::now();
                                shared.emit(state(time, paused, buffering, duration));
                            }
                        }
                    }
                    P_DURATION => duration = double().unwrap_or(duration),
                    P_CACHE => {
                        buffering = flag().unwrap_or(false);
                        shared.emit(state(time, paused, buffering, duration));
                    }
                    P_EOF => {
                        // keep-open: the end shows as eof-reached, not end-file
                        if loaded && flag() == Some(true) {
                            shared.emit(VideoEvent::Ended);
                        }
                    }
                    P_TRACKS => {
                        if loaded {
                            shared.emit(VideoEvent::Tracks(tracks(lib, mpv)));
                        }
                    }
                    P_VOLUME | P_MUTE => {
                        let volume = mpv.get_f64(lib, "volume").unwrap_or(100.0);
                        let muted = mpv.get_flag(lib, "mute").unwrap_or(false);
                        shared.emit(VideoEvent::Volume { volume, muted });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    // SAFETY: the shutdown event came: no other thread uses the handle now (the player cleared
    // it before asking mpv to quit).
    unsafe { (lib.terminate_destroy)(mpv.0) };
    // mpv's window is gone: now its parent can go (dropping the UI thread ends it)
    let ui = shared.ui.lock().unwrap_or_else(PoisonError::into_inner).take();
    if let Some(ui) = ui {
        ui.run(|| {
            if let Some(h) = host() {
                // SAFETY: our own window, on the thread that made it.
                let _ = unsafe { DestroyWindow(h) };
                HOST.set(None);
            }
        });
        drop(ui);
    }
}

// ---- the player ------------------------------------------------------------------------------

/// The local video player: a file played by mpv in a child window of the app's window.
/// Dropping it closes the file and the window.
pub struct VideoPlayer {
    ui: Option<UiThread>,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for VideoPlayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoPlayer").finish_non_exhaustive()
    }
}

impl VideoPlayer {
    /// Opens `source` (a file, or a shared video) in a child window of `parent` at `rect` (physical pixels), from `start`
    /// seconds, playing or paused. Returns at once: problems come as [`VideoEvent::Error`].
    /// `on_event` is called on the player's own threads.
    ///
    /// # Errors
    /// The player's thread couldn't start.
    pub fn open(
        parent: ParentWindow,
        rect: Rect,
        visible: bool,
        source: VideoSource,
        start: f64,
        playing: bool,
        on_event: impl Fn(VideoEvent) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let ui = UiThread::start("3rtc-video").ok_or("couldn't start the video player's thread")?;
        let shared = Arc::new(Shared {
            mpv: Mutex::new(None),
            expect: Mutex::new(Expect::default()),
            on_event: Box::new(on_event),
            ui: Mutex::new(None),
            opener: Mutex::new(None),
        });
        let mine = Arc::clone(&shared);
        ui.run(move || {
            if let Err(e) = setup(&mine, parent, rect, visible, &source, start, playing) {
                tracing::warn!("video: {e}");
                mine.emit(VideoEvent::Error(e));
            }
        });
        Ok(Self { ui: Some(ui), shared })
    }

    fn with(&self, f: impl FnOnce(&Lib, Mpv, &Shared) + Send + 'static) {
        let shared = Arc::clone(&self.shared);
        if let Some(ui) = &self.ui {
            ui.run(move || {
                if let (Ok(lib), Some(mpv)) = (lib(), shared.mpv()) {
                    f(lib, mpv, &shared);
                }
            });
        }
    }

    /// Moves or resizes it (physical pixels).
    pub fn set_rect(&self, rect: Rect) {
        if let Some(ui) = &self.ui {
            ui.run(move || {
                if let Some(h) = host() {
                    // SAFETY: our own window, on the thread that made it.
                    let _ = unsafe {
                        SetWindowPos(
                            h,
                            None,
                            rect.x,
                            rect.y,
                            rect.width.max(1),
                            rect.height.max(1),
                            SWP_NOZORDER | SWP_NOACTIVATE,
                        )
                    };
                }
            });
        }
    }

    /// Hides it (a menu or dialog is open over the stage) or shows it again.
    pub fn set_visible(&self, visible: bool) {
        if let Some(ui) = &self.ui {
            ui.run(move || {
                if let Some(h) = host() {
                    // SAFETY: our own window, on the thread that made it.
                    let _ = unsafe { ShowWindow(h, if visible { SW_SHOWNA } else { SW_HIDE }) };
                }
            });
        }
    }

    /// Plays (first going to `at` when it's more than 1.2 s away).
    pub fn play(&self, at: Option<f64>) {
        self.with(move |lib, mpv, s| {
            let cur = mpv.get_f64(lib, "time-pos").unwrap_or(0.0);
            if let Some(t) = at.filter(|t| t.is_finite() && (cur - t).abs() > 1.2) {
                s.expect(VideoAction::Seek, 8000);
                mpv.command(lib, &["seek", &format!("{:.3}", t.max(0.0)), "absolute"]);
            }
            if mpv.get_flag(lib, "pause") != Some(false) {
                s.expect(VideoAction::Play, 3000);
                mpv.set(lib, "pause", "no");
            }
        });
    }

    /// Pauses (at `at`).
    pub fn pause(&self, at: Option<f64>) {
        self.with(move |lib, mpv, s| {
            let cur = mpv.get_f64(lib, "time-pos").unwrap_or(0.0);
            if let Some(t) = at.filter(|t| t.is_finite() && (cur - t).abs() > 0.5) {
                s.expect(VideoAction::Seek, 8000);
                mpv.command(lib, &["seek", &format!("{:.3}", t.max(0.0)), "absolute"]);
            }
            if mpv.get_flag(lib, "pause") != Some(true) {
                s.expect(VideoAction::Pause, 3000);
                mpv.set(lib, "pause", "yes");
            }
        });
    }

    /// Goes to `secs`.
    pub fn seek(&self, secs: f64) {
        if !secs.is_finite() {
            return;
        }
        self.with(move |lib, mpv, s| {
            s.expect(VideoAction::Seek, 8000);
            mpv.command(lib, &["seek", &format!("{:.3}", secs.max(0.0)), "absolute"]);
        });
    }

    /// A person's own play/pause/seek from our controls (the room hears it from the app, not
    /// from here: the event is expected).
    pub fn toggle_pause(&self) {
        self.with(|lib, mpv, s| {
            let paused = mpv.get_flag(lib, "pause").unwrap_or(true);
            s.expect(
                if paused {
                    VideoAction::Play
                } else {
                    VideoAction::Pause
                },
                3000,
            );
            mpv.set(lib, "pause", if paused { "no" } else { "yes" });
        });
    }

    /// Volume, 0–130 (100: the file's own level).
    pub fn set_volume(&self, volume: f64) {
        self.with(move |lib, mpv, _| {
            mpv.set(lib, "volume", &format!("{:.0}", volume.clamp(0.0, 130.0)));
        });
    }

    /// Mute on or off.
    pub fn set_mute(&self, muted: bool) {
        self.with(move |lib, mpv, _| {
            mpv.set(lib, "mute", if muted { "yes" } else { "no" });
        });
    }

    /// Shows subtitle track `id`, or none.
    pub fn set_subtitle(&self, id: Option<i64>) {
        self.with(move |lib, mpv, _| {
            mpv.set(lib, "sid", &id.map_or_else(|| "no".to_owned(), |i| i.to_string()));
        });
    }

    /// Plays sound track `id`.
    pub fn set_audio(&self, id: i64) {
        self.with(move |lib, mpv, _| {
            mpv.set(lib, "aid", &id.to_string());
        });
    }

    /// Adds a subtitle file and shows it.
    pub fn add_subtitle(&self, path: &std::path::Path) {
        let p = path.to_string_lossy().into_owned();
        self.with(move |lib, mpv, _| {
            mpv.command(lib, &["sub-add", &p, "select"]);
        });
    }

    /// Subtitles earlier (negative) or later, seconds.
    pub fn set_subtitle_delay(&self, secs: f64) {
        self.with(move |lib, mpv, _| {
            mpv.set(lib, "sub-delay", &format!("{secs:.2}"));
        });
    }

    /// Subtitle size (1.0: normal).
    pub fn set_subtitle_scale(&self, scale: f64) {
        self.with(move |lib, mpv, _| {
            mpv.set(lib, "sub-scale", &format!("{:.2}", scale.clamp(0.3, 3.0)));
        });
    }

    /// Playback speed (1.0: normal).
    pub fn set_speed(&self, speed: f64) {
        self.with(move |lib, mpv, _| {
            mpv.set(lib, "speed", &format!("{:.2}", speed.clamp(0.25, 4.0)));
        });
    }
}

impl Drop for VideoPlayer {
    fn drop(&mut self) {
        let Some(ui) = self.ui.take() else { return };
        // a read waiting for a shared video's data returns now (mpv can't quit while it waits)
        if let Some(o) = self
            .shared
            .opener
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            o.close();
        }
        // The UI thread is handed over first: whoever finishes last ends it, after mpv and its
        // window are gone (the event thread), or here when mpv never started.
        let mut slot = self.shared.ui.lock().unwrap_or_else(PoisonError::into_inner);
        *slot = Some(ui);
        let shared = Arc::clone(&self.shared);
        if let Some(ui) = slot.as_ref() {
            ui.run(move || {
                // no more calls into it from here
                let mpv = shared.mpv.lock().unwrap_or_else(PoisonError::into_inner).take();
                if let (Ok(lib), Some(mpv)) = (lib(), mpv) {
                    // the event thread ends mpv, then the window, then this thread
                    mpv.command(lib, &["quit"]);
                } else {
                    if let Some(h) = host() {
                        // SAFETY: our own window, on the thread that made it (mpv never started).
                        let _ = unsafe { DestroyWindow(h) };
                        HOST.set(None);
                    }
                    let ui = shared.ui.lock().unwrap_or_else(PoisonError::into_inner).take();
                    drop(ui);
                }
            });
        }
    }
}
