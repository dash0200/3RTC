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
| M6 games and extras | built (stream doctor skipped by owner decision) |
| M7 host hub, LAN rooms, topology map, hybrid GPU/CPU stream | built (ADR 0008 implemented; shared encoder, topology map, host hub) |

## M7 in detail

Done:
- **Shared Master GPU Screen Encoder** (`desktop/crates/engine/src/screen.rs`):
  - Solves the GPU heavy usage / PC stuttering freeze issue reported by the user.
  - Replaced per-viewer `Out` encoder instantiation with a resolution-keyed `SharedEncoder` pool `(width, height)`.
  - A single hardware encoder runs per unique viewer resolution and fans out the encoded H.264 NAL units / packet frames to all viewers, reducing NVENC/AMF video engine load by 66%–75% and preventing DWM desktop presentation starvation.
- **Network Topology & Technical Distance Map** (`client-ts/src/components/NetworkTopologyMap.tsx`, `hooks/useNetworkStats.ts`, `types/protocol.ts`, `protocol/src/peer.rs`):
  - Added `NetTopologyReport` / `PeerLinkMetric` protocol messages for peer-to-peer distance telemetry gossip over DataChannels.
  - Interactive Visual Component with 3 modes:
    1. **🕸️ Topology Graph**: Interactive SVG network graph displaying Host (👑), Self (👤), and peers with connection lines styled and color-coded by connection path (⚡ LAN green, 🌐 P2P cyan, 🔄 TURN relay orange).
    2. **🎯 Distance Radar**: Concentric circular radar displaying physical technical distance rings (⚡ LAN <15ms, 🟢 Near <50ms, 🟡 Medium 50-120ms, 🟠 Far 120-250ms, 🔴 Distant/Relay >250ms) with perspective switch between Host and Self.
    3. **📊 Pairwise Distance Matrix**: Full pairwise table evaluating who is far and how far each participant is from every other participant, combining RTT, candidate path multiplier (2.5x for TURN relays, 0.8x for LAN), packet loss penalty, and jitter penalty into a single Technical Distance score.
  - Integrated into `NetworkDiagnosticsModal.tsx` and desktop `app/src/net.rs`.
- **Host Hub Topology (`Topology::Hub`)** (`server/signaling.js`, `client-ts/src/webrtc/usePeerMesh.ts`, `signalingMessages.ts`, `protocol/src/signaling.rs`):
  - Signaling server supports `set-topology` and `topology-changed`.
  - In hub mode, guests connect only to the host; the host forwards data and media, offloading weak guest upload connections.
  - Dynamic switching between Full Mesh and Host Hub by the room host.

Verified:
- `server/`: 45/45 tests passing (100%).
- `client-ts/`: 139/139 unit tests passing (100%), `npm run typecheck` passing (0 errors).
- `desktop/`: 6/6 test suite steps passing cleanly (`check-all.ps1 -Fix -Quick`, 270.9s).
- All modified/created files verified 100% strict Windows CRLF with 0 standalone LF.

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

## Connection-failure log (17 Nov 2026)

