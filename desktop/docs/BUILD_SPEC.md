# 3RTC Desktop: build spec

This is the working document for the coding agent that builds the 3RTC desktop app. It says what
to build, in what order, how it must look, how to prove each part works, and when to stop and ask.

- **Why and what was decided:** the plan, <https://claude.ai/artifact/CDKXmq58x1GzJ8w3BpjSgS>.
- **How the web app works:** [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md),
  [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md), [`docs/ADDING_A_FEATURE.md`](../../docs/ADDING_A_FEATURE.md).
- **What the UI must look like:** [`ui-reference/`](ui-reference) (screenshots of the web app) and
  the web sources named in each section below.

**What is copied and what is rebuilt** (owner's rule, 11 Nov): the desktop app matches the web app
**only in UI/UX, the look and the feel**: screens, layout, colours, fonts, wording, interactions.
**Everything else is a total rebuild for desktop**, aimed at better performance and quality than a
browser can give: the audio pipeline, networking, file transfer, video playback, game engines,
storage. Don't port the web app's internals; design each for desktop and record the design in an
ADR. One hard constraint stays: desktop and web users must still share rooms, so the wire
protocol (`docs/PROTOCOL.md`) and anything two apps must agree on (messages, timings that the other
side relies on, who is host, game rules) follow the web app. If this spec and the plan disagree,
stop and ask.

---

## 1. Goal

A native Windows 10/11 app (Rust, GPUI) that does everything 3rtc.me does, in the same rooms as
web users, and looks and behaves like the web app's computer layout, plus the things a browser
can't do (section 9).

**Done means:** a person who knows 3rtc.me can use the desktop app without noticing a difference
in layout, wording or behaviour, except where section 5.9 lists one; a desktop user and web users
can share every feature in one room; and every budget in section 11 holds.

**Not in scope:** macOS and Linux releases (keep the code portable, ship Windows only); the web
app's phone layout; accounts or any server-side storage; changing the signaling server (until the
host hub, M7).

---

## 2. Rules for the agent

1. **One milestone at a time** (section 10), in order. A milestone is finished only when its exit
   checklist passes. Don't start the next one before that.
2. **Read before you write.** For each feature, read the web sources named for it (for how it looks
   and behaves for the user, and what it sends on the wire) and the matching part of
   `docs/PROTOCOL.md`. Copy the experience and the protocol; build the internals fresh for desktop.
3. **Never break the web app.** Any change under `client-ts/` or `server/` must keep
   `npm test` (both folders) and the e2e suites green. Protocol changes follow the rules at the
   top of `docs/PROTOCOL.md`: new types and fields only, never rename or repurpose.
4. **Prove it.** Every behaviour gets a test at the lowest level that can show it (section 12).
   State what you ran and what passed; never report something as working that you didn't run.
5. **Keep CI green.** `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
   `cargo test --workspace`, `cargo deny check` must pass before every push.
6. **Small commits** on the `CLAUDE` branch, conventional messages (`feat(audio): …`,
   `fix(core): …`), each one building and passing tests.
7. **Stop and ask** when: a decision in the plan would have to change; a dependency can't do what
   this spec assumes (section 13 lists the known risks); something needs admin rights, a paid
   service or a signing certificate; a web-app behaviour looks like a bug you'd be copying; or the
   UI can't match the reference.
8. **Write decisions down.** Each significant choice gets a one-page ADR in `docs/adr/`
   (`0002-…md`, next number). Update `desktop/README.md` when commands or layout change, and
   tick milestones in this file.
9. **No secrets, no telemetry.** The desktop app sends nothing anywhere except the signaling
   server and the peers in the room. Don't add analytics.
10. **Security rules carry over** (`docs/ARCHITECTURE.md`, "Who to trust"): identity and host come
    from the server and the connection, never from fields a peer sends; names are cleaned
    (`client-ts/src/utils/names.ts`); text from peers is shown as text; links open only if
    `http(s)`; incoming files are size-capped and never executed; per-peer rate limits match the
    web app's.

---

## 3. Where things stand (after M0)

Workspace: `desktop/` (see `desktop/README.md`). Pinned Rust in `rust-toolchain.toml`.

| Crate | State | Notes |
|---|---|---|
| `rtc-protocol` | Signaling messages complete. Peer messages: identity, voice status, bye, net ping/pong, chat, reaction, room-state*. Everything else arrives as `Unknown`. | Add types milestone by milestone; each with JSON captured from the web app as a test. |
| `rtc-core` | `Room::update(Input) -> Vec<Effect>`: create, join, leave, identities, chat, mute flag, host transfer, seat reclaim. 12 tests. | No peer recovery yet (section 6.2). No ports/traits yet (section 4.2). |
| `rtc-signaling` | WebSocket actor: reconnect with backoff, ping, silence watchdog. Tested against `server/server.js`. | One URL only: no fallback servers, no `find-room` (section 6.1). |
| `rtc-webrtc` | Factory, the two data channels, SDP/candidate conversion. Loopback test. | No audio or video tracks. |
| `rtc-engine` | One queue; runs core + signaling + peers. `examples/chat.rs` terminal client. | Bulk channel is opened but unused. |
| `rtc-app` | Placeholder window (home, people list, chat) on `gpui-kit` 0.9.1. | **Does not match 3rtc.me. Rebuilt in M1.** |

Proven so far: the engine joins a room the web app hosts in Chromium, swaps identities and chats
both ways (`client-ts/tests/e2e/desktop_interop_test.py`); the window was driven on a virtual
Linux display. **Not yet proven: anything on Windows.** The first task of M1 is to get the
`desktop` GitHub workflow green and run `3rtc.exe` on Windows.

---

## 4. Architecture

### 4.1 Crates (target)

```
protocol ← core ← engine ← app
              ↑       ↑       ↑
        (ports)   signaling  ui
                  rtc        platform-win
                  audio      video
        games ────────────────┘   (games has no dependencies on the others)
