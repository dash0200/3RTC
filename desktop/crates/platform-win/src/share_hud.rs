//! Screen sharing HUD (like Microsoft Teams): a floating always-on-top pill at the top of the
//! screen while sharing. It is excluded from the screen capture (`WDA_EXCLUDEFROMCAPTURE`), so
//! only the host sees it (even while playing games in borderless or windowed mode).
//!
//! Features:
//! - Constant live pulse indicator while sharing (`● Sharing screen` with a glowing animated pulse).
//! - Top-of-screen interactive alert when someone asks for remote control (`[ Allow ]` and `[ Deny ]`).
//! - Top-of-screen status and `[ Take back ]` button while someone controls.
//! - Uses `WS_EX_NOACTIVATE` so clicking its buttons NEVER steals keyboard focus from the game.

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CLIP_DEFAULT_PRECIS, CreateFontW, CreatePen, CreateSolidBrush, DEFAULT_CHARSET,
    DEFAULT_PITCH, DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_SINGLELINE, DT_VCENTER, DeleteObject, DrawTextW,
    Ellipse, EndPaint, FW_BOLD, FW_SEMIBOLD, FillRect, HGDIOBJ, InvalidateRect, NONANTIALIASED_QUALITY,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID, RoundRect, SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, GetSystemMetrics,
    HWND_TOPMOST, IDC_ARROW, IDC_HAND, KillTimer, LWA_ALPHA, LWA_COLORKEY, LoadCursorW, MSG, PostMessageW,
    PostQuitMessage, RegisterClassExW, SM_CXSCREEN, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SetCursor,
    SetLayeredWindowAttributes, SetTimer, SetWindowDisplayAffinity, SetWindowPos, ShowWindow,
    TranslateMessage, WDA_EXCLUDEFROMCAPTURE, WM_APP, WM_CLOSE, WM_DESTROY, WM_LBUTTONUP, WM_MOUSEMOVE,
    WM_PAINT, WM_SETCURSOR, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};
use windows::core::{PCWSTR, w};

use crate::{ShareHudAction, ShareHudState};

const WM_UPDATE: u32 = WM_APP + 9;
const WM_MOUSELEAVE: u32 = 0x02A3;
/// Magenta see-through colour (`0x00BBGGRR`).
const KEY: u32 = 0x00FF_00FF;
const TOP_TIMER_MS: u32 = 2000;
const PULSE_TIMER_MS: u32 = 500;

