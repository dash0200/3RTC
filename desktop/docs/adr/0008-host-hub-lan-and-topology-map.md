# ADR 0008: Host Hub, LAN Rooms, Topology Map, and Hybrid GPU/CPU Streaming

Status: accepted (2026-11)

## Context

3RTC has operated as a full peer-to-peer (P2P) mesh: every participant opens an `RTCPeerConnection` to every other participant ($N \times (N-1) / 2$ connections).

While a full mesh gives zero server compute cost and minimum latency for 2–4 people, it faces real-world scaling limits:
1. **Upstream Bandwidth & Battery on Phones**: A guest streaming audio, screen, or webcam must encode and upload $N-1$ copies simultaneously. On mobile devices or home asymmetric connections (low upload speeds), connections choke when rooms grow beyond 4–5 people.
2. **Offline & LAN Play**: Today, creating and joining rooms requires an active internet connection to reach the cloud signaling server (`3rtc.me`), even when all participants sit in the same room on the same local Wi-Fi or office network.
3. **Network Visibility**: Users cannot easily tell who is slowing down a call, who is on the same local network, who is routing through a distant TURN relay, or how "far" peers are technically from the host and from each other.
4. **GPU Contention & Stuttering During Screen Share**: Today, the desktop engine spawns an independent hardware encoder session for each viewer (`MAX_HW_VIEWERS = 4`) at up to 60 FPS at native resolution. When multiple viewers watch or a 3D game runs simultaneously, the GPU video engine (NVENC/AMF) and D3D device saturate, causing the entire Windows desktop, mouse, and games to hitch and stutter.

## Decision

We introduce **M7: Host Hub and LAN Rooms**, expanded with the **Topology Distance Map** and a **Hybrid GPU + CPU Screen Streaming Architecture**.

---

### 1. Host Hub Architecture (`Topology::Hub`)

A new `Topology` abstraction (`rtc_engine::topology` and `client-ts/src/webrtc/topology.ts`):
- **`Mesh` (Default / Fallback)**: Full P2P mesh for decentralized calls or when the room is hosted by a phone/browser.
- **`Hub` (Desktop Host as Relay / SFU)**:
  - Enabled when the room host is a desktop app with sufficient compute and bandwidth.
  - **Star Topology**: Guests connect **only to the Host** (1 peer connection per guest; the Host manages $N-1$ connections).
  - **Media Forwarding**:
    - **Screen & Video**: The sharing peer sends 1 upstream video track to the Host. The Host fans out the stream to all other viewers.
    - **Voice Audio**: Guests send 1 audio stream to the Host. The Host mixes or forwards the individual audio lines to guests.
    - **Data Channels**: Guest messages (`chat`, `reactions`, `game` actions) travel to the Host, which broadcasts them to the other guests.
  - **Seamless Fallback**: If the Host leaves or disconnects, the room automatically migrates back to `Mesh`, or another eligible desktop host takes over the Hub role without tearing down the call.

---

### 2. LAN Rooms (Offline & Local Discovery)

For zero-latency local collaboration without cloud dependency:
- **Local Discovery**:
  - The desktop app announces its room on the local subnet via UDP broadcast (or mDNS on local port `3872`): `3RTC-LAN { roomId, hostName, port }`.
  - Nearby devices on the same Wi-Fi see available local rooms in the Home screen under a new section: **"Rooms on your Wi-Fi"** (one-click join without typing codes).
- **Embedded Local Signaling**:
  - The desktop host runs a local lightweight WebSocket server bound to LAN IP for signaling.
  - When all peers are on the same LAN, ICE connects via direct `host` candidates (sub-3 ms latency, zero internet data usage).

---

### 3. The Topology & Technical Distance Map

