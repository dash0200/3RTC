# 3RTC — Feature Roadmap & Enhancement Suggestions

This document tracks planned features, architectural improvements, and quality-of-life enhancements for **3RTC**.

---

## 1. 🎬 Media & Watch Party Enhancements

### 1.1 Shared Video Queue & Collaborative Playlist ✅ `[COMPLETED]`
- **Description**: Enable peers to paste YouTube links or presets into an "Up Next" collaborative playlist queue.
- **Key Capabilities**:
  - Collaborative queue where peers can add videos, re-order (move up/down), remove items, or play immediately.
  - Vote-to-skip mechanism with real-time peer voting and progress bar.
  - Autoplay next video in the queue with synchronized start for all peers upon video completion (`ENDED` state).
  - Dedicated Queue tab in sidebar with Now Playing card and animated equalizer bars.
- **Implementation Notes**:
  - Broadcast queue state over WebRTC DataChannel via action payloads `{ type: 'queue-action', action, ... }`.
  - Full synchronization on late-join via `yt-request-sync` and `yt-sync-state`.

---

### 1.2 Floating Live Reactions Over Video Player ✅ `[COMPLETED]`
- **Description**: Animate floating emoji reactions (like YouTube Live / Twitch hearts) that float up the side of the stage when peers click quick reactions (`🔥`, `❤️`, `😂`, `👏`, `👍`, `🎉`) or press hotkeys `1`–`6`.
- **Key Capabilities**:
  - Smooth CSS particle animations rising, drifting organically, and fading along the bottom-right corner of the video.
  - Sleek translucent floating reaction dock with hotkey tags `[1]` through `[6]` on the video stage.
  - Global keyboard hotkeys `1`–`6` trigger instant reactions when watching.
  - Zero performance lag using lightweight hardware-accelerated CSS animations and auto-cleanup.
- **Implementation Notes**:
  - Broadcast `{ type: 'reaction', id, emoji, sender, lane, driftVariant, scale, rot }` over DataChannel with low latency.
  - Integrated with LiveChat quick reaction chips and sound synthesized popping effect.

---

### 1.3 "Host Control" (DJ Mode) vs "Collaborative Mode"
- **Description**: Give the room host control over playback permissions.
  - **DJ Mode (Host Only)**: Only the host can play, pause, and scrub the timeline. Ideal for movie sessions to avoid accidental interruptions.
  - **Collaborative Mode**: Any peer can play, pause, and seek (default current behavior).
- **Key Capabilities**:
  - Visual lock badge on stage player controls for non-host peers when DJ mode is enabled.
  - Host can toggle mode anytime with a single click.

---

### 1.4 WebRTC Direct Video Streaming (MSE Chunk Sharing) ✅ `[COMPLETED]`
- **Description**: Slices local video files and streams them peer-to-peer over WebRTC DataChannel, while retaining the existing zero-bandwidth local file sync option.
- **Key Capabilities**:
  - **Dual-Option Interoperability**:
    - **Option 1 (P2P Streaming)**: Peers who do not have the video file on their device can stream it directly peer-to-peer from the room peer with progressive chunk buffering, live transfer stats (`%`, `MB/s`, `chunks`), and autoplay once buffered.
    - **Option 2 (Zero-Bandwidth Sync - Current)**: Peers who already possess the identical video file locally can select or drag & drop their local file for zero network bandwidth usage.
  - Slices video files into 60 KB binary chunks with backpressure flow control (`bufferedAmountHigh: 512KB`, `bufferedAmountLow: 128KB`).
  - Full WebRTC playback synchronization (play, pause, seek, restart, sync pulse) works seamlessly across both streamed and local-file peers.
- **Implementation Notes**:
  - `P2PStreamSender` & `P2PStreamReceiver` in [p2pStreamer.js](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/utils/p2pStreamer.js).
  - Dual-option waiting UI and topbar streaming status pills in [LocalVideoSyncPlayer.jsx](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/components/LocalVideoSyncPlayer.jsx).
  - Binary DataChannel routing (`dc.binaryType = 'arraybuffer'`) and lifecycle handlers in [App.jsx](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/App.jsx).

---

