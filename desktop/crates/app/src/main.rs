//! 3RTC for Windows: the window, wired to the engine.
//!
//! GPUI owns the main thread; the engine (signaling, peer connections) runs on a small tokio
//! runtime beside it. The two talk over channels only.

// Release builds have no console window; dev builds keep it for logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod home;
mod settings;
mod view;

use anyhow::Context as _;
use gpui_kit::{AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};

use crate::settings::Settings;
use crate::view::RoomView;

/// The signaling server the web app uses (`client-ts/src/App.tsx`, `DEFAULT_SIGNAL_URL`);
/// `RTC_SIGNAL_URL` overrides it (a local server while developing).
const DEFAULT_SIGNAL_URL: &str = "wss://orc.3rtc.me";

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn,rtc=info".into()),
        )
        .init();

    // Two worker threads are plenty: the media work happens on libwebrtc's own threads.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("rtc-engine")
        .enable_all()
        .build()
        .context("starting the engine runtime")?;
    let handle = runtime.handle().clone();
    let settings = Settings::load();
    let signaling_url = std::env::var("RTC_SIGNAL_URL").unwrap_or_else(|_| DEFAULT_SIGNAL_URL.to_owned());

    gpui_kit::application()
        .with_assets(rtc_ui::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            if let Err(e) = rtc_ui::init(cx) {
                tracing::error!("couldn't load the fonts: {e:#}");
            }
            let bounds = Bounds::centered(None, size(px(1440.), px(900.)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(1024.), px(640.))),
                ..WindowOptions::default()
            };
            let opened = gpui_kit::open_window(options, cx, move |window, cx| {
                cx.new(|cx| RoomView::new(window, cx, &handle, settings, signaling_url))
            });
            if let Err(e) = opened {
                tracing::error!("couldn't open the window: {e:#}");
                cx.quit();
            }
            cx.on_window_closed(|cx, _| cx.quit()).detach();
            cx.activate(true);
        });
    drop(runtime);
    Ok(())
}
