//! Remote control of a shared screen (like AnyDesk): the viewer given control moves, clicks,
//! scrolls and types here, played back with `SendInput` over the shared screen or window.
//!
//! While it lasts:
//! - a banner sits at the top of the shared area ("Asha is controlling this screen …"); it lets
//!   the mouse through, never takes focus, and is left out of the shared picture;
//! - **Ctrl+Alt+Shift+X** takes control back (a hotkey on the banner's window);
//! - so does the sharer's own mouse: a click, or moving it a fair way, as told apart from the
//!   played-back input by a low-level mouse hook (Windows marks input we inject). The hook
//!   only watches; every event goes on unchanged.
//!
//! Dropping the [`RemoteControl`] lets go of any key or button the viewer still held, removes
//! the hook and the hotkey, and closes the banner. Positions are physical pixels (this thread
//! asks for per-monitor DPI while it works them out).

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::{Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CLIP_DEFAULT_PRECIS, CreateFontW, CreateSolidBrush, DEFAULT_CHARSET, DEFAULT_PITCH, DEVMODEW,
    DISPLAY_DEVICEW, DT_CENTER, DT_END_ELLIPSIS, DT_SINGLELINE, DT_VCENTER, DeleteObject, DrawTextW,
    ENUM_CURRENT_SETTINGS, ENUM_DISPLAY_SETTINGS_FLAGS, EndPaint, EnumDisplayDevicesW,
    EnumDisplaySettingsExW, FW_SEMIBOLD, FillRect, HGDIOBJ, NONANTIALIASED_QUALITY, OUT_DEFAULT_PRECIS,
    PAINTSTRUCT, SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOUSE_EVENT_FLAGS,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MapVirtualKeyW,
    RegisterHotKey, SendInput, UnregisterHotKey, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    GetSystemMetrics, GetWindowRect, HWND_TOPMOST, KillTimer, LLMHF_INJECTED, LWA_ALPHA, MSG, MSLLHOOKSTRUCT,
    PostMessageW, PostQuitMessage, RegisterClassExW, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SetLayeredWindowAttributes,
    SetTimer, SetWindowDisplayAffinity, SetWindowPos, SetWindowsHookExW, ShowWindow, TranslateMessage,
    UnhookWindowsHookEx, WDA_EXCLUDEFROMCAPTURE, WH_MOUSE_LL, WM_CLOSE, WM_DESTROY, WM_HOTKEY,
    WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONDOWN, WM_TIMER, WM_XBUTTONDOWN,
    WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
    WS_POPUP,
};
use windows::core::{PCWSTR, w};

use crate::{ControlArea, Injection, MouseKey, TakeBack};

const BANNER_W: i32 = 760;
const BANNER_H: i32 = 40;
/// The banner is put back on top (and over the area, if it moved) this often.
const PLACE_TIMER_MS: u32 = 1000;
/// The sharer's mouse moving this far (physical pixels) …
const TAKE_BACK_PX: f64 = 200.0;
/// … within this long takes control back.
const TAKE_BACK_WINDOW: Duration = Duration::from_millis(700);
const HOTKEY_ID: i32 = 0x3C7;

