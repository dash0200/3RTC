//! The in-game overlay (BUILD_SPEC §9 feature 7): a small always-on-top window in a corner of the
//! screen listing who's in the call and who's talking. It never takes the mouse or the keyboard
//! (clicks go through to the game), never takes focus, and has no taskbar button. Nothing is
//! injected into games: it shows over games in borderless or windowed mode, not exclusive
//! full screen (Windows draws nothing over those).
//!
//! It runs on its own thread with plain GDI drawing: a layered window whose magenta pixels are
//! see-through, text drawn without smoothing so its edges stay clean against that colour.

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CLIP_DEFAULT_PRECIS, CreateFontW, CreatePen, CreateSolidBrush, DEFAULT_CHARSET,
    DEFAULT_PITCH, DT_END_ELLIPSIS, DT_LEFT, DT_SINGLELINE, DT_VCENTER, DeleteObject, DrawTextW, Ellipse,
    EndPaint, FW_SEMIBOLD, FillRect, HGDIOBJ, InvalidateRect, NONANTIALIASED_QUALITY, OUT_DEFAULT_PRECIS,
    PAINTSTRUCT, PS_SOLID, RoundRect, SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, GetSystemMetrics,
    HWND_TOPMOST, KillTimer, LWA_ALPHA, LWA_COLORKEY, MSG, PostMessageW, PostQuitMessage, RegisterClassExW,
    SM_CXSCREEN, SM_CYSCREEN, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SetLayeredWindowAttributes, SetTimer, SetWindowPos, ShowWindow, TranslateMessage, WM_APP, WM_CLOSE,
    WM_DESTROY, WM_PAINT, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::{PCWSTR, w};

use crate::{Corner, OverlayLine};

const WM_UPDATE: u32 = WM_APP + 7;
/// See-through colour (magenta, as a `COLORREF`: 0x00BBGGRR).
const KEY: u32 = 0x00FF_00FF;
const WIDTH: i32 = 240;
const ROW: i32 = 34;
const PAD: i32 = 8;
const MARGIN: i32 = 16;
/// Re-asserted on top this often (games that make themselves topmost).
const TOP_TIMER_MS: u32 = 2000;

