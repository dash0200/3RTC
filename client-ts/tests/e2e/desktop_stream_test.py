"""Desktop ↔ web: streaming a video file to someone who doesn't have it (the block protocol).

The desktop engine (examples/chat) stands in for the desktop app: `/share <path>` plays a real
file and offers it; `/stream <name>` streams the room's file the way mpv reads it (the end first,
then front to back) and prints `STREAM_READ <bytes> <fnv64>` when it has read it all.

1. The desktop shares a 21 MB MP4: the browser presses "Stream from Darshan" and plays it (range
   mode, blocks served from the desktop's disk; the browser asks as a swarm viewer, so the
   desktop also answers its checksum requests), seeks near the end and keeps playing.
2. The browser shares the file: the desktop streams all of it, byte for byte.
3. The owner stops: the viewer is told.
4. A browser that can't play on demand (no service worker) gets the whole file pushed.
Needs the desktop example built: `cargo build -p rtc-engine --example chat` in desktop/ (skipped if not)."""
import os, re, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CLI = harness.REPO / 'desktop' / 'target' / 'debug' / 'examples' / ('chat.exe' if harness.IS_WIN else 'chat')
if not CLI.exists():
    print(f'skipping: build {CLI} first')
    sys.exit(0)

BASE = harness.preview()  # the built app: its service worker plays on demand
DEV = harness.dev()       # the dev server has none: there the whole file is pushed
SIGNAL = harness.signaling()
FILE = harness.media('test.mp4')
NAME = os.path.basename(FILE)
SIZE = os.path.getsize(FILE)
V = "document.querySelector('video.local-video-element')"
errors = []


def fnv(path):
    h = 0xcbf29ce484222325
    with open(path, 'rb') as f:
        for b in f.read():
            h = ((h ^ b) * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return f'{h:016x}'


class Desktop:
    def __init__(self, room=None):
        self.out = []
        args = [str(CLI), SIGNAL, 'Darshan'] + ([str(room)] if room else [])
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, env=dict(os.environ, RUST_LOG='warn'))
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.out.append(re.sub(r'\x1b\[[0-9;]*m', '', line.rstrip()))

    def say(self, cmd):
        self.proc.stdin.write(cmd + '\n'); self.proc.stdin.flush()

    def saw(self, pattern, since=0):
        return next((m for m in (re.search(pattern, l) for l in self.out[since:]) if m), None)

    def mark(self):
        return len(self.out)

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def vs(pg):
    return pg.evaluate(f"(() => {{ const v = {V}; return v ? {{ t: +v.currentTime.toFixed(2), paused: v.paused, rs: v.readyState, d: v.duration }} : null; }})()")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    web.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.goto(BASE); wait(lambda: web.evaluate('!!navigator.serviceWorker.controller'), 10)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    d = Desktop(room)
    try:
        check('desktop joins and connects', wait(lambda: d.saw(r'members=Riya\+'), 25), d.out[-3:])
        time.sleep(2)

        # ---- 1. the desktop's file, streamed to the browser ----
        m = d.mark()
        d.say(f'/share {FILE}')
        check('desktop shares a file: the browser offers "Stream from Darshan"',
              wait(lambda: web.get_by_role('button', name='Stream from Darshan').count() > 0, 10))
        web.get_by_role('button', name='Stream from Darshan').click()
        check('...the desktop serves it on demand, the browser as a swarm viewer',
              wait(lambda: d.saw(r'LOG 📡 Streaming .* to Riya \(shared between viewers\)', m), 10), d.out[-4:])
        check('...the browser can play it (metadata and first frames arrive)',
              wait(lambda: (vs(web) or {}).get('rs', 0) >= 2, 25), vs(web))
        web.evaluate(f'{V}.muted = true; {V}.play()')
        check('...and it plays', wait(lambda: (vs(web) or {}).get('t', 0) > 1.5, 15), vs(web))
        dur = (vs(web) or {}).get('d') or 0
        web.evaluate(f'{V}.currentTime = {max(0, dur - 8):.1f}')
        check('...a seek near the end plays on (blocks fetched out of order)',
              wait(lambda: (vs(web) or {}).get('t', 0) > dur - 6 and (vs(web) or {}).get('rs', 0) >= 2, 20), vs(web))
        m = d.mark()
        d.say('/exit')
        d.say('/unshare')
        check('desktop stops: the browser closes the video', wait(lambda: web.locator('video.local-video-element').count() == 0, 10))
        time.sleep(1.5)

        # ---- 2. the browser's file, streamed to the desktop ----
        m = d.mark()
        web.locator('input[accept*=".mp4"]').first.set_input_files(FILE)
        check('browser opens a file: the desktop sees it',
              wait(lambda: d.saw(rf'WATCH showing=local:{re.escape(NAME)}:{SIZE}', m), 10), d.out[-3:])
        time.sleep(1)
        d.say(f'/stream {NAME}')
        check('desktop asks: the browser starts a stream', wait(lambda: d.saw(rf'STREAM_READY {SIZE} {re.escape(NAME)}', m), 15), d.out[-4:])
        hit = wait(lambda: d.saw(r'STREAM_READ (\d+) ([0-9a-f]+)', m), 90)
        want = fnv(FILE)
        check('...and the desktop reads the whole file through it, byte for byte',
              hit and int(hit.group(1)) == SIZE and hit.group(2) == want,
              (hit.group(0) if hit else d.out[-4:], want))

        # ---- 3. the owner stops ----
        m = d.mark()
        web.evaluate("document.querySelector('[aria-label*=\"Exit\" i], button[title*=\"Exit\" i]')?.click()")
        if not wait(lambda: d.saw(r'STREAM_ENDED', m), 4):
            web.get_by_role('button', name=re.compile('Exit', re.I)).first.click()
        check('browser exits: the desktop is told the stream stopped', wait(lambda: d.saw(r'STREAM_ENDED', m), 10), d.out[-4:])

        # ---- 4. a browser without on-demand playback: the whole file is pushed ----
        old = b.new_context(viewport={'width': 1200, 'height': 800}).new_page()
        old.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Mia');")
        old.on('pageerror', lambda e: errors.append(str(e)))
        old.goto(f'{DEV}?room={room}'); old.wait_for_timeout(1500)
        old.get_by_role('button', name='Join room').click()
        check('a third person (dev page) joins', wait(lambda: d.saw(r'members=.*Mia\+'), 25), d.out[-2:])
        time.sleep(2)
        m = d.mark()
        d.say(f'/share {FILE}')
        wait(lambda: old.get_by_role('button', name='Stream from Darshan').count() > 0, 10)
        old.get_by_role('button', name='Stream from Darshan').click()
        check('...asks without on-demand playback: the desktop pushes the whole file',
              wait(lambda: d.saw(r'LOG 📡 Peer "Mia" requested video stream', m), 10), d.out[-4:])
        check('...and it plays once it has all of it',
              wait(lambda: (vs(old) or {}).get('rs', 0) >= 2, 60), vs(old))
    finally:
        d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
