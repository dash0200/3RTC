"""Desktop ↔ web: a video file from someone's computer, kept in sync.

Each side plays its own copy of the same file (the web app's "I have this file"; the desktop's
"use my copy"); only the name, size and play / pause / seek travel. The desktop engine
(examples/chat) stands in for the desktop app's player: `/file <size> <name>` opens the file,
`/play`, `/pause`, `/seek` act as a person at its player would, `PLAYER …` lines are what its
player is told. Streaming the file itself (p2p-*) is the next step and isn't covered here.
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

BASE = harness.dev()
SIGNAL = harness.signaling()
FILE = harness.media('test_small.mp4')
NAME = os.path.basename(FILE)
SIZE = os.path.getsize(FILE)
V = "document.querySelector('video.local-video-element')"
errors = []


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
    return pg.evaluate(f"(() => {{ const v = {V}; return v ? {{ t: +v.currentTime.toFixed(2), paused: v.paused, rs: v.readyState }} : null; }})()")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    web.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.goto(BASE); web.wait_for_timeout(1200)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    d = Desktop(room)
    try:
        check('desktop joins and connects', wait(lambda: d.saw(r'members=Riya\+'), 25), d.out[-3:])
        time.sleep(1.5)

        # ---- the desktop plays a file; the browser picks its own copy ----
        m = d.mark()
        d.say(f'/file {SIZE} {NAME}')
        check('desktop opens a file: its player opens it, paused at the start',
              wait(lambda: d.saw(rf'PLAYER open local:{re.escape(NAME)}:{SIZE} t=0\.0 playing=false', m), 5), d.out[-3:])
        check('...the browser offers it ("Darshan is playing")',
              wait(lambda: 'Darshan is playing' in web.locator('body').inner_text() and NAME in web.locator('body').inner_text(), 10))
        web.locator('input[accept*=".mp4"]').first.set_input_files(FILE)
        check('...the browser plays its own copy', wait(lambda: (vs(web) or {}).get('rs', 0) >= 1, 10), vs(web))
        time.sleep(1.5)
        d.say('/play 5')
        check('desktop plays at 0:05: the browser plays from there',
              wait(lambda: not (vs(web) or {'paused': True})['paused'] and vs(web)['t'] >= 4.5, 8), vs(web))
        time.sleep(1.5)
        d.say('/pause 9')
        check('desktop pauses at 0:09: the browser pauses there',
              wait(lambda: (vs(web) or {}).get('paused') and abs(vs(web)['t'] - 9) < 1, 8), vs(web))
        d.say('/seek 20')
        check('desktop seeks to 0:20: the browser follows', wait(lambda: abs((vs(web) or {}).get('t', 0) - 20) < 1, 8), vs(web))
        time.sleep(1.5)
        m = d.mark()
        web.evaluate(f'{V}.muted = true; {V}.play()')
        check('browser plays: the desktop player plays', wait(lambda: d.saw(r'PLAYER play t=', m), 8), d.out[-3:])
        time.sleep(1.5)
        m = d.mark()
        web.evaluate(f'{V}.pause()')
        check('browser pauses: the desktop player pauses', wait(lambda: d.saw(r'PLAYER pause t=\d', m), 8), d.out[-3:])
        m = d.mark()
        web.evaluate(f'{V}.currentTime = 40')
        check('browser seeks to 0:40: the desktop follows', wait(lambda: d.saw(r'PLAYER (seek t=40\.\d|pause t=40\.\d)', m), 8), d.out[-3:])
        m = d.mark()
        d.say('/exit')
        check('desktop exits: the browser closes the video', wait(lambda: web.locator('video.local-video-element').count() == 0, 8))
        time.sleep(1)

        # ---- the browser plays a file; the desktop uses its own copy, landing where the room is ----
        m = d.mark()
        web.locator('input[accept*=".mp4"]').first.set_input_files(FILE)
        check('browser opens a file: the desktop sees it (no player yet, it has no copy)',
              wait(lambda: d.saw(rf'WATCH showing=local:{re.escape(NAME)}:{SIZE}', m), 8) and not d.saw(r'PLAYER open', m), d.out[-3:])
        wait(lambda: (vs(web) or {}).get('rs', 0) >= 1, 10)
        web.evaluate(f'{V}.muted = true; {V}.currentTime = 30; {V}.play()')
        time.sleep(3)
        m = d.mark()
        d.say(f'/file {SIZE} {NAME}')
        hit = wait(lambda: d.saw(rf'PLAYER open local:{re.escape(NAME)}:{SIZE} t=(\d+\.\d) playing=true', m), 6)
        t = float(hit.group(1)) if hit else -1
        here = (vs(web) or {}).get('t', 0)
        check('desktop picks its own copy: it opens where the room is, playing', hit and abs(t - here) < 2.5, f'desktop {t} web {here}')
        m = d.mark()
        web.evaluate(f'{V}.pause()')
        check('...and follows the browser from then on', wait(lambda: d.saw(r'PLAYER pause t=\d', m), 8), d.out[-3:])
    finally:
        d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
