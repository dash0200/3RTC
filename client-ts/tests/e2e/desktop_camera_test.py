"""Desktop ↔ web: cameras (desktop/docs/adr/0010-webcam.md, docs/PROTOCOL.md "Webcam").

The desktop engine (examples/chat) stands in for the desktop app: `/camera on WxH` sends a moving
test pattern of that size on its camera line, `/camera off` stops it; `CAMERAS … remote=<names>`
says whose cameras it shows, `CAMERA_FRAME <name> WxH fps=N` that their pictures arrive. Chromium
uses its fake camera.

Who makes each connection decides who adds the camera line, so one room covers every way:
- Riya (browser) hosts; Darshan (desktop) joins: the browser adds the line, the desktop answers.
- Kai (desktop) joins: Darshan adds the line to Kai (desktop to desktop: full size, 1280x720).
- Anna (browser) joins last: Darshan adds the line to a browser (which gets at most 640x360).

1. Darshan's camera on: Riya shows its tile, playing, no more than 360 lines.
2. Riya's camera on: Darshan decodes it.
3. Riya clicks Darshan's tile: it fills the stage, for her only; "Back to the stage" closes it.
4. Kai joins late: he's told both cameras are on and gets Darshan's at full size (1280x720).
5. Anna joins: she shows Darshan's camera (at most 360 lines) and Riya's.
6. Darshan's camera off: every tile of it goes. Riya's off: the desktops drop hers.
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
errors = []


class Desktop:
    def __init__(self, name, room):
        self.out = []
        args = [str(CLI), SIGNAL, name, str(room)]
        env = dict(os.environ, RUST_LOG='warn,rtc_engine::camera=info')
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

    def last(self, pattern):
        return next((m for m in (re.search(pattern, l) for l in reversed(self.out)) if m), None)

    def mark(self):
        return len(self.out)

    def cameras(self):
        """The names in the last CAMERAS line."""
        m = self.last(r'CAMERAS on=\S+ starting=\S+ mine=\S+ remote=(.*)$')
        return [n for n in (m.group(1).split(',') if m else []) if n]

    def frame(self, name):
        """The size of the last picture reported from `name`'s camera."""
        m = self.last(rf'CAMERA_FRAME {re.escape(name)} (\d+)x(\d+) fps=(\d+)')
        return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


TILES = """(() => [...document.querySelectorAll('.camera-tile')].map(t => {
  const v = t.querySelector('video');
  return { name: t.querySelector('.camera-tile-name')?.textContent || '', w: v?.videoWidth || 0,
           h: v?.videoHeight || 0, t: v ? +v.currentTime.toFixed(2) : 0 };
}))()"""


def tile(pg, name):
    return next((t for t in pg.evaluate(TILES) if t['name'] == name), None)


def playing(pg, name):
    a = tile(pg, name)
    if not a or a['w'] == 0:
        return False
    time.sleep(0.6)
    b = tile(pg, name)
    return bool(b and b['t'] > a['t'])


def page(b, name):
    pg = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + f"localStorage.setItem('webrtc_username', '{name}');")
    pg.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    return pg


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    riya = page(b, 'Riya')
    riya.goto(BASE); riya.wait_for_timeout(1500)
    harness.create_room(riya)
    room = wait(lambda: next((m['roomId'] for m in riya.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    darshan = Desktop('Darshan', room)
    kai = None
    anna = None
    try:
        check('Darshan (desktop) joins and connects', wait(lambda: darshan.saw(r'members=Riya\+'), 25), darshan.out[-3:])
        time.sleep(3)  # the camera line is offered once the identities are in

        # ---- 1. Darshan's camera on ----
        darshan.say('/camera on 1280x720')
        check("Darshan's camera is on", wait(lambda: darshan.saw(r'CAMERAS on=true starting=false mine=true'), 10), darshan.out[-3:])
        check("Riya shows Darshan's camera, playing", wait(lambda: playing(riya, 'Darshan'), 25), riya.evaluate(TILES))
        t = tile(riya, 'Darshan') or {}
        check('...at most 640x360, as the web app sends (Darshan sends 1280x720)', 0 < t.get('h', 0) <= 360 and t.get('w', 0) <= 640, t)
        check('...and her own camera button says it is off', riya.get_by_role('button', name='Turn camera on').count() == 1)

        # ---- 2. Riya's camera on ----
        riya.get_by_role('button', name='Turn camera on').first.click()
        check("Darshan shows Riya's camera", wait(lambda: 'Riya' in darshan.cameras(), 15), darshan.out[-3:])
        check('...and decodes its pictures', wait(lambda: (darshan.frame('Riya') or (0, 0, 0))[0] > 0, 20),
              [l for l in darshan.out if 'CAMERA' in l][-3:])
        check("Riya sees her own tile as You", wait(lambda: tile(riya, 'You') is not None, 5), riya.evaluate(TILES))

        # ---- 3. a camera on the stage, for one viewer ----
        riya.locator('.camera-tile', has_text='Darshan').first.click()
        check("Riya clicks Darshan's tile: it fills her stage", wait(lambda: riya.locator('.camera-stage').count() == 1, 5))
        check('...with his name on it', 'Darshan' in (riya.locator('.camera-stage-name').first.text_content() or ''))
        riya.get_by_role('button', name='Back to the stage').first.click()
        check('"Back to the stage" closes it', wait(lambda: riya.locator('.camera-stage').count() == 0, 5))

        # ---- 4. a second desktop joins late ----
        kai = Desktop('Kai', room)
        check('Kai (desktop) joins and connects to both', wait(lambda: kai.saw(r'members=.*Darshan\+.*') and kai.saw(r'members=.*Riya\+'), 30), kai.out[-3:])
        check('Kai is told both cameras are on, and shows them', wait(lambda: {'Darshan', 'Riya'} <= set(kai.cameras()), 30), kai.out[-4:])
        full = wait(lambda: (kai.frame('Darshan') or (0, 0, 0))[:2] == (1280, 720), 30)
        check("Kai gets Darshan's camera at full size (1280x720): no compromise between desktop apps", full,
              [l for l in kai.out if 'CAMERA' in l][-4:])

        # ---- 5. a browser joins last (Darshan makes that connection) ----
        anna = page(b, 'Anna')
        anna.goto(f'{BASE}/?room={room}'); anna.wait_for_timeout(1500)
        anna.get_by_role('button', name='Join room').click()
        check("Anna shows Darshan's camera, playing", wait(lambda: playing(anna, 'Darshan'), 30), anna.evaluate(TILES))
        t = tile(anna, 'Darshan') or {}
        check('...at most 640x360', 0 < t.get('h', 0) <= 360, t)
        check("...and Riya's", wait(lambda: playing(anna, 'Riya'), 20), anna.evaluate(TILES))

        # ---- 6. off ----
        darshan.say('/camera off')
        check("Darshan's camera off: Riya's tile of it goes", wait(lambda: tile(riya, 'Darshan') is None, 10), riya.evaluate(TILES))
        check("...Anna's too", wait(lambda: tile(anna, 'Darshan') is None, 10), anna.evaluate(TILES))
        check("...and Kai's", wait(lambda: 'Darshan' not in kai.cameras(), 10), kai.out[-3:])
        riya.get_by_role('button', name='Turn camera off').first.click()
        check("Riya's camera off: the desktops drop it",
              wait(lambda: 'Riya' not in darshan.cameras() and 'Riya' not in kai.cameras(), 10), (darshan.out[-2:], kai.out[-2:]))
    finally:
        darshan.quit()
        if kai:
            kai.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