/// `0xRRGGBB` → `COLORREF` (`0x00BBGGRR`).
const fn rgb(c: u32) -> COLORREF {
    COLORREF(((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF))
}

/// The control thread's own state (its window procedure and mouse hook read it).
struct Watch {
    on_take_back: Box<dyn Fn(TakeBack) + Send>,
    /// Where the pointer last was (any event).
    last: Option<POINT>,
    /// How far the sharer's own mouse moved since `since`.
    moved: f64,
    since: Instant,
    /// Taken back already (told once).
    fired: bool,
    /// The banner's text.
    text: Vec<u16>,
    area: ControlArea,
}

thread_local! {
    static WATCH: RefCell<Option<Watch>> = const { RefCell::new(None) };
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Runs `f` with this thread working in physical pixels (per-monitor DPI), then puts it back.
fn physical<T>(f: impl FnOnce() -> T) -> T {
    // SAFETY: changes only this thread's DPI awareness; restored below.
    let old = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let out = f();
    if !old.0.is_null() {
        // SAFETY: as above, back to what it was.
        let _ = unsafe { SetThreadDpiAwarenessContext(old) };
    }
    out
}

fn metric(m: windows::Win32::UI::WindowsAndMessaging::SYSTEM_METRICS_INDEX) -> i32 {
    // SAFETY: a plain metric read.
    unsafe { GetSystemMetrics(m) }
}

fn virtual_desktop() -> RECT {
    let (x, y) = (metric(SM_XVIRTUALSCREEN), metric(SM_YVIRTUALSCREEN));
    let (w, h) = (metric(SM_CXVIRTUALSCREEN), metric(SM_CYVIRTUALSCREEN));
    RECT {
        left: x,
        top: y,
        right: x + w.max(1),
        bottom: y + h.max(1),
    }
}

/// Where the shared screen or window is now, in physical pixels on the virtual desktop.
fn area_rect(area: ControlArea) -> Option<RECT> {
    match area {
        ControlArea::Window(id) => {
            let hwnd = HWND(usize::try_from(id).ok()? as *mut c_void);
            let mut r = RECT::default();
            // SAFETY: `r` is a RECT and the size says so; a gone window just fails.
            let framed = unsafe {
                DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_EXTENDED_FRAME_BOUNDS,
                    (&raw mut r).cast(),
                    u32::try_from(std::mem::size_of::<RECT>()).unwrap_or(16),
                )
            };
            if framed.is_err() {
                // SAFETY: as above.
                unsafe { GetWindowRect(hwnd, &raw mut r) }.ok()?;
            }
            (r.right > r.left && r.bottom > r.top).then_some(r)
        }
        // libwebrtc's "the whole desktop"
        ControlArea::Screen(u64::MAX) => Some(virtual_desktop()),
        // libwebrtc numbers screens as Windows lists display devices
        ControlArea::Screen(id) => {
            let mut dd = DISPLAY_DEVICEW {
                cb: u32::try_from(std::mem::size_of::<DISPLAY_DEVICEW>()).unwrap_or(0),
                ..DISPLAY_DEVICEW::default()
            };
            // SAFETY: `dd` is sized as its `cb` says.
            if !unsafe { EnumDisplayDevicesW(PCWSTR::null(), u32::try_from(id).ok()?, &raw mut dd, 0) }
                .as_bool()
            {
                return None;
            }
            let mut dm = DEVMODEW {
                dmSize: u16::try_from(std::mem::size_of::<DEVMODEW>()).unwrap_or(0),
                ..DEVMODEW::default()
            };
            // SAFETY: the device name is the NUL-terminated one just filled in; `dm` is sized.
            let ok = unsafe {
                EnumDisplaySettingsExW(
                    PCWSTR(dd.DeviceName.as_ptr()),
                    ENUM_CURRENT_SETTINGS,
                    &raw mut dm,
                    ENUM_DISPLAY_SETTINGS_FLAGS(0),
                )
            };
            if !ok.as_bool() {
                return None;
            }
            // SAFETY: display settings fill the display half of this union (position).
            let at = unsafe { dm.Anonymous1.Anonymous2.dmPosition };
            let w = i32::try_from(dm.dmPelsWidth).ok()?;
            let h = i32::try_from(dm.dmPelsHeight).ok()?;
            (w > 0 && h > 0).then_some(RECT {
                left: at.x,
                top: at.y,
                right: at.x + w,
                bottom: at.y + h,
            })
        }
    }
}

/// `x`, `y` (0–1 over `r`) as `SendInput`'s absolute position (0–65535 over the virtual desktop).
fn absolute(r: RECT, x: f64, y: f64) -> (i32, i32) {
    let v = virtual_desktop();
    let px = f64::from(r.left) + x.clamp(0.0, 1.0) * f64::from((r.right - r.left - 1).max(0));
    let py = f64::from(r.top) + y.clamp(0.0, 1.0) * f64::from((r.bottom - r.top - 1).max(0));
    let nx = (px - f64::from(v.left)) * 65535.0 / f64::from((v.right - v.left - 1).max(1));
    let ny = (py - f64::from(v.top)) * 65535.0 / f64::from((v.bottom - v.top - 1).max(1));
    #[allow(clippy::cast_possible_truncation)]
    (
        nx.round().clamp(0.0, 65535.0) as i32,
        ny.round().clamp(0.0, 65535.0) as i32,
    )
}

fn mouse(at: (i32, i32), flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: at.0,
                dy: at.1,
                mouseData: data.cast_unsigned(),
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Keys Windows wants flagged "extended" (arrows, the block above them, right Ctrl and Alt, …).
const fn extended(vk: u16) -> bool {
    matches!(
        vk,
        0x21..=0x28 | 0x2C | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90 | 0xA3 | 0xA5
    )
}

fn key(vk: u16, down: bool) -> INPUT {
    // SAFETY: a table lookup.
    let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) };
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: u16::try_from(scan).unwrap_or(0),
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send(inputs: &[INPUT]) {
    if inputs.is_empty() {
        return;
    }
    // SAFETY: a slice of complete INPUTs, with their size.
    let sent = unsafe { SendInput(inputs, i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0)) };
    if sent as usize != inputs.len() {
        // e.g. the screen is locked, or the app in front runs as administrator
        tracing::debug!("control: Windows took {sent} of {} inputs", inputs.len());
    }
}

