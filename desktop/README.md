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
| `app` (`rtc-app`, binary `3rtc`) | The GPUI window | yes |

Dependencies point down the table only. Everything with rules in it (`protocol`, `core`) is pure
and tested without a network.

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
- Desktop ↔ web check: `cargo build -p rtc-engine --example chat`, then
  `python client-ts/tests/e2e/desktop_interop_test.py` (the web app hosts, the engine joins, they chat).

## Standards

- `unsafe` is forbidden workspace-wide; `unwrap`/`expect`/`panic`/`println` are denied outside tests.
- Every public item is documented. Clippy pedantic (selected) runs as errors in CI.
- `cargo deny` checks licences, sources and advisories.
- Release builds link the C runtime statically (`.cargo/config.toml`): one portable `3rtc.exe`.
