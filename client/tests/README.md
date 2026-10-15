# Tests

## Unit tests (fast, no browser)

```
cd client
npm test
```

Node's built-in test runner, no extra packages. `tests/unit/fakeRoom.js` wires several in-memory
"apps" together with fake data channels, so multi-person behaviour (shared state, the host
leaving, late joiners) is tested in milliseconds. Put tests for pure logic (game reducers,
parsers, the relay tree, the stream swarm, MKV/MP4 headers) here.

The signaling server has its own tests: `cd server && npm test`.

## Browser tests (real rooms, real WebRTC)

```
pip install playwright        # once
playwright install chromium   # once
python client/tests/e2e/run_all.py              # every suite (~25 min)
python client/tests/e2e/run_all.py queue        # just one: <name>_test.py
```

Needs Node with `npm install` done in `client/` and `server/`, and `ffmpeg` (it makes the test
videos and sounds on the first run). The runner starts what each suite needs and stops it at the
end; nothing has to be running before. If something already listens on port 8080 (a signaling
server you started), stop it: the connection test restarts the server on purpose.

| Suite | Covers |
|---|---|
| `connection` | two people: P2P link, bulk channel, voice, speaking ring, chat, signaling restart, ICE restart, rebuild, leaving |
| `devices` | choosing the microphone and speaker: quick menu by the mic button and Audio settings, the chosen mic used and switched live, voices and new media on the chosen speaker, mic test, remembered after a reload |
| `chat_attach` | sending an image (desktop and phone); links in messages open in a new tab, message text can be selected and copied |
| `youtube_sync` | play / pause / seek sync, computer and phone |
| `youtube_unavailable` | blocked videos skipped and remembered |
| `host_controls` | "only I control playback", wake lock, chat timestamps |
| `queue` | Quick Watch queue buttons, Play queue, browse window, phone sheet |
| `quick_picks_region` | trending is a worldwide mix by default; "Trending in" switches to a country (remembered); India's rows first when India is chosen |
| `activities` | start, shared state, late joiner, host lock, close, leave (dev sample activity) |
| `ludo` | lobby and rules, a real game (computer + phone), watchers, same board everywhere, a player leaving, taking a seat, late joiner |
| `ludo_stack` | phone: tokens sharing a square stay visible, the movable ones on top, tapping one moves exactly that one (rigged dice) |
| `ludo_rejoin` | the host reloads and rejoins (lobby and mid-game): gets the game, its colour back, stays in charge; the guest keeps its colour and gets no host buttons |
| `ludo_video` | a video starts mid-game: the game becomes a small window on the computer (drag, resize, full size, minimise to a bubble) and a bubble on the phone that pulses "Your turn", opens over the video and goes away on Back; ending the video brings the game back full size |
| `room_basics` | reactions (incl. spam and flood limits, combos), soundboard, ping, vote to skip, leaving resets the room |
| `phone_layout` | phone screens (screenshots in `.out/phone`) |
| `back_button` | phone Back: closes what's open, asks before leaving, never closes a video or game; room code in the address; Rejoin (guest and host); closing the tab mid-video asks |
| `stream` | sharing a local video: on-demand streaming, seeking, a hard-refreshed viewer |
| `media_links` | paste anything: video files, HLS, Vimeo, Twitch in sync (computer + phone), late joiner, queue, unplayable links explained, host lock, automatic re-sync (links and YouTube) |
| `stream_uneven` | a film with an uneven bitrate (heavy first half) plays straight through |
| `local_video_sync` | local video play / pause / seek sync |
| `file_format` | format check (AC-3 audio: "no sound" for viewers before they stream, and who is affected for the sharer; AVI won't play), MKV subtitle tracks picked by anyone and shared (SRT and ASS), late joiner gets the format |
| `swarm` | viewers fetch the film from each other (owner sends far less), a viewer sending damaged blocks is caught by the owner's checksums and ignored, an older app in the same room still streams, a viewer leaving |
| `media_session` | lock-screen / headset controls |
| `six_people` | a full room: mesh, voice bitrate, video shared between the viewers |

Output (logs per suite, screenshots, generated media): `client/tests/e2e/.out/`.

**Streaming on a realistic connection** (not part of `run_all`, takes minutes):
`python client/tests/e2e/stream_bench.py [seconds] [MB/s] [one-way delay ms] [freeze s] [file]`
plays a film with calm and heavy scenes over a simulated internet link (speed limit, delay, a
short freeze every 20 s) and reports how often and how long the viewer's video stalled. Put your
own file in `.out/media` to try it.
Each suite can also be run on its own: `python client/tests/e2e/queue_test.py`.

`harness.py` holds the shared setup (servers, media, `check`, `wait`). The YouTube player is
replaced by a stand-in in the YouTube suites (`INIT` in `youtube_sync_test.py`), and quick picks
come from a fake YouTube API (`fixtures/fake_youtube.mjs`), so no test touches the real YouTube.
