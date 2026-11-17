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
| `peer-identity` | `peerId, username, isHost, isMuted, proto, build, clientId, isReply?, playbackLock?` | sent when a channel opens; the other side replies with `isReply: true`. The host adds `playbackLock`. `build` is the app's build number (YYMMDD.HHMM, shown in the Peers tab; older apps leave it out). `clientId` is the app's stable id (same after a reload or rejoin, unlike `peerId`): games use it to give a returning player their seat back. |
| `peer-voice-status` | `peerId, sender, isMuted` | mic muted / unmuted |
| `peer-bye` | – | leaving on purpose (don't try to reconnect) |
| `net-ping` / `net-pong` | `pingId, sendTime` | latency probe (Network HUD) |

### Chat, reactions, soundboard
| type | fields |
|---|---|
| `chat` | `id, sender, isHost, text, replyTo?, mentions?` — `text` may use simple markdown (`**bold**`, `*italic*`/`_italic_`, `~~struck~~`, `` `code` ``) and `@Name` mentions, which older apps just show as typed. `replyTo {id, sender, text}`: the message it answers (`text` a plain snippet of at most 140 characters; receivers quote their own copy when they have it). `mentions`: the peer ids named with @Name (at most 10); those people get a notice. Malformed `replyTo`/`mentions` are dropped, the message kept. |
| `p2p-image-start` (bulk) | `id, transferId, fileName, fileSize, mimeType, caption, …`, then binary frames starting with `IMG1` |
| `reaction` | `id, emoji, lane, combo` (any single emoji: each person picks their own set of up to 10; receivers allow ~10 a second per person) |
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
| `media-action` | a link source: `action: load \| play \| pause \| seek \| close`, `media?` (load), `currentTime?, fromHost, byVote?` |
| `media-sync-state` | `media, queue, skipVotes`, and `currentTime, isPlaying` once its player knows them |
| `media-heartbeat` | `key, currentTime, isPlaying`: from the room's reference app (host, else smallest peer id) every 4 s, for the automatic re-sync (`features/playback/useDriftSync.js`) |

A link source (`media`) is `{ provider: 'vimeo' \| 'twitch' \| 'file' \| 'hls', url, title?, … }`. Apps
rebuild it from `url` (`normalizeMedia` in `features/media/sources.js`) and never trust the other
fields. YouTube and local files keep their own types so apps from before link sources still sync
them; older apps ignore `media-*` (they just don't see link videos).

Someone already watching the same video ignores a `*-sync-state` answer (it comes from a person who
just joined, whose player may still be at 0:00), except when it undoes a blocked change under the
host controls lock.

With the host controls lock on, apps drop `yt-action` / `local-video-action` / `media-action` play,
pause, seek, load and close from guests (`fromHost` false), except `byVote` ones.

### Queue
`queue-action` with `action`:
`add {item}`, `remove {itemId}`, `reorder {queue}`, `clear`, `play-item {itemId}`,
`next {nextVideoId, nextTitle, remainingQueue}`, `vote-skip {skipVotes}`, `vote-skip-passed`.
An item is `{ id, videoId, title, addedBy, timestamp }` (YouTube) or `{ id, media, title, addedBy, timestamp }`
(a link source; `nextVideoId` is then null).

### Sharing a local video (`features/playback/useStreamTransfer.js`)
| type | direction | fields |
|---|---|---|
| `p2p-stream-request` | viewer → everyone | `requester, fileName, supportsRange, canRelay, swarm?` |
| `p2p-stream-header` (bulk) | owner → viewer | `mode: 'range'` (on demand) with `streamNo, fileSize, blockSize, via?, swarm?`; or whole-file mode with `totalChunks` |
| `p2p-range-request` / `p2p-range-cancel` (bulk) | viewer → owner, relay, or another viewer | `streamNo, blocks, urgent?, swarm?` |
| `p2p-stream-complete` | owner → viewer | whole-file mode finished |
| `p2p-stream-cancel` | either | stop sending to me / I stopped sharing |
| `p2p-relay-gone` | relay → its child | I can't relay any more: fetch from the owner |
| `p2p-have` | viewer → everyone | `streamNo` and either `ranges: [first, last, first, last, …]` (all the blocks I hold; every 10 s and to newcomers) or `add, remove` (changes since the last one), plus `getting` (blocks I'm fetching from the owner right now, so others wait for me instead) |
| `p2p-range-miss` (bulk) | viewer → viewer | `streamNo, blocks`: I don't have these (any more), ask someone else |
| `p2p-swarm-gone` (bulk) | viewer → viewer | I stopped serving you blocks |
| `p2p-hash-request` (bulk) | viewer → owner | `streamNo, blocks` |
| `p2p-block-hashes` | owner → viewer | `streamNo, hashes: [[block, sha256 hex], …]` |

Binary frames on the bulk channel carry the blocks (`utils/p2pStreamer.js`).

Swarm (torrent-like): a viewer asks with `swarm: true`; an owner that knows it answers with
`swarm: true` in the header and serves that viewer directly (no relay tree). Such viewers announce
what they hold with `p2p-have` and ask each block from the least busy viewer that has it, the owner
being the fallback; a request to another viewer carries `swarm: true` and is answered only from
what it holds (`p2p-range-miss` otherwise), never fetched upstream. Each viewer fills its buffer
in its own order (past the next couple of blocks), so viewers watching together fetch different
parts from the owner and swap them. A block that came from another
viewer is used only if it matches the owner's SHA-256 for it; a viewer that sent a bad one is never
asked again. An older owner ignores `swarm` (relay tree as before); older viewers never send it, so
they keep using the tree, which only contains viewers like them.

### Whiteboard (`features/activities/whiteboard`)
Finished strokes are shared state (`act:whiteboard` and its chunks `act:whiteboard:<epoch>:<n>`).
While drawing, two messages that are not state:
| type | fields |
|---|---|
| `wb-live` | `e` (board epoch), `id, k, c, w`, `from` (how many numbers were sent before) and `pts` (the new ones), `name`; or `{ e, id, done: true }` when the stroke ends |
| `wb-cursor` | `x, y, name` (board units, at most ~12 a second), or `gone: true` |

### Cards in hand (Last Card)
Shared stores can pass `redact(state, peerId)` (core/sharedState.ts): every copy of the state sent to
a peer is made for that peer, so in Last Card each app receives its own hand and nobody else's. No new
message types.

### Stream doctor (`features/diagnostics/speedTest.ts`)
A test between two apps from the Network HUD. Every app answers; older apps ignore these types, and
no test data is sent to a peer before it answered `diag-hello`.
| type | direction | fields |
|---|---|---|
| `diag-hello` / `diag-hello-ok` | tester → peer → tester | `v, nonce`; the reply adds `device` (browser, cores, network hints) and `live` (that app's streaming numbers) |
| `diag-ping` / `diag-pong` | either | `t, n`: round trip on the control channel |
| `diag-burst` | tester → peer | `id, high, low, ms`: send test frames to me for `ms`, keeping the bulk channel's buffer between `low` and `high` bytes |
| `diag-burst-end` | peer → tester | `id, sender` (frames, time waiting on the buffer, drain time), `link` (its getStats view), or `error` |
| `diag-recv-end` / `diag-recv-result` | tester → peer → tester | after the tester sent frames: `id, frames`; the reply has `meter` (what arrived, gaps, speed) and `link` |
| `diag-stats` / `diag-stats-ok` | tester → peer → tester | `id`; the reply has `link, live, device` |

Test frames (bulk channel, binary): 16 KB, starting with `DGN1`, then the test id and a sequence
number (uint32, big-endian).

### Local file format (`features/files/useFileFormat.js`)
| type | direction | fields |
|---|---|---|
| `file-format` | sharer → everyone, and to each newcomer | `fileName, fileSize, format: { container, video, audio[], subtitles[], duration }` |
| `file-format-report` | viewer → sharer | `fileName, verdict: ok \| maybe \| no-video \| no-audio, message, device` |
| `file-subtitle-request` | viewer → sharer | `fileName, track`: read this subtitle track out of the file and share it |
| `file-subtitle-progress` | sharer → everyone | `fileName, track, progress, done?, error?` |

The subtitles themselves go out as the usual `local-video-action` `subtitle-share`. Apps rebuild the
format with `cleanFormat` (known fields, short strings, bounded lists) before using it.

### Screen sharing (`features/screenshare/useScreenShare.ts`, `ScreenPointerOverlay.tsx`)
The picture is the video line every connection has from the start; these say who shares and point at it.
| type | direction | fields |
|---|---|---|
| `screen-share-status` | sharer → everyone, and to each newcomer | `isSharing, peerId, username, hasAudio` |
| `screen-pointer` | anyone → everyone | `peerId, x, y` (0–1 across and down the picture), `username`, `active` (false: the pointer left) |
| `screen-ping` | anyone → everyone | `id, x, y, username, color, peerId`: a click (a ripple there) |
| `screen-quality` | desktop viewer → desktop sharer | `maxHeight`: the tallest picture this viewer wants (0: whatever is sent) |

`screen-quality` is the desktop app's only: a desktop sharer sends each viewer their own picture (its
own size and data rate, encoded by the GPU when H.264 is negotiated), and this is the viewer's choice
of size. The web app neither sends nor reads it; a web viewer gets at most 1440p from a desktop sharer.

**The shared screen's sound (desktop → desktop only).** A desktop sharer who shares with sound (all of
the PC's sound except 3RTC's own) adds a second audio line to each *desktop* viewer's connection while
sharing, in a media stream with id `screen-audio`, and sends a new offer on the open connection for it.
Its Opus is tuned for music: `stereo=1;sprop-stereo=1;maxaveragebitrate=256000;useinbandfec=1` on every
audio m-line after the first. The receiver tells it from the voice by that stream id. Web viewers never
get the line (the web app takes any incoming audio for the person's voice), and `hasAudio` in
`screen-share-status` is true only in the copy sent to desktop viewers.

**Webcam (`features/camera`, `webrtc/cameraLine.ts`).** An app that can show cameras says
`camera: true` in `peer-identity`. Between two such apps, the side that made the connection adds a
**second video line** once (after both identities are in) and sends a new offer for it; line order is
fixed, so on both ends the first video line is the shared screen and the next one is the camera.
Turning a camera on or off only swaps the track on that line (nothing is sent while it's off: no new
offer). A camera sends at most 640×360, 24 fps, 350 kbps. Apps that don't say `camera` never get the
line: they take any incoming video for the shared screen, so it must never reach them.
| type | direction | fields |
|---|---|---|
| `camera-status` | anyone → everyone, and to each newcomer while on | `on` (true or false) |

A tile is shown only when `camera-status` says on and the camera line's picture has arrived.

**QUIC file transfer (desktop → desktop only, `desktop/docs/adr/0009`).** Between two desktop apps,
files of 8 MB or more can go over a direct QUIC connection instead of the `bulk` channel. The web app
neither sends nor reads these (its types are listed in `types/protocol.ts` only to keep the lists the
same).
| type | direction | fields |
|---|---|---|
| `quic-offer` | sender → one receiver | `transferId, fileName, fileSize, sha256` (hex), `addrs` (`ip:port`, LAN and public), `certSha256` (hex: the only certificate the receiver accepts), `token` (hex, one-time), `relativePath?` (a folder's file: its path inside the folder, e.g. `Photos/2026/a.jpg`; the receiver cleans it and saves under Downloads) |
| `quic-answer` | receiver → sender | `transferId, addrs`, `offset` (bytes it already has, to resume; else 0) |
| `quic-fallback` | either way | `transferId, reason`: QUIC didn't connect (or was turned down); the file goes over the `bulk` channel as usual |

Both sides send a few small UDP packets to each other's `addrs` (hole punching), then the receiver
connects (ALPN `3rtc-file/1`), accepts only the certificate whose SHA-256 is `certSha256`, and sends
`token` and the 8-byte offset first on a stream; the sender checks the token before sending anything.
The receiver checks the whole file's SHA-256 at the end. Within 8 s of no connection: `quic-fallback`.

**Remote control (desktop → desktop only).** The web app neither sends nor reads these; a desktop app
offers it only when the sharer is on the desktop app.
| type | direction | fields |
|---|---|---|
| `screen-control` | desktop viewer ↔ desktop sharer | `action`, and for `state`: `peerId, username` (absent: nobody) |
| `screen-input` | the controlling viewer → the sharer | `e` (`move`, `button`, `wheel`, `key`), `x, y` (0–1 over the picture), `button` (0 left, 1 middle, 2 right), `down`, `dx, dy` (wheel, 1/120 notch, up and right positive), `vk` (Windows virtual-key code) |

`screen-control` actions: the viewer sends `request` (may I?), `cancel` (the request), `accept` or
`decline` (an offer) and `release` (I stop); the sharer sends `offer`, `grant`, `deny`, `revoke` (control
taken back, or an offer withdrawn) and `state` (who controls now) to every desktop viewer. The sharer
decides every time: control starts only with the sharer allowing a request or the viewer accepting the
sharer's offer, one viewer at a time. The sharer plays back `screen-input` only from the viewer it
granted control to, and ignores it from anyone else. Control ends when the sharer takes it back (a
button, Ctrl+Alt+Shift+X, or using their own mouse), the viewer releases it, either leaves, or the share
stops. Unknown actions and input kinds are ignored (rule 1).

### Shared state (`core/sharedState.js`): games, polls, the open activity
| type | fields | meaning |
|---|---|---|
| `room-state` | `key, v, state` | full state, version `v` (only higher versions are accepted). Sent by everyone who has a state to each peer whose channel opens, so a host who comes back gets the game it left. |
| `room-state-action` | `key, action` | to the authority (host, else smallest peer id) |
| `room-state-request` | `key` | "send me `key` if you have it" (a store created late); also says "I have it now" |
| `room-state-gone` | `key` | "I don't have `key`": someone who skipped or left a game. Sent when leaving it, to peers who connect, and in answer to that store's messages; the authority and `meta.present` for `key` leave them out until they send something for it again |

Keys in use: `activity` (which activity is open: `{ current: { id, startedBy, startedByName, startedAt } | null }`),
`act:<activity-id>` for each activity's own state, e.g. `act:ludo` (seats, rules, tokens, turn,
dice; actions `sit`, `stand`, `add-bot`, `clear-seat`, `rules`, `start`, `roll`, `move`, `auto`,
`again`, see `features/activities/ludo/rules.js`).

## Signaling messages (`server/signaling.js`)

Browser → server: `create-room {peerId}`, `create-room {roomId, peerId, hostToken, seatToken?}`
(the host getting its room back), `join {roomId, peerId, rejoin?, seatToken?}`, `leave`,
`offer {targetId, offer, fresh?, iceRestart?}`, `answer {targetId, answer}`,
`ice-candidate {targetId, candidate}` (`candidate` is accepted too), `ping`,
`find-room {roomId}` (is that room on this server? limited like a join), `transfer-host {targetPeerId}`
(the host makes someone in the room the host).

Server → browser: `room-created {roomId, peerId, hostPeerId, seatToken, hostToken}`,
`room-resumed {roomId, peerId, peers, hostPeerId, seatToken, hostToken}`,
`joined {roomId, peerId, peers, hostPeerId, seatToken}`, `host {hostPeerId, from?, reason?}` (the host got the room back,
maybe with a new peer id; with `from`: `from` handed the room to `hostPeerId`; with `reason: "host-left"`:
the host left and the server picked the next host), `host-token {roomId, hostToken}`
(to the new host after a transfer), `peer-joined {peerId}`, `peer-left {peerId}`, `left`, `offer / answer / ice-candidate {from, …}`,
`pong`, `room-found {roomId, exists}`, `error {message, code?}` (`code`: `resume-denied`, `seat-taken`,
`room-full`, `not-found`, `server-busy`, `rate-limited`, `not-host`, `target-not-found`).

**Seats** (`server/seats.js`): peer ids are public (everyone in the room sees them), so naming one
proves nothing. The server signs a **seat token** (this peer id in this room) and, for the host, a
**host token** (this room, any peer id), and checks them when someone comes back:
- a peer id held by another live connection is only given to someone with its seat token (a peer
  whose signaling dropped reclaims its own seat);
- `create-room` with a code (resume) needs the room's host token: after a signaling drop, a server
  restart, a page reload (new peer id; the app saves the token with "Rejoin room"), or Leave then
  Rejoin. The host token is enough for the host's own seat or a free one, not for a guest's live seat;
- `join` with `rejoin` brings back a room that's gone (server restart) only with a seat token for it.
Tokens name the room instance (a random id given at creation), so a token from an earlier room with
the same code doesn't work on a new one, and they expire after 24 hours. They are signed with the
server's secret (`SIGNAL_SECRET`, or `.signal-secret` made on first start in production), so they
survive restarts. The app sends tokens only back to the server, never to peers.

**Handing the room on** (`transfer-host`): only the peer the server knows as host may do it, to someone
connected in the room. The room's **host generation** goes up by one; host tokens name it (`v2.` tokens;
generation 0 keeps the `v1.` form), and the server refuses a host token of an earlier generation, so the
old host can't take the room back (its seat token still works: it stays as a guest). After a server
restart a room brought back by a guest has no generation yet: the first valid host token sets it, and a
later generation still wins.

**When the host leaves** (its connection ends while others are still in the room), the server keeps
the room for it for `HOST_HANDOVER_GRACE_MS` (20 s): a host that comes back in time (Wi-Fi blip,
reload, Leave then Rejoin with its host token) stays host. Otherwise whoever has been in the room
longest becomes the host, as with `transfer-host`: the host generation goes up, the new host gets
`host-token`, and everyone gets `host {hostPeerId, reason: "host-left"}` (no `from`, so apps that
don't know `reason` just update the host without a notice). The old host can come back as a guest. A
hub room becomes a mesh again (`topology-changed`), since its hub is gone.

**Several servers** (Oracle first, then GCP): rooms live in the memory of the server they were made
on. Both servers must use the **same secret** (the deploy scripts upload `server/.signal-secret`,
made once and git-ignored, to each), so when the app falls back to the other server the host's and
guests' tokens still work there and the room comes back. And before telling someone a code doesn't
exist, the app asks the other servers (`find-room`) and moves to the one that has the room
(`webrtc/findRoom`), staying on it for reconnects.

**Who is the host** comes from the server (`hostPeerId`: whoever made the room or got it back with
its host token; `null` when not known, e.g. a room brought back by a guest until the host returns).
Apps don't trust what a peer says about itself: `isHost` in any peer message is replaced on arrival
with "is this connection the server's host" (`webrtc/peerMessages.js`), so the HOST badge, host
controls and the shared-state tiebreak can't be claimed. Chat and image messages take the sender's
name and host flag from the connection and keep only their own fields; names from peers are cleaned
(`utils/names.js`). With an older server that doesn't send `hostPeerId`, peers' claims are used.

HTTP: `GET /api/link-preview?url=…` (chat link previews, `server/linkPreview.js`): `{ url, title, description, image, siteName }` from the page's Open Graph tags or `<title>` (YouTube through oEmbed), 404 when there's none, 429 past 30 a minute per address. The server fetches only public http(s) addresses on standard ports (checked again after DNS and on each redirect), reads at most 512 KB, and caches results; `image` is https only.

HTTP: `GET /api/quick-picks?region=IN` (cached YouTube picks, CORS open): `{ updatedAt, region, regions, categories }`. Trending rows are that country's charts (`region` is one of `regions`), or a worldwide mix (`region: 'GLOBAL'`) for any other or no country; the app asks for the worldwide mix unless the viewer picked a country in "Trending in".
