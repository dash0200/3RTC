//! The Windows implementations. Each `unsafe` block holds one Win32 call and says why the call
//! is sound: what the handles are, that buffers are the size Windows is told, and who frees what.

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::{
    CloseHandle, E_ACCESSDENIED, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetDoubleClickTime, GetFocus, SetFocus};
use windows::Win32::UI::Shell::{
    NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIIF_LARGE_ICON, NIIF_RESPECT_QUIET_TIME,
    NIIF_USER, NIM_ADD, NIM_DELETE, NIM_MODIFY, NIM_SETVERSION, NIN_BALLOONUSERCLICK, NIN_SELECT,
    NOTIFYICON_VERSION_4, NOTIFYICONDATAW, NOTIFYICONDATAW_0, Shell_NotifyIconW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, ClipCursor, CreateIcon, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
    DestroyWindow, DispatchMessageW, GetClientRect, GetCursorPos, GetForegroundWindow, GetMessageW,
    GetSystemMetrics, GetWindowThreadProcessId, HICON, ICON_BIG, ICON_SMALL, IsIconic, MF_CHECKED, MF_GRAYED,
    MF_SEPARATOR, MF_STRING, MSG, PostMessageW, PostQuitMessage, RegisterClassExW, RegisterWindowMessageW,
    SM_CXICON, SM_CXSMICON, SW_HIDE, SW_RESTORE, SW_SHOW, SendMessageW, SetCursorPos, SetForegroundWindow,
    ShowCursor, ShowWindowAsync, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu,
    TranslateMessage, WINDOW_EX_STYLE, WM_APP, WM_CLOSE, WM_CONTEXTMENU, WM_DESTROY, WM_NULL, WM_SETICON,
    WNDCLASSEXW, WS_OVERLAPPED,
};
use windows::core::{PCWSTR, PWSTR, w};

use crate::keys::{Binding, Key};
use crate::{KeyEvent, MenuItem, TrayEvent, art};

// ---------------------------------------------------------------------------------------------
// Keys

/// How often held keys are read (Windows' timer makes it about every 16 ms).
const KEY_POLL: Duration = Duration::from_millis(10);

fn is_down(key: Key) -> bool {
    // SAFETY: GetAsyncKeyState only reads the global key state; any virtual-key code is valid.
    let state = unsafe { GetAsyncKeyState(i32::from(key.0)) };
    // the most significant bit says "down now"
    state < 0
}

/// Keys and mouse buttons held right now, left and right modifiers merged, in code order.
#[must_use]
pub fn keys_down() -> Vec<Key> {
    let mut out: Vec<Key> = (0x04..=0xFE_u8)
        .map(Key)
        .filter(|k| k.normalize().is_some())
        .filter(|k| is_down(*k))
        .filter_map(Key::normalize)
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

struct Watched {
    stop: AtomicBool,
    bindings: Mutex<Vec<(u32, Binding)>>,
}

/// Watches key combinations from a background thread and reports each one going down and up.
/// It reads the keys' state; it doesn't hook or swallow anything.
pub struct KeyWatcher {
    watched: Arc<Watched>,
}

impl std::fmt::Debug for KeyWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyWatcher").finish_non_exhaustive()
    }
}

impl KeyWatcher {
    /// Starts the watching thread; `on_event` runs on it.
    pub fn start(on_event: impl Fn(KeyEvent) + Send + 'static) -> Self {
        let watched = Arc::new(Watched {
            stop: AtomicBool::new(false),
            bindings: Mutex::new(Vec::new()),
        });
        let mine = Arc::clone(&watched);
        let spawned = std::thread::Builder::new()
            .name("3rtc-keys".to_owned())
            .spawn(move || {
                let mut down: Vec<u32> = Vec::new();
                while !mine.stop.load(Ordering::Relaxed) {
                    let bindings = mine
                        .bindings
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .clone();
                    down.retain(|id| bindings.iter().any(|(b, _)| b == id));
                    for (id, binding) in &bindings {
                        let held = !binding.is_empty() && binding.keys().iter().all(|k| is_down(*k));
                        let was = down.contains(id);
                        if held != was {
                            if held {
                                down.push(*id);
                            } else {
                                down.retain(|d| d != id);
                            }
                            on_event(KeyEvent { id: *id, down: held });
                        }
                    }
                    std::thread::sleep(KEY_POLL);
                }
            });
        if let Err(e) = spawned {
            tracing::warn!("keys: couldn't start watching: {e}");
        }
        Self { watched }
    }