A visual network radar and topology graph accessible from the room header and Network HUD:
- **What is "Technical Distance"?**
  In WebRTC, physical geographic distance matters less than network path health. Technical distance is calculated from:
  1. **Round-Trip Time (RTT / Ping)**: The round-trip time in milliseconds (sub-5 ms LAN, 20–50 ms near WAN, 100–250 ms overseas, >250 ms high latency).
  2. **Candidate Connection Type**:
     - ⚡ **Local LAN** (`host` candidate: direct subnet, no router traversal).
     - 🌐 **Direct P2P** (`srflx` / STUN: direct peer-to-peer over the public internet).
     - 🔄 **Relayed** (`relay` / TURN: packets bounced through a cloud relay server due to restrictive NAT).
  3. **Link Jitter & Packet Loss**: Line stability indicators.
- **Visual Display**:
  - **Concentric Distance Rings** radiating from the center:
    - Ring 0 (< 10 ms): *Local LAN*
    - Ring 1 (10–50 ms): *Near / Low Latency*
    - Ring 2 (50–120 ms): *Medium*
    - Ring 3 (120–250 ms): *Far / Cross-region*
    - Ring 4 (> 250 ms or TURN): *Relayed / High Latency*
  - **Nodes**: Avatars showing username, badge (`HOST`, `YOU`, `DESKTOP`, `PHONE`), and live ping.
  - **Perspective Toggle**:
    - **"View from Host"**: Shows every participant's distance from the Host (vital in Hub mode to see who is closest and who is struggling).
    - **"View from Me"**: Shows distances relative to your own device.
  - **Topology Lines**:
    - In **Mesh mode**: Interconnected web showing links between all peers.
    - In **Hub mode**: Clean star lines radiating from the Host hub to each peer, color-coded by link quality (Green = Direct P2P/LAN, Orange = Relayed, Red = Packet loss/Jitter).
  - **Peer Card Details**: Clicking any node or line reveals detailed link telemetry (local/remote IP type, protocol, loss %, jitter, and throughput).

---

### 4. Hybrid GPU + CPU Screen Streaming Architecture

To eliminate GPU contention and PC hitching during screen share:
- **Single Master GPU Encode ($1\times$)**:
  - The GPU encodes the screen **once** at the highest needed resolution (e.g. 1080p60).
  - Encoded H.264 NAL units are reused across all viewers at that tier instead of running separate hardware encoder instances per viewer. This cuts GPU encoding load by 66%–75%.
- **Dual-GPU Role Division**:
  - When both an integrated GPU (Intel QuickSync / AMD VCN) and a dedicated GPU (NVIDIA RTX / AMD Radeon) are present:
    - The dGPU renders the game and OS desktop at full speed.
    - The iGPU is targeted for the hardware MFT encoder, completely isolating the screen share from the gaming card.
- **CPU Software Encoding Tier / Fallback**:
  - For mobile viewers or bandwidth-constrained guests requiring lower resolutions (e.g. 720p or 480p), the CPU encodes the lower tier using multi-threaded software encoders, preventing the GPU from having to open additional encoding contexts.
  - When the GPU is under extreme 3D load, encoding can dynamically fall back to the CPU without interrupting the stream.
- **SRTP & Network Fan-out on CPU**:
  - The CPU handles frame packetization, SRTP encryption, and network fan-out.

---

### 5. Protocol & Signaling Changes

- **Signaling Messages (`server/signaling.js`, `protocol/src/signaling.rs`, `types/protocol.ts`)**:
  - `create-room`: accepts `topology: "mesh" | "hub"`.
  - `joined` / `room-created`: returns `topology: "mesh" | "hub"`, `hubPeerId?: string`.
  - `switch-topology { topology: "mesh" | "hub" }`: Host can toggle topology live.
- **Peer Messages (`docs/PROTOCOL.md`)**:
  - `net-topology-ping`: Peers periodically exchange link RTT and candidate pair types so the Topology Map can render distances between all peers even in Hub mode.

## Consequences

- **Web App Parity**: Web clients connect to the Host in Hub mode with reduced CPU and bandwidth, and render the Topology Map in the Network Diagnostics modal.
- **Desktop Efficiency**: Master GPU encoding and multi-GPU routing eliminate frame hitching while gaming.
- **Backwards Compatibility**: Rooms default to standard Mesh unless the host explicitly enables Hub mode or LAN hosting.