const fn button_flags(b: MouseKey, down: bool) -> MOUSE_EVENT_FLAGS {
    match (b, down) {
        (MouseKey::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (MouseKey::Left, false) => MOUSEEVENTF_LEFTUP,
        (MouseKey::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (MouseKey::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        (MouseKey::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (MouseKey::Right, false) => MOUSEEVENTF_RIGHTUP,
    }
}

const fn button_index(b: MouseKey) -> usize {
    match b {
        MouseKey::Left => 0,
        MouseKey::Middle => 1,
        MouseKey::Right => 2,
    }
}

const BUTTONS: [MouseKey; 3] = [MouseKey::Left, MouseKey::Middle, MouseKey::Right];

/// What the viewer holds down now (let go of when control ends).
#[derive(Default)]
struct Held {
    buttons: [bool; 3],
    keys: Vec<u16>,
}

fn take_back(why: TakeBack) {
    WATCH.with_borrow_mut(|w| {
        if let Some(w) = w
            && !w.fired
        {
            w.fired = true;
            (w.on_take_back)(why);
        }
    });
}

/// The sharer's own mouse (not ours): a click, or moving it a fair way, takes control back.
fn noticed(msg: u32, pt: POINT, injected: bool) {
    let mut fire = false;
    WATCH.with_borrow_mut(|w| {
        let Some(w) = w else { return };
        let last = w.last.replace(pt);
        if injected || w.fired {
            return;
        }
        if matches!(
            msg,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
        ) {
            fire = true;
        } else if msg == WM_MOUSEMOVE
            && let Some(l) = last
        {
            if w.since.elapsed() > TAKE_BACK_WINDOW {
                w.since = Instant::now();
                w.moved = 0.0;
            }
            w.moved += f64::from(pt.x - l.x).hypot(f64::from(pt.y - l.y));
            fire = w.moved >= TAKE_BACK_PX;
        }
    });
    if fire {
        take_back(TakeBack::Mouse);
    }
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY: for WH_MOUSE_LL with a code of 0 or more, `lparam` points at this event's
        // MSLLHOOKSTRUCT for the length of the call.
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        noticed(
            u32::try_from(wparam.0).unwrap_or(0),
            info.pt,
            info.flags & LLMHF_INJECTED != 0,
        );
    }
    // SAFETY: passes the event on unchanged.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Puts the banner at the top middle of the shared area, on top.
fn place(hwnd: HWND) {
    let Some(area) = WATCH.with_borrow(|w| w.as_ref().map(|w| w.area)) else {
        return;
    };
    let r = area_rect(area).unwrap_or_else(virtual_desktop);
    let width = BANNER_W.min(r.right - r.left - 16).max(200);
    let x = r.left + (r.right - r.left - width) / 2;
    let y = r.top.max(virtual_desktop().top) + 8;
    // SAFETY: our own window, on its own thread.
    let _ = unsafe { SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, width, BANNER_H, SWP_NOACTIVATE) };
}

fn paint(hwnd: HWND) {
    let mut text = WATCH
        .with_borrow(|w| w.as_ref().map(|w| w.text.clone()))
        .unwrap_or_default();
    let mut ps = PAINTSTRUCT::default();
    // SAFETY: WM_PAINT for our own window; ended below.
    let hdc = unsafe { BeginPaint(hwnd, &raw mut ps) };
    let mut all = ps.rcPaint;
    // SAFETY: the window's own area.
    let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &raw mut all) };
    // SAFETY: a plain solid brush, deleted below.
    let card = unsafe { CreateSolidBrush(rgb(0xd9_3a3f)) };
    // SAFETY: fills our own DC.
    let _ = unsafe { FillRect(hdc, &raw const all, card) };
    // SAFETY: a font by name, deleted below.
    let font = unsafe {
        CreateFontW(
            -16,
            0,
            0,
            0,
            FW_SEMIBOLD.0.cast_signed(),
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            NONANTIALIASED_QUALITY,
            DEFAULT_PITCH.0.into(),
            w!("Segoe UI"),
        )
    };
    // SAFETY: selects our font into our DC (the old one is put back below).
    let old_font = unsafe { SelectObject(hdc, HGDIOBJ(font.0)) };
    // SAFETY: text settings on our DC.
    let _ = unsafe { SetBkMode(hdc, TRANSPARENT) };
    // SAFETY: as above.
    let _ = unsafe { SetTextColor(hdc, rgb(0xff_ffff)) };
    let mut r = RECT {
        left: all.left + 12,
        right: all.right - 12,
        ..all
    };
    // SAFETY: draws `text` (a UTF-16 slice) into `r` on our DC.
    let _ = unsafe {
        DrawTextW(
            hdc,
            &mut text,
            &raw mut r,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        )
    };
    // SAFETY: restores the DC's own font.
    let _ = unsafe { SelectObject(hdc, old_font) };
    for obj in [HGDIOBJ(card.0), HGDIOBJ(font.0)] {
        // SAFETY: our own objects, no longer selected anywhere.
        let _ = unsafe { DeleteObject(obj) };
    }
    // SAFETY: ends the BeginPaint above.
    let _ = unsafe { EndPaint(hwnd, &raw const ps) };
}

unsafe extern "system" fn banner_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            paint(hwnd);
            LRESULT(0)
        }
        WM_TIMER => {
            place(hwnd);
            LRESULT(0)
        }
        WM_HOTKEY => {
            take_back(TakeBack::Hotkey);
            LRESULT(0)
        }
        WM_CLOSE => {
            // SAFETY: our own window and hotkey, on this thread.
            let _ = unsafe { UnregisterHotKey(Some(hwnd), HOTKEY_ID) };
            // SAFETY: as above.
            let _ = unsafe { KillTimer(Some(hwnd), 1) };
            // SAFETY: as above.
            let _ = unsafe { DestroyWindow(hwnd) };
            LRESULT(0)
        }
        WM_DESTROY => {
            // SAFETY: ends this thread's message loop.
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        // SAFETY: the default handling for everything else, with the arguments we were given.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn control_thread(watch: Watch, ready: &std::sync::mpsc::Sender<Result<isize, String>>) {
    // SAFETY: this thread only: physical pixels for the banner and the hook's positions.
    let _ = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    // SAFETY: a null name asks for this exe's own module handle (no reference count).
    let Ok(module) = (unsafe { GetModuleHandleW(PCWSTR::null()) }) else {
        let _ = ready.send(Err("no module handle".to_owned()));
        return;
    };
    let class = w!("3RTC.RemoteControl");
    let wc = WNDCLASSEXW {
        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
        lpfnWndProc: Some(banner_proc),
        hInstance: module.into(),
        lpszClassName: class,
        ..WNDCLASSEXW::default()
    };
    // SAFETY: `wc` is complete and the class name is a static string (registering twice fails
    // harmlessly).
    let _ = unsafe { RegisterClassExW(&raw const wc) };
    WATCH.with_borrow_mut(|w| *w = Some(watch));
    // SAFETY: a popup of the class above, owned by this thread: the mouse goes through it
    // (`WS_EX_TRANSPARENT` with `WS_EX_LAYERED`), never activated, no taskbar button.
    let created = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            w!("3RTC remote control"),
            WS_POPUP,
            0,
            0,
            BANNER_W,
            BANNER_H,
            None,
            None,
            Some(module.into()),
            None,
        )
    };
    let Ok(hwnd) = created else {
        WATCH.with_borrow_mut(|w| *w = None);
        let _ = ready.send(Err("couldn't create the banner".to_owned()));
        return;
    };
    // SAFETY: our own layered window, slightly see-through.
    let _ = unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), 240, LWA_ALPHA) };
    // SAFETY: our own window: kept out of screen captures (Windows 10 2004 and later), so the
    // viewer's picture isn't covered.
    if unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) }.is_err() {
        tracing::debug!("control: the banner may show in the shared picture");
    }
    place(hwnd);
    // SAFETY: shows our own window without activating it.
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
    // SAFETY: a timer for our own window (stopped on close).
    let _ = unsafe { SetTimer(Some(hwnd), 1, PLACE_TIMER_MS, None) };
    // SAFETY: a hotkey for our own window (removed on close).
    if let Err(e) = unsafe {
        RegisterHotKey(
            Some(hwnd),
            HOTKEY_ID,
            MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
            u32::from(b'X'),
        )
    } {
        tracing::warn!("control: Ctrl+Alt+Shift+X is taken by another app ({e})");
    }
    // SAFETY: a low-level mouse hook run on this thread's message loop (removed below); it
    // only reads events and passes every one on.
    let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), Some(module.into()), 0) };
    if let Err(e) = &hook {
        tracing::warn!("control: can't watch the mouse to take control back ({e})");
    }
    let _ = ready.send(Ok(hwnd.0 as isize));
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
    if let Ok(h) = hook {
        // SAFETY: the hook set above, on this thread.
        let _ = unsafe { UnhookWindowsHookEx(h) };
    }
    WATCH.with_borrow_mut(|w| *w = None);
}