/// `0xRRGGBB` → `COLORREF` (`0x00BBGGRR`).
const fn rgb(c: u32) -> COLORREF {
    COLORREF(((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HoverBtn {
    None,
    Stop,
    Allow,
    Deny,
    TakeBack,
}

struct Watch {
    state: Option<ShareHudState>,
    on_action: Box<dyn Fn(ShareHudAction) + Send>,
    pulse: bool,
    hover: HoverBtn,
    btn_stop: RECT,
    btn_allow: RECT,
    btn_deny: RECT,
    btn_take_back: RECT,
}

thread_local! {
    static WATCH: RefCell<Option<Watch>> = const { RefCell::new(None) };
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn hit_test(w: &Watch, x: i32, y: i32) -> HoverBtn {
    let pt_in = |r: &RECT| x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    match &w.state {
        Some(ShareHudState::Sharing { .. }) => {
            if pt_in(&w.btn_stop) {
                HoverBtn::Stop
            } else {
                HoverBtn::None
            }
        }
        Some(ShareHudState::ControlRequested { .. }) => {
            if pt_in(&w.btn_allow) {
                HoverBtn::Allow
            } else if pt_in(&w.btn_deny) {
                HoverBtn::Deny
            } else {
                HoverBtn::None
            }
        }
        Some(ShareHudState::Controlling { .. }) => {
            if pt_in(&w.btn_take_back) {
                HoverBtn::TakeBack
            } else {
                HoverBtn::None
            }
        }
        None => HoverBtn::None,
    }
}

fn dimensions(state: &Option<ShareHudState>) -> (i32, i32) {
    match state {
        Some(ShareHudState::Sharing { .. }) => (230, 34),
        Some(ShareHudState::ControlRequested { .. }) => (380, 40),
        Some(ShareHudState::Controlling { .. }) => (340, 38),
        None => (230, 34),
    }
}

fn place(hwnd: HWND) {
    let state = WATCH.with_borrow(|w| w.as_ref().and_then(|w| w.state.clone()));
    if state.is_none() {
        // SAFETY: our own window, on its own thread.
        let _ = unsafe { ShowWindow(hwnd, SW_HIDE) };
        return;
    }
    let (width, height) = dimensions(&state);
    // SAFETY: metric query for primary monitor width.
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let x = (screen_w - width) / 2;
    let y = 12;

    // SAFETY: our own window; always on top of everything without taking focus.
    let _ = unsafe { SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, width, height, SWP_NOACTIVATE) };
    // SAFETY: repaint the window.
    // SAFETY: repaint HUD on timer/hover.
    let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
    // SAFETY: show without activating so full-screen games don't lose focus.
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
}

fn paint(hwnd: HWND) {
    let (state, pulse, hover) = WATCH.with_borrow(|w| {
        w.as_ref().map_or((None, false, HoverBtn::None), |w| {
            (w.state.clone(), w.pulse, w.hover)
        })
    });

    let Some(state) = state else { return };
    let (width, height) = dimensions(&Some(state.clone()));

    let mut ps = PAINTSTRUCT::default();
    // SAFETY: BeginPaint for our own window, paired with EndPaint below.
    let hdc = unsafe { BeginPaint(hwnd, &raw mut ps) };

    let all = RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };

    // 1. Fill entire window rect with transparent magenta key.
    // SAFETY: solid brush for color keying.
    let key_brush = unsafe { CreateSolidBrush(COLORREF(KEY)) };
    // SAFETY: fills DC with key color.
    let _ = unsafe { FillRect(hdc, &raw const all, key_brush) };

    // 2. Prepare typography font.
    // SAFETY: Segoe UI semibold font; no antialiasing so the edges stay clean against key color.
    let font_normal = unsafe {
        CreateFontW(
            -13,
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
    // SAFETY: bold font for buttons.
    let font_bold = unsafe {
        CreateFontW(
            -12,
            0,
            0,
            0,
            FW_BOLD.0.cast_signed(),
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

    // SAFETY: transparent text background.
    let _ = unsafe { SetBkMode(hdc, TRANSPARENT) };

    match state {
        ShareHudState::Sharing { viewers } => {
            // SAFETY: card brush.
            let card_brush = unsafe { CreateSolidBrush(rgb(0x14_1419)) };
            // SAFETY: card border pen.
            let border_pen = unsafe { CreatePen(PS_SOLID, 1, rgb(0x3a_3a45)) };
            // SAFETY: select card brush into DC.
            let old_brush = unsafe { SelectObject(hdc, HGDIOBJ(card_brush.0)) };
            // SAFETY: select border pen into DC.
            let old_pen = unsafe { SelectObject(hdc, HGDIOBJ(border_pen.0)) };
            // SAFETY: draw rounded pill card.
            let _ = unsafe { RoundRect(hdc, 0, 0, width, height, height, height) };

            let cy = height / 2;
            if pulse {
                // SAFETY: halo outer glow brush.
                let halo_brush = unsafe { CreateSolidBrush(rgb(0x16_4e33)) };
                // SAFETY: null pen for borderless halo.
                let null_pen = unsafe { CreatePen(PS_SOLID, 0, COLORREF(0)) };
                // SAFETY: select halo brush into DC.
                let prev_b = unsafe { SelectObject(hdc, HGDIOBJ(halo_brush.0)) };
                // SAFETY: select null pen into DC.
                let prev_p = unsafe { SelectObject(hdc, HGDIOBJ(null_pen.0)) };
                // SAFETY: draw halo ellipse.
                let _ = unsafe { Ellipse(hdc, 10, cy - 8, 26, cy + 8) };
                // SAFETY: restore brush.
                let _ = unsafe { SelectObject(hdc, prev_b) };
                // SAFETY: restore pen.
                let _ = unsafe { SelectObject(hdc, prev_p) };
                // SAFETY: delete halo brush.
                let _ = unsafe { DeleteObject(HGDIOBJ(halo_brush.0)) };
                // SAFETY: delete null pen.
                let _ = unsafe { DeleteObject(HGDIOBJ(null_pen.0)) };
            }
            let dot_color = if pulse { 0x36_d399 } else { 0x1e_8255 };
            // SAFETY: green dot solid brush.
            let dot_brush = unsafe { CreateSolidBrush(rgb(dot_color)) };
            // SAFETY: select dot brush into DC.
            let prev_b = unsafe { SelectObject(hdc, HGDIOBJ(dot_brush.0)) };
            // SAFETY: draw live dot.
            let _ = unsafe { Ellipse(hdc, 13, cy - 5, 23, cy + 5) };
            // SAFETY: restore previous brush.
            let _ = unsafe { SelectObject(hdc, prev_b) };
            // SAFETY: delete dot brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(dot_brush.0)) };

            let text_str = if viewers > 1 {
                format!("Sharing screen ({viewers})")
            } else {
                "Sharing screen".to_owned()
            };
            let mut text = wide(&text_str);
            // SAFETY: set text color.
            let _ = unsafe { SetTextColor(hdc, rgb(0xf4_f4f6)) };
            // SAFETY: select normal font.
            let prev_f = unsafe { SelectObject(hdc, HGDIOBJ(font_normal.0)) };
            let mut text_rect = RECT {
                left: 30,
                top: 0,
                right: width - 68,
                bottom: height,
            };
            // SAFETY: draw text.
            let _ = unsafe {
                DrawTextW(
                    hdc,
                    &mut text,
                    &raw mut text_rect,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                )
            };
            // SAFETY: restore previous font.
            let _ = unsafe { SelectObject(hdc, prev_f) };

            let btn_r = RECT {
                left: width - 62,
                top: 5,
                right: width - 8,
                bottom: height - 5,
            };
            WATCH.with_borrow_mut(|w| {
                if let Some(w) = w.as_mut() {
                    w.btn_stop = btn_r;
                }
            });
            let btn_bg = if hover == HoverBtn::Stop {
                rgb(0x42_1c26)
            } else {
                rgb(0x26_161d)
            };
            // SAFETY: stop button brush.
            let btn_brush = unsafe { CreateSolidBrush(btn_bg) };
            // SAFETY: stop button pen.
            let btn_pen = unsafe { CreatePen(PS_SOLID, 1, rgb(0x60_2230)) };
            // SAFETY: select stop brush into DC.
            let prev_b = unsafe { SelectObject(hdc, HGDIOBJ(btn_brush.0)) };
            // SAFETY: select stop pen into DC.
            let prev_p = unsafe { SelectObject(hdc, HGDIOBJ(btn_pen.0)) };
            // SAFETY: draw stop button rect.
            let _ = unsafe { RoundRect(hdc, btn_r.left, btn_r.top, btn_r.right, btn_r.bottom, 8, 8) };
            // SAFETY: restore previous brush.
            let _ = unsafe { SelectObject(hdc, prev_b) };
            // SAFETY: restore previous pen.
            let _ = unsafe { SelectObject(hdc, prev_p) };
            // SAFETY: delete stop brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(btn_brush.0)) };
            // SAFETY: delete stop pen.
            let _ = unsafe { DeleteObject(HGDIOBJ(btn_pen.0)) };

            let mut btn_text = wide("Stop");
            // SAFETY: stop text color.
            let _ = unsafe { SetTextColor(hdc, rgb(0xff_8a9c)) };
            // SAFETY: select bold font.
            let prev_f = unsafe { SelectObject(hdc, HGDIOBJ(font_bold.0)) };
            let mut draw_r = btn_r;
            // SAFETY: draw stop text.
            let _ = unsafe {
                DrawTextW(
                    hdc,
                    &mut btn_text,
                    &raw mut draw_r,
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER,
                )
            };
            // SAFETY: restore previous font.
            let _ = unsafe { SelectObject(hdc, prev_f) };

            // SAFETY: restore old brush.
            let _ = unsafe { SelectObject(hdc, old_brush) };
            // SAFETY: restore old pen.
            let _ = unsafe { SelectObject(hdc, old_pen) };
            // SAFETY: delete card brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(card_brush.0)) };
            // SAFETY: delete border pen.
            let _ = unsafe { DeleteObject(HGDIOBJ(border_pen.0)) };
        }
        ShareHudState::ControlRequested { name, .. } => {
            // SAFETY: control request alert card brush.
            let card_brush = unsafe { CreateSolidBrush(rgb(0x1c_1c23)) };
            // SAFETY: control request alert border pen.
            let border_pen = unsafe { CreatePen(PS_SOLID, 1, rgb(0x36_d399)) };
            // SAFETY: select alert card brush into DC.
            let old_brush = unsafe { SelectObject(hdc, HGDIOBJ(card_brush.0)) };
            // SAFETY: select alert border pen into DC.
            let old_pen = unsafe { SelectObject(hdc, HGDIOBJ(border_pen.0)) };
            // SAFETY: draw alert rounded card.
            let _ = unsafe { RoundRect(hdc, 0, 0, width, height, 12, 12) };

            let cy = height / 2;
            // SAFETY: alert green dot brush.
            let dot_brush = unsafe { CreateSolidBrush(rgb(0x36_d399)) };
            // SAFETY: select alert dot brush into DC.
            let prev_b = unsafe { SelectObject(hdc, HGDIOBJ(dot_brush.0)) };
            // SAFETY: draw alert dot.
            let _ = unsafe { Ellipse(hdc, 12, cy - 5, 22, cy + 5) };
            // SAFETY: restore previous brush.
            let _ = unsafe { SelectObject(hdc, prev_b) };
            // SAFETY: delete alert dot brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(dot_brush.0)) };

            let mut text = wide(&format!("{name} asks for control"));
            // SAFETY: set text color.
            let _ = unsafe { SetTextColor(hdc, rgb(0xf4_f4f6)) };
            // SAFETY: select normal font.
            let prev_f = unsafe { SelectObject(hdc, HGDIOBJ(font_normal.0)) };
            let mut text_rect = RECT {
                left: 30,
                top: 0,
                right: width - 140,
                bottom: height,
            };
            // SAFETY: draw alert text.
            let _ = unsafe {
                DrawTextW(
                    hdc,
                    &mut text,
                    &raw mut text_rect,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                )
            };
            // SAFETY: restore previous font.
            let _ = unsafe { SelectObject(hdc, prev_f) };

            let allow_r = RECT {
                left: width - 132,
                top: 6,
                right: width - 72,
                bottom: height - 6,
            };
            WATCH.with_borrow_mut(|w| {
                if let Some(w) = w.as_mut() {
                    w.btn_allow = allow_r;
                }
            });
            let allow_bg = if hover == HoverBtn::Allow {
                rgb(0x45_e5aa)
            } else {
                rgb(0x36_d399)
            };
            // SAFETY: allow button brush.
            let allow_brush = unsafe { CreateSolidBrush(allow_bg) };
            // SAFETY: select allow brush into DC.
            let prev_b = unsafe { SelectObject(hdc, HGDIOBJ(allow_brush.0)) };
            // SAFETY: draw allow button rect.
            let _ = unsafe {
                RoundRect(
                    hdc,
                    allow_r.left,
                    allow_r.top,
                    allow_r.right,
                    allow_r.bottom,
                    8,
                    8,
                )
            };
            // SAFETY: restore previous brush.
            let _ = unsafe { SelectObject(hdc, prev_b) };
            // SAFETY: delete allow brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(allow_brush.0)) };

            let mut allow_text = wide("Allow");
            // SAFETY: allow text color.
            let _ = unsafe { SetTextColor(hdc, rgb(0x0a_0a0d)) };
            // SAFETY: select bold font.
            let prev_f = unsafe { SelectObject(hdc, HGDIOBJ(font_bold.0)) };
            let mut draw_allow = allow_r;
            // SAFETY: draw allow text.
            let _ = unsafe {
                DrawTextW(
                    hdc,
                    &mut allow_text,
                    &raw mut draw_allow,
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER,
                )
            };

            let deny_r = RECT {
                left: width - 66,
                top: 6,
                right: width - 8,
                bottom: height - 6,
            };
            WATCH.with_borrow_mut(|w| {
                if let Some(w) = w.as_mut() {
                    w.btn_deny = deny_r;
                }
            });
            let deny_bg = if hover == HoverBtn::Deny {
                rgb(0x3a_3a45)
            } else {
                rgb(0x2a_2a33)
            };
            // SAFETY: deny button brush.
            let deny_brush = unsafe { CreateSolidBrush(deny_bg) };
            // SAFETY: select deny brush into DC.
            let prev_b = unsafe { SelectObject(hdc, HGDIOBJ(deny_brush.0)) };
            // SAFETY: draw deny button rect.
            let _ = unsafe { RoundRect(hdc, deny_r.left, deny_r.top, deny_r.right, deny_r.bottom, 8, 8) };
            // SAFETY: restore previous brush.
            let _ = unsafe { SelectObject(hdc, prev_b) };
            // SAFETY: delete deny brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(deny_brush.0)) };

            let mut deny_text = wide("Deny");
            // SAFETY: deny text color.
            let _ = unsafe { SetTextColor(hdc, rgb(0xa9_a9b5)) };
            let mut draw_deny = deny_r;
            // SAFETY: draw deny text.
            let _ = unsafe {
                DrawTextW(
                    hdc,
                    &mut deny_text,
                    &raw mut draw_deny,
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER,
                )
            };
            // SAFETY: restore previous font.
            let _ = unsafe { SelectObject(hdc, prev_f) };

            // SAFETY: restore old brush.
            let _ = unsafe { SelectObject(hdc, old_brush) };
            // SAFETY: restore old pen.
            let _ = unsafe { SelectObject(hdc, old_pen) };
            // SAFETY: delete card brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(card_brush.0)) };
            // SAFETY: delete border pen.
            let _ = unsafe { DeleteObject(HGDIOBJ(border_pen.0)) };
        }
        ShareHudState::Controlling { name } => {
            // SAFETY: controlling card brush.
            let card_brush = unsafe { CreateSolidBrush(rgb(0x20_1016)) };
            // SAFETY: controlling border pen.
            let border_pen = unsafe { CreatePen(PS_SOLID, 1, rgb(0x5a_1e2a)) };
            // SAFETY: select controlling card brush into DC.
            let old_brush = unsafe { SelectObject(hdc, HGDIOBJ(card_brush.0)) };
            // SAFETY: select controlling border pen into DC.
            let old_pen = unsafe { SelectObject(hdc, HGDIOBJ(border_pen.0)) };
            // SAFETY: draw controlling rounded card.
            let _ = unsafe { RoundRect(hdc, 0, 0, width, height, 12, 12) };

            let cy = height / 2;
            // SAFETY: red dot brush.
            let dot_brush = unsafe { CreateSolidBrush(rgb(0xff_8a9c)) };
            // SAFETY: select red dot brush into DC.
            let prev_b = unsafe { SelectObject(hdc, HGDIOBJ(dot_brush.0)) };
            // SAFETY: draw red active control dot.
            let _ = unsafe { Ellipse(hdc, 12, cy - 5, 22, cy + 5) };
            // SAFETY: restore previous brush.
            let _ = unsafe { SelectObject(hdc, prev_b) };
            // SAFETY: delete red dot brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(dot_brush.0)) };

            let mut text = wide(&format!("{name} is controlling"));
            // SAFETY: set text color.
            let _ = unsafe { SetTextColor(hdc, rgb(0xf4_f4f6)) };
            // SAFETY: select normal font.
            let prev_f = unsafe { SelectObject(hdc, HGDIOBJ(font_normal.0)) };
            let mut text_rect = RECT {
                left: 30,
                top: 0,
                right: width - 106,
                bottom: height,
            };
            // SAFETY: draw controlling text.
            let _ = unsafe {
                DrawTextW(
                    hdc,
                    &mut text,
                    &raw mut text_rect,
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                )
            };
            // SAFETY: restore previous font.
            let _ = unsafe { SelectObject(hdc, prev_f) };

            let tb_r = RECT {
                left: width - 100,
                top: 5,
                right: width - 8,
                bottom: height - 5,
            };
            WATCH.with_borrow_mut(|w| {
                if let Some(w) = w.as_mut() {
                    w.btn_take_back = tb_r;
                }
            });
            let tb_bg = if hover == HoverBtn::TakeBack {
                rgb(0xfa_204b)
            } else {
                rgb(0xe5_143d)
            };
            // SAFETY: take back button brush.
            let tb_brush = unsafe { CreateSolidBrush(tb_bg) };
            // SAFETY: select take back brush into DC.
            let prev_b = unsafe { SelectObject(hdc, HGDIOBJ(tb_brush.0)) };
            // SAFETY: draw take back button rect.
            let _ = unsafe { RoundRect(hdc, tb_r.left, tb_r.top, tb_r.right, tb_r.bottom, 8, 8) };
            // SAFETY: restore previous brush.
            let _ = unsafe { SelectObject(hdc, prev_b) };
            // SAFETY: delete take back brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(tb_brush.0)) };

            let mut tb_text = wide("Take back");
            // SAFETY: take back text color.
            let _ = unsafe { SetTextColor(hdc, rgb(0xff_ffff)) };
            // SAFETY: select bold font.
            let prev_f = unsafe { SelectObject(hdc, HGDIOBJ(font_bold.0)) };
            let mut draw_tb = tb_r;
            // SAFETY: draw take back text.
            let _ = unsafe {
                DrawTextW(
                    hdc,
                    &mut tb_text,
                    &raw mut draw_tb,
                    DT_CENTER | DT_SINGLELINE | DT_VCENTER,
                )
            };
            // SAFETY: restore previous font.
            let _ = unsafe { SelectObject(hdc, prev_f) };

            // SAFETY: restore old brush.
            let _ = unsafe { SelectObject(hdc, old_brush) };
            // SAFETY: restore old pen.
            let _ = unsafe { SelectObject(hdc, old_pen) };
            // SAFETY: delete card brush.
            let _ = unsafe { DeleteObject(HGDIOBJ(card_brush.0)) };
            // SAFETY: delete border pen.
            let _ = unsafe { DeleteObject(HGDIOBJ(border_pen.0)) };
        }
    }

    for obj in [HGDIOBJ(font_normal.0), HGDIOBJ(font_bold.0), HGDIOBJ(key_brush.0)] {
        // SAFETY: delete font or brush object.
        let _ = unsafe { DeleteObject(obj) };
    }
    // SAFETY: end paint for our window.
    let _ = unsafe { EndPaint(hwnd, &raw const ps) };
}

unsafe extern "system" fn hud_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
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
            if wparam.0 == 1 {
                // Pulse timer: toggle pulse phase and redraw
                WATCH.with_borrow_mut(|w| {
                    if let Some(w) = w.as_mut() {
                        w.pulse = !w.pulse;
                    }
                });
                // SAFETY: repaint HUD on timer/hover.
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            } else if wparam.0 == 2 {
                // Topmost assert timer
                place(hwnd);
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            let mut track = TRACKMOUSEEVENT {
                cbSize: u32::try_from(std::mem::size_of::<TRACKMOUSEEVENT>()).unwrap_or(0),
                dwFlags: TME_LEAVE,
                hwndTrack: hwnd,
                dwHoverTime: 0,
            };
            // SAFETY: tracks mouse leave for our window.
            let _ = unsafe { TrackMouseEvent(&raw mut track) };
            let changed = WATCH.with_borrow_mut(|w| {
                let Some(w) = w.as_mut() else { return false };
                let new_hover = hit_test(w, x, y);
                if new_hover != w.hover {
                    w.hover = new_hover;
                    true
                } else {
                    false
                }
            });
            if changed {
                // SAFETY: repaint hover states.
                // SAFETY: repaint HUD on timer/hover.
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            let changed = WATCH.with_borrow_mut(|w| {
                let Some(w) = w.as_mut() else { return false };
                if w.hover != HoverBtn::None {
                    w.hover = HoverBtn::None;
                    true
                } else {
                    false
                }
            });
            if changed {
                // SAFETY: repaint hover states.
                // SAFETY: repaint HUD on timer/hover.
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            let action = WATCH.with_borrow(|w| {
                let w = w.as_ref()?;
                match hit_test(w, x, y) {
                    HoverBtn::Stop => Some(ShareHudAction::StopSharing),
                    HoverBtn::Allow => {
                        if let Some(ShareHudState::ControlRequested { peer, .. }) = &w.state {
                            Some(ShareHudAction::AllowControl(peer.clone()))
                        } else {
                            None
                        }
                    }
                    HoverBtn::Deny => {
                        if let Some(ShareHudState::ControlRequested { peer, .. }) = &w.state {
                            Some(ShareHudAction::DenyControl(peer.clone()))
                        } else {
                            None
                        }
                    }
                    HoverBtn::TakeBack => Some(ShareHudAction::TakeBackControl),
                    HoverBtn::None => None,
                }
            });
            if let Some(act) = action {
                WATCH.with_borrow(|w| {
                    if let Some(w) = w.as_ref() {
                        (w.on_action)(act);
                    }
                });
            }
            LRESULT(0)
        }
        WM_SETCURSOR => {
            let is_btn = WATCH.with_borrow(|w| w.as_ref().is_some_and(|w| w.hover != HoverBtn::None));
            if is_btn {
                // SAFETY: standard hand cursor.
                if let Ok(cursor) = unsafe { LoadCursorW(None, IDC_HAND) } {
                    // SAFETY: set cursor.
                    unsafe { SetCursor(Some(cursor)) };
                    return LRESULT(1);
                }
            } else {
                // SAFETY: default arrow cursor.
                if let Ok(cursor) = unsafe { LoadCursorW(None, IDC_ARROW) } {
                    // SAFETY: set cursor.
                    unsafe { SetCursor(Some(cursor)) };
                    return LRESULT(1);
                }
            }
            // SAFETY: default proc.
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_CLOSE => {
            // SAFETY: cleanup timers.
            let _ = unsafe { KillTimer(Some(hwnd), 1) };
            // SAFETY: cleanup timers.
            let _ = unsafe { KillTimer(Some(hwnd), 2) };
            // SAFETY: destroy window.
            let _ = unsafe { DestroyWindow(hwnd) };
            LRESULT(0)
        }
        WM_DESTROY => {
            // SAFETY: quit message loop.
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        // SAFETY: default handling.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn hud_thread(
    shared: &Arc<Mutex<Option<ShareHudState>>>,
    on_action: Box<dyn Fn(ShareHudAction) + Send>,
    ready: &std::sync::mpsc::Sender<Option<isize>>,
) {
    // SAFETY: null asks for our own module handle.
    let Ok(module) = (unsafe { GetModuleHandleW(PCWSTR::null()) }) else {
        let _ = ready.send(None);
        return;
    };
    let class = w!("3RTC.ShareHud");
    let wc = WNDCLASSEXW {
        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
        lpfnWndProc: Some(hud_proc),
        hInstance: module.into(),
        lpszClassName: class,
        ..WNDCLASSEXW::default()
    };
    // SAFETY: register class.
    let _ = unsafe { RegisterClassExW(&raw const wc) };

    WATCH.with_borrow_mut(|w| {
        *w = Some(Watch {
            state: shared.lock().unwrap_or_else(PoisonError::into_inner).clone(),
            on_action,
            pulse: true,
            hover: HoverBtn::None,
            btn_stop: RECT::default(),
            btn_allow: RECT::default(),
            btn_deny: RECT::default(),
            btn_take_back: RECT::default(),
        });
    });

    // Create layered, topmost popup window.
    // WS_EX_NOACTIVATE ensures clicking it NEVER steals focus from full-screen games.
    // SAFETY: creates top-most layered window.
    let created = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            w!("3RTC Share HUD"),
            WS_POPUP,
            0,
            0,
            240,
            34,
            None,
            None,
            Some(module.into()),
            None,
        )
    };
    let Ok(hwnd) = created else {
        tracing::warn!("share_hud: couldn't create HUD window");
        let _ = ready.send(None);
        return;
    };

    // SAFETY: magenta is see-through, non-magenta pixels rendered at 245/255 opacity.
    let _ = unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(KEY), 245, LWA_COLORKEY | LWA_ALPHA) };

    // SAFETY: Exclude from screen captures (Windows 10 2004+).
    // Viewers NEVER see this HUD in the shared picture; ONLY the host sees it physically on their monitor!
    // SAFETY: excludes window from screen capture.
    if unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) }.is_err() {
        tracing::debug!("share_hud: HUD may appear in captured picture");
    }

    place(hwnd);

    // Timers: 1 = pulse indicator (500ms), 2 = keep on top of games (2000ms)
    // SAFETY: window timers.
    let _ = unsafe { SetTimer(Some(hwnd), 1, PULSE_TIMER_MS, None) };
    // SAFETY: timer to re-assert topmost window order.
    let _ = unsafe { SetTimer(Some(hwnd), 2, TOP_TIMER_MS, None) };

    let _ = ready.send(Some(hwnd.0 as isize));

    let mut msg = MSG::default();
    loop {
        // SAFETY: message retrieval.
        let got = unsafe { GetMessageW(&raw mut msg, None, 0, 0) };
        if got.0 <= 0 {
            break;
        }
        if msg.message == WM_UPDATE {
            let new_state = shared.lock().unwrap_or_else(PoisonError::into_inner).clone();
            WATCH.with_borrow_mut(|w| {
                if let Some(w) = w.as_mut() {
                    w.state = new_state;
                    w.hover = HoverBtn::None;
                }
            });
            place(hwnd);
            continue;
        }
        // SAFETY: message dispatching.
        let _ = unsafe { TranslateMessage(&raw const msg) };
        // SAFETY: dispatch window message.
        unsafe { DispatchMessageW(&raw const msg) };
    }
    WATCH.with_borrow_mut(|w| *w = None);
}

/// The screen sharing HUD overlay window (dropping it closes it).
pub struct ShareHud {
    hwnd: isize,
    shared: Arc<Mutex<Option<ShareHudState>>>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for ShareHud {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShareHud").finish_non_exhaustive()
    }
}

impl ShareHud {
    /// Creates the HUD window. `None` if Windows wouldn't create it.
    #[must_use]
    pub fn start(on_action: impl Fn(ShareHudAction) + Send + 'static) -> Option<Self> {
        let shared = Arc::new(Mutex::new(None));
        let thread_shared = Arc::clone(&shared);
        let (ready, started) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("3rtc-share-hud".to_owned())
            .spawn(move || hud_thread(&thread_shared, Box::new(on_action), &ready))
            .ok()?;
        let hwnd = started.recv().ok().flatten()?;
        Some(Self {
            hwnd,
            shared,
            thread: Some(thread),
        })
    }

    /// Updates the HUD state (None: hides the window).
    pub fn update(&self, state: Option<ShareHudState>) {
        {
            let mut s = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
            if *s == state {
                return;
            }
            *s = state;
        }
        // SAFETY: posts to HUD thread's window.
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

impl Drop for ShareHud {
    fn drop(&mut self) {
        // SAFETY: asks the HUD thread's window to close; its thread then ends cleanly.
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
