# Tests

## Unit tests (fast, no browser)

```
cd client
npm test
```

Node's built-in test runner, no extra packages. `tests/unit/fakeRoom.js` wires several in-memory
"apps" together with fake data channels, so multi-person behaviour (shared state, the host
leaving, late joiners) is tested in milliseconds. Put tests for pure logic (game reducers,
parsers, the relay tree) here.

The signaling server has its own tests: `cd server && npm test`.

## Browser tests (real rooms, real WebRTC)

```
pip install playwright        # once
playwright install chromium   # once
python client/tests/e2e/run_all.py              # every suite (~10 min)
python client/tests/e2e/run_all.py queue        # just one: <name>_test.py
```

Needs Node with `npm install` done in `client/` and `server/`, and `ffmpeg` (it makes the test
videos and sounds on the first run). The runner starts what each suite needs and stops it at the
end; nothing has to be running before. If something already listens on port 8080 (a signaling
server you started), stop it: the connection test restarts the server on purpose.

| Suite | Covers |
|---|---|
| `connection` | two people: P2P link, bulk channel, voice, speaking ring, chat, signaling restart, ICE restart, rebuild, leaving |
| `chat_attach` | sending an image (desktop and phone) |
| `youtube_sync` | play / pause / seek sync, computer and phone |
| `youtube_unavailable` | blocked videos skipped and remembered |
| `host_controls` | "only I control playback", wake lock, chat timestamps |
| `queue` | Quick Watch queue buttons, Play queue, browse window, phone sheet |
| `activities` | start, shared state, late joiner, host lock, close, leave (dev sample activity) |
| `ludo` | lobby and rules, a real game (computer + phone), watchers, same board everywhere, a player leaving, taking a seat, late joiner |
| `room_basics` | reactions (incl. spam and flood limits, combos), soundboard, ping, vote to skip, leaving resets the room |
| `phone_layout` | phone screens (screenshots in `.out/phone`) |
| `stream` | sharing a local video: on-demand streaming, seeking, a hard-refreshed viewer |
| `stream_uneven` | a film with an uneven bitrate (heavy first half) plays straight through |
| `local_video_sync` | local video play / pause / seek sync |
| `media_session` | lock-screen / headset controls |
| `six_people` | a full room: mesh, voice bitrate, video through the relay tree |

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