/// A viewer controlling the shared screen (see the module docs). Dropping it ends that.
pub struct RemoteControl {
    area: ControlArea,
    hwnd: isize,
    held: Mutex<Held>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for RemoteControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteControl")
            .field("area", &self.area)
            .finish_non_exhaustive()
    }
}

impl RemoteControl {
    /// `name` controls `area` from now on: shows the banner and starts watching for the sharer
    /// taking control back (`on_take_back` is called once, from another thread).
    ///
    /// # Errors
    /// If the banner couldn't be made (then nothing is played back).
    pub fn start(
        area: ControlArea,
        name: &str,
        on_take_back: impl Fn(TakeBack) + Send + 'static,
    ) -> Result<Self, String> {
        let watch = Watch {
            on_take_back: Box::new(on_take_back),
            last: None,
            moved: 0.0,
            since: Instant::now(),
            fired: false,
            text: wide(&format!(
                "{name} is controlling this screen  ·  move your mouse or press Ctrl+Alt+Shift+X to take it back"
            )),
            area,
        };
        let (ready, started) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("3rtc-control".to_owned())
            .spawn(move || control_thread(watch, &ready))
            .map_err(|e| e.to_string())?;
        let hwnd = started.recv().map_err(|e| e.to_string())??;
        Ok(Self {
            area,
            hwnd,
            held: Mutex::new(Held::default()),
            thread: Some(thread),
        })
    }

