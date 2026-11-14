# 5. Screen sharing at the screen's own quality, per viewer

Date: 2026-11-13 · Status: accepted (owner, 13 Nov)

## Context

The first screen share (M5) sent every viewer the same picture: at most 1920×1080, 30 frames a
second, encoded by libwebrtc in software, with libwebrtc's default rate ceiling and its "balanced"
trade-off (it shrinks the picture when the network is short, which blurs text). The owner asked
for VDI-like quality between desktops: the screen's own resolution, a high and dynamic data rate
on a good connection, sharp text, 60 frames a second, the GPU's encoder; a choice of size for the
sharer and for each viewer; and web viewers adjusted for themselves without lowering anyone else.

## Decision

- **Each viewer gets their own picture.** The capture runs at the screen's own size (up to
  4096×2304, H.264 level 5.1), at 60 or 30 frames a second. A viewer's picture is the smallest of
  the screen, the sharer's choice (Native, 1440p, 1080p, 720p), the viewer's own choice (a new
  desktop-only message, `screen-quality {maxHeight}`, docs/PROTOCOL.md) and 1440p for web viewers.
- **The GPU encodes for desktop viewers.** Our libwebrtc build has no hardware encoders on Windows,
  so `rtc_platform_win::H264Encoder` drives the GPU's H.264 encoder through Media Foundation
  (NVENC, AMF or Quick Sync: asynchronous, low-latency, constant rate, no B-frames). When H.264
  is negotiated with a viewer (desktops put it first), their sender gets its own pass-through
  source (`NativeVideoSource::new_encoded`, `VideoEncoderBackend::PreEncoded`): we encode their
  picture and libwebrtc packetises it. libwebrtc's rate requests (its bandwidth estimate) set the
  encoder's rate; its keyframe requests (a lost picture, a new viewer) make a keyframe. At most
  four viewers get a GPU encoder (consumer GPUs limit sessions); the rest, viewers without H.264
  (the web app in some browsers) and computers without a GPU encoder get the software path:
  libwebrtc encodes the shared picture, scaled per viewer by their sender's settings.
- **Rate.** The ceiling grows with the picture (about 0.1 bit a pixel: ~50 Mbit/s for 4K at 60,
  ~12 for 1080p at 60; 12 at most for web viewers); the connection's estimate starts at 4 Mbit/s
  and may go to 60. The network decides within the ceiling.
- **Sharp text.** Senders keep the resolution when the network is short (frames are dropped
  instead: `DegradationPreference::MaintainResolution`).
- **Viewing.** Frames are scaled to the size the stage shows them at (physical pixels) before
  they're turned into BGRA, so a 4K share in a small window costs little to draw; a line under
  the picture shows what's received (and, for the sharer, what each viewer gets and how).

## Consequences

- Colour is 4:2:0, like every video call: hardware encoders don't produce 4:4:4, so fine
  coloured text (red on blue) is a little softer than on the sharer's screen.
- H.264 is the desktops' first choice for the video line, also for software encoding (OpenH264)
  when no GPU encoder is there; VP8 and the rest stay as fallbacks.
- The Media Foundation code runs only on Windows and is tested there; elsewhere, tests replace
  the GPU encoder with a file of H.264 access units (`RTC_TEST_H264`), which exercises everything
  around it (`desktop_screen_hq_test.py`).