### 1.5 Drag & Drop Subtitles (.SRT / .VTT) for Local Video ✅ `[COMPLETED]`
- **Description**: Seamlessly load and synchronize external subtitle files (.SRT / .VTT) on the local video player, styled to perfection and auto-shared across peers.
- **Key Capabilities**:
  - **Drag & Drop Subtitles**: Drag and drop any `.srt` or `.vtt` file directly onto the local video player (or browse via the CC menu) with dynamic visual drop indicators.
  - **Parser Engine**: Converts SubRip (`.srt`) and WebVTT (`.vtt`) files into normalized cues with BOM stripping, CRLF normalization, and live WebVTT `<track>` Blob URL generation.
  - **Synchronized Subtitle Overlay**: Real-time cue matching against `currentTimeSec` with custom styling and hardware-accelerated animations.
  - **CC Settings Menu (Glassmorphic Popover)**: Dedicated CC button in player toolbar with active glow indicator opening:
    - Master Subtitles Toggle (`ON` / `OFF`).
    - Active Subtitle File card (filename, cue count, replace & remove actions).
    - Timing Sync Offset Steppers ($-1.0\text{s}$, $-0.5\text{s}$, $-0.1\text{s}$, Reset, $+0.1\text{s}$, $+0.5\text{s}$, $+1.0\text{s}$).
    - Appearance customization: Font Size (`S`, `M`, `L`, `XL`), Colors (`White`, `Yellow`, `Cyan`, `Lime`), Background Box (`Semi-Dark`, `Solid`, `Outline/Shadow`), and Position (`Bottom`, `Elevated`, `Top`).
  - **P2P Subtitle Synchronization**: Automatically broadcasts loaded subtitle files over WebRTC DataChannel (`action: 'subtitle-share'`) so all room peers enjoy synchronized subtitles without needing to manually find the file. Late-joiners receive active subtitles via room sync state.
  - **Keyboard Hotkeys**: `C` (toggle subtitles / open CC menu), `[` (delay -0.1s), `]` (delay +0.1s).
- **Implementation Notes**:
  - `subtitleParser.js`: [subtitleParser.js](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/utils/subtitleParser.js).
  - Player overlay, controls, and CC popover: [LocalVideoSyncPlayer.jsx](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/components/LocalVideoSyncPlayer.jsx).
  - WebRTC DataChannel subtitle routing and late-joiner state: [App.jsx](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/App.jsx).
  - Glassmorphic menu and cue styling: [App.css](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/App.css).

---

## 2. 🎙️ Voice & Peer Audio Upgrades

### 2.1 Per-Peer Volume Sliders & Speaking Rings ✅ `[COMPLETED]`
- **Description**: Real-time visual voice activity detection (VAD), discrete volume sliders ($0\% - 200\%$) per peer, and one-click peer muting.
- **Key Capabilities**:
  - **Animated Speaking Rings**: Neon-green pulsating aura rings around peer avatars when vocal speech exceeds threshold (`average > 12`).
  - **Live VU Energy Meters**: Real-time dynamic audio level indicators for both self-mic test and each remote peer.
  - **Discrete Volume Sliders (0% - 200%)**: Custom gradient range sliders with quick-preset chips ($50\%$, $100\%$, $150\%$, $200\%$) powered by Web Audio `GainNode` for clean amplification up to 200%.
  - **One-Click "Mute for Me"**: Silence any individual noisy peer without deafening the whole room.
  - **Dual Placement**:
    - **Stage Controls Bar**: Compact peer badges with initials and speaking rings; clicking any badge opens an interactive glassmorphic volume popover.
    - **Sidebar "Peers" Tab**: Dedicated 4th navigation tab in `LiveChat` displaying full user cards, mic test meter, individual volume sliders, and mute toggles.
