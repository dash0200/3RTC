# 2. Voice through libwebrtc's platform audio device

Date: 2026-11-11 · Status: accepted for M1–M2; superseded in M3 by [ADR 0003](0003-own-audio-pipeline.md)

## Context

Voice must be as clear and as quick as Chrome's, keep running with the window hidden, and let
people pick exact devices. Two ways exist with the `libwebrtc` crate (0.4):

1. **Platform audio device** (`acquire_platform_adm`): libwebrtc opens the microphone and the
   speakers itself (WASAPI on Windows) and runs Chrome's echo cancellation, noise suppression and
   gain control with capture and playback on one clock. Devices are listed and picked by stable id.
2. **Our own pipeline**: we capture and play with `cpal`, run WebRTC's audio processing module
   (`AudioProcessingModule`) ourselves, feeding it the speaker signal for echo cancellation, mix
   every person's voice ourselves and push frames into a `NativeAudioSource`.

## Decision

Use (1) for M1. It is the same audio engine as the browser on the other end, needs no delay
tuning for echo cancellation, and costs no extra threads. Without a sound card (CI, tests) the
voice is a test tone or silence through a `NativeAudioSource`, so everything else runs the same.

Speaking detection reads `audioLevel` from libwebrtc's stats every 150 ms (our mic: the media
source; each person: their inbound audio), with a 0.03 threshold and a 400 ms hold. Deafen stops
playout (nothing plays, so nothing can echo); mute disables the track (silence is sent, and
Opus's silence detection keeps it tiny).

## Consequences

- Voice, mute, deafen, device choice and speaking rings work with web users in the same room
  (`client-ts/tests/e2e/desktop_interop_test.py`).
- **Not possible on this path:** per-person volume (libwebrtc mixes all voices before we see
  them) and an RNNoise stage (capture never passes through our code). Both need path (2). The
  web app has both (it plays each voice in its own element, and runs RNNoise in an audio
  worklet). Decided 11 Nov: path (2) in M3, see ADR 0003.
- The settings dialog's mic meter and test sound need the device outside a call; the platform
  device only records while a call sends audio, so they come with path (2) or a small `cpal`
  side-path.
