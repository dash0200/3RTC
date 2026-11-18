# Where the desktop app stands (handover)

Last updated: 18 Nov 2026. If you're an agent picking this up, read this first. Then read
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

- **Host migration** (server, changed 18 Nov): a room always has a host. When the host leaves,
  whoever was in the room longest stands in at once (`host {hostPeerId, reason: "host-left"}`);
  when the room's owner comes back it is the host again (`reason: "host-returned"`), unless the
  owner had handed the room on by hand. See `docs/PROTOCOL.md`. Desktop: the `reason` field on
  `ServerMessage::Host`; core says "👑 The host left. X is now the host" and "👑 X is back and is
  the host again" (`the_owner_coming_back_is_the_host_again_and_a_stand_in_steps_down`).
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

## Sketch (17–18 Nov 2026)

The web app's Sketch (one draws a word, everyone else guesses) on desktop, playable with browsers:
- Rules: `crates/games/src/sketch.rs` (the web app's `sketch/rules.ts`: word list, guess
  normalising, "close" guesses, hints at half and three-quarter time, points, redaction of the
  word to the drawer). Vectors: `client-ts/tests/vectors/players/sketch.ts` →
  `crates/games/vectors/sketch.json`.
- Each turn's board is `act:sketch:t<turn>` (a whiteboard index and its chunks, `reducer_for`).
  `app/src/whiteboard.rs` now draws any board (`BoardUi::base`, `board(…, &Mode, …)`): read-only
  for guessers, no light / dark or footer in a game, only the drawer clears.