- **Implementation Notes**:
  - Components: [PeerVoiceRoster.jsx](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/components/PeerVoiceRoster.jsx) (`PeerVoiceRoster`, `PeerVoiceBadge`, `PeerAudioPopover`, `PeerVoicePanel`).
  - Web Audio & VAD loop: [App.jsx](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/App.jsx) (`localAnalyserRef`, `peerEntry.analyserNode`, 75ms sampling interval, `peer-identity` handshake).
  - Stage integration: [Stage.jsx](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/components/Stage.jsx).
  - Sidebar integration: [LiveChat.jsx](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/components/LiveChat.jsx).
  - Glassmorphic styling & keyframe animations: [App.css](file:///c:/Users/dvana/Documents/WebRTCUsers/client/src/App.css).

---

### 2.2 Audio Processing Toggles (Noise Suppression & Echo Cancellation)
- **Description**: Fine-grained audio settings for optimal voice clarity in varied environments.
- **Key Capabilities**:
  - Toggle browser native `noiseSuppression`, `echoCancellation`, and `autoGainControl`.
  - Push-to-Talk (PTT) mode with customizable hotkey (e.g., `Space` or `Ctrl`).

---

### 2.3 Synchronized Soundboard (Mini SFX Tray)
- **Description**: A fun, collapsible tray of instant audio sound bites synchronized across peers.
- **Key Capabilities**:
  - Quick 1-second sound clips (Applause, Airhorn, Drumroll, Laugh track, Cheering, Tada).
  - Dedicated soundboard volume slider to prevent blasting peer ears.
  - WebRTC DataChannel message triggering client-side Web Audio synthesis or cached sound assets.

---

## 3. 💬 Chat & Social Experience

### 3.1 Picture-in-Picture (PiP) Chat & Video
- **Description**: Enable users to browse other tabs while keeping track of the watch party.
- **Key Capabilities**:
  - Browser Picture-in-Picture button for video playback.
  - Support for `Document Picture-in-Picture` API to float a mini chat and video window together outside the browser tab.

---

### 3.2 Rich Chat: `@mentions`, Markdown & Link Cards
- **Description**: Enhance communication clarity and interactivity.
- **Key Capabilities**:
  - Autocomplete `@username` with subtle audio chime and badge highlighting for mentioned peer.
  - Lightweight markdown rendering: `*bold*`, `_italic_`, `` `code` ``, `~strike~`.
  - Compact link preview cards for shared web links.

---

### 3.3 Direct P2P Image & Screenshot Sharing
- **Description**: Share images or paste screenshots directly into chat without an upload server.
- **Key Capabilities**:
  - Paste clipboard image (`Ctrl+V`) or drag & drop image into the chat input bar.
  - Transfer binary blobs directly through WebRTC DataChannel.
  - Lightbox preview modal for viewing shared images in high resolution.

---

## 4. ⚡ Connectivity, Performance & Diagnostics

### 4.1 Real-Time P2P Network HUD (Ping & Latency)
- **Description**: Transparent diagnostic HUD for enthusiasts and troubleshooters.
- **Key Capabilities**:
  - Real-time round-trip latency (RTT / Ping in ms).
  - WebRTC connection type: `Direct P2P (Host/STUN)` vs `Relay (TURN)`.
  - Video synchronization drift metric (e.g., `Synced within 14ms`).
  - Packet loss and bitrate indicators.

---

### 4.2 Automatic Host Migration
- **Description**: Seamless room continuity if the host leaves or disconnects.
- **Key Capabilities**:
  - Next longest-connected peer automatically promoted to room host.
  - Room status smoothly updates without interrupting media playback or disconnecting existing peers.

---

### 4.3 QR Code for Instant Mobile Join
- **Description**: Effortless mobile onboarding.
- **Key Capabilities**:
  - Clicking the room code or a "Share" icon generates an instant QR code.
  - Friends in the room can scan the code using their smartphone camera to immediately open and join the room.

---

## 5. 📱 PWA & Platform Polish

### 5.1 Progressive Web App (PWA) Installability
- **Description**: Enable 3RTC to run as an installed desktop or mobile app.
- **Key Capabilities**:
  - Web App Manifest + Service Worker caching for instant loading.
  - "Install App" prompt in browser bar.
  - Launches in a clean, standalone, borderless native window on Windows, macOS, Android, and iOS.

---

### 5.2 Keyboard Shortcuts Cheat Sheet Modal (`?`)
- **Description**: Quick reference for power users.
- **Shortcuts**:
  - `Space`: Play / Pause synchronized media
  - `F`: Toggle Fullscreen mode
  - `M`: Toggle Microphone mute / unmute
  - `C`: Toggle Sidebar (Chat / Logs)
  - `←` / `→`: Seek $\pm 5\text{s}$
  - `↑` / `↓`: Volume $\pm 5\%$
  - `1` – `6`: Trigger quick reactions
  - `?`: Open shortcut cheat sheet
