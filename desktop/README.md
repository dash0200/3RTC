# 3RTC desktop

The native 3RTC app for Windows 10 and 11, in Rust with [GPUI](https://www.gpui.rs).
It joins the same rooms as the web app (3rtc.me) and talks to browsers directly.

Plan and decisions: [3RTC desktop plan](https://claude.ai/artifact/CDKXmq58x1GzJ8w3BpjSgS) · ADRs in [`docs/adr`](docs/adr).

## Crates

| Crate | What it is | I/O? |
| --- | --- | --- |
| `protocol` (`rtc-protocol`) | Wire messages shared with the web app: signaling (app ↔ server) and peer (app ↔ app) | no |
| `core` (`rtc-core`) | Room rules as a state machine: `Input` in, `Effect`s out | no |
| `signaling` (`rtc-signaling`) | WebSocket client actor: reconnects, pings, drops stale sends | yes |
| `rtc` (`rtc-webrtc`) | Google's libwebrtc (LiveKit bindings) in the web app's shapes: channels, SDP, candidates | yes |
| `engine` (`rtc-engine`) | The shell: runs `core` with `signaling` and `rtc` on one queue | yes |
| `ui` (`rtc-ui`) | Design tokens, fonts, the web icon set, shared components (look of 3rtc.me) | no |
| `app` (`rtc-app`, binary `3rtc`) | The GPUI window: home, room, dialogs | yes |

Dependencies point down the table only. Everything with rules in it (`protocol`, `core`) is pure
and tested without a network.

## Run it locally

On Windows, from `desktop/` (or double-click `dev.cmd`):

```powershell
.\dev.cmd            # local signaling server + the app
.\dev.cmd -Web       # ...plus the web app in your browser, on the same local server
.\dev.cmd -Prod      # the app against the real server
.\dev.cmd -Check     # format check, clippy, tests: run before pushing
```

Needs Rust (rustup), Visual Studio Build Tools with "Desktop development with C++", and Node.js 22
for the local server. `./dev.sh` does the same on Linux and macOS.

## Build and test

Rust is pinned in `rust-toolchain.toml`; `rustup` installs it on first use.

```sh
cargo test --workspace            # unit + integration tests
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p rtc-app              # the app (RTC_SIGNAL_URL=ws://localhost:8080 for a local server)
```

- The signaling test starts `server/server.js`; run `npm ci` in `server/` first (it's skipped otherwise).
- On Linux, libwebrtc's prebuilt library needs **clang 21+** (`CC`/`CXX`) and GPUI needs
  `libxkbcommon-dev libwayland-dev libfontconfig1-dev`. Windows needs only Visual Studio's C++ tools.
- Desktop ↔ web checks: `cargo build -p rtc-engine --example chat -p rtc-app`, then
  `python client-ts/tests/e2e/desktop_interop_test.py` (engine ↔ web app: chat, voice both ways, mute)
  and `desktop_window_test.py` (the real window, driven on Xvfb, with a web user; screenshots in
  `docs/progress/`).
- Without a sound card, `RTC_FAKE_MIC=tone` sends a 440 Hz tone as your voice.
- After `client-ts/src/components/icons.tsx` changes: `python crates/ui/tools/gen_icons.py`.

## Standards

- `unsafe` is forbidden workspace-wide; `unwrap`/`expect`/`panic`/`println` are denied outside tests.
- Every public item is documented. Clippy pedantic (selected) runs as errors in CI.
- `cargo deny` checks licences, sources and advisories.
- Release builds link the C runtime statically (`.cargo/config.toml`): one portable `3rtc.exe`.

## Releases

From `desktop\` on Windows: `.\packaging\package.ps1 -Notes "what's new"` builds everything into
`target\dist` (needs Inno Setup 6 for the installer: `winget install JRSoftware.InnoSetup`):

| File | What |
|---|---|
| `3RTC-Setup.exe` | per-user installer: `%LOCALAPPDATA%\Programs\3RTC`, Start menu, uninstaller, no admin |
| `3RTC-portable.zip` | a folder to unzip anywhere; settings stay beside the exe |
| `3rtc-<build>.exe`, `latest.json` | what installed and portable apps download to update themselves |

`-Publish` copies them into `client-ts\public\desktop`, so the next deploy of the web app serves
them at `https://3rtc.me/desktop/`. Apps check `latest.json` 15 s after starting and every 6 hours
and update in place (More → Desktop → Updates). The build number is the UTC time of the build,
`YYMMDD.HHMM`; builds from source (`dev.cmd`, CI) have none and never update.
