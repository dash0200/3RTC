# Camera checklist (ADR 0010): run on Windows 10 or 11

`.\dev.cmd -Prod` on this PC (with a webcam). Have someone on 3rtc.me in the same room (a phone
works), and for the last part a second PC with the desktop app.

## Your camera
- [ ] The dock has a camera button after the mic, with a caret. Click it: "Starting camera…", then your tile ("You", mirrored) shows above the dock
- [ ] The browser shows your camera's tile with your name, moving
- [ ] Click the button again: your tile goes here and in the browser
- [ ] Caret: "Camera" tray with "Default camera" and your cameras (a phone link / OBS virtual camera shows too, if you have one). Pick another one while the camera is on: the picture switches without turning off; it's remembered after a restart
- [ ] Windows Settings → Privacy & security → Camera → turn off "Let desktop apps access your camera", then turn the camera on: the toast says "Camera blocked: allow it in Windows Settings → Privacy → Camera". Turn the setting back on
- [ ] Open the camera in the Windows Camera app first, then here: "The camera is busy in another app" (some cameras allow both: then it just works)
- [ ] Unplug a USB camera while it's on: your camera turns off, no crash

## Their camera
- [ ] The browser turns its camera on: its tile shows here with their name, moving
- [ ] Click their tile: it fills the stage ("✕ Back to the stage" at the top right); a playing YouTube video keeps its sound; Esc or the button brings the stage back
- [ ] ✕ next to the tiles hides them ("Show cameras (n)" brings them back); a new camera turning on brings them back too

## Two desktop PCs
- [ ] Both cameras on: each PC shows the other's tile; click it: on the stage the picture is sharp (your camera's full size, up to 1080p), while the browser's copy stays 640×360
- [ ] Logs (or the terminal with `RUST_LOG=info`): `camera: to <peer> (desktop): 1920×1080` (your camera's size) and `(web): 640×360 at most`
