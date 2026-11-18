# ADR 0010: Webcam on the desktop app

Status: accepted (2026-11-18, owner: "Approve plan"; then "Full Quality between desktop apps and show
the msg when camera is blocked", and a camera picker on both apps). Built the same day; see
`docs/STATUS.md` for what has been run.

## Context

The web app got a webcam in b0140d0 (`features/camera/useCamera.ts`, `CameraTiles.tsx`,
`webrtc/cameraLine.ts`; `docs/PROTOCOL.md` "Webcam"). The desktop app has none. Desktop and browser
users must see each other's cameras, so the wire follows the web app exactly; capture, encoding,
decoding and drawing are built for desktop.

What the web app does on the wire:

- `camera: true` in `peer-identity` says "I understand the camera line". Apps that don't say it never
  get the line (they take any incoming video for the shared screen).
- Between two such apps, **the side that made the connection** (the initiator) adds a **second video
  line** once, after the identities are in, with `addTransceiver('video', sendrecv)`, and sends a new
  offer on the open connection (retrying every 500 ms, up to 20 times, while not `stable`). Line
  order is fixed: the first video line is the shared screen, the second the camera. Audio lines
  (voice, `screen-audio`) don't count.
- The answerer sets that transceiver to `sendrecv` and puts its camera track (or none) in it.
- On or off only swaps the track (`replaceTrack`, null while off): no new offer.
- 640×360 ideal, 24 fps max, sender `maxBitrate` 350 kbps and `maxFramerate` 24, `contentHint`
  motion. Codec: whatever the connection negotiated.
- `camera-status { on }` to everyone on change, and to each newcomer (`peer-open`) while on.
- A tile shows only when the status says on **and** the camera line's track has arrived. Order: the
  order they turned it on. Ours last, named "You", mirrored.
- Tiles: a row just above the dock, right-aligned, 176 px wide 16:9, radius 10, name chip; a click
  makes one 360 px wide; ✕ hides the row, "Show cameras (n)" brings it back (and it comes back by
  itself when another camera turns on). Dock button `camera` / `cameraOff`, "Turn camera on/off",
  "Starting camera…" while opening.

## Decision

**Protocol and core (`crates/protocol`, `crates/core`).** `camera: Option<bool>` in `PeerIdentity`
(we send `true`); `PeerMessage::CameraStatus { on }`. Core keeps, per member, `camera` (can show
cameras) and `camera_on`, plus the order they turned it on; our own on/off arrives as an input.
Core sends `camera-status` on change and to each newcomer when their channel opens while ours is
on, and forgets a member's camera when they leave. The snapshot lists the cameras that are on, in
order. Unit tests with the web app's JSON.

**Connections (`crates/engine/src/peers.rs`, `camera.rs`).** One camera track per app (a
`NativeVideoSource`, not a screencast), like the screen's track; frames go in only while it's on, so
nothing is sent while it's off (the web app's `replaceTrack(null)` has the same effect).

- *As the initiator*: once the main channel is open and the member says `camera: true`, and the
  connection is `connected` and `stable`, `add_track(camera, ["camera"])` and offer again (the same
  "try again on the next tick" pattern as `add_screen_sound`). Once per connection.
