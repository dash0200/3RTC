# Where the desktop app stands (handover)

Last updated: 14 Nov 2026. If you're an agent picking this up, read this first. Then read
`AGENTS.md`, `docs/BUILD_SPEC.md` (the rules, the plan and §10's milestone progress) and the ADRs
in `docs/adr/`. Keep this page current: update it at the end of every piece of work.

## How the owner works (follow this)

- **Don't commit or push.** Write changes into the working copy; the owner reviews and commits
  them (the spec's "small commits on `CLAUDE`" is the owner's job here).
- **Text files use Windows line endings (CRLF)** in the owner's checkout.
- **Don't run things on the owner's PC yourself.** Give the exact command, what to look for in the
  output, and roughly how long it takes; the owner runs it and pastes the result.
- Ask before turning on the WASM build of the games for the web app.
- M7 (host hub, LAN rooms) changes the server and the web app: write a design ADR and ask first.
- `unsafe` only in `crates/platform-win`, each block with a `// SAFETY:` note, one unsafe operation
  per block.

## Milestones

| Milestone | State |
|---|---|
| M0 proof | done |
| M1 UI and voice | built; owner's Windows run pending (`checklists/M1.md`) |
| M2 desktop essentials | built; owner's run pending (`checklists/M2.md`) |
| M3 version 1 (own audio pipeline, chat pictures, reactions, soundboard, host controls, updater) | done |
| M4 watch party | done |
| M5 local video (mpv), file sharing, screen share | built; owner's run pending (`checklists/M5.md`) |
| M6 games and extras | in progress (below) |
| M7 host hub, LAN rooms | not started; needs a design ADR and the owner's go-ahead |

## M6 in detail

Done:
- Shared state and the activity shell (ADR 0006).
- Chess, Ludo, Last Card, Tycoon and Whiteboard. The rules are in `crates/games` and checked
  against golden vectors. Each game has a native board and an interop test.

Added at the owner's request before the stream doctor (ADR 0007):
- **Host controls** hide what others mustn't use. That covers player play/pause, the seekbar,
  Skip, Exit, the queue's play/next/clear, and adding a video
  (`app/src/watch.rs` `locked_for_me`, `local_video.rs`, `webview/assets/player.html`).
- **Full screen for a shared screen** (viewers): a button or a double-click; Esc leaves it
  (`app/src/screen.rs`).
- **The shared screen's sound:** all PC sound except 3RTC's, in stereo, sent to desktop viewers
  only.
  - Capture: `platform-win/src/loopback.rs`.
  - The `screen-audio` track and the music-tuned SDP: `rtc/src/voice.rs`, `rtc/src/sdp.rs`,
    `engine/src/peers.rs`.
  - The mixer and speakers are now stereo: `audio/src/{mix,lib,device}.rs`.
  - Viewers set its volume in the quality menu.
- **Remote control**, desktop to desktop:
  - Messages: `screen-control` and `screen-input` (`docs/PROTOCOL.md`, `protocol/src/stream.rs`).
  - Rules: `engine/src/control.rs`.
  - Playback on the sharer's PC: `platform-win/src/control.rs` (`SendInput`, the banner, the
    Ctrl+Alt+Shift+X hotkey, and a low-level mouse hook that only watches).
  - UI: `app/src/control.rs` (Request/Stop, Allow/Say no cards, Give control, Take back, the
    status chip, mouse and keyboard capture on the stage).
- **Graphics card choice:** Auto / Power saving / High performance, under Settings → Graphics.
  It's stored in Windows' per-app GPU preference and applies after a restart
  (`platform-win/src/gpu.rs`, `app/src/dialogs.rs`).

Verified (Linux sandbox):
- `desktop_remote_control_test.py` 24/24, `desktop_screen_sound_test.py` 10/10,
  `desktop_screen_hq_test.py` 13/13.
- Engine, app and protocol unit tests.
- clippy clean.
- `platform-win` type-checked for Windows (the owner's `cargo clippy --workspace` on Windows is
  clean too).

Not yet verified:
- The full `cargo test --workspace` after these changes.
- `desktop_window_test.py` (30/30 before these changes).
- Screenshots of the new screens for `docs/progress/`.
- Anything in `checklists/M6.md` on real Windows: input playback, the banner, take-back, the sound
  and the GPU switch can only be proven there.

Not done:
- Whiteboard: the text tool and "Save as a picture".
- **The stream doctor** (`features/diagnostics/speedTest.ts`, `docs/PROTOCOL.md` "Stream doctor").
  This is next, once the owner has run `checklists/M6.md`.

## Known limits (accepted)

- Remote control can't type into apps running as administrator, or on the secure desktop (UAC
  prompts, the lock screen). Windows forbids it.
- Remote control keys use virtual-key codes with US-layout punctuation from the viewer.
- Web viewers get a desktop share's picture without its sound, and can't ask for control.

## Testing quick reference

- From `desktop/`: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D
  warnings`, `cargo test --workspace`.
- Interop tests: `client-ts/tests/e2e/desktop_*_test.py`. They need
  `cargo build -p rtc-engine --example chat`, and the screen ones need Xvfb (Linux only).
  `run_all.py` lists them all.
- `examples/chat.rs` is a headless client driven by stdin commands. `/control …` covers remote
  control, `/screenopts <h> <fps> [sound 1|0]` sets screen options, and the other commands are
  listed at its top.