    /// Plays back one of the viewer's events.
    pub fn input(&self, i: Injection) {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        physical(|| match i {
            Injection::Key { vk, down } => {
                // keys only (not mouse buttons), as named codes
                if vk == 0 || vk > 0xFE || matches!(vk, 0x01 | 0x02 | 0x04..=0x06) {
                    return;
                }
                if down {
                    if !held.keys.contains(&vk) {
                        held.keys.push(vk);
                    }
                } else if let Some(i) = held.keys.iter().position(|&k| k == vk) {
                    held.keys.remove(i);
                } else {
                    return;
                }
                send(&[key(vk, down)]);
            }
            Injection::Move { x, y } => {
                let Some(r) = area_rect(self.area) else { return };
                send(&[mouse(
                    absolute(r, x, y),
                    MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    0,
                )]);
            }
            Injection::Button { button, down, x, y } => {
                let Some(r) = area_rect(self.area) else { return };
                held.buttons[button_index(button)] = down;
                send(&[mouse(
                    absolute(r, x, y),
                    MOUSEEVENTF_MOVE
                        | MOUSEEVENTF_ABSOLUTE
                        | MOUSEEVENTF_VIRTUALDESK
                        | button_flags(button, down),
                    0,
                )]);
            }
            Injection::Wheel { x, y, dx, dy } => {
                let Some(r) = area_rect(self.area) else { return };
                let mut inputs = vec![mouse(
                    absolute(r, x, y),
                    MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    0,
                )];
                if dy != 0 {
                    inputs.push(mouse((0, 0), MOUSEEVENTF_WHEEL, dy.clamp(-2400, 2400)));
                }
                if dx != 0 {
                    inputs.push(mouse((0, 0), MOUSEEVENTF_HWHEEL, dx.clamp(-2400, 2400)));
                }
                send(&inputs);
            }
        });
    }

    /// Lets go of everything the viewer still holds.
    fn let_go(&self) {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        let mut inputs: Vec<INPUT> = held.keys.drain(..).rev().map(|k| key(k, false)).collect();
        for b in BUTTONS {
            if std::mem::take(&mut held.buttons[button_index(b)]) {
                inputs.push(mouse((0, 0), button_flags(b, false), 0));
            }
        }
        send(&inputs);
    }
}

impl Drop for RemoteControl {
    fn drop(&mut self) {
        self.let_go();
        // SAFETY: asks the control thread's window to close; its thread then ends.
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