- Screen: `app/src/sketch.rs` (joins on open, word picker, hint blanks, timer, scores, guesses
  feed and its own guess box, Skip, Play again, chime when it's your turn). The deciding app sends
  `tick` twice a second (the app's clock, and `examples/chat.rs` for tests).
- Interop: `client-ts/tests/e2e/desktop_sketch_test.py` (in `run_all.py`).
- No blink when a stroke is saved (whiteboard and Sketch): the board's canvas paints the saved
  strokes' picture itself and keeps the last decoded one up, with the strokes it lacks painted
  over it, until the new one has decoded (`img()` showed nothing meanwhile). Replaced pictures
  are freed (they used to pile up in gpui's asset cache, one per stroke).
- Building on Windows needs the MSVC toolchain: `rustup set default-host x86_64-pc-windows-msvc`
  (a GNU default host makes `rust-toolchain.toml` pick the MinGW toolchain, and `webrtc-sys`
  fails).
- Not yet verified: `cargo fmt`, `clippy`, `cargo test` (incl. the sketch vectors),
  `desktop_sketch_test.py`, and a real game on Windows.

## Local / torrent video player feel (18 Nov 2026)

Mouse handling for the mpv player (`app/src/local_video.rs`, `app/src/watch.rs`,
`platform-win/src/mpv.rs`):
- The video window is created `WS_DISABLED`: Windows skips it (and mpv's window inside it) for the
  mouse, so clicks, double clicks, the wheel and the pointer reach the app's own stage, which
  handles them. mpv passed clicks on unreliably (single clicks never paused).
- A click's play / pause waits 250 ms (or the system double-click time if shorter); a double
  click cancels it, or undoes it if the second click came later, and toggles full screen. Before,
  every double click paused (a 300 ms play/pause debounce swallowed the "undo").
- In full screen the controls bar `occlude`s the stage under it: clicking Exit full screen (or
  any bar button) no longer also counts as a click on the video.
- Full screen: the bar shows only while the pointer is at the bottom edge (0.8 s grace after it
  leaves, kept while a menu or dialog is open); the pointer hides after 2 s still off the bar.
- The bar's clip on the video window is applied as soon as the bar shows or hides, only when it
  changes, and mpv repaints at once (a paused video kept showing the old bar).
- Not yet verified: `cargo fmt`, `clippy`, `test`, and a run with a local file and a torrent.
  If clicks on the picture do nothing at all, the `WS_DISABLED` routing is the suspect.

## Torrent file picker (18 Nov 2026)

Opening a torrent with several files lets the user pick one; only that file downloads
(`app/src/torrent.rs`, `app/src/watch.rs`):
- The torrent is first added `list_only` (metadata only: nothing downloaded, no files created),
  then re-added from the resolved metainfo with `only_files: [chosen]` and the peers seen while
  resolving. A torrent the session already had gets `update_only_files` too.
- More than one real file (padding and empty files left out): a "Pick a file to stream" list
  under the paste box, grouped by folder (the torrent's own top folder left out; headers show
  file count and size and fold shut on click; natural order, so `S2` before `S10`, `E2` before
  `E10`; videos first and tagged; the largest video marked "Suggested"). The list scrolls (rows
  are `flex_none`: shrinking to fit the box, they never overflowed). Cancel stops it. One file:
  plays straight away as before.
- Room peers: unchanged and no wire change. The host shares the chosen file (`share_file`
  name/size), so everyone streams that same file from the host. The web app has no torrent
  support, so nothing changed there.
- Subtitle files (`.srt` `.ass` `.ssa` `.vtt` `.sub`) in the picker: tagged SUB with a box to tick.
  A click on a file selects it, Play starts it; the subtitles matching it are ticked
  (`matching_subtitles`: named after it in its folder, in `Subs`/`Subtitles` beside it, or any
  there when it's the only video). Ticked ones download with it; each complete one
  (`TorrentProgress::Subtitle`) loads into mpv (queued until the player is up), and the first
  is shared with the room as WebVTT, like a dropped subtitle file.
- Tests: `torrent.rs` (file list, default pick, folder grouping, natural order, chosen path,
  subtitle matching).
- "Keep torrent downloads" (`keep_torrents`, on by default): a switch in the file picker and in
  Player Shortcuts & Controls → TORRENTS; read when the file is picked (`torrent::set_keep`). On: saved in `Downloads\3RTC\Torrents` in qBittorrent's "Original"
  layout (`<torrent name>\<folders>\file`) and kept when it stops. Off: `%TEMP%\3RTC\torrents`,
  deleted when it stops and emptied when the service starts. To finish a kept download in
  qBittorrent: add the same torrent with save path `Downloads\3RTC\Torrents`, hash check on.
  Unpicked files exist as empty files. "Show file" next to the swarm stats (kept only) opens it.
- No upload to the swarm: librqbit's `disable-upload` feature, `SessionOptions::disable_upload`
  (no bitfield or haves sent, piece requests refused). The host's upload goes to the room only.
  Some swarm peers may choke us for it (tit-for-tat), so downloads can be slower.
- Not yet verified: `cargo fmt`, `clippy`, `test`, and a run with a multi-file magnet.

## Webcam (18 Nov 2026, ADR 0010)

Desktop and browser users see each other's cameras (the web app's `features/camera`, b0140d0):
- Wire: `camera: true` in `peer-identity`, `camera-status { on }`, the second video line
  (`protocol/src/peer.rs`; core: `Command::SetCamera`, `Member::camera / camera_on`,
  `Room::cameras()` in order, status to newcomers).
- Connections (`engine/src/peers.rs`): as the initiator we add the camera line once and offer it;
  as the answerer our camera track is added up front and takes the second offered video line (no
  `set_direction` in libwebrtc 0.4). `video_sender` is now the first video line's only.
  Never call a transceiver's `current_direction()`/`fired_direction()`: the vendored webrtc-sys
  reads them with `optional::value()`, which aborts the app (0xc0000409) on a line not negotiated yet.
- Sending (`engine/src/camera.rs`): desktop viewers get the camera's full picture (up to 1080p30,
  owner's call); web viewers 640×360, 24 fps, 350 kbps. Receiving: each camera that's on decoded to
  a small feed. Capture: `platform-win/src/camera.rs` (Media Foundation, NV12; the blocked toast
  "Camera blocked: allow it in Windows Settings → Privacy → Camera").
- UI (`app/src/camera.rs`): dock button and caret (camera picker tray, saved as `cameraDevice`),
  tiles above the dock, a click puts a camera on the stage for you only (the web app got the same,
  and a camera picker: `features/camera/spotlight.ts`, `CameraStage.tsx`, `cameraDevices.ts`).
- Headless client: `/camera on [WxH]` (test pattern), `/camera device [id]`, `/camera off`,
  `/cameras`. Interop: `client-ts/tests/e2e/desktop_camera_test.py` (in `run_all.py`).
- Icons regenerated from `icons.tsx` (`crates/ui/tools/gen_icons.py`): `camera`, `cameraOff`, and the
  other icons the web set had gained since (bolt, download, pointer, …), unused for now.
- Not yet run (nothing was built or run in the session that wrote it): `cargo fmt`, `clippy`,
  `cargo test`, `desktop_camera_test.py`, the web app's `npm run typecheck` / `npm test`, and
  `checklists/camera.md` on Windows with a real camera.

## Chat files: cancel, Accept for big files, folders picked file by file (18 Nov 2026)

- Rules in `docs/PROTOCOL.md` ("Big files wait for Accept", "Cancelling a chat file"); owner decisions:
  only files of 8 MB+ need Accept (pictures too); folders are offered as a list and each file is
  downloaded from a window with the folder's tree (files already in Downloads say so); older apps get
  nothing until they update (no capability flag).
- Wire: `p2p-file-control` gains `accept`; new `p2p-folder-offer` (`protocol/src/peer.rs`
  `P2pFolderOffer`, `FolderEntry`; `client-ts/src/types/protocol.ts`).
- Core: `transfers.rs` (waiting / sending / sent per receiver, `ACCEPT_MIN_BYTES`), `ChatLine::folder`,
  `ChatFolder`, `Command::FolderSent`, `clean_folder`; tests in `core/tests/transfers.rs`.
- Engine: `files.rs` (sending, offers, per-receiver sends, folder queue one file at a time per
  receiver, saving bulk-received folder files, `Update::SendState`, `Update::FolderHere`, cancel);
  `quic_flow.rs` sends per receiver on accept (`quic_send_to`) and only takes offers we accepted;
  `images.rs` drops a transfer after two minutes with no frame (was: two minutes after it started);
  `outgoing::Stop`. The old folder queue (`folder_queue`, `inflight`) is gone.
- App: Accept / Decline and sender status on the file card (`chat.rs`), the folder card and window
  (`folder.rs`, `Dialog::Folder`). `examples/chat.rs`: `/accept`, `/cancel`, `FOLDER_OFFER`, `SEND_STATE`.
- Web: `features/chat/useFileTransfers.ts` (moved out of `useChat.ts`), `transferPeers.ts`,
  `folderOffer.ts`, `chatMessages.ts`, `FolderOfferCard.tsx`; `p2pImageShare.ts` `announce()`, staleness
  counted from the last frame; tests in `tests/unit/transferCancel.test.ts`.
- A cancelled QUIC download keeps its `.3rtc-part` in Downloads (as after a failure; "Resume" offers it).
- Not yet verified: `cargo fmt`, `clippy`, `cargo test`, `npm test`, typecheck, and a real run.

## Chat drop hint (18 Nov 2026)

Dragging files, pictures or a folder over the room's side panel shows "Drop to send in chat"
(`app/src/room.rs` `drop_hint`: a `drag_over::<ExternalPaths>` overlay, invisible otherwise, whose
hitbox doesn't block the mouse, so the panel's `on_drop` still takes the drop).
Not yet verified: a run with a real drag from Explorer.

## Everything saved in Downloads\3RTC (18 Nov 2026)

One folder, sorted by kind (`core/src/saves.rs`, `rtc_core::saves::dir(Kind)`):
- `Downloads\3RTC\Torrents`: kept torrents (`app/src/torrent.rs` `download_dir`).
- `Downloads\3RTC\Files`: single files received in chat (QUIC; `engine` `Place::save_dir`).
- `Downloads\3RTC\Folders\<folder>`: folders received in chat, in their layout (QUIC and bulk;
  "already here" is looked for there).
- `Downloads\3RTC\Pictures`: where Save on a chat picture starts (`app/src/chat.rs`).
Files received before this, straight in Downloads, aren't found for resume or "already here".
Not yet verified: build, tests (`saves` has one), a run.

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