- *As the answerer*: the camera track is added with `add_track` when the connection is made, after
  the voice and screen tracks. libwebrtc pairs an offered m-line with the first unused track-added
  transceiver of that kind, so the screen track takes the first video line (as today), and the
  camera track waits, unused (an answer can't add lines, so older apps never see it), until a
  second video line is offered, and makes that line `sendrecv`. This is how voice and screen already
  take the offered lines, and it is needed because LiveKit's `libwebrtc` 0.4 has no
  `set_direction` on a transceiver.
- *Which line is which*: `on_track` passes the transceiver's `mid`; the engine compares it with the
  connection's second video transceiver (in `transceivers()` order, video by the receiver's track,
  as `cameraLine.ts` does). `video_sender` (screen share's routing) changes from "the first sender
  with a video track" to "the first video line's sender", so the screen code never touches the
  camera line.
- Senders (`Engine::route_camera`, each tick until set): **desktop viewers** get the camera's
  own picture (owner, 18 Nov: "Full Quality between desktop apps"): up to 1080p at 30 fps, the rate
  cap growing with the picture (`camera::desktop_bitrate`: about 3.1 Mbit/s at 1080p30, within
  0.5–4 Mbit/s), the network's estimate deciding within it. **Web viewers** get what the web app
  sends: `scale_resolution_down_by` to 360 lines, 24 fps, 350 kbps. libwebrtc's own (software)
  encoder, for whatever codec was negotiated: one encoder per viewer, so three desktop viewers of a
  1080p camera cost about three software 1080p encodes (if that's too heavy on a slow PC, the
  screen's GPU pass-through, ADR 0005, can be reused later).
- Receiving: each peer's camera track (only while their status says on) decoded by
  `NativeVideoStream` into a `ScreenFeed` (the screen's `Watch`, reused), scaled to the tile's size
  (400×225 physical) or, for the camera on the stage, as sent; turned into BGRA off the UI thread.
- The engine tells the UI with `Update::Cameras(CameraView)`: ours (on, starting, our mirrored
  preview) and everyone else's that's on and has a picture, in order.

**Capture (`crates/platform-win/src/camera.rs`).** Media Foundation: `MFEnumDeviceSources` (video
capture devices; their symbolic link is the id the picker saves), `MFCreateSourceReaderFromMediaSource`
with advanced video processing on, so the reader decodes MJPG/YUY2 and gives **NV12**. The camera's
own mode is picked first (`best_mode`: the biggest picture up to 1920×1080, at 24–30 fps if it can),
so a 4K camera isn't asked for 4K. A thread per capture reads samples synchronously and hands NV12
frames to a callback; the engine copies them into the camera source and keeps a mirrored copy (about
15 a second, 480 wide) for our own tile. Errors become the web app's toasts: no device → "No camera
found"; in use → "The camera is busy in another app"; anything else → "Couldn’t start the camera";
and `E_ACCESSDENIED` (Windows' privacy switch for desktop apps; owner, 18 Nov: "show the msg when
camera is blocked") → **"Camera blocked: allow it in Windows Settings → Privacy → Camera"**. A camera
unplugged mid-call turns ours off, as the web app's `track.onended`. Stand-in on other systems: "No
camera found". `unsafe` only here, one operation per block, each with `// SAFETY:`.

**Camera picker (owner, 18 Nov: "Add a camera picker also for both web and desktop").** A caret on
the camera button, like the mic's. Web (`features/camera/cameraDevices.ts`): "Default camera" and
each `videoinput` (named "Camera N" until the browser shows names), saved in `localStorage`
(`3rtc_camera_device`); a saved camera that's unplugged falls back to the default. Desktop: the
dock's tray (as the mic's devices), "Default camera" and each camera from `rtc_platform_win::cameras()`,
saved as `cameraDevice` in settings. Picking one while the camera is on switches to it without
turning it off (no `camera-status` change; the track on every camera line just gets the new
pictures). Nothing goes on the wire.

**Tests' camera.** The headless client (`examples/chat.rs`): `/camera on [WxH]` sends a moving test
pattern made in the engine (no device), `/camera device [id]` a real camera (the probe on Windows),
`/camera off`, `/cameras`; it prints `CAMERAS on= starting= mine= remote=<names>` and
`CAMERA_FRAME <name> WxH fps=N`.

**UI (`crates/app/src/camera.rs`).** The dock button in the web app's place (after the mic group)
with its caret, the tile row above the dock with the web app's sizes and wording, hide and "Show
cameras (n)", ours mirrored and named "You". The stage (and the YouTube web view's rectangle)
shrinks by the row's height, as on the web. The `camera` and `cameraOff` icons are regenerated from
`icons.tsx` (`tools/gen_icons.py`; it also added the other icons the web set had gained).

**Camera on the stage (owner, 18 Nov; the web app has it too).** Clicking a tile puts that camera
in the stage, where videos play, for this viewer only (nothing is sent; others' screens don't
change). It replaces the web app's "slightly bigger" click. Whatever was on the stage keeps running
under it: a playing video keeps its sound and stays in sync. "✕ Back to the stage", Esc (Back on a
phone), a second click on the same tile, or that camera going away brings the stage back; the tile
on the stage has an accent ring. Web: `features/camera/spotlight.ts`, `CameraStage.tsx`. On desktop
the YouTube web view and mpv are child windows over GPUI, so they are hidden (still playing, as when
a dialog is open, BUILD_SPEC §5.9) while a camera is on the stage.

## Not included

- Host hub topology: guests connect only to the host, and the host doesn't forward cameras, so
  guests see only the host's camera (the web app is the same).
- On a phone, the web app has no picker (it opens the front camera).
- Background blur; the quality following the size a desktop viewer shows the camera at (a desktop
  viewer always gets the full picture; a `camera-quality` message like `screen-quality` could cut
  that for small tiles later).

## Risks

1. libwebrtc pairing the pre-added camera transceiver with the second offered video line. Proved
   by `desktop_camera_test.py` (Kai: a desktop answering a desktop's camera line, and the browser's).
   If it doesn't hold: patch the vendored `webrtc-sys` + vendor `libwebrtc` to expose
   `set_direction` (ask first).
2. Cameras that only give MJPG, or odd sizes: the reader's video processing should cover them; the
   owner's run with a real camera checks it (`checklists/camera.md`).
3. Windows' camera privacy switch for desktop apps (`E_ACCESSDENIED`): shown as the blocked toast.
4. Software encoding of a 1080p camera for several desktop viewers (CPU).