    /// The combinations to watch, by id (replaces the previous ones).
    pub fn watch(&self, bindings: Vec<(u32, Binding)>) {
        *self
            .watched
            .bindings
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = bindings;
    }
}

impl Drop for KeyWatcher {
    fn drop(&mut self) {
        self.watched.stop.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------------------------
// The program in front

/// A handle we opened and close once.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle came from OpenProcess/OpenProcessToken, is ours and closed only here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Whether the process runs elevated; `None` if that can't be read. Windows refuses to show
/// an elevated process's token to a normal one, so "access denied" also means elevated.
fn elevated(process: HANDLE) -> Option<bool> {
    let mut token = HANDLE::default();
    // SAFETY: `process` is a live handle with query rights; `token` is a valid place to write.
    if let Err(e) = unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) } {
        return (e.code() == E_ACCESSDENIED).then_some(true);
    }
    let token = Owned(token);
    let mut info = TOKEN_ELEVATION::default();
    let mut len = 0u32;
    let size = u32::try_from(std::mem::size_of::<TOKEN_ELEVATION>()).ok()?;
    // SAFETY: the buffer is one TOKEN_ELEVATION and `size` is exactly its size.
    unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some((&raw mut info).cast::<c_void>()),
            size,
            &raw mut len,
        )
    }
    .ok()?;
    Some(info.TokenIsElevated != 0)
}

fn exe_name(process: HANDLE) -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut len = u32::try_from(buf.len()).ok()?;
    // SAFETY: `buf` holds `len` UTF-16 units; Windows writes at most that many and updates `len`.
    unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &raw mut len) }
        .ok()?;
    let path = String::from_utf16_lossy(buf.get(..len as usize)?);
    let name = path.rsplit(['\\', '/']).next().unwrap_or(&path);
    Some(name.to_owned())
}