/// `0xRRGGBB` → `COLORREF` (`0x00BBGGRR`).
const fn rgb(c: u32) -> COLORREF {
    COLORREF(((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF))
}

#[derive(Debug, Default)]
struct Wanted {
    corner: Corner,
    lines: Vec<OverlayLine>,
}

thread_local! {
    static WANTED: RefCell<Option<Arc<Mutex<Wanted>>>> = const { RefCell::new(None) };
}

fn wanted() -> (Corner, Vec<OverlayLine>) {
    WANTED.with_borrow(|w| {
        w.as_ref().map_or((Corner::TopLeft, Vec::new()), |w| {
            let w = w.lock().unwrap_or_else(PoisonError::into_inner);
            (w.corner, w.lines.clone())
        })
    })
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Moves, sizes and shows (or hides) the window for what's wanted now.
fn place(hwnd: HWND) {
    let (corner, lines) = wanted();
    if lines.is_empty() {
        // SAFETY: our own window, on its own thread.
        let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
        return;
    }
    let n = i32::try_from(lines.len()).unwrap_or(1).min(12);
    let height = PAD * 2 + n * ROW;
    // SAFETY: plain metric queries.
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    // SAFETY: as above.
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    let x = match corner {
        Corner::TopLeft | Corner::BottomLeft => MARGIN,
        Corner::TopRight | Corner::BottomRight => screen_w - WIDTH - MARGIN,
    };
    let y = match corner {
        Corner::TopLeft | Corner::TopRight => MARGIN,
        Corner::BottomLeft | Corner::BottomRight => screen_h - height - MARGIN * 4,
    };
    // SAFETY: our own window; on top of everything, without taking focus.
    let _ = unsafe { SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, WIDTH, height, SWP_NOACTIVATE) };
    // SAFETY: repaint all of it.
    let _ = unsafe { InvalidateRect(Some(hwnd), None, true) };
    // SAFETY: shows it without activating it.
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
}

fn paint(hwnd: HWND) {
    let (_, lines) = wanted();
    let mut ps = PAINTSTRUCT::default();
    // SAFETY: WM_PAINT for our own window; ended below.
    let hdc = unsafe { BeginPaint(hwnd, &raw mut ps) };
    let n = i32::try_from(lines.len()).unwrap_or(1).min(12);
    let all = RECT {
        left: 0,
        top: 0,
        right: WIDTH,
        bottom: PAD * 2 + n * ROW,
    };
    // SAFETY: a plain solid brush, deleted below.
    let key = unsafe { CreateSolidBrush(COLORREF(KEY)) };
    // SAFETY: fills our own DC.
    let _ = unsafe { FillRect(hdc, &raw const all, key) };
    // SAFETY: plain GDI objects, deleted below.
    let card = unsafe { CreateSolidBrush(rgb(0x1c_1c23)) };
    // SAFETY: as above.
    let edge = unsafe { CreatePen(PS_SOLID, 1, rgb(0x3a_3a45)) };
    // SAFETY: a font by name; no smoothing so the see-through colour doesn't fringe it.
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
    // SAFETY: selects our objects into our DC (the old ones are put back below).
    let old_brush = unsafe { SelectObject(hdc, HGDIOBJ(card.0)) };
    // SAFETY: as above.
    let old_pen = unsafe { SelectObject(hdc, HGDIOBJ(edge.0)) };
    // SAFETY: as above.
    let old_font = unsafe { SelectObject(hdc, HGDIOBJ(font.0)) };
    // SAFETY: text drawing settings on our DC.
    let _ = unsafe { SetBkMode(hdc, TRANSPARENT) };
    for (i, line) in lines.iter().take(12).enumerate() {
        let top = PAD + i32::try_from(i).unwrap_or(0) * ROW;
        // SAFETY: draws on our DC with the selected brush and pen.
        let _ = unsafe { RoundRect(hdc, PAD, top, WIDTH - PAD, top + ROW - 4, 14, 14) };
        let dot = if line.speaking {
            0x36_d399
        } else if line.muted {
            0xff_8a9c
        } else {
            0x85_858f
        };
        // SAFETY: a plain brush, deleted right after.
        let dot_brush = unsafe { CreateSolidBrush(rgb(dot)) };
        // SAFETY: selects it into our DC.
        let prev = unsafe { SelectObject(hdc, HGDIOBJ(dot_brush.0)) };
        let cy = top + (ROW - 4) / 2;
        // SAFETY: draws the dot.
        let _ = unsafe { Ellipse(hdc, PAD + 10, cy - 5, PAD + 20, cy + 5) };
        // SAFETY: puts the card brush back, then deletes the dot brush (no longer selected).
        let _ = unsafe { SelectObject(hdc, prev) };
        // SAFETY: as above.
        let _ = unsafe { DeleteObject(HGDIOBJ(dot_brush.0)) };
        // SAFETY: text colour on our DC.
        let _ = unsafe { SetTextColor(hdc, rgb(if line.speaking { 0xf4_f4f6 } else { 0xa9_a9b5 })) };
        let mut text = wide(&line.name);
        if line.muted {
            text.extend(wide("  (muted)"));
        }
        let mut r = RECT {
            left: PAD + 28,
            top,
            right: WIDTH - PAD - 8,
            bottom: top + ROW - 4,
        };
        // SAFETY: draws `text` (a valid UTF-16 slice) into `r` on our DC.
        let _ = unsafe {
            DrawTextW(
                hdc,
                &mut text,
                &raw mut r,
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
            )
        };
    }
    // SAFETY: restores the DC's own objects.
    let _ = unsafe { SelectObject(hdc, old_brush) };
    // SAFETY: as above.
    let _ = unsafe { SelectObject(hdc, old_pen) };
    // SAFETY: as above.
    let _ = unsafe { SelectObject(hdc, old_font) };
    for obj in [HGDIOBJ(key.0), HGDIOBJ(card.0), HGDIOBJ(edge.0), HGDIOBJ(font.0)] {
        // SAFETY: our own objects, no longer selected anywhere.
        let _ = unsafe { DeleteObject(obj) };
    }
    // SAFETY: ends the BeginPaint above.
    let _ = unsafe { EndPaint(hwnd, &raw const ps) };
}

unsafe extern "system" fn overlay_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            paint(hwnd);
            LRESULT(0)
        }
        WM_UPDATE => {
            place(hwnd);
            LRESULT(0)
        }
        WM_TIMER => {
            if !wanted().1.is_empty() {
                // SAFETY: our own window: back on top (a game may have put itself above).
                let _ = unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(HWND_TOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                    )
                };
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            // SAFETY: our own window, on its own thread.
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

fn overlay_thread(wanted: Arc<Mutex<Wanted>>, ready: &std::sync::mpsc::Sender<Option<isize>>) {
    // SAFETY: a null name asks for this exe's own module handle (no reference count).
    let Ok(module) = (unsafe { GetModuleHandleW(PCWSTR::null()) }) else {
        let _ = ready.send(None);
        return;
    };
    let class = w!("3RTC.Overlay");
    let wc = WNDCLASSEXW {
        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
        lpfnWndProc: Some(overlay_proc),
        hInstance: module.into(),
        lpszClassName: class,
        ..WNDCLASSEXW::default()
    };
    // SAFETY: `wc` is complete and the class name is a static string (registering twice fails
    // harmlessly).
    let _ = unsafe { RegisterClassExW(&raw const wc) };
    WANTED.with_borrow_mut(|w| *w = Some(wanted));
    // SAFETY: a popup of the class above, owned by this thread: see-through for the mouse
    // (`WS_EX_TRANSPARENT` with `WS_EX_LAYERED`), never activated, no taskbar button.
    let created = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            w!("3RTC overlay"),
            WS_POPUP,
            0,
            0,
            WIDTH,
            ROW,
            None,
            None,
            Some(module.into()),
            None,
        )
    };
    let Ok(hwnd) = created else {
        tracing::warn!("overlay: couldn't create its window");
        let _ = ready.send(None);
        return;
    };
    // SAFETY: our own layered window: magenta is see-through, the rest slightly so.
    let _ = unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(KEY), 235, LWA_COLORKEY | LWA_ALPHA) };
    // SAFETY: a timer for our own window (stopped on close).
    let _ = unsafe { SetTimer(Some(hwnd), 1, TOP_TIMER_MS, None) };
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
    WANTED.with_borrow_mut(|w| *w = None);
}

