//! Captures one app's sound on its own, without the rest of 3RTC (no window, no calls, no other
//! audio): `cargo run -p rtc-platform-win --example app_sound_probe -- chrome`. Prints the apps
//! with sound open, then how much sound arrived each second for 5 seconds. If this works and the
//! app crashes, the trouble is in how the app uses it; if this crashes too, it's the capture.

#![allow(clippy::print_stdout, clippy::cast_precision_loss, clippy::drop_non_drop)] // a console probe

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .init();
    let want = std::env::args().nth(1).unwrap_or_else(|| "chrome".to_owned());
    let apps = rtc_platform_win::audio_apps();
    for a in &apps {
        println!(
            "app: {} (pid {}){}",
            a.name,
            a.pid,
            if a.playing { " playing" } else { "" }
        );
    }
    let Some(app) = apps.iter().find(|a| a.name.eq_ignore_ascii_case(&want)) else {
        println!("no app called {want} has sound open");
        return;
    };
    let samples = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (s, p) = (Arc::clone(&samples), Arc::clone(&peak));
    let capture = rtc_platform_win::AppSound::start(app.pid, move |x| {
        s.fetch_add(x.len(), Ordering::Relaxed);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let loudest = (x.iter().fold(0.0f32, |m, v| m.max(v.abs())) * 1000.0) as usize;
        p.fetch_max(loudest, Ordering::Relaxed);
    });
    let capture = match capture {
        Ok(c) => c,
        Err(e) => {
            println!("couldn't start: {e}");
            return;
        }
    };
    for second in 1..=5 {
        std::thread::sleep(Duration::from_secs(1));
        println!(
            "after {second} s: {} samples, loudest {:.3}",
            samples.load(Ordering::Relaxed),
            peak.swap(0, Ordering::Relaxed) as f32 / 1000.0
        );
    }
    drop(capture);
    println!("stopped cleanly");
}
