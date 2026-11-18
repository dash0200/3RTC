//! 3RTC for Windows: the window, wired to the engine.
//!
//! GPUI owns the main thread; the engine (signaling, peer connections) runs on a small tokio
//! runtime beside it. The two talk over channels only.

// Release builds have no console window; dev builds keep it for logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod camera;
mod chat;
mod chess;
mod control;
mod desktop;
mod dialogs;
mod emoji;
mod extras;
mod folder;
mod fun;
mod home;
mod lastcard;
mod links;
mod local_video;
mod ludo;
mod net;
mod quick_picks;
mod room;
mod screen;
mod settings;
mod single;
mod sketch;
mod sounds;
mod torrent;
mod tycoon;
mod update;
mod view;
mod watch;
mod whiteboard;

use anyhow::Context as _;
use gpui_kit::{AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};

use crate::settings::Settings;
use crate::view::RoomView;

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
    crate::torrent::set_runtime_handle(handle.clone());

    // restarted after an update: let the old version close first, then tidy up after it
    if std::env::args().any(|a| a == "--after-update") {
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
    std::thread::spawn(update::clean_up);

    // one 3RTC per person: a second launch (or a clicked 3rtc:// link) hands over to the first
    let open_room = links::room_in_args(std::env::args().skip(1));
    let message = open_room.map_or_else(|| single::SHOW.to_owned(), |r| format!("link {r}"));
    let launches = match single::claim(&handle, &message) {
        single::Instance::Forwarded => return Ok(()),
        single::Instance::First(rx) => Some(rx),
    };
    // started with Windows: wait quietly in the tray
    let start_hidden = std::env::args().any(|a| a == "--tray");

    let settings = Settings::load();
    if settings.open_links
        && let Err(e) = register_links()
    {
        tracing::warn!("couldn't set up 3rtc:// links: {e}");
    }

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
                show: !start_hidden,
                focus: !start_hidden,
                ..WindowOptions::default()
            };
            let opened = gpui_kit::open_window(options, cx, move |window, cx| {
                let view = cx.new(|cx| RoomView::new(window, cx, &handle, settings, launches, open_room));
                // the close button can keep 3RTC running in the tray
                let weak = view.downgrade();
                window.on_window_should_close(cx, move |window, cx| {
                    weak.update(cx, |v, cx| v.should_close(window, cx))
                        .unwrap_or(true)
                });
                view
            });
            if let Err(e) = opened {
                tracing::error!("couldn't open the window: {e:#}");
                cx.quit();
            }
            cx.on_window_closed(|cx, _| cx.quit()).detach();
            if !start_hidden {
                cx.activate(true);
            }
        });
    drop(runtime);
    Ok(())
}

/// Makes `3rtc://` links open this exe (the user's own registry key; done at every start so a
/// moved portable exe still opens them).
pub(crate) fn register_links() -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let command = format!("\"{}\" \"%1\"", exe.display());
    if rtc_platform_win::links::registered_command().as_deref() == Some(command.as_str()) {
        return Ok(());
    }
    rtc_platform_win::links::register(&command)
}