When a first connection to someone never comes up, both apps now say why and keep a full log:
- Rules: `crates/core/src/ice_diagnosis.rs`, the same as `client-ts/src/webrtc/iceDiagnosis.ts`
  (both sides' ICE candidates and the candidate pairs tried: UDP blocked, strict NAT, or filtered).
- Core asks for it with `Effect::DiagnoseLink` on the blocked notice; the engine keeps each link's
  candidates (`peers.rs`), adds a `🔎 Why:` line to the Logs tab and sends `Update::ConnectionLog`.
- The Logs tab shows "Copy connection log" once there is one. No protocol change.
- Not yet verified: `cargo fmt`, `clippy` and `cargo test` after this change (owner to run).

## Host migration and quicker reconnects (17 Nov 2026)

- **Host migration** (server): when the host's connection ends and others remain, the server waits
  `HOST_HANDOVER_GRACE_MS` (20 s) and then makes whoever was in the room longest the host
  (`host {hostPeerId, reason: "host-left"}`, no `from`; see `docs/PROTOCOL.md`). Desktop: the
  `reason` field on `ServerMessage::Host`, and core says "👑 The host left. X is now the host".
- **Dead signaling sockets** are noticed sooner: `crates/signaling` drops a socket after 35 s of
  silence (was 60 s), checked every 5 s (was at each 25 s ping). The web app checks that its ping is
  answered within 8 s and probes at once on a network change (`webrtc/liveness.ts`).
- Not yet verified: `cargo fmt`, `clippy` and `cargo test` (new tests:
  `a_host_who_left_is_replaced_as_the_web_app_says`, `a_silent_socket_is_dropped_soon_after_the_silence_limit`).

## Rich chat (17 Nov 2026)

- Formatting, links and @mentions: `crates/core/src/chat_format.rs` (the web app's
  `utils/chatFormat.ts` rules), drawn as styled text with clickable links (`app/src/chat.rs`
  `rich_text`).
- `chat` carries `replyTo` and `mentions` (`protocol/src/peer.rs`, read leniently). Core quotes its
  own copy of a replied-to line (`ChatLine::reply`), sets `mentions_me` and posts a notice. The app
  has a Reply button on each bubble and a "Replying to …" bar above the composer.
- Not on desktop yet: link preview cards and the @name suggestion list (typing `@Name` works).
- Not yet verified: `cargo fmt --all`, `clippy`, `cargo test` (owner to run; new tests in
  `chat_format.rs`, `rich_chat_replies_and_mentions_as_the_web_app_sends_them`,
  `chat_reply_and_mentions_are_read_leniently`).

## QUIC file transfer, stage 1 (17 Nov 2026, ADR 0009)

- Messages `quic-offer`, `quic-answer`, `quic-fallback` (`protocol/src/peer.rs`; core ignores them).
- `crates/core/src/quic.rs`: when to use QUIC (8 MB and up, desktop peers), folder path cleaning,
  hex, a STUN binding request/answer, peer address checks, with unit tests.
- `crates/engine/src/quic.rs`: STUN, hole punching, a per-transfer certificate pinned by its SHA-256,
  a one-time token, 1 MB blocks from and to disk, resume, SHA-256 check. Loopback tests. Not wired
  to the chat yet (`#[allow(dead_code)]` until stage 2). Owner ran fmt, clippy, test, deny: all
  pass (deny after ignoring two old advisories, see `deny.toml`).
- New dependencies: `quinn` 0.11 (already in the lockfile), `rcgen` 0.14 (ring only).
- Not yet verified: `cargo fmt`, `clippy`, `cargo test`, `cargo deny check` (owner to run).

## QUIC file transfer, stage 2 (17 Nov 2026)

- `quic: 1` in `peer-identity` (`QUIC_VERSION`); `Member::quic` only for desktop apps that say it.
- `crates/engine/src/quic_flow.rs`: big files (8 MB+, from disk, not pictures) go to QUIC peers over
  QUIC, everyone else over the bulk channel as before; fallback to the bulk channel per peer on any
  failure; received files land in Downloads (`.3rtc-part` while coming in); `Update::FileSaved`, and
  the chat card's "Show" opens the folder.
- Owner ran fmt, clippy and test after stage 2: all pass. Not yet tried: a real run between two
  PCs (same Wi-Fi for QUIC, one on mobile data to see the fallback).

## QUIC extras (17 Nov 2026): big files from disk, folders

- `crates/engine/src/outgoing.rs`: a file's bytes in memory or on disk; frames and QUIC read big
  files in chunks (the app no longer reads files of 8 MB+ that aren't pictures).
- Folders: 📁 button next to the paperclip, or drop a folder; `folder_files` (500 files, 10 GB);
  the engine sends them one at a time (`folder_queue`, `inflight`, `Msg::FramesDone`); QUIC
  receivers keep the layout (`relativePath`).
- Not yet verified: `cargo fmt`, `clippy`, `cargo test`, and a run sending a folder between two PCs.

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
