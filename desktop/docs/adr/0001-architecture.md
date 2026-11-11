# 1. Functional core, imperative shell; libwebrtc for peers

Date: 2026-11-11 · Status: accepted

## Context

The desktop app must join the same rooms as the web app and connect to browsers directly, with
low latency voice and fast transfers, while staying easy to test and change.

## Decision

1. **Protocol as its own crate.** Every message the web app sends or receives has a typed Rust
   twin, tested against JSON captured from the web app. Unknown types and fields are ignored, as
   the web app does, so either side can add messages first.
2. **Functional core.** Room rules (who offers, who hosts, identities, chat, leaving) live in
   `rtc-core` as a state machine with no I/O: `Room::update(Input) -> Vec<Effect>`. They mirror
   `client-ts/src/webrtc/signalingMessages.ts`; the peer already in the room makes the offer.
3. **Imperative shell.** `rtc-engine` owns the socket and the peer connections in one task; every
   event (UI, server, libwebrtc callback) goes through one queue, so there are no locks around
   room state. Callbacks carry a connection generation, so events from a replaced connection
   are dropped.
4. **Google's libwebrtc** through LiveKit's `libwebrtc` crate (prebuilt): the same engine as
   Chrome, so audio processing, congestion control and codecs match the browser exactly.
5. **GPUI** for the window (through `gpui-kit` for ready-made controls), talking to the engine
   over channels only.

## Consequences

- The room logic is tested in microseconds; the network parts have their own integration tests
  (Node server, libwebrtc loopback, and a desktop ↔ Chromium test).
- The prebuilt libwebrtc fixes our compiler floor on Linux (clang 21); Windows uses MSVC.
- A protocol change needs the same change in `client-ts` and `rtc-protocol`, checked by the
  interop test.
