# 3RTC architecture

3RTC is a peer-to-peer watch party. Browsers connect **directly to each other** (WebRTC); the only
server is a small signaling server that introduces them and caches YouTube quick picks. This page
explains how the code is organised so new features can be added without reshaping what's there.

## The three layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ features/*        chat · reactions · soundboard · queue · playback ·      │
│                   host controls · activities (games)                      │
│                   Each owns its state and its message types.              │
├──────────────────────────────────────────────────────────────────────────┤
│ core/*            roomBus (send / receive / local events)                 │
│                   sharedState (one synced value per key, for games etc.)  │
│                   RoomContext (React access: useRoom, usePeerMessage...)  │
├──────────────────────────────────────────────────────────────────────────┤
│ webrtc/*          usePeerMesh: signaling socket, one RTCPeerConnection    │
│                   per person, data channels, voice, recovery, leaving     │
└──────────────────────────────────────────────────────────────────────────┘
        components/*  (UI, gets data and callbacks as props)   App.jsx (wiring + layout)
```

**Rule of thumb:** a feature talks to other people only through the bus, and never touches
`RTCPeerConnection` or data channels. The connection layer knows nothing about features.

### webrtc/ — the connection layer

| File | Job |
|---|---|
| `usePeerMesh.js` | The hook App uses. Owns room id, host flag, peer count, the peer map; creates connections, cleans them up, leaves rooms. Feeds the bus. |
| `signalingMessages.js` | Messages from the signaling server: room created / joined, offer / answer / ICE. |
| `peerMessages.js` | Everything arriving on a data channel. Handles only `peer-bye`, `peer-identity`, `peer-voice-status`, then hands every message to `bus.dispatch`. |
| `peerRecovery.js` | ICE restarts and rebuilding broken connections. |
| `remoteAudio.js`, `sdp.js`, `peerEntry.js` | Voice playback, codec tuning, teardown. |
| `streamTree.js` | Relay tree for sharing a local video with viewers on older apps (pure functions); newer viewers use the swarm in `utils/p2pStreamer.js`. |
| `config.js` | ICE servers, room size, protocol version, recovery timings. |

Each peer has two data channels: **main** (JSON, small, ordered: chat, sync, games) and **bulk**
(id 512, files and video), so a big transfer never delays a chat message or a chess move.

### core/ — shared plumbing

- **`roomBus.js`**: `broadcast(type, payload)`, `send(peerId, type, payload)`,
  `on(type, handler)`, `onBinary(handler)`, and local events `onEvent / emitEvent`
  (`peer-open`, `peer-close`, `channel-close`, `room-left`, `media-changed`). No React, no WebRTC:
  unit-tested with fake channels.
- **`sharedState.js`**: a value every person sees the same, changed by actions. One peer, the
  **authority** (the host, or the smallest peer id if the host is away), runs a reducer that
  accepts or rejects each action and broadcasts the result. Handles late joiners, versioning and
  the host leaving. Games are built on this.
- **`RoomContext.jsx`**: `useRoom()`, `usePeerMessage(type, fn)`, `useBusEvent(name, fn)`,
  `useSharedState(key, { initial, reducer })` for components. Hooks called in App use the `...On`
  variants with the room passed in.
- **`backStack.js`**: the Back button in a room. One guard entry in the browser history keeps
  Back inside the app; each press closes the last thing opened (`useBackLayer(isOpen, close)`),
  or with nothing open asks "Leave room?". The address carries `?room=` while in a room. Videos
  and the open game are never closed by Back.

The **room object** (built once in `App.jsx`) is what every feature receives:

```js
room.bus                 // the bus
room.getSelf()           // { peerId, username, isHost }
room.getSelfId()
room.isPeerHost(peerId), room.getHostPeerId(), room.peerName(peerId), room.peerProtocol(peerId)
room.getAuthorityId()    // who runs shared-state reducers
room.getRoomSettings()   // { playbackLock }
room.notify(text)        // toast
room.log(text)           // Logs tab (keeps the last 200)
```

Through `useRoom()` components also get `roomId`, `isHost`, `username`, `peers`, `playbackLock`.

### features/ — what users see

| Folder | What | Message types |
|---|---|---|
| `notices/` | toasts and the Logs tab | – |
| `chat/` | messages, images, unread count | `chat`, `p2p-image-start`, binary `IMG1` |
| `reactions/` | floating emoji | `reaction` |
| `soundboard/` | shared sound clips | `soundboard-sfx` |
| `playback/usePlayback` | what's playing (YouTube, a local file, or a link source), play/pause/seek/load | `yt-action`, `local-video-action`, `media-action` |
| `playback/useDriftSync` | automatic re-sync: quietly corrects anyone more than 1.5 s off, for every source | `media-heartbeat` |
| `media/` | "paste anything": `sources.js` (what a link is), `adapters/` (one small player per source: Vimeo, Twitch, `<video>` + hls.js), `LinkPlayer.jsx` (the sync engine for link sources) | `media-action`, `media-sync-state` |
| `playback/useHostControls` | "only I control playback" lock | `room-settings` (+ field in `peer-identity`) |
| `playback/useMediaSync` | catching up people who join | `yt-request-sync`, `yt-sync-state`, `local-video-sync-state`, `media-sync-state` |
| `playback/useStreamTransfer` | sharing a local video P2P: on-demand blocks, fetched from the owner and (swarm) from other viewers, checked against the owner's SHA-256 | `p2p-*`, binary chunks |
| `files/` | what's inside a local video (`formats.js`: MP4/MOV/MKV/WebM headers, can this browser play it), subtitle tracks read out of an MKV in a worker, the warning / subtitle-picker card | `file-format`, `file-format-report`, `file-subtitle-*` |
| `queue/` | watch queue, vote to skip | `queue-action` |
| `activities/` | games and other things to do together | `room-state*` (via sharedState) |

Features talk to each other through explicit arguments (the queue gets `playback` and
`hostControls`) or bus events (`media-changed` clears skip votes), never through shared globals.

## The server (`server/`)

| File | Job |
|---|---|
| `server.js` | Entry point: HTTP (quick picks endpoint; in production redirects page visits to 3rtc.me), starts the two below |
| `signaling.js` | WebSocket rooms (5-digit codes, up to `MAX_ROOM_USERS`), relays offer / answer / ICE, heartbeat |
| `quickPicks.js` | Fetches YouTube quick picks on a daily-quota budget (trending charts for 10 countries + a worldwide mix, search rows for everyone), caches them, serves `GET /api/quick-picks?region=` |
| `seats.js` | Signed seat and host tokens: who may reclaim a seat or get a room back (see PROTOCOL.md, Seats) |
| `log.js` | Timestamped log lines |
| `deploy_gcp.py` | Creates or updates the VM; uploads every file in `SERVER_FILES` (add new server files there) and installs `webrtc-signaling.service` |
| `webrtc-signaling.service` | systemd unit: runs as the unprivileged `webrtc` user, Node on 127.0.0.1:8080 behind Caddy (only 80/443/8443 are public) |

The server never sees chat, video or game traffic: that all goes browser to browser.

**Who to trust.** Anything a peer's app sends could be made up, so identity comes from the server:
it assigns seats (a peer id is only reclaimed with its seat token) and says who the host is
(`hostPeerId`). The apps replace `isHost` on every incoming peer message with the server's answer
and take chat names from the connection (`webrtc/peerMessages.js`). Text from peers is shown as text
(React escapes it; links are `http(s)` only). When adding a feature, check host-only actions with
`room.isPeerHost(fromPeerId)`, never with a field in the message.

## Lifecycles

- **A peer's channel opens** → we send our identity → `peer-open` event → media sync asks what
  they're watching, shared stores send their state.
- **A message arrives** → `peerMessages.js` → `bus.dispatch` → every handler for that type.
- **A peer goes away** → `peer-close` event → streams to/from them stop, relay children move.
- **We leave** → `usePeerMesh.leaveRoom()` → `room-left` event → every feature resets itself.
  App doesn't need to know what each feature holds.

## Compatibility between versions

People in one room may run different app versions (cached PWA). So:

- Unknown message types are ignored, so adding a type never breaks older apps.
- Existing message fields are never renamed or given a new meaning; add new fields instead.
- `peer-identity` carries `proto` (`PROTOCOL_VERSION` in `webrtc/config.js`) for the rare change
  that older apps can't ignore.
- An activity started from a newer app shows "Update app" on older ones instead of failing.

See [PROTOCOL.md](PROTOCOL.md) for every message.

## Performance rules

- Activity code is lazy-loaded (`import()`), so games add nothing to the first load.
- Small JSON on the main channel, anything large on the bulk channel.
- Lists that grow during a session are capped (logs 200, reactions 25).
- Production builds strip `console.*` (`vite.config.js`).

## Tests

- `client/tests/unit` (Node's built-in test runner, no extra packages): bus, shared state (with an
  in-memory multi-peer network in `fakeRoom.js`), activities, relay tree, chat timestamps.
  `npm test` in `client/`.
- `server/tests`: the signaling server (rooms, joining, size limit, relaying). `npm test` in `server/`.
- `client/tests/e2e` (Python + Playwright): real browsers in real rooms: connection and recovery,
  six-person rooms, streaming, sync, host controls, queue, phone layout, activities.
  `python client/tests/e2e/run_all.py`. See `client/tests/README.md`.

Adding something? Read [ADDING_A_FEATURE.md](ADDING_A_FEATURE.md).
