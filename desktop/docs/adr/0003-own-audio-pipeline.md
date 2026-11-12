# 3. Our own audio pipeline (M3)

Date: 2026-11-11 · Status: accepted (owner, 11 Nov); built in M3

## Context

The desktop app copies the web app's look and feel only; everything under it is built for desktop,
for better performance and quality than a browser. Voice is the app's main job. ADR 0002 used
libwebrtc's platform audio device: Chrome's audio quality, but every voice arrives already mixed,
so the app can't give per-person volume, "mute for me", an RNNoise stage, a mic-test meter outside
a call, or its own latency tuning. The web app has the first three.

## Decision

From M3 the app owns the audio path end to end. libwebrtc stays the transport and codec (Opus,
jitter buffer, congestion control) and its audio processing module (APM) stays the echo
canceller; we feed it and play its output ourselves. libwebrtc's audio device runs in synthetic
mode (no device of its own).

```
mic ─► capture (WASAPI) ─► 48 kHz mono 10 ms frames ─► APM: echo cancel (reference = what we play),
       high-pass, gain ─► RNNoise (Voice Isolation, on by default) ─► noise gate ─► level meter
       ─► NativeAudioSource ─► every peer connection (Opus 128 kbps, FEC, 10 ms packets)

peer A track ─► NativeAudioStream ─► gain A (0–200 %, mute-for-me) ─► level A (speaking ring) ┐
peer B track ─► NativeAudioStream ─► gain B ─► level B                                         ├► mix ─► limiter
...                                                                                           ┘   │
                                                     APM reverse stream (echo reference) ◄────────┤
                                                                                                  ▼
                                                                         render (WASAPI) ─► speakers
```

- **Devices:** `cpal` over WASAPI in shared mode, event-driven, smallest period the driver offers
  (aim 10 ms, 3 ms where possible). Exclusive mode as an option for "Lowest delay". Device
  hot-plug and default-device changes followed live (the stream is rebuilt, the call continues).
- **Threads:** one capture and one render callback, both real-time (MMCSS "Pro Audio" through
  `platform-win`). No locks, no allocation, no logging inside them; they exchange frames with the
  engine through single-producer/single-consumer ring buffers (`rtrb`). APM, RNNoise and mixing
  run in the callbacks on fixed buffers allocated up front.
- **Clock drift:** capture and render devices can run at slightly different rates; an adaptive
  resampler on the render side keeps the echo reference aligned, and APM gets the measured
  stream delay (`set_stream_delay_ms`).
- **Per person:** volume 50–200 % and "mute for me", saved per client id; speaking from each
  person's own level (no stats polling); deafen just stops the render mix.
- **Mic test and meters:** the capture path runs on its own while Voice settings is open, with the
  web app's meter and "Play test sound".
- **Settings:** echo cancellation, noise suppression, auto gain and Voice Isolation as the web app's
  toggles, same defaults.

## Testing

- Unit: mixer, gains, limiter, resampler, ring buffers, noise gate (pure, on sample buffers).
- Pipeline with fake devices: a recorded voice plus its own echo goes in, the test checks the
  echo is cancelled (echo return loss enhancement above 20 dB) and the voice survives.
- Latency: a click through capture → APM → network loopback → render, timed; the budget is the
  plan's ~60 ms app share.
- Interop: the existing desktop ↔ web tests (voice both ways, mute, deafen) plus per-person volume
  and mute-for-me.
- Owner's Windows checklist: echo with laptop speakers, Bluetooth headset, device unplug mid-call,
  30-minute call CPU and memory.

## Consequences

- Per-person volume, mute-for-me, RNNoise, the mic meter and lower delay become possible; the app
  controls every millisecond of the path.
- Echo cancellation quality is now ours to keep: delay estimation and drift handling must be right
  on every device. That is the main risk; the fake-device echo test and the owner's checklist
  guard it. Path (1) stays in the code behind a setting until M3's checklist passes, as a fallback.
- `cpal`, `rtrb` and `nnnoiseless` join the dependencies (all MIT/Apache, pure Rust or thin
  Windows bindings).
