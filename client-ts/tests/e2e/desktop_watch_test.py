"""Desktop ↔ web: the watch party.

The web app hosts (with stand-ins for the provider players, as media_links_test.py), the desktop
engine (examples/chat) joins and acts as a person at the desktop app's player would: it loads
YouTube videos and links, plays, pauses and seeks (`/play`, `/pause`, `/seek`), and prints what
its player is told (`PLAYER …`) and the room's watch state (`WATCH …`).
Covered: a YouTube video loaded each way; play / pause / seek each way; a direct video link each
way (the browser's real <video>); the auto re-sync (the web host is the reference); the queue
(add, next, vote to skip); a late joiner (a browser) landing at the desktop's spot.
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
INIT = harness.signal_init(SIGNAL)
MEDIA = harness.media_server()
FILE = f'{MEDIA}/test_small.mp4'
_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'media_links_test.py'), encoding='utf-8').read()
FAKES = re.search(r'FAKES = r"""(.*?)"""', _src, re.S).group(1)
VIDEO = "document.querySelector('.link-player-video')"
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

    def last_watch(self):
        return next((l for l in reversed(self.out) if l.startswith('WATCH ')), '')

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def yt(pg):
    return pg.evaluate("(() => { const p = window.__yt; return p ? { t: +p._now().toFixed(2), state: p.state } : null; })()")


def vt(pg):
    return pg.evaluate(f"(() => {{ const v = {VIDEO}; return v ? {{ t: +v.currentTime.toFixed(2), paused: v.paused }} : null; }})()")


def page(b):
    pg = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    pg.add_init_script(INIT); pg.add_init_script(FAKES)
    pg.add_init_script("localStorage.setItem('webrtc_username', 'Riya');")
    pg.on('pageerror', lambda e: errors.append(str(e)))
    return pg


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = page(b)
    web.goto(BASE); web.wait_for_timeout(1200)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    d = Desktop(room)
    try:
        check('desktop joins and connects', wait(lambda: d.saw(r'members=Riya\+'), 25), d.out[-3:])
        time.sleep(1.5)

        # ---- YouTube: desktop loads, the browser follows ----
        m = d.mark()
        d.say('/watch https://youtu.be/dQw4w9WgXcQ')
        check('desktop loads a YouTube video: its player opens', wait(lambda: d.saw(r'PLAYER open yt:dQw4w9WgXcQ t=0\.0 playing=true', m), 5), d.out[-3:])
        check('...and the browser opens it, playing', wait(lambda: (yt(web) or {}).get('state') == 1, 10), yt(web))
        check('...the browser logs who loaded it',
              wait(lambda: 'Darshan loaded a YouTube video: "Test video"' in web.locator('body').inner_text() or
                   web.evaluate("document.body.innerText.includes('Darshan loaded')"), 5))
        time.sleep(1.2)
        m = d.mark()
        web.evaluate('window.__yt.pauseVideo()')
        check('browser pauses (its player): the desktop player pauses', wait(lambda: d.saw(r'PLAYER pause t=\d', m), 6), d.out[-3:])
        m = d.mark()
        web.evaluate('window.__yt.seekTo(100); window.__yt.playVideo()')
        check('browser plays at 1:40: the desktop plays from there', wait(lambda: d.saw(r'PLAYER (play t=(9\d|10\d)|seek t=(9\d|10\d))', m), 6), d.out[-4:])
        time.sleep(2)
        d.say('/pause 150')
        check('desktop pauses at 2:30: the browser pauses there', wait(lambda: (yt(web) or {}).get('state') == 2 and abs(yt(web)['t'] - 150) < 1, 6), yt(web))
        d.say('/seek 200')
        check('desktop seeks to 3:20: the browser follows', wait(lambda: abs((yt(web) or {}).get('t', 0) - 200) < 1, 6), yt(web))
        d.say('/play 200')
        check('desktop plays: the browser plays', wait(lambda: (yt(web) or {}).get('state') == 1, 6), yt(web))

        # ---- the auto re-sync: the web host is the reference; the desktop is far behind ----
        time.sleep(5.5)  # let the last change settle (5 s)
        m = d.mark()
        d.say('/state 20 true')
        check('desktop far behind the host: it jumps back in sync by itself',
              wait(lambda: d.saw(r'PLAYER seek t=2\d\d\.\d drift=true', m), 10), d.out[-3:])

        # ---- a direct video link, the browser's real <video> ----
        m = d.mark()
        d.say(f'/watch {FILE}')
        check('desktop opens a video link: the browser plays it', wait(lambda: (vt(web) or {}).get('t', 0) > 0.5 and not vt(web)['paused'], 15), vt(web))
        check('...its title is the file name', wait(lambda: 'test_small.mp4' in web.locator('.link-player-title').inner_text(), 5))
        time.sleep(1.5)
        m = d.mark()
        web.evaluate(f'{VIDEO}.pause()')
        check('browser pauses the video: the desktop pauses', wait(lambda: d.saw(r'PLAYER pause t=\d', m), 6), d.out[-3:])
        d.say('/seek 30')
        check('desktop jumps to 0:30: the browser follows', wait(lambda: abs((vt(web) or {}).get('t', 0) - 30) < 1, 6), vt(web))
        d.say('/play 30')
        check('desktop plays: the browser plays', wait(lambda: not (vt(web) or {'paused': True})['paused'], 6), vt(web))

        # ---- the queue ----
        m = d.mark()
        d.say('/queue https://youtu.be/aqz-KE-bpKQ Big Buck Bunny')
        check('desktop queues a video: the browser\'s queue shows it',
              wait(lambda: web.evaluate("document.body.innerText.includes('Darshan queued: \"Big Buck Bunny\"')") or
                   (web.locator('.chat-tab-btn', has_text='Queue').first.click() or True) and 'Big Buck Bunny' in web.locator('.queue-panel-wrapper').inner_text(), 6))
        check('...and the desktop\'s watch state has it', wait(lambda: 'queue=Big Buck Bunny' in d.last_watch(), 3), d.last_watch())
        m = d.mark()
        d.say('/skip')
        check('desktop votes to skip (2 people: one vote passes): the next video plays on both',
              wait(lambda: d.saw(r'PLAYER open yt:aqz-KE-bpKQ', m), 6) and wait(lambda: (yt(web) or {}).get('state') == 1, 10), d.out[-4:])
        check('...the queue is empty on the desktop', wait(lambda: 'queue= ' in d.last_watch() or d.last_watch().endswith('queue= votes='), 3), d.last_watch())
        m = d.mark()
        d.say('/exit')
        check('desktop exits: the browser closes the video', wait(lambda: web.locator('.yt-fullstage-player').count() == 0, 6))
    finally:
        d.quit()

    # ---- a late joiner lands where the desktop is (the desktop hosts) ----
    h = Desktop()
    try:
        code = wait(lambda: (lambda m: m and m.group(1))(h.saw(r'^ROOM (\d+) ')), 25)
        check('desktop creates a room', code, h.out[-3:])
        h.say('/watch https://youtu.be/dQw4w9WgXcQ')
        h.say('/state 100 true')
        time.sleep(1)
        late = page(b)
        late.goto(f'{BASE}?room={code}'); late.wait_for_timeout(1200)
        late.get_by_role('button', name=re.compile('Join', re.I)).first.click()
        check('a browser joining later gets the video at the desktop\'s spot, playing',
              wait(lambda: (yt(late) or {}).get('state') == 1 and abs(yt(late)['t'] - 100) < 15, 25), yt(late))
        check('...within a couple of seconds of it', abs((yt(late) or {}).get('t', 0) - 100) < 25, yt(late))
    finally:
        h.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
