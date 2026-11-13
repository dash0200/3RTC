"""Desktop ↔ web: screen sharing.

The desktop engine (examples/chat) stands in for the desktop app: `SCREEN …` says who shares,
`SCREEN_FRAME WxH lit=N` that pictures arrive (N bright pixels), `/sharescreen` shares the first
screen (the test's virtual display), `/pointer x y` moves its laser pointer.

1. The browser shares its screen (a stand-in for getDisplayMedia: a bright animated canvas):
   the desktop is told who shares and decodes pictures of it.
2. The browser stops: the desktop is told.
3. The desktop shares its screen: the browser shows it playing; the desktop's laser pointer and
   the browser's show up on the other side.
Needs the desktop example built: `cargo build -p rtc-engine --example chat` in desktop/ (skipped if not)."""
import os, re, shutil, subprocess, sys, threading, time
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
errors = []

# getDisplayMedia stand-in: a 1280x720 canvas cycling bright colours
FAKE_SCREEN = """
navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const g = c.getContext('2d'); let n = 0;
  setInterval(() => { n++; g.fillStyle = `hsl(${(n * 7) % 360}, 90%, 60%)`; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('shared ' + n, 100, 300); }, 50);
  return c.captureStream(30);
};
"""

# a virtual display with something on it, for the desktop to share
DISPLAY = None
xvfb = None
if not harness.IS_WIN and shutil.which('Xvfb'):
    DISPLAY = ':97'
    xvfb = subprocess.Popen(['Xvfb', DISPLAY, '-screen', '0', '1280x720x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    if shutil.which('xsetroot'):
        subprocess.run(['xsetroot', '-display', DISPLAY, '-solid', '#33aaff'], check=False)


class Desktop:
    def __init__(self, room=None):
        self.out = []
        args = [str(CLI), SIGNAL, 'Darshan'] + ([str(room)] if room else [])
        env = dict(os.environ, RUST_LOG='warn')
        if DISPLAY:
            env['DISPLAY'] = DISPLAY
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, env=env)
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


def remote_video(pg):
    return pg.evaluate("""(() => { const v = [...document.querySelectorAll('.screen-share-stage video')].find(x => x.srcObject);
        return v ? { w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(2) } : null; })()""")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    web.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + FAKE_SCREEN + "localStorage.setItem('webrtc_username', 'Riya');")
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.goto(BASE); web.wait_for_timeout(1500)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    d = Desktop(room)
    try:
        check('desktop joins and connects', wait(lambda: d.saw(r'members=Riya\+'), 25), d.out[-3:])
        time.sleep(2)

        # ---- 1. the browser shares ----
        m = d.mark()
        web.get_by_role('button', name='Share screen').first.click()
        check('the browser shares its screen: the desktop is told who', wait(lambda: d.saw(r'SCREEN sharer=Riya mine=false', m), 10), d.out[-3:])
        big = lambda: next((h for h in (re.search(r'SCREEN_FRAME (\d+)x(\d+) lit=(\d+)', l) for l in d.out[m:])
                            if h and int(h.group(1)) >= 640), None)
        hit = wait(big, 25)
        check('...and decodes its pictures (at least 640 wide once the bitrate ramps up, bright)',
              hit and int(hit.group(3)) > 0.8 * int(hit.group(1)) * int(hit.group(2)),
              hit.group(0) if hit else [l for l in d.out[m:] if 'FRAME' in l])

        # ---- 2. it stops ----
        m = d.mark()
        web.get_by_role('button', name=re.compile('Stop sharing', re.I)).first.click()
        check('the browser stops: the desktop is told', wait(lambda: d.saw(r'SCREEN sharer=- ', m), 10), d.out[-3:])
        time.sleep(1)

        # ---- 3. the desktop shares ----
        m = d.mark()
        d.say('/sharescreen')
        ok = wait(lambda: d.saw(r'SCREEN sharer=Darshan mine=true|SCREEN_ERROR', m), 12)
        if ok and 'SCREEN_ERROR' in ok.group(0):
            check('the desktop shares its screen', False, d.out[-3:])
        else:
            check('the desktop shares its screen', ok, d.out[-3:])
            check('...the browser shows it playing',
                  wait(lambda: (remote_video(web) or {}).get('w', 0) > 0 and (remote_video(web) or {}).get('t', 0) > 0.5, 30),
                  remote_video(web))
            d.say('/pointer 0.5 0.4')
            check("...the desktop's laser pointer shows on the browser",
                  wait(lambda: web.locator('.screen-pointer-marker:not(.is-self)').count() > 0, 8))
            m = d.mark()
            d.say('/stopscreen')
            check('the desktop stops: the browser closes the share',
                  wait(lambda: web.locator('.screen-share-stage video').count() == 0, 10))
    finally:
        d.quit()
        if xvfb:
            xvfb.kill()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
