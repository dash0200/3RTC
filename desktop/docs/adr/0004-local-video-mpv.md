# 4. Local video files play in mpv, natively (M5)

Date: 2026-11-13 · Status: accepted (owner, 13 Nov); being built in M5

## Context

A video file from this computer should play the way it does in VLC or PotPlayer: straight from
disk, hardware decoded, any container and codec (MKV, HEVC, AV1, many audio and subtitle tracks),
with no frame passing through the app. The web app plays files in a `<video>` element, which
can't open most MKV files or switch their tracks. The YouTube player (M4) is a WebView2 child
window on its own UI thread; the same shape works for a native player.

## Decision

- **libmpv** plays the file. mpv draws into a child window of the app's window (`wid`), on its
  own UI thread (`rtc_platform_win::UiThread`), placed over the stage in physical pixels. GPUI's
  thread never waits on it. The control bar under the video is GPUI (`app/src/local_video.rs`);
  keys and clicks on the video are mpv's, bound to the web player's shortcuts.
- **The LGPL build** of libmpv (`mpv-dev-lgpl-x86_64` from zhongfly/mpv-winbuild). It leaves out
  only mpv's GPL-only parts (some old filters and capture devices), none of which play files.
  It's loaded at run time from `libmpv-2.dll` beside `3rtc.exe`, so the app builds and runs
  without it and says what's missing. `packaging/get-mpv.ps1` fetches it; `dev.ps1` and
  `package.ps1` call it; the portable zip and the installer ship it.
- **Sync is the web app's:** `local-video-action` and `local-video-sync-state`, keyed by the
  file's name and size. Everyone plays their own copy; someone without it can pick theirs ("I
  have this file") or stream it: the block protocol (`engine/src/stream.rs`), which mpv reads
  through a `stream_cb` protocol (`rtcstream://`) that waits for blocks as they arrive.

## Consequences

- Same picture quality and formats as a desktop player, little CPU (hardware decoding).
- A child window draws over GPUI: menus over the stage hide it (as the web view), and the track
  menus sit in the control bar so the video stays visible.
- Auto-update replaces only `3rtc.exe`; `latest.json` also lists `libmpv-2.dll`, which the app
  downloads (checked by SHA-256) when an install doesn't have it.
- LGPL: the DLL is shipped unmodified beside the exe, which loads it dynamically; the licence
  and where its source is are in More > Desktop > Updates and in the portable README.
