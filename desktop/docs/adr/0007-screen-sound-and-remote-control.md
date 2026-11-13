# ADR 0007: The shared screen's sound, and remote control

Status: accepted (2026-11)

## Context

Screen sharing is used to watch films together, which needs the PC's sound and a full-screen
picture, and to help someone on their computer, which needs control "like AnyDesk". Both are
wanted between desktop apps; the web app is not changed (it would take a second audio line for the
person's voice, and a browser can't play input back on a computer anyway).

## Decision

**Sound.**
- The sharer captures all of the PC's sound except 3RTC's own (WASAPI process loopback, excluding
  our process tree, so voices, WebView2 and libmpv aren't sent back), in stereo.
- It goes out as a separate stereo track (stream id `screen-audio`) added to each *desktop* viewer's
  connection while sharing, with a fresh offer on the open connection. Its Opus line is tuned for
  music (stereo, 256 kbit/s, in-band FEC).
- The mixer and speakers are now stereo: voices are mono on both sides, the screen's sound keeps
  left and right, and the echo canceller's reference is the downmix. Viewers set its volume
  (Off, 50, 100, 150 %).

**Remote control.** It uses new `screen-control` and `screen-input` peer messages (see `PROTOCOL.md`),
between desktop apps only.
- **The sharer decides every time.** A viewer asks and the sharer allows or says no (a card on the
  stage, and a Windows notification when 3RTC isn't in front). Or the sharer offers and the
  viewer takes it. One viewer controls at a time.
- **Played back on the sharer's PC** with `SendInput`, over the shared screen (its monitor's
  rectangle) or window (its frame), in physical pixels. Coordinates are 0–1 over the picture, so
  the picture size doesn't matter. Keys are Windows virtual-key codes with their scan codes.
  Whatever the viewer still holds is let go when control ends.
- **Taking back.** While someone controls:
  - a banner sits at the top of the shared area. It lets the mouse through, never takes focus,
    and is kept out of the capture.
  - Ctrl+Alt+Shift+X takes control back (a hotkey).
  - so does the sharer's own mouse: a click, or 200 px of movement within 0.7 s. A low-level mouse
    hook tells their input from ours (Windows marks injected input); it only watches and passes
    every event on.
  - Control also ends when the viewer lets go, either one leaves, or the share stops.
- Windows won't let us play input into an app running as administrator, or onto the secure
  desktop (UAC prompts, the lock screen). That's accepted.

**Graphics card.**
- Settings offers Auto, Power saving or High performance, stored where Windows keeps per-app GPU
  preferences (`HKCU\Software\Microsoft\DirectX\UserGpuPreferences`).
- It applies from the next start; "Restart now" is offered.

## Consequences

- A web viewer gets the picture without the sound, and can't ask for control.
- The app never captures or injects input unless the sharer has allowed this viewer, and it shows
  that it is happening the whole time.