/// The overlay window (dropping it closes it).
pub struct Overlay {
    hwnd: isize,
    wanted: Arc<Mutex<Wanted>>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Overlay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Overlay").finish_non_exhaustive()
    }
}

impl Overlay {
    /// Creates it (hidden until there's someone to show). `None` if Windows wouldn't.
    #[must_use]
    pub fn start() -> Option<Self> {
        let wanted = Arc::new(Mutex::new(Wanted::default()));
        let mine = Arc::clone(&wanted);
        let (ready, started) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("3rtc-overlay".to_owned())
            .spawn(move || overlay_thread(mine, &ready))
            .ok()?;
        let hwnd = started.recv().ok().flatten()?;
        Some(Self {
            hwnd,
            wanted,
            thread: Some(thread),
        })
    }

    /// Shows these people in that corner (none: hidden).
    pub fn show(&self, corner: Corner, lines: Vec<OverlayLine>) {
        {
            let mut w = self.wanted.lock().unwrap_or_else(PoisonError::into_inner);
            if w.corner == corner && w.lines == lines {
                return;
            }
            w.corner = corner;
            w.lines = lines;
        }
        // SAFETY: posts to the overlay thread's own window (gone: nothing happens).
        let _ = unsafe {
            PostMessageW(
                Some(HWND(self.hwnd as *mut c_void)),
                WM_UPDATE,
                WPARAM(0),
                LPARAM(0),
            )
        };
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        // SAFETY: asks the overlay thread's window to close; its thread then ends.
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