/// The program in front, by file name, when it runs as administrator and we don't: Windows
/// then keeps its keys from us, so push-to-talk can't work while it's in front.
#[must_use]
pub fn foreground_admin_app() -> Option<String> {
    // SAFETY: GetCurrentProcess returns a pseudo-handle that needs no closing.
    let me = unsafe { GetCurrentProcess() };
    if elevated(me) == Some(true) {
        return None;
    }
    // SAFETY: no arguments; returns a window handle or null.
    let window = unsafe { GetForegroundWindow() };
    if window.is_invalid() {
        return None;
    }
    let mut pid = 0u32;
    // SAFETY: `window` came from GetForegroundWindow; `pid` is a valid place to write.
    let _ = unsafe { GetWindowThreadProcessId(window, Some(&raw mut pid)) };
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    // SAFETY: opening with query-only rights changes nothing; `Owned` closes the handle.
    let process = Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
    if elevated(process.0) == Some(true) {
        Some(exe_name(process.0).unwrap_or_else(|| "a program".to_owned()))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------------------------
// Sound and the window

/// Plays a WAV file on the default speakers without waiting for it.
pub fn play_wav(wav: &'static [u8]) {
    // SAFETY: with SND_MEMORY the "name" is the WAV data; it is 'static, so it outlives the
    // asynchronous playback.
    let _ = unsafe {
        PlaySoundW(
            PCWSTR(wav.as_ptr().cast()),
            None,
            SND_MEMORY | SND_ASYNC | SND_NODEFAULT,
        )
    };
}

fn hwnd_of(window: &impl HasWindowHandle) -> Option<HWND> {
    match window.window_handle().ok()?.as_raw() {
        RawWindowHandle::Win32(h) => Some(HWND(h.hwnd.get() as *mut c_void)),
        _ => None,
    }
}

/// This process's memory in MB: (working set, committed private bytes). For the log file.
#[must_use]
pub fn memory_mb() -> Option<(u64, u64)> {
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut counters = PROCESS_MEMORY_COUNTERS_EX {
        cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    // SAFETY: a pseudo handle to this process; nothing to close.
    let me = unsafe { GetCurrentProcess() };
    // SAFETY: `counters` is the EX struct with its size in `cb`, as the call expects.
    unsafe {
        GetProcessMemoryInfo(
            me,
            (&raw mut counters).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        )
    }
    .ok()?;
    let mb = |b: usize| (b / (1024 * 1024)) as u64;
    Some((mb(counters.WorkingSetSize), mb(counters.PrivateUsage)))
}

/// Gives the keyboard back to the app window `hwnd` (from [`raw_hwnd`]) when another window of
/// ours has it (the video player's web view, on its own thread) or none does (that web view closed
/// while it had it: then no key reached the app at all). Call it outside the window's own event
/// handling: Windows tells the window at once.
pub fn take_keyboard_focus(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    let h = HWND(hwnd as *mut c_void);
    // SAFETY: only reads which window has the keyboard in this thread's input.
    let now = unsafe { GetFocus() };
    if now != h {
        // SAFETY: `h` is the app's own live top-level window, and this is its thread.
        let _ = unsafe { SetFocus(Some(h)) };
    }
}

/// Returns the raw window handle (`HWND` as `isize`) of `window`.
pub fn raw_hwnd(window: &impl HasWindowHandle) -> isize {
    hwnd_of(window).map_or(0, |h| h.0 as isize)
}

/// Returns whether the cursor is currently in the bottom strip (`threshold_px` high) of the window's client area.
pub fn cursor_in_bottom_hwnd(raw_hwnd: isize, threshold_px: i32) -> bool {
    cursor_window_state(raw_hwnd, threshold_px).is_some_and(|(_, _, at_bottom)| at_bottom)
}

/// The system's double-click time in milliseconds (what GPUI counts double clicks by).
#[must_use]
pub fn double_click_ms() -> u64 {
    // SAFETY: reads a system setting; takes no arguments.
    u64::from(unsafe { GetDoubleClickTime() })
}

/// Returns `(pt.x, pt.y, at_bottom)` in client coordinates if the window handle is valid.
pub fn cursor_window_state(raw_hwnd: isize, threshold_px: i32) -> Option<(i32, i32, bool)> {
    if raw_hwnd == 0 {
        return None;
    }
    let h = HWND(raw_hwnd as *mut c_void);
    let mut rect = RECT::default();
    // SAFETY: rect is valid.
    if unsafe { GetClientRect(h, &raw mut rect) }.is_err() {
        return None;
    }
    let mut pt = POINT::default();
    // SAFETY: pt is valid.
    if unsafe { GetCursorPos(&raw mut pt) }.is_err() {
        return None;
    }
    // SAFETY: converts screen coordinates to client coordinates.
    let _ = unsafe { ScreenToClient(h, &raw mut pt) };
    let inside = pt.x >= (rect.left - 16)
        && pt.x <= (rect.right + 16)
        && pt.y >= rect.top
        && pt.y <= (rect.bottom + 24);
    let at_bottom = inside && pt.y >= (rect.bottom - threshold_px.max(72));
    Some((pt.x, pt.y, at_bottom))
}

/// Hides the window (it stays open; the tray brings it back).
///
/// Asynchronous on purpose: this is called while the UI is handling an event, and a synchronous
/// `ShowWindow` would make Windows call back into the UI at once (GPUI then reports "RefCell
/// already borrowed" and drops frames). `ShowWindowAsync` posts the change instead.
pub fn hide_window(window: &impl HasWindowHandle) {
    if let Some(h) = hwnd_of(window) {
        // SAFETY: `h` is the app's own live window; this only queues a change of visibility.
        let _ = unsafe { ShowWindowAsync(h, SW_HIDE) };
    }
}

/// Shows the window (restored if minimised) and brings it to the front, without calling back
/// into the UI while it's busy (see [`hide_window`]).
pub fn show_window(window: &impl HasWindowHandle) {
    let Some(h) = hwnd_of(window) else { return };
    // SAFETY: `h` is the app's own live window; IsIconic only reads its state.
    let minimised = unsafe { IsIconic(h) }.as_bool();
    // SAFETY: as above; this only queues a change of visibility.
    let _ = unsafe { ShowWindowAsync(h, if minimised { SW_RESTORE } else { SW_SHOW }) };
    // Bringing it to the front from another thread: the activation messages then wait in the
    // UI thread's queue instead of arriving in the middle of its current event.
    let raw = h.0 as isize;
    let _ = std::thread::Builder::new()
        .name("3rtc-front".to_owned())
        .spawn(move || {
            // SAFETY: the window belongs to this process and outlives this brief call; if it was
            // closed meanwhile, Windows just returns false.
            let _ = unsafe { SetForegroundWindow(HWND(raw as *mut c_void)) };
        });
}

/// Shows or hides the OS cursor for the current thread.
///
/// Keeps an internal flag so `ShowCursor`'s display counter is decremented when hidden
/// and incremented back when shown, avoiding unbounded counter drift.
pub fn set_cursor_visible(visible: bool) {
    static HIDDEN: AtomicBool = AtomicBool::new(false);
    if visible {
        if HIDDEN.swap(false, Ordering::SeqCst) {
            // SAFETY: increments the current thread's cursor display counter back.
            unsafe { ShowCursor(true) };
        }
    } else if !HIDDEN.swap(true, Ordering::SeqCst) {
        // SAFETY: decrements the current thread's cursor display counter to hide it.
        unsafe { ShowCursor(false) };
    }
}

/// Confines the cursor to `window`'s client area and hides it for gaming mode.
pub fn lock_pointer(window: &impl HasWindowHandle) {
    if let Some(h) = hwnd_of(window) {
        let mut rect = RECT::default();
        // SAFETY: rect is a valid pointer; h is live.
        if unsafe { GetClientRect(h, &raw mut rect) }.is_ok() {
            let mut top_left = POINT {
                x: rect.left,
                y: rect.top,
            };
            let mut bottom_right = POINT {
                x: rect.right,
                y: rect.bottom,
            };
            // SAFETY: converts client coordinates to screen coordinates.
            let _ = unsafe { ClientToScreen(h, &raw mut top_left) };
            // SAFETY: converts client coordinates to screen coordinates.
            let _ = unsafe { ClientToScreen(h, &raw mut bottom_right) };
            let screen_rect = RECT {
                left: top_left.x,
                top: top_left.y,
                right: bottom_right.x,
                bottom: bottom_right.y,
            };
            // SAFETY: confines cursor to screen_rect.
            let _ = unsafe { ClipCursor(Some(&raw const screen_rect)) };
        }
    }
    set_cursor_visible(false);
}

/// Releases cursor confinement and restores cursor visibility.
pub fn unlock_pointer() {
    // SAFETY: releases any cursor clipping.
    let _ = unsafe { ClipCursor(None) };
    set_cursor_visible(true);
}

/// Centers the cursor in `window`'s client area and returns the screen coordinates.
pub fn center_cursor(window: &impl HasWindowHandle) -> Option<(i32, i32)> {
    let h = hwnd_of(window)?;
    let mut rect = RECT::default();
    // SAFETY: rect is valid.
    unsafe { GetClientRect(h, &raw mut rect) }.ok()?;
    let cx = rect.left + (rect.right - rect.left) / 2;
    let cy = rect.top + (rect.bottom - rect.top) / 2;
    let mut pt = POINT { x: cx, y: cy };
    // SAFETY: converts client point to screen point.
    let _ = unsafe { ClientToScreen(h, &raw mut pt) };
    // SAFETY: sets cursor position.
    let _ = unsafe { SetCursorPos(pt.x, pt.y) };
    Some((pt.x, pt.y))
}

/// The logo as an icon `size` pixels square (made once per size and kept for the app's life).
fn logo_icon(size: i32) -> Option<HICON> {
    let side = u32::try_from(size).ok()?;
    let mut bgra = art::logo_rgba(side);
    let mut mask = Vec::with_capacity(bgra.len() / 4);
    for p in bgra.as_chunks_mut::<4>().0 {
        mask.push(p[3].wrapping_sub(u8::MAX));
        p.swap(0, 2);
    }
    // SAFETY: `bgra` is size×size 32-bit pixels and `mask` has a byte per pixel (more than the
    // 1 bit per pixel read); both outlive the call, which copies them into the new icon.
    unsafe { CreateIcon(None, size, size, 1, 32, mask.as_ptr(), bgra.as_ptr()) }.ok()
}

fn metric_or(which: windows::Win32::UI::WindowsAndMessaging::SYSTEM_METRICS_INDEX, fallback: i32) -> i32 {
    // SAFETY: reads a system setting; no pointers.
    let v = unsafe { GetSystemMetrics(which) };
    if v > 0 { v } else { fallback }
}

/// The small and large logo icons, as raw handle values (icons live as long as the app).
fn icons() -> (isize, isize) {
    static ICONS: OnceLock<(isize, isize)> = OnceLock::new();
    *ICONS.get_or_init(|| {
        let small = logo_icon(metric_or(SM_CXSMICON, 16)).map_or(0, |i| i.0 as isize);
        let big = logo_icon(metric_or(SM_CXICON, 32)).map_or(0, |i| i.0 as isize);
        (small, big)
    })
}

/// Gives the window the 3RTC icon (title bar, taskbar, Alt+Tab).
pub fn set_window_icon(window: &impl HasWindowHandle) {
    let Some(h) = hwnd_of(window) else { return };
    let (small, big) = icons();
    for (which, icon) in [(ICON_SMALL, small), (ICON_BIG, big)] {
        if icon != 0 {
            // SAFETY: `h` is the app's own window and the icon lives as long as the app.
            unsafe { SendMessageW(h, WM_SETICON, Some(WPARAM(which as usize)), Some(LPARAM(icon))) };
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The tray icon

/// The shell tells us about clicks on the icon with this message.
const WM_TRAY: u32 = WM_APP + 1;
/// We tell the tray thread that the tooltip changed or a notification is waiting.
const WM_UPDATE: u32 = WM_APP + 2;
/// The keyboard version of NIN_SELECT.
const NIN_KEYSELECT: u32 = NIN_SELECT | 1;
/// Our one icon's id.
const ICON_ID: u32 = 1;

/// What the app asks of the tray thread.
#[derive(Default)]
struct Wanted {
    menu: Vec<MenuItem>,
    tooltip: Option<String>,
    notification: Option<(String, String)>,
}

/// The tray thread's own state (lives on that thread only).
struct Local {
    wanted: Arc<Mutex<Wanted>>,
    on_event: Box<dyn Fn(TrayEvent) + Send>,
    tooltip: String,
    taskbar_created: u32,
}

thread_local! {
    static LOCAL: RefCell<Option<Local>> = const { RefCell::new(None) };
}

/// The icon in the notification area: a menu, a tooltip, and notifications from it.
pub struct Tray {
    hwnd: isize,
    wanted: Arc<Mutex<Wanted>>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Tray {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tray").finish_non_exhaustive()
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Copies `s` into a fixed UTF-16 field, cut to fit, ending with 0.
fn fill(field: &mut [u16], s: &str) {
    field.fill(0);
    let room = field.len().saturating_sub(1);
    for (slot, unit) in field.iter_mut().take(room).zip(s.encode_utf16()) {
        *slot = unit;
    }
}

fn icon_data(hwnd: HWND) -> NOTIFYICONDATAW {
    NOTIFYICONDATAW {
        cbSize: u32::try_from(std::mem::size_of::<NOTIFYICONDATAW>()).unwrap_or(0),
        hWnd: hwnd,
        uID: ICON_ID,
        ..NOTIFYICONDATAW::default()
    }
}

fn add_icon(hwnd: HWND, tooltip: &str) {
    let mut data = icon_data(hwnd);
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
    data.uCallbackMessage = WM_TRAY;
    data.hIcon = HICON(icons().0 as *mut c_void);
    fill(&mut data.szTip, tooltip);
    // SAFETY: `data` is a complete NOTIFYICONDATAW with its size set; Windows copies it.
    if !unsafe { Shell_NotifyIconW(NIM_ADD, &raw const data) }.as_bool() {
        tracing::warn!("tray: couldn't add the icon");
        return;
    }
    data.Anonymous = NOTIFYICONDATAW_0 {
        uVersion: NOTIFYICON_VERSION_4,
    };
    // SAFETY: as above.
    let _ = unsafe { Shell_NotifyIconW(NIM_SETVERSION, &raw const data) };
}

fn emit(event: TrayEvent) {
    LOCAL.with_borrow(|l| {
        if let Some(l) = l {
            (l.on_event)(event);
        }
    });
}

fn show_menu(hwnd: HWND) {
    let items = LOCAL.with_borrow(|l| {
        l.as_ref().map(|l| {
            l.wanted
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .menu
                .clone()
        })
    });
    let Some(items) = items else { return };
    // SAFETY: creates an empty menu, destroyed below.
    let Ok(menu) = (unsafe { CreatePopupMenu() }) else {
        return;
    };
    let labels: Vec<Vec<u16>> = items
        .iter()
        .map(|i| match i {
            MenuItem::Item { label, .. } => wide(label),
            MenuItem::Separator => Vec::new(),
        })
        .collect();
    for (item, label) in items.iter().zip(&labels) {
        match item {
            MenuItem::Separator => {
                // SAFETY: `menu` is ours; a separator has no text.
                let _ = unsafe { AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null()) };
            }
            MenuItem::Item {
                id,
                checked,
                disabled,
                ..
            } => {
                let mut flags = MF_STRING;
                if *checked {
                    flags |= MF_CHECKED;
                }
                if *disabled {
                    flags |= MF_GRAYED;
                }
                // SAFETY: `menu` is ours; `label` is NUL-terminated UTF-16 that outlives the
                // call (Windows copies it).
                let _ = unsafe { AppendMenuW(menu, flags, *id as usize, PCWSTR(label.as_ptr())) };
            }
        }
    }
    let mut at = POINT::default();
    // SAFETY: `at` is a valid place to write the cursor position.
    let _ = unsafe { GetCursorPos(&raw mut at) };
    // The menu only closes on a click elsewhere if its window is in front (documented quirk).
    // SAFETY: `hwnd` is the tray thread's own window.
    let _ = unsafe { SetForegroundWindow(hwnd) };
    // SAFETY: `menu` and `hwnd` are ours; TPM_RETURNCMD returns the picked id (0 for none).
    let picked = unsafe {
        TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
            at.x,
            at.y,
            None,
            hwnd,
            None,
        )
    };
    // SAFETY: wakes our own window so the menu closes properly (documented quirk).
    let _ = unsafe { PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0)) };
    // SAFETY: the menu is ours and no longer shown.
    let _ = unsafe { DestroyMenu(menu) };
    if let Ok(id) = u32::try_from(picked.0)
        && id != 0
    {
        emit(TrayEvent::Menu(id));
    }
}

/// Applies a new tooltip or shows a waiting notification.
fn update(hwnd: HWND) {
    let (tooltip, notification) = LOCAL.with_borrow_mut(|l| {
        let Some(l) = l else { return (None, None) };
        let mut wanted = l.wanted.lock().unwrap_or_else(PoisonError::into_inner);
        let tooltip = wanted.tooltip.take();
        if let Some(t) = &tooltip {
            l.tooltip.clone_from(t);
        }
        (tooltip, wanted.notification.take())
    });
    if let Some(tooltip) = tooltip {
        let mut data = icon_data(hwnd);
        data.uFlags = NIF_TIP | NIF_SHOWTIP;
        fill(&mut data.szTip, &tooltip);
        // SAFETY: a complete NOTIFYICONDATAW for our icon; Windows copies it.
        let _ = unsafe { Shell_NotifyIconW(NIM_MODIFY, &raw const data) };
    }
    if let Some((title, body)) = notification {
        let mut data = icon_data(hwnd);
        data.uFlags = NIF_INFO;
        fill(&mut data.szInfoTitle, &title);
        fill(&mut data.szInfo, &body);
        data.dwInfoFlags = NIIF_USER | NIIF_LARGE_ICON | NIIF_RESPECT_QUIET_TIME;
        data.hBalloonIcon = HICON(icons().1 as *mut c_void);
        // SAFETY: as above.
        let _ = unsafe { Shell_NotifyIconW(NIM_MODIFY, &raw const data) };
    }
}

unsafe extern "system" fn tray_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let taskbar_created = LOCAL.with_borrow(|l| l.as_ref().map_or(0, |l| l.taskbar_created));
    match msg {
        WM_TRAY => {
            // NOTIFYICON_VERSION_4: the event is in the low word of lParam
            #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
            let event = (lparam.0 as u32) & 0xFFFF;
            match event {
                NIN_SELECT | NIN_KEYSELECT | NIN_BALLOONUSERCLICK => emit(TrayEvent::Open),
                WM_CONTEXTMENU => show_menu(hwnd),
                _ => {}
            }
            LRESULT(0)
        }
        WM_UPDATE => {
            update(hwnd);
            LRESULT(0)
        }
        WM_CLOSE => {
            // SAFETY: our own window, on its own thread.
            let _ = unsafe { DestroyWindow(hwnd) };
            LRESULT(0)
        }
        WM_DESTROY => {
            let data = icon_data(hwnd);
            // SAFETY: removes our icon; `data` names it.
            let _ = unsafe { Shell_NotifyIconW(NIM_DELETE, &raw const data) };
            // SAFETY: ends this thread's message loop.
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        m if m != 0 && m == taskbar_created => {
            // Explorer restarted: the icon is gone, put it back
            let tooltip = LOCAL.with_borrow(|l| l.as_ref().map(|l| l.tooltip.clone()));
            add_icon(hwnd, &tooltip.unwrap_or_default());
            LRESULT(0)
        }
        // SAFETY: the default handling for everything else, with the arguments we were given.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn tray_thread(local: Local, ready: &std::sync::mpsc::Sender<Option<isize>>) {
    // SAFETY: a null name asks for this exe's own module handle (no reference count).
    let Ok(module) = (unsafe { GetModuleHandleW(PCWSTR::null()) }) else {
        let _ = ready.send(None);
        return;
    };
    let class = w!("3RTC.Tray");
    let wc = WNDCLASSEXW {
        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
        lpfnWndProc: Some(tray_proc),
        hInstance: module.into(),
        lpszClassName: class,
        ..WNDCLASSEXW::default()
    };
    // SAFETY: `wc` is complete and the class name is a static string. (Registering twice in one
    // process fails harmlessly: the class already exists.)
    let _ = unsafe { RegisterClassExW(&raw const wc) };
    let tooltip = local.tooltip.clone();
    LOCAL.with_borrow_mut(|l| *l = Some(local));
    // SAFETY: a plain hidden window of the class above, owned by this thread.
    let created = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("3RTC"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(module.into()),
            None,
        )
    };
    let Ok(hwnd) = created else {
        tracing::warn!("tray: couldn't create its window");
        let _ = ready.send(None);
        return;
    };
    // SAFETY: a static NUL-terminated string.
    let taskbar_created = unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) };
    LOCAL.with_borrow_mut(|l| {
        if let Some(l) = l {
            l.taskbar_created = taskbar_created;
        }
    });
    add_icon(hwnd, &tooltip);
    let _ = ready.send(Some(hwnd.0 as isize));
    let mut msg = MSG::default();
    loop {
        // SAFETY: `msg` is a valid place for the next message of this thread.
        let got = unsafe { GetMessageW(&raw mut msg, None, 0, 0) };
        if got.0 <= 0 {
            break;
        }
        // SAFETY: `msg` was filled by GetMessageW above.
        let _ = unsafe { TranslateMessage(&raw const msg) };
        // SAFETY: as above.
        unsafe { DispatchMessageW(&raw const msg) };
    }
    LOCAL.with_borrow_mut(|l| *l = None);
}

impl Tray {
    /// Puts the icon in the notification area. `on_event` runs on the tray's own thread.
    /// `None` if Windows wouldn't create it.
    pub fn start(
        tooltip: &str,
        menu: Vec<MenuItem>,
        on_event: impl Fn(TrayEvent) + Send + 'static,
    ) -> Option<Self> {
        let wanted = Arc::new(Mutex::new(Wanted {
            menu,
            ..Wanted::default()
        }));
        let local = Local {
            wanted: Arc::clone(&wanted),
            on_event: Box::new(on_event),
            tooltip: tooltip.to_owned(),
            taskbar_created: 0,
        };
        let (ready, started) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("3rtc-tray".to_owned())
            .spawn(move || tray_thread(local, &ready))
            .ok()?;
        let hwnd = started.recv().ok().flatten()?;
        Some(Self {
            hwnd,
            wanted,
            thread: Some(thread),
        })
    }

    fn poke(&self) {
        // SAFETY: posts to the tray thread's own window (it may be gone, then nothing happens).
        let _ = unsafe {
            PostMessageW(
                Some(HWND(self.hwnd as *mut c_void)),
                WM_UPDATE,
                WPARAM(0),
                LPARAM(0),
            )
        };
    }

    /// Replaces the menu (used the next time it opens).
    pub fn set_menu(&self, menu: Vec<MenuItem>) {
        self.wanted.lock().unwrap_or_else(PoisonError::into_inner).menu = menu;
    }

    /// Changes the text shown on hover.
    pub fn set_tooltip(&self, tooltip: &str) {
        self.wanted.lock().unwrap_or_else(PoisonError::into_inner).tooltip = Some(tooltip.to_owned());
        self.poke();
    }

    /// Shows a notification from the icon. Windows holds it back while Focus Assist / Do not
    /// disturb is on, and clicking it shows the app ([`TrayEvent::Open`]).
    pub fn notify(&self, title: &str, body: &str) {
        self.wanted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .notification = Some((title.to_owned(), body.to_owned()));
        self.poke();
    }
}

impl Drop for Tray {
    fn drop(&mut self) {
        // SAFETY: asks the tray thread's window to close; its thread removes the icon and ends.
        let _ = unsafe {
            PostMessageW(
                Some(HWND(self.hwnd as *mut c_void)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            )
        };
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The registry (the user's own key: no admin rights)

fn io(e: &impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

/// Starting with Windows: a value under the user's own `Run` key.
pub mod autostart {
    use windows_registry::CURRENT_USER;

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "3RTC";

    /// Whether the app starts with Windows.
    #[must_use]
    pub fn enabled() -> bool {
        CURRENT_USER.open(RUN).and_then(|k| k.get_string(NAME)).is_ok()
    }

    /// Turns starting with Windows on (running `command`) or off.
    ///
    /// # Errors
    /// If the user's registry can't be written.
    pub fn set(on: bool, command: &str) -> std::io::Result<()> {
        let key = CURRENT_USER.create(RUN).map_err(|e| super::io(&e))?;
        if on {
            key.set_string(NAME, command).map_err(|e| super::io(&e))
        } else if enabled() {
            key.remove_value(NAME).map_err(|e| super::io(&e))
        } else {
            Ok(())
        }
    }
}

/// `3rtc://` links: a URL protocol under the user's own `Software\Classes`.
pub mod links {
    use windows_registry::CURRENT_USER;

    const KEY: &str = r"Software\Classes\3rtc";
    const COMMAND: &str = r"Software\Classes\3rtc\shell\open\command";

    /// Makes `3rtc://` links open `command` (`%1` is the link).
    ///
    /// # Errors
    /// If the user's registry can't be written.
    pub fn register(command: &str) -> std::io::Result<()> {
        let key = CURRENT_USER.create(KEY).map_err(|e| super::io(&e))?;
        key.set_string("", "URL:3RTC").map_err(|e| super::io(&e))?;
        key.set_string("URL Protocol", "").map_err(|e| super::io(&e))?;
        CURRENT_USER
            .create(COMMAND)
            .and_then(|k| k.set_string("", command))
            .map_err(|e| super::io(&e))
    }

    /// The command `3rtc://` links open now, if any.
    #[must_use]
    pub fn registered_command() -> Option<String> {
        CURRENT_USER.open(COMMAND).and_then(|k| k.get_string("")).ok()
    }

    /// Stops `3rtc://` links opening this app.
    ///
    /// # Errors
    /// If the user's registry can't be written.
    pub fn unregister() -> std::io::Result<()> {
        if registered_command().is_none() {
            return Ok(());
        }
        CURRENT_USER.remove_tree(KEY).map_err(|e| super::io(&e))
    }
}
