# ADR 0009: Fast file transfer between desktop apps over QUIC

Status: accepted (2026-11-17, owner: "QUIC as proposed")

## Context

BUILD_SPEC §9 #11: big files and folders, resumable, over QUIC between desktop apps, falling back to
the data channel with web users. Today a desktop app sends a chat file the web app's way: the
`bulk` data channel, 60 KB frames, the whole file read into memory first (up to 10 GB), no resume.

WebRTC data channels (SCTP over DTLS over UDP) are slow for big files: a small send window, a fixed
congestion control, one stream. QUIC (`quinn`) gets close to the link's speed (modern congestion
control, large windows, many streams), and reads and writes straight from and to disk.

The catch: QUIC needs **its own path through both routers**. libwebrtc's ICE path can't be reused
(its UDP socket is libwebrtc's). So QUIC has to hole-punch on its own, and that only works when
neither side is behind a strict ("symmetric") NAT. On strict NATs, like the pair whose failure led
to the connection-failure log, it falls back to the data channel, so it's never slower than today,
but those people see no gain.

## Proposal

**When.** Only between two desktop apps (`client: "desktop"` and a new `quic: 1` in `peer-identity`),
for files over 8 MB. Anything else, and web users, keep the data channel exactly as now.

**Path.**
1. The sender opens a UDP socket, learns its public address with one STUN request from that socket
   (`stun.l.google.com`, as ICE already does), and lists its LAN addresses.
2. `quic-offer` on the main channel: transfer id, file name and size, SHA-256, the addresses, and the
   **fingerprint of a fresh self-signed certificate** (`rcgen`, made for this transfer).
3. The receiver does the same (`quic-answer`: its addresses), then both send a few small UDP
   packets to each other's addresses for about 2 s (hole punching); the receiver connects with
   QUIC (`quinn`) to the first address that answers.
4. Nothing within 5 s: `quic-fallback`, and the file goes over the data channel as today.

**Security.** The certificate's fingerprint travels over the data channel, which is already
encrypted and tied to the room (DTLS). The receiver accepts only that certificate (a custom
`rustls` verifier), so nobody else can take the connection or read the file. One connection per
transfer, closed at the end. Incoming files keep the existing rules: size-capped, saved to
Downloads under a cleaned name, never run.

**Transfer.** One QUIC stream, read from and written to disk in 1 MB blocks (never the whole file in
memory), a running SHA-256 checked at the end. **Resume:** the receiver keeps the partial file and
its offset; on a new offer for the same id and hash it asks to start from there
(`quic-resume {offset}`). **Folders:** sent as a sequence of files with their relative paths
(cleaned: no `..`, no absolute paths), one stream each, after one confirmation for the folder.

**Limits.** Bandwidth is the link's (it's a direct path); the app caps a transfer at 10 GB as today.

## New dependencies

`quinn` (QUIC), `rustls` (already in the tree through `tokio-tungstenite`), `rcgen` (certificates).
All MIT or Apache-2.0, so `cargo deny` allows them. `quinn` brings `quinn-proto` and `quinn-udp`.

## Work and verification

Pure parts in `core` (offer/answer/fallback state, path cleaning, resume offsets) with unit tests;
the QUIC side in a new `crates/engine/src/quic.rs`; an interop test with two engines on one machine
(LAN addresses, so no STUN), a forced fallback test, and a resume test. The owner runs cargo and
tries it between two PCs, including one on mobile data. Several rounds of compile fixes are likely,
since the code can't be built where it's written.

## Alternatives

- **Faster data channel instead** (several bulk channels in parallel, bigger frames, read from disk
  in blocks, resume): works for everyone, web users and strict NATs included, with no new
  dependencies; slower than QUIC on a good link, but a clear gain over today. Could come first.
- **QUIC through a relay:** a TURN-style relay for QUIC costs server bandwidth, which the abuse
  limits were added to avoid.

## Decision

QUIC as proposed (owner, 17 Nov 2026), with `quinn` (already in the tree), `rcgen` and `rustls`.
One change from the proposal: the receiver also proves it's the one the offer went to, with a
one-time token sent first on the stream (the certificate pin only protects the receiver).

Stage 1 (done): the messages (`quic-offer`, `quic-answer`, `quic-fallback`), the rules in
`crates/core/src/quic.rs`, the transport in `crates/engine/src/quic.rs` with loopback tests (a whole
file, a resume, a wrong token, a wrong certificate).

Stage 2 (done): `quic: 1` in `peer-identity` (a member counts only if it's also `client: "desktop"`);
chat files of 8 MB or more picked from disk (not pictures) go to those peers over QUIC
(`crates/engine/src/quic_flow.rs`), everyone else gets the bulk frames as before; the announcement
goes to all, so the chat line is the same everywhere. Any failure for a peer (no answer within 20 s,
no path, a break on the way, or the receiver's `quic-fallback`) re-sends the announcement and the
frames to that peer over the bulk channel. The receiver writes to `Downloads\<name>.3rtc-part`, then
renames it (a free name); the chat card's button becomes "Show" (opens the folder).

Stage 3 (done): big files (8 MB+, not pictures) stay on disk and are read in chunks as they're sent,
over QUIC and over the bulk channel alike (`crates/engine/src/outgoing.rs`), so nothing near 10 GB is
held in memory on the sending side. Folders (a 📁 button, or drop one): up to 500 files and 10 GB,
sent one after the other (the next starts when every way of sending the last one has finished),
each as a chat file; the first's caption says "📁 Photos: 12 files". `quic-offer` carries
`relativePath`, so other desktop apps save into `Downloads\Photos\…` (cleaned; a folder's pictures
go over QUIC too, to keep it whole). Web users get the files one by one, as single files.