```

| Crate | Owns | May depend on |
|---|---|---|
| `protocol` | Every wire message, ids, limits | serde only |
| `core` | Room rules, shared-state store, playback/queue/chat state machines, the port traits | `protocol` |
| `games` | Rules, bots and state for the five games; builds for `wasm32-unknown-unknown` too | serde only |
| `signaling`, `rtc`, `audio`, `video`, `platform-win` | One kind of I/O each (adapters) | `protocol`, `core` (for port traits) |
| `engine` | Wiring: one queue, runs `core`, drives adapters | all of the above except `ui`, `app` |
| `ui` | Design tokens, shared components (button, avatar, tabs, popover, dialog, toast…) | `gpui-kit` only |
| `app` | Screens, window, settings, glue to the engine | `engine`, `ui`, `games`, `platform-win` |

Dependencies point one way. `protocol`, `core` and `games` do no I/O, read no clock and no
randomness except through arguments, and never log secrets.

### 4.2 Ports

The M0 engine calls its adapters directly. Before adding voice, introduce the port traits in
`core` and make the engine generic over them, so the whole room can be tested with fakes:

- `SignalingPort` (send a `ClientMessage`; events arrive as inputs)
- `PeerTransport` (open/close a peer, apply signaling, send on main/bulk, add/remove tracks)
- `AudioDevices` (list, select, levels), `Clock`, `SettingsStore`, `Notifier`

Add `desktop/crates/engine/tests/room_sim.rs`: several engines wired together through in-memory
fakes (the Rust twin of the in-memory multi-app rooms in `client-ts/tests/unit/core.test.ts` and
`sharedRejoin.test.ts`), used for every multi-person rule.

### 4.3 Threads

- **Main thread:** GPUI only. Never blocks on I/O; never calls libwebrtc.
- **Engine runtime:** tokio, 2 worker threads. All room state lives in the engine task.
- **libwebrtc threads:** its own; callbacks only push a message onto the engine queue.
- **Audio thread:** real-time priority, no locks, no allocation (section 6.3).
- **Workers:** file hashing, MKV parsing, game bots: `spawn_blocking` or a dedicated thread.

Engine → UI is a stream of updates (`Update` in `rtc-engine`); UI → engine is `Command`. The UI
keeps no copy of room truth beyond the last snapshot. Grow `Snapshot` into per-area snapshots
(room, chat, playback, queue, activity, network) so a chat message doesn't redraw the stage.

### 4.4 Settings

JSON in `%APPDATA%\3RTC\settings.json` (next to the exe in portable mode: a `portable` marker
file beside `3rtc.exe` switches it). One `SettingsStore` behind a trait; versioned with a
`settingsVersion` field and migrated on load. It holds what the web app keeps in `localStorage`:

| Web key | Meaning |
|---|---|
| `webrtc_username` | display name |
| `3rtc_audio_settings` | `AudioSettings` (`client-ts/src/utils/audioSettings.ts`), same fields and defaults |
| `3rtc_sidebar_width` | side panel width |
| `3rtc_activity_chat` | chat-peek setting in games |
| `webrtc_signal_url`, `webrtc_signal_fallbacks` | server settings |
| reactions set, soundboard, rejoin card | see `features/reactions/reactionSet.ts`, `utils/soundboard.ts`, `components/RejoinCard.tsx` |

Plus desktop-only settings (section 9). Seat and host tokens are saved for "Rejoin room" exactly
as the web app does, and sent only to the server.

---

## 5. UI and UX: the same as 3rtc.me

### 5.1 The rule

Every screen is a port of the web app's computer layout (`client-ts/src`, the non-phone branch in
`App.tsx`). Same structure, sizes, colours, fonts, icons, wording, states and motion. Copy every
user-visible string from the web sources exactly, including punctuation.

The references are in [`ui-reference/`](ui-reference), taken at 1440×900 by
`client-ts/tests/e2e/capture_ui_reference.py`. Re-run that script whenever the web UI changes.
For each screen the work is done when a desktop screenshot at the same window size, placed next to
the reference, shows the same layout to within a few pixels and the same colours and text.
Rendering differences in font anti-aliasing are fine.

### 5.2 Tokens (`crates/ui/src/tokens.rs`)

Take every value from `client-ts/src/index.css` (`:root`) and `redesign.css`; don't use
`gpui-kit`'s default theme colours. The core set:

| Token | Value | Use |
|---|---|---|
| `bg` | `#0a0a0d` | app ground |
| `surface` | `#141419` | cards, inputs, sheets |
| `raised` | `#1c1c23` | buttons, selected tab |
| `panel` | `#0e0e12` | deep surface (dock, side panel) |
| `line` / `line_strong` | `#2a2a33` / `#3a3a45` | borders / input borders |
| `text` / `text_2` / `text_3` | `#f4f4f6` / `#a9a9b5` / `#85858f` | primary / secondary / hints |
| `accent` / `accent_press` | `#e5143d` / `#c40f33` | the one primary action |
| `live` / `live_text` | `#36d399` / `#7be7bf` | speaking, in sync, connected |
| `warn` | `#f5b544` | weak connection, permissions |
| `danger_text` / `danger_bg` / `danger_line` | `#ff8a9c` / `#3a1520` / `#5a1e2a` | mic off, Leave, errors |
| `focus` | `#6aa8ff` | focus ring, links |

