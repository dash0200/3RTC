//! Which graphics card the app draws with (BUILD_SPEC settings: "Graphics card"). Windows picks the
//! card a program uses when the program starts, from the user's choice in Settings → System →
//! Display → Graphics (`HKCU\Software\Microsoft\DirectX\UserGpuPreferences`, one value per
//! program). We read and write that same value for `3rtc.exe`: the app's drawing (DirectX 11),
//! the video player (libmpv, in the same process) and the screen-share encoder all follow it after
//! a restart. "Auto" removes our value, so Windows decides as it would by itself.

use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_GPU_PREFERENCE,
    DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, DXGI_GPU_PREFERENCE_MINIMUM_POWER, IDXGIAdapter1, IDXGIFactory6,
};
use windows_registry::CURRENT_USER;

use crate::{GpuChoice, Gpus};

const KEY: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";

/// The cards Windows would give a program asking for the least power and for the most speed.
#[must_use]
pub fn gpus() -> Gpus {
    let first = |pref: DXGI_GPU_PREFERENCE| -> Option<String> {
        // SAFETY: plain factory creation; no pointers of ours are passed.
        let factory: IDXGIFactory6 = unsafe { CreateDXGIFactory1() }.ok()?;
        for i in 0..8 {
            // SAFETY: `factory` is a live DXGI factory; an index past the end returns an error.
            let Ok(adapter) = (unsafe { factory.EnumAdapterByGpuPreference::<IDXGIAdapter1>(i, pref) })
            else {
                break;
            };
            // SAFETY: `adapter` is a live adapter from the factory above.
            let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
                continue;
            };
            #[allow(clippy::cast_possible_wrap)]
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let end = desc
                .Description
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(desc.Description.len());
            return Some(
                String::from_utf16_lossy(&desc.Description[..end])
                    .trim()
                    .to_owned(),
            );
        }
        None
    };
    Gpus {
        power_saving: first(DXGI_GPU_PREFERENCE_MINIMUM_POWER),
        high_performance: first(DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE),
    }
}

/// The choice saved for `exe` (Auto when there's none).
#[must_use]
pub fn gpu_choice(exe: &str) -> GpuChoice {
    let value = CURRENT_USER
        .open(KEY)
        .and_then(|k| k.get_string(exe))
        .unwrap_or_default();
    if value.contains("GpuPreference=1") {
        GpuChoice::PowerSaving
    } else if value.contains("GpuPreference=2") {
        GpuChoice::HighPerformance
    } else {
        GpuChoice::Auto
    }
}

/// Saves the choice for `exe` (the full path of the program), as Windows' own Graphics settings
/// page does. It applies the next time the program starts.
///
/// # Errors
/// If the user's registry can't be written.
pub fn set_gpu_choice(exe: &str, choice: GpuChoice) -> std::io::Result<()> {
    let io = |e: windows_core::Error| std::io::Error::other(e.to_string());
    let key = CURRENT_USER.create(KEY).map_err(io)?;
    match choice {
        GpuChoice::Auto => {
            if key.get_string(exe).is_ok() {
                key.remove_value(exe).map_err(io)?;
            }
            Ok(())
        }
        GpuChoice::PowerSaving => key.set_string(exe, "GpuPreference=1;").map_err(io),
        GpuChoice::HighPerformance => key.set_string(exe, "GpuPreference=2;").map_err(io),
    }
}
