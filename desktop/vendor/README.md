# Vendored crates

## webrtc-sys 0.3.53 (LiveKit)

Copied from crates.io unchanged except three changes, each marked `3RTC:`:

1. `src/adm_proxy.cpp`: `AdmProxy::BuiltInAECIsAvailable()` returns `false` on Windows (below).
2. `src/peer_connection.cpp`: `audio_jitter_buffer_fast_accelerate = true`, so the audio jitter
   buffer catches up quickly after a burst of late packets.
3. `src/peer_connection_factory.cpp`: field trial `WebRTC-Audio-NetEqDelayManagerConfig` with
   `quantile:0.90` (NetEq's default is 0.95), a slightly lower jitter buffer target.

2 and 3 came from a phone on Wi-Fi: its voice waited 190-330 ms in our jitter buffer (round trip
12 ms), heard as 50-100 ms more delay than the other direction.

Why 1: with the platform audio device on Windows, libwebrtc's Core Audio module reports a
built-in echo canceller (Windows' "Voice Capture DSP" DMO). WebRTC then records through the DMO
at 16 kHz from the default *communications* devices and switches its own echo canceller off. On
the first Windows laptop we tested (Intel Smart Sound mic array, Bluetooth earbuds) the DMO
delivered pure silence: `[REC : 10001msec, 16kHz] ... level: 0`. Chrome never uses the DMO; it
records with plain WASAPI at 48 kHz and cancels echo with AEC3. Saying "not available" makes
WebRTC do the same.

To update: copy the new version over this folder, re-apply the `3RTC:` change, bump the version
in this file. Goes away in M3, when our own audio pipeline replaces the platform audio device
(docs/adr/0003-own-audio-pipeline.md).