- **Radius:** chip 8, input 12, video 16, sheet 24, pill 9999.
- **Spacing:** 4, 8, 12, 16, 24, 32, 48.
- **Type:** display 68/700/1.05, h1 34/700/1.15, h2 24/700/1.25, body-lg 18/400/1.45,
  body 16/400/1.5, label 14/600/1.4, caption 12/600/1.4 (12 is the floor).
- **Fonts, bundled in the exe** (all OFL): Figtree Variable (text), Bricolage Grotesque Variable
  (display headings), JetBrains Mono 500/700 (room codes, build number). Load them with GPUI's
  `add_fonts`; never fall back to a system font silently.
- **Sizes:** header 64 high, dock 80 high, side panel 380 wide (resizable, saved), dock button
  46×46 radius 13, avatar 36.
- **Motion:** easing `cubic-bezier(0.2, 0, 0, 1)`; copy durations from the CSS rule for each
  element. Honour Windows' "Show animations" setting (off = no motion).
- **Shadow:** elevated `0 16px 40px rgba(0,0,0,0.7)`.

### 5.3 Icons

Port `client-ts/src/components/icons.tsx` and the lucide icons the web app imports into one icon
module (SVG paths drawn by GPUI). Same icon, same size, same stroke width. The logo is
`components/Logo.tsx`. Emoji use Segoe UI Emoji.

### 5.4 Screens

| # | Screen | Reference | Web source |
|---|---|---|---|
| 1 | Home: name, Create a room, 5-digit join boxes, hero preview, header links, footer, "Ready" status | `01-home`, `01c-home-named` | `components/DesktopHome.tsx`, `hooks/useRoomCodeInput.ts` |
| 2 | Server settings dialog | `01b-home-server-settings` | `components/ServerSettingsModal.tsx` |
| 3 | Invite link ("You're invited to watch together", mic toggle, Join room) | `03-invite-link-screen` | `components/InviteScreen.tsx`, `PreJoinModal.tsx` |
| 4 | Rejoin card | – | `components/RejoinCard.tsx` |
| 5 | Room header: logo, room code chip (copy), now playing, connection pill, Invite/people count, Hide Panel | `02-…`, `04-…` | `components/Header.tsx` |
| 6 | Stage, nothing playing: "What are we watching?", paste box, drop zone, Quick picks | `02-room-alone-invite-tab` | `components/Stage.tsx`, `QuickPicksBrowser.tsx`, `features/media/PasteLinkForm.tsx` |
| 7 | Dock: you, people strip (click for volume), Mic + device caret, Deafen, Reactions, Soundboard, Add a video, Share screen, Games, More, Leave | `06-dock-*` | `components/room/DesktopDock.tsx` |
| 8 | Side panel tabs: Invite, Chat, Queue, People, Logs (with counts) | `05-panel-*` | `components/LiveChat.tsx`, `room/InvitePanel.tsx`, `PeerVoiceRoster.tsx` |
| 9 | Add a video sheet | `07-add-video-sheet` | `App.tsx` `renderAddVideoSheet`, `QuickPicksModal.tsx` |
| 10 | Audio & Voice Settings | `11-more-0-voice-settings` | `components/AudioSettingsModal.tsx`, `AudioDevicePicker.tsx` |
| 11 | Connection details and Stream doctor | `09-connection-details` | `components/NetworkDiagnosticsModal.tsx`, `features/diagnostics/` |
| 12 | QR code | `11-more-2-invite-with-qr-code` | `components/QrCodeModal.tsx` |
| 13 | Leave dialog | `13-leave-dialog` | `components/LeaveRoomDialog.tsx` |
| 14 | Players: YouTube, link sources, local video (controls, subtitles, sync pill, people overlay, scrubber heatmap, ambient glow) | – (capture when building M4/M5) | `YouTubeSyncPlayer.tsx`, `features/media/LinkPlayer.tsx`, `LocalVideoSyncPlayer.tsx`, `components/room/*` |
| 15 | Screen share stage and pointer overlay | – | `components/room/ScreenShareStage.tsx`, `ScreenPointerOverlay.tsx` |
| 16 | Games: lobby, play, bubble, chat peek, zoom | `12-game-*` | `features/activities/` |
| 17 | Image lightbox, reactions editor, file-format notice, network-blocked banner, toasts, push-to-talk HUD | – | `ImageLightboxModal.tsx`, `features/reactions/ReactionsEditor.tsx`, `features/files/FileFormatNotice.tsx`, `NetworkBlockedBanner.tsx` |

Add any screen missing a reference to `capture_ui_reference.py` before building it.

### 5.5 Components (`crates/ui`)

Build these once, from the web CSS, and use them everywhere: Button (primary, secondary, ghost,
danger; sizes), IconButton / dock button (normal, active, off), Input, CodeBoxes, Toggle, Select,
Tabs with count badge, Avatar (initial, colour from name as `utils` does it, speaking ring, muted
badge), Chip/Pill, Popover and Menu (anchored, closes on outside click and Esc), Dialog/Sheet
(scrim, focus trap, Esc), Toast, Tooltip, Slider, ScrollArea, VirtualList (chat, logs), Banner.

`gpui-kit` components may be used underneath only if they can be styled to match exactly;
otherwise write the component on raw GPUI.

### 5.6 Behaviour that must match

- **Keyboard:** `M` mutes in open-mic mode, `Q` shows the QR code, the push-to-talk key
  (`hooks/useKeyboardShortcuts.ts`); number keys send reactions as the dock shows; player keys
  Space, ←/→, `M`, `F`, `C`, `H`, `[`, `]` (`LocalVideoSyncPlayer.tsx`); lightbox `+`, `-`, `0`;
  Enter sends chat, Shift+Enter makes a new line; Esc closes the top-most popover or dialog (the
  order `core/backStack.ts` gives). Shortcuts never fire while typing in a field.
