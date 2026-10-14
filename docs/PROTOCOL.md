# 3RTC message protocol

Two kinds of messages: **signaling** (browser ↔ signaling server, WebSocket) and **peer**
(browser ↔ browser, WebRTC data channels). All are JSON objects with a `type`, except binary
file/video frames on the bulk channel.

## Rules that keep every version working together

1. **Ignore what you don't know.** Every app drops unknown `type`s and unknown fields silently.
   That is what makes adding a feature safe for people who haven't updated yet.
2. **Never rename or repurpose** a shipped `type` or field. Add a new field or a new type.
3. **New feature → new type**, prefixed with the feature (`chess-…`), or use shared state
   (`room-state*`) and pick a key; activities use `act:<activity-id>`.
4. Senders add `sender` (display name) and `timestamp`; the bus does this for you. Trust the
   peer id the message *arrived from*, not names inside it, for anything that matters.
5. Keep main-channel messages small (well under 16 KB). Files and video go on the bulk channel.
6. `PROTOCOL_VERSION` (in `peer-identity` as `proto`) changes only for a break older apps can't
   ignore. Current: **2**. (Apps from before the field existed count as 1.)

## Peer messages (main channel unless noted)

### Connection (handled in `webrtc/peerMessages.js`)
| type | fields | meaning |
|---|---|---|
| `peer-identity` | `peerId, username, isHost, isMuted, proto, isReply?, playbackLock?` | sent when a channel opens; the other side replies with `isReply: true`. The host adds `playbackLock`. |
| `peer-voice-status` | `peerId, sender, isMuted` | mic muted / unmuted |
| `peer-bye` | – | leaving on purpose (don't try to reconnect) |
| `net-ping` / `net-pong` | `pingId, sendTime` | latency probe (Network HUD) |

### Chat, reactions, soundboard
| type | fields |
|---|---|
| `chat` | `id, sender, isHost, text` |
| `p2p-image-start` (bulk) | `id, transferId, fileName, fileSize, mimeType, caption, …`, then binary frames starting with `IMG1` |
| `reaction` | `id, emoji, lane, driftVariant, scale, rot` |
| `soundboard-sfx` | `soundId, soundName, emoji` |

### Playback
| type | fields |
|---|---|
| `yt-action` | `action: load \| play \| pause \| seek \| close \| unload`, `newVideoId?, title?, currentTime?, fromHost, byVote?` |
| `local-video-action` | `action: load \| close \| play \| pause \| seek \| subtitle-share \| …`, `fileName?, fileSize?, currentTime?, fromHost` |
| `room-settings` | `playbackLock` (from the host only) |
| `yt-request-sync` | – "what are you watching?" (sent on every new channel) |
| `yt-sync-state` | `videoId, currentTime, isPlaying, queue, skipVotes, activeVideoTitle` or `{ videoId: null, nothingPlaying: true }` |
| `local-video-sync-state` | `mediaType: 'local', fileName, fileSize, currentTime, isPlaying, subtitleInfo?` |

With the host controls lock on, apps drop `yt-action` / `local-video-action` play, pause, seek,
load and close from guests (`fromHost` false), except `byVote` ones.

### Queue
`queue-action` with `action`:
`add {item}`, `remove {itemId}`, `reorder {queue}`, `clear`, `play-item {itemId}`,
`next {nextVideoId, nextTitle, remainingQueue}`, `vote-skip {skipVotes}`, `vote-skip-passed`.
An item is `{ id, videoId, title, addedBy, timestamp }`.

### Sharing a local video (`features/playback/useStreamTransfer.js`)
| type | direction | fields |
|---|---|---|
| `p2p-stream-request` | viewer → everyone | `requester, fileName, supportsRange, canRelay` |
| `p2p-stream-header` (bulk) | owner → viewer | `mode: 'range'` (on demand) with `streamNo, fileSize, blockSize, via?`; or whole-file mode with `totalChunks` |
| `p2p-range-request` / `p2p-range-cancel` (bulk) | viewer → owner or relay | `streamNo, blocks, urgent?` |
| `p2p-stream-complete` | owner → viewer | whole-file mode finished |
| `p2p-stream-cancel` | either | stop sending to me / I stopped sharing |
| `p2p-relay-gone` | relay → its child | I can't relay any more: fetch from the owner |

Binary frames on the bulk channel carry the blocks (`utils/p2pStreamer.js`).

### Shared state (`core/sharedState.js`): games, polls, the open activity
| type | fields | meaning |
|---|---|---|
| `room-state` | `key, v, state` | full state, version `v` (only higher versions are accepted) |
| `room-state-action` | `key, action` | to the authority (host, else smallest peer id) |
| `room-state-request` | `key` | "send me `key` if you have it" (a store created late) |

Keys in use: `activity` (which activity is open: `{ current: { id, startedBy, startedByName, startedAt } | null }`),
`act:<activity-id>` for each activity's own state.

## Signaling messages (`server/server.js`)

Browser → server: `create-room {peerId}`, `join {roomId, peerId}`, `leave`,
`offer {targetId, offer, fresh?, iceRestart?}`, `answer {targetId, answer}`,
`ice-candidate {targetId, candidate}` (`candidate` is accepted too), `ping`.

Server → browser: `room-created {roomId}`, `room-resumed {roomId, peers}`, `joined {roomId, peers}`,
`peer-joined {peerId}`, `peer-left {peerId}`, `left`, `offer / answer / ice-candidate {from, …}`,
`pong`, `error {message}`.

HTTP: `GET /api/quick-picks` (cached YouTube picks, CORS open).