- **Focus:** visible focus ring (`focus` colour) on every control; Tab order follows the layout.
- **Zoom in games:** wheel zooms at the cursor, drag pans, hand cursor (`usePinchZoom.ts`).
- **Drag and drop:** a video file anywhere on the stage; images into chat.
- **Clipboard:** copy room code and invite link; paste a link to play; paste an image into chat.
- **Empty, loading and error states:** copy each one ("Waiting for friends", "Connecting…",
  "You're the first one here", inline join errors).
- **Toasts and Logs:** same texts, same cap (logs 200).
- **Window title and taskbar:** the web tab title logic (`utils/tabTitle.ts`,
  `components/TabTitle.tsx`) drives the window title; the favicon dot becomes a taskbar overlay
  icon, and blinking becomes a taskbar flash.

### 5.7 Window

Minimum size 1024×640 (the computer layout's floor; check `App.css` breakpoints and raise it if
the web layout switches to phone above that). Remembers size, position and maximised state.
Standard Windows title bar in M1; a custom title bar matching the header is optional later.
Per-monitor DPI aware; all sizes above are logical pixels.

### 5.8 Accessibility

Names and roles for controls (the web app's `aria-label`s are the names), keyboard reachability
for everything, contrast as the tokens give it. Screen-reader support is as far as GPUI allows on
Windows; note what isn't possible in an ADR.

### 5.9 Allowed differences

1. **Web view on top.** The YouTube, Vimeo and Twitch player is a WebView2 that draws over GPUI.
   While one plays, nothing may open over it: floating reactions run in a strip beside or below
   the player, and popovers, menus and toasts are placed outside its rectangle. Dialogs hide the
   web view (show a still frame) while open. Local video (mpv) has none of this.
2. **No browser chrome features:** no PWA install prompts, no "add to home screen" lines, no
   service worker text. The home footer's SEO links (YouTube watch party, Movie night…) are left
   out; "How it works" and "About" open 3rtc.me in the browser.
3. **Home tagline:** "Free · No sign-up · Nothing to install" drops "Nothing to install".
4. **Desktop-only controls** (section 9) are added inside the existing Voice settings dialog and
   More menu, in the same style.
5. **No phone layout.**

Anything else that can't match: stop and ask.

---

## 6. Features

For each: port the named web sources, support the listed messages exactly as
`docs/PROTOCOL.md` defines them, and meet the acceptance line. "Interop" means an automated test
with the desktop engine and the web app in one room (section 12).

### 6.1 Rooms and signaling

Sources: `hooks/useSignalingConnection.ts`, `webrtc/signalingMessages.ts`, `webrtc/findRoom*`,
`App.tsx` (server pool), `server/signaling.js`.

- Server pool: the primary URL, then fallbacks, in order; stay on the server that has the room.
- `find-room` across servers before saying a code doesn't exist.
- Seat and host tokens; resume as host; rejoin as guest; "Rejoin room" after restart.
- All error codes with the web app's texts; rate-limit handling.
- Room size 4 (`MAX_ROOM_SIZE`), enforced by the server.
- Host transfer (`transfer-host`, `host`, `host-token`), host generation.

Accept: every case in `server/tests` that a client takes part in has a desktop twin in
`room_sim.rs` or against the real server; interop for create, join, full room, wrong code, host
transfer both directions, server restart.

### 6.2 Peer connections and recovery

Sources: `webrtc/usePeerMesh.ts`, `peerRecovery.ts`, `peerEntry.ts`, `config.ts`
(`RECOVERY` timings), `tests/unit/peerRecovery.test.ts`.

Port the recovery state machine into `core` as pure logic driven by timer inputs: disconnect
grace 3 s, ICE restart every 8 s up to 4 times, rebuild once, the initiator keeps rebuilding while
the peer is in the room, the non-initiator drops after 60 s only if never connected or signaling
is down, first connection deadline 25 s, `fresh` offers, the reconnect notice shown once.
ICE servers: the two Google STUN servers, overridable in server settings (TURN with credentials).

Accept: the Rust tests mirror every case in `peerRecovery.test.ts`; interop test where UDP is
blocked for 20 s and both sides recover without rejoining.

### 6.3 Voice

Sources: `hooks/useVoiceChat.ts`, `webrtc/remoteAudio.ts`, `webrtc/sdp.ts`,
`utils/micPipeline.ts`, `utils/audioSettings.ts`, `utils/audioDevices.ts`,
`features/audio/` (ducking, spatial).

- One Opus track per peer, SDP munged as the web app does: `useinbandfec=1;
  maxaveragebitrate=128000`, sender `maxBitrate` 128 kbps, priority high.
- Capture → echo cancellation, noise suppression, auto gain (each a setting, same defaults) →
  optional RNNoise ("Voice Isolation", on by default) → encoder. 48 kHz, 10 ms frames.
- Open mic and push-to-talk (key, release delay 200 ms, chime), mute, deafen.
- Per-person volume (dock avatar popover), speaking detection and rings, muted badges,
  `peer-voice-status`.
- Device lists, live switching, "Test mic" meter, "Play test sound", device-lost fallback.
- Ducking of video sound while someone speaks, as `useAudioDucking.ts`.
- Voice keeps running at full quality with the window hidden or minimised.

**Spike first (stop and report the result):** confirm how the `libwebrtc` crate exposes audio on
Windows: whether its audio device module can capture and play directly with echo cancellation, or
whether we capture with `cpal`/WASAPI, run WebRTC's audio processing module ourselves and push
frames into a native audio source. Pick the path that gives one clock for capture, playback and
echo cancellation; write ADR 0002.

Accept: interop voice test (a tone sent from desktop is heard in Chromium and the reverse,
checked by analysing received audio); mute, deafen and PTT states visible on the other app;
mouth-to-ear delay measured by loopback and recorded; a 30-minute soak with no drops.

### 6.4 Chat

Sources: `features/chat/useChat.ts`, `components/LiveChat.tsx`, `utils/p2pImageShare.ts`,
`ImageLightboxModal.tsx`. Messages: `chat`, `p2p-image-start` + binary `IMG1` frames (bulk).

Text with links, emoji picker with search, quick-reaction row and its editor, image attach /
paste / drop with caption and progress, lightbox, timestamps, HOST badge, grouping, unread count
on the tab, auto-scroll rules, message and size limits, per-peer rate limits.

Accept: interop for text both ways, an image both ways (bytes identical), unread counts.

### 6.5 Reactions and soundboard

Sources: `features/reactions/`, `components/FloatingReactions.tsx`,
`features/soundboard/`, `utils/soundboard.ts`, `SoundboardTray.tsx`.
Messages: `reaction`, `soundboard-sfx`. Own set of up to 10 emoji, lanes and combos, rate limit
(~10/s per person), the same sounds (port the synthesis or bundle rendered audio; same names).

### 6.6 People, invite, host controls

Sources: `PeerVoiceRoster.tsx`, `room/InvitePanel.tsx`, `QrCodeModal.tsx`,
`features/playback/useHostControls.ts`. Messages: `room-settings`, `playbackLock` in identity.
Invite link format `https://3rtc.me/?room=<code>` (the link opens the web app; with the desktop
app installed the page may offer "Open in app", section 9). WhatsApp share opens the browser.
"Only I control playback" / "The host controls playback"; make someone host.

### 6.7 Playback, queue, quick picks

Sources: `features/playback/` (`usePlayback`, `useMediaSync`, `useDriftSync`, `drift.ts`),
`features/queue/useQueue.ts`, `features/media/` (`sources.ts`, `resolveLink.ts`, adapters),
`utils/quickPicks.ts`, `QuickPicksBrowser.tsx`, `TrendingRegionSelect.tsx`,
`YouTubeSyncPlayer.tsx`, `LinkPlayer.tsx`, `room/SyncPill.tsx`.
Messages: `yt-action`, `media-action`, `yt-request-sync`, `yt-sync-state`, `media-sync-state`,
`media-heartbeat`, `queue-action`.

- Playback state machine in `core` (pure): load, play, pause, seek, close, late-join sync, drift
  correction (> 1.5 s off the reference app), host lock, vote to skip.
- **YouTube, Vimeo, Twitch:** a WebView2 created when such a video starts and destroyed when it
  ends. It loads a small local page that hosts the provider's own embedded player and talks to
  the app over the web view's message channel (play, pause, seek, time, state). Never extract or
  play their streams natively. Section 5.9 item 1 applies.
- **Direct file and HLS links:** played by mpv (section 6.8), not a web view.
- Quick picks from `GET /api/quick-picks?region=` on the signaling server; thumbnails cached on
  disk with a size cap.

Accept: interop: desktop loads a YouTube video and Chromium follows; play/pause/seek each way
within the web app's tolerance; a late joiner lands in sync; queue add/reorder/next/vote.
A process check proves no WebView2 process exists when no such video is playing.

### 6.8 Local video

Sources: `LocalVideoSyncPlayer.tsx`, `features/playback/useStreamTransfer.ts`,
`utils/p2pStreamer.ts`, `webrtc/streamTree.ts`, `features/files/`, `utils/subtitleParser.ts`,
`features/subtitles/`. Messages: `local-video-action`, `local-video-sync-state`, all `p2p-*`,
`file-format*`, `file-subtitle-*`, binary block frames.

- Player: libmpv embedded in the stage (render API into a GPUI surface), hardware decoding, the
  web player's controls, shortcuts, subtitle and audio-track menus.
- Sharing: the block protocol exactly (range mode, swarm, SHA-256 per block, relay tree for
  older viewers), so web viewers can watch a desktop host's file and the reverse. mpv reads
  through a custom stream that asks the block store.
- Format card: container and codec detection (`formats.ts`, `mkv.ts`, `mp4.ts`), verdict
  reports, MKV subtitle extraction on a worker.
- For web viewers when the file isn't browser-playable: remux on the fly (MKV → fragmented MP4)
  as the plan describes. **Later (M5b):** the GPU live-stream mode as a WebRTC video track.

Accept: unit tests ported from `tests/unit` (stream swarm, relay tree, MKV/MP4 headers);
interop: desktop shares an MP4, Chromium plays it in sync, and the reverse; hash mismatch
handling; a 2 GB file without loading it into memory.

### 6.9 Screen share

Sources: `features/screenshare/useScreenShare.ts`, `room/ScreenShareStage.tsx`,
`ScreenPointerOverlay.tsx`. Capture a window or a screen (Windows Graphics Capture), hardware
encode, send as a video track with optional system or per-app audio; receive and show the web
app's shares; pointer overlay messages as the web app sends them.

### 6.10 Shared state and activities

Sources: `core/sharedState.ts`, `features/activities/` (`useActivities`, `activityState`,
`activityHost`, `registry.ts`, `ActivityStage.tsx`, `ActivityBubble.tsx`, `ChatPeek.tsx`),
`tests/unit/core.test.ts`, `sharedRedact.test.ts`, `sharedRejoin.test.ts`.

Port the shared-state store into `core`: authority (host, else smallest peer id), versions,
late joiners, `room-state-gone`, redaction per peer, chunked keys. Then the activity shell:
Games menu, lobby, seats, "Update app" for unknown activities, bubble (minimised game), end for
all with confirm.

Accept: the Rust tests mirror the three unit files; `room_sim` cases for host leaving and
returning mid-game.

### 6.11 Games

Sources per game: `features/activities/<game>/` (`rules.ts`, `index.tsx`, `board.ts`,
`BoardView.tsx`, `engine.ts`, `model.ts`, css) and `tests/unit/<game>.test.ts`.

| Game | Notes |
|---|---|
| Ludo | seats, bots, rules options, dice, auto-move |
| Chess | full rules, the built-in engine (off the UI thread), swap colours, drag or click to move |
| Last Card | hands hidden per peer (redaction), seat reclaim by client id |
| Tycoon | global board, `$`, building, trades, "How to play", seat reclaim |
| Whiteboard | strokes as chunked state, `wb-live`, `wb-cursor`, zoom-aware drawing |

Order of work for each game:

1. Export **golden vectors** from the web rules: a script in `client-ts/tests/` that plays
   scripted and random games through the TypeScript reducer and writes
   `desktop/crates/games/vectors/<game>.json` (initial state, action, resulting state, for
   thousands of steps, including rejected actions).
2. Port the rules to `crates/games`; the vectors must pass byte-for-byte on the JSON state.
3. Build the native board UI to match the reference screenshots.
4. Interop: a web player and a desktop player finish a game together.

**After all five pass:** build `games` to WASM and switch the web app to it behind a flag, keeping
the TypeScript rules until the e2e suites pass on the WASM build. This step changes the shipped
web app: stop and ask before turning the flag on by default.

### 6.12 Diagnostics

Sources: `hooks/useNetworkStats.ts`, `utils/networkMonitor.ts`,
`components/NetworkDiagnosticsModal.tsx`, `features/diagnostics/` (stream doctor, speed test,
verdict). Messages: `net-ping`/`net-pong`, all `diag-*`, `DGN1` frames. The connection pill
("Waiting for friends", "Connected", weak) and its rules.

### 6.13 Notices and logs

`features/notices/useNotices.ts`: toasts, the Logs tab, the same texts.

---

## 7. Protocol additions

Allowed without asking (older apps ignore them): `client: "desktop"` in `peer-identity`
(done); the desktop build number in `build`.

Each further addition (hub topology field, QUIC transfer offer, "Open in app") needs: a
paragraph in `docs/PROTOCOL.md`, the change in `client-ts/src/types/protocol.ts` and
`rtc-protocol` in the same commit, and an interop test. Ask first if it changes what a web user
sees.

---

## 8. Performance

Budgets (measured on Windows in CI where possible; record numbers in `docs/perf.md` each
milestone): memory in a 4-person voice call under 150 MB; CPU with the window hidden in a call
under 2% of one core; zero redraws when nothing changes; start to home screen under 1 s; no
WebView2 process unless a YouTube/Vimeo/Twitch video is playing; app-side voice delay about
60 ms.

How: redraw only on state change; virtual lists; no polling timers in the UI; audio thread
without locks or allocation; shared byte buffers (`bytes::Bytes`) for file blocks; release
profile as in `Cargo.toml` (LTO, one codegen unit); `mimalloc` once measured to help.

---

## 9. Desktop-only features

| # | Feature | Milestone | Notes |
|---|---|---|---|
| 1 | Push-to-talk anywhere (keyboard or mouse button) | M2 | Held keys read with `GetAsyncKeyState` ~60×/s from a small thread: sees the release (which `RegisterHotKey` can't) and mouse buttons, swallows nothing, no keyboard hook (anti-cheat and antivirus flag hooks); tells the user when an app running as admin is in front (Windows hides its keys from every method) |
| 2 | Global mute / deafen hotkeys | M2 | Same key reading; `RegisterHotKey` (which takes the combination from the app in front) is the option if double triggers in games bother anyone |
| 3 | Voice that never throttles | M1 | soak test with the window hidden |
| 4 | Tray, start with Windows, back into the last room | M2 | per-user Run key; asks first |
| 5 | Native notifications (mention, your turn, someone joined) | M2 | respects Focus Assist |
| 6 | RNNoise plus a noise gate | M1 | |
| 7 | In-game overlay: who's talking, click-through | M4 | borderless-window games only; no injection |
| 8 | Share one app's sound | M4 | WASAPI process loopback |
| 9 | Exact audio devices, live switch | M1 | |
| 10 | Hardware-encoded screen share | M5 | |
| 11 | Big files and folders, resumable; QUIC between desktop apps | M5 | falls back to the data channel with web users |
| 12 | Local video in any format | M5 | mpv |
| 13 | `3rtc://` links and "Open in app" | M2 | always asks, never opens by itself |
| 14 | Low-power mode | M3 | More → Desktop: calm reactions, no Voice Isolation, connections checked half as often |

Settings for these live in Audio & Voice Settings (new sections in the same style) and a
"Desktop" entry in the More menu.

---

## 10. Milestones

Tick the box when the exit checklist passes. Each exit includes: CI green on Windows, tests
listed, references matched for the screens touched, `docs/perf.md` updated, and a short
checklist the owner runs on a real PC (write it to `docs/checklists/M<n>.md`).

- [x] **M0: proof.** Protocol, core, signaling, peers, engine, placeholder window, CI.
- [ ] **M1: the real UI, and voice.** *Built 11 Nov; waiting for the owner's Windows run
  (`docs/checklists/M1.md`).* Done: `crates/ui` (tokens, bundled fonts, the web icon set
  generated from `icons.tsx`, components); home, room (header, stage, dock, side panel with
  Invite / Chat / Queue / People / Logs), devices and More popovers, Leave, QR, Voice settings
  and Server settings dialogs; recovery (`core::recovery`, the web tests mirrored), server pool
  and `find-room`; voice through libwebrtc's platform audio device (ADR 0002) with mute, deafen,
  device choice and speaking rings. Tests: 61 Rust, `desktop_interop_test.py` (18 checks, voice
  both ways) and `desktop_window_test.py` (9 checks, the real window driven on Xvfb).
  **Open:** per-person volume, RNNoise and the mic-test meter need the custom audio path (ADR
  0002, owner's call); the invite-link screen comes with `3rtc://` links (M2); quick picks with
  the watch party (M4).
  1. Windows CI green; `3rtc.exe` runs on Windows 10 and 11; measure exe size.
  2. `crates/ui`: tokens, fonts, icons, components (5.2–5.5).
  3. Screens 1–8, 12, 13 with everything not yet built shown as the web app's own disabled or
     empty state. Chat text complete (6.4 text part), People, Invite, Logs.
  4. Ports and `room_sim` (4.2); recovery (6.2); server pool and `find-room` (6.1).
  5. Voice (6.3) and Audio & Voice Settings (screen 10), desktop features 3, 6, 9.
  - Exit: a desktop user and two web users talk and chat for 30 minutes, window minimised part
    of the time, one of them dropping Wi-Fi for 20 s; side-by-side screenshots for each screen.
- [ ] **M2: desktop essentials.** Push-to-talk and hotkeys, tray, notifications, start with
  Windows, `3rtc://`, rejoin card. `crates/platform-win` (the only crate allowed `unsafe`, each
  block with a `// SAFETY:` note).
  *Built 12 Nov; waiting for the owner's Windows run (`docs/checklists/M2.md`).* Done:
  `crates/platform-win` (clippy `undocumented_unsafe_blocks` and `multiple_unsafe_ops_per_block`;
  stand-ins elsewhere; a quick CI job checks it for the Windows target from Linux). Keys are
  read with `GetAsyncKeyState` from a small thread (~60 times a second): push-to-talk with key,
  combination or mouse button, release delay and chirps (the web app's); global mute and deafen
  hotkeys; nothing hooked or swallowed; a warning when the app in front runs as administrator.
  Tray icon (own thread, `Shell_NotifyIcon`) with Open / Mute / Deafen / Leave / Quit; closing
  keeps running in the tray (said once); notifications are the tray's balloons, which Windows
  shows as its own notifications and holds back in Do not disturb (someone joined, an @mention,
  only while the window isn't in front). Start with Windows (`--tray`, HKCU `Run`, off until
  turned on), `3rtc://join/12345` links (HKCU `Software\Classes`) and one app per person (a named
  pipe hands a second launch's link to the running app, which asks before joining); the rejoin
  card (30 min, takes a hosted room back with its host token: `Command::Resume`). Settings: Voice
  settings gained the push-to-talk panel and Global Hotkeys; More → Desktop has the rest. Tests:
  78 Rust, `desktop_window_test.py` 13 checks (push-to-talk by holding the mic button, the
  link hand-off, the rejoin card).
- [ ] **M3: version 1.** **Our own audio pipeline (ADR 0003): per-person volume and mute-for-me,
  RNNoise (Voice Isolation), the mic-test meter and test sound, live device changes, lower delay;
  libwebrtc's device path kept behind a setting until the checklist passes.**
  *Built 12 Nov; waiting for the owner's Windows run (`docs/checklists/M3.md`).*
  `crates/audio`: the sound card through `cpal` (WASAPI shared mode, MMCSS priority), lock-free
  queues (`rtrb`), our own resampler, APM (echo, gain, high-pass, noise) then RNNoise and a noise
  gate on the way out; per-person queues, volume and a limiter on the way in; devices reopened
  when unplugged or when Windows changes the default. Each remote track is read with
  `NativeAudioStream` into the mixer. App: our path is the default, "Classic audio" (libwebrtc's
  devices) is a switch in Voice settings; Voice settings gained the mic meter, "Play test sound"
  and Voice Isolation (on by default); clicking a person in the dock (or 🔊 on their People card)
  opens their volume (0–200%, presets, mute for me, reset), saved by their install id so it
  sticks across rooms. Tests: `desktop_interop_test.py` with `RTC_MIC=pipeline` (20 checks: the
  browser's voice reaches our mixer), `desktop_rejoin_test.py` (someone leaves and rejoins with the
  same peer id: fixed in the vendored `AdmProxy::Init`, see `3RTC:`).
  Then the rest of version 1. **Chat:** pictures both ways on the bulk channel (`IMG1` frames,
  `rtc_protocol::image`), attached with the picture button, pasted (Ctrl+V) or dropped on the
  window, with progress, a lightbox and Save; the emoji picker; your quick reactions over the
  box; the web app's pop and chime. **Reactions:** the dock popover, keys 1–9 and 0, floating
  emoji with lanes, combos (×3…) and the sender's name, the web app's limits (`rtc_core::fun`),
  the "Your quick reactions" editor. **Soundboard:** the web app's seven clips (decoded to 48 kHz
  in `crates/app/assets/sounds`), volume and mute, "… played …" banner, played through our mixer
  (Windows' player on the classic path). **Host controls:** "Only I control playback" in More,
  `room-settings` and `playbackLock` in identity, the "Host controls" pill, lifted 4 s after the
  host leaves. **Connection details** (More): round trip, path, loss, jitter, data rates per
  person, the latency graph, the Markdown report. **Low-power mode** (More → Desktop).
  **Settings** are versioned (`settingsVersion` 2) and migrated on load. **Releases:**
  `packaging/package.ps1` builds the exe, the portable zip, the per-user installer
  (`packaging/3rtc.iss`, Inno Setup, no admin) and `latest.json`; the app checks
  `https://3rtc.me/desktop/latest.json`, downloads a newer exe, checks its SHA-256 and swaps it in
  place (`crates/app/src/update.rs`). Tests: 113 Rust, `desktop_fun_test.py` (11: reactions,
  clips and pictures both ways, byte for byte), `desktop_window_test.py` (18).
  Exit: the plan's v1 budgets, measured on Windows (checklist).
- [ ] **M4: watch party.** Playback core, YouTube/Vimeo/Twitch web view, link sources, queue,
  quick picks, sync pill, people overlay; overlay and per-app sound (features 7, 8).
- [ ] **M5: local video and sharing.** mpv player, block protocol and swarm, format card,
  subtitles, screen share, big files; then (M5b) GPU live stream and QUIC transfers.
- [ ] **M6: games.** Shared state, activity shell, the five games (6.11), stream doctor.
- [ ] **M7: host hub and LAN rooms.** `Topology` trait with `Mesh` and `Hub`; the plan's hub
  design. Needs server and web changes: write a design ADR and ask before starting.

---

## 11. Definition of done (every change)

- Behaviour matches the web source; strings copied exactly.
- Tests added at the right level; all of section 2 rule 5 passes locally.
- No `unwrap`/`expect`/`panic`/`println` outside tests; no `unsafe` outside `platform-win`;
  public items documented; errors are `thiserror` types in libraries.
- No new dependency without checking licence (`cargo deny`), maintenance and size; prefer what
  the workspace already has.
- UI: tokens only (no literal colours or sizes in screens), reference matched, keyboard works.
- README / ADR / this file updated if anything they describe changed.

---

## 12. Testing

| Level | Tool | For |
|---|---|---|
| Unit and property | `cargo test`, `proptest` | protocol parsing (never panics on any input), state machines, rules |
| Golden vectors | JSON from the web app's own code | games, shared state, playback/drift maths, name cleaning, subtitle parsing, file headers |
| Simulated rooms | `room_sim.rs` with fake ports | multi-person rules, recovery, host changes, late joiners |
| Adapter | real Node server; libwebrtc loopback | signaling, peer connections, audio path |
| Interop | Python + Playwright in `client-ts/tests/e2e/desktop_*_test.py`, driving the web app in Chromium and the desktop engine through `examples/` binaries | every shared feature, both directions |
| UI | `gpui-kit`'s headless window tests for logic; screenshots at 1440×900 compared by eye and by a pixel-difference script against `ui-reference/` | screens |
| Performance | soak and startup tests on Windows CI | section 8 |

Grow `examples/chat.rs` into a scriptable headless client (stdin commands, one JSON event per
line on stdout) so interop tests can drive every feature without a window. Add each new
`desktop_*_test.py` to `run_all.py`.

Commands: see `desktop/README.md`. Linux needs clang 21+ for libwebrtc and
`libxkbcommon-dev libwayland-dev libfontconfig1-dev` for GPUI; a window can be driven on Linux
with `Xvfb` and Mesa's software Vulkan (`mesa-vulkan-drivers`).

---

## 13. Known risks: check these early

| Risk | Check | If it fails |
|---|---|---|
| `libwebrtc` crate's audio path on Windows (6.3) | Spike at the start of M1 step 5 | Done: ADR 0002 (M1), ADR 0003 (M3) |
| Echo cancellation in our own pipeline (delay, drift) | Fake-device echo test first thing in M3 | Keep the platform-device path as the default; ask |
| `libwebrtc` crate and static CRT (`+crt-static`) link on MSVC | First Windows CI run | Drop `crt-static`, ship the VC++ runtime DLLs beside the exe; ADR |
| `gpui-kit` 0.9.1 on Windows 10 (DirectX 11) | M1 step 1 | Ask |
| Pixel-exact custom components on `gpui-kit` | M1 step 2 | Write on raw GPUI |
| Variable fonts in GPUI's text system | M1 step 2 | Bundle static weights 400/500/600/700 |
| WebView2 inside a GPUI window (`wry`), z-order, message channel | Start of M4 | Separate child window for the player; ask |
| libmpv render API into a GPUI surface | Start of M5 | mpv in a child window (same limits as the web view) |
| Low-level keyboard hook vs anti-cheat and antivirus (unsigned exe) | M2 | No hook: held keys are read (`GetAsyncKeyState`); admin apps in front are the documented limit |
| Exact parity of floating-point game or sync maths between TS and Rust | Golden vectors | Use integers or the same operation order; never "close enough" |

---

## 14. Web file → desktop home

| Web (`client-ts/src`) | Desktop |
|---|---|
| `types/protocol.ts`, `webrtc/config.ts` | `crates/protocol` |
| `webrtc/signalingMessages.ts`, `peerMessages.ts`, `peerRecovery.ts`, `core/sharedState.ts`, `features/playback/*` logic, `features/queue`, `features/chat` logic, `utils/names.ts` | `crates/core` |
| `hooks/useSignalingConnection.ts` | `crates/signaling` |
| `webrtc/usePeerMesh.ts`, `sdp.ts`, `remoteAudio.ts` | `crates/rtc`, `crates/engine` |
| `hooks/useVoiceChat.ts`, `utils/micPipeline.ts`, `audioDevices.ts`, `features/audio` | `crates/audio` |
| `utils/p2pStreamer.ts`, `p2pImageShare.ts`, `features/files`, players | `crates/video`, `crates/engine` |
| `features/activities/*/rules.ts`, `engine.ts`, `model.ts` | `crates/games` |
| `index.css`, `redesign.css`, `App.css`, `components/icons.tsx` | `crates/ui` |
| `components/*`, `features/*/*.tsx`, `App.tsx` | `crates/app` |
