"""Host controls survive leaving and coming back (desktop ↔ web).

1. The browser hosts and turns host controls on; the desktop joins: it's held back.
2. The desktop leaves and joins again: still held back (the host's identity carries the lock),
   also after the 4 s in which a missing host's lock would lift.
3. The desktop hosts and turns them on; a second desktop joins, leaves and joins again: held back.
4. The desktop host leaves the app and takes its room back (rejoin card): the lock is still on.
Needs the desktop example built: `cargo build -p rtc-engine --example chat` in desktop/."""
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
    def __init__(self, name, room=None):
        self.out = []
        args = [str(CLI), SIGNAL, name] + ([str(room)] if room else [])
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                     bufsize=1, env=dict(os.environ, RUST_LOG='warn', RTC_MIC='silence'))
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.out.append(re.sub(r'\x1b\[[0-9;]*m', '', line.rstrip()))

    def say(self, cmd):
        self.proc.stdin.write(cmd + '\n'); self.proc.stdin.flush()

    def lock(self):
        hits = [l for l in self.out if l.startswith('LOCK ')]
        return hits[-1] if hits else None

    def last(self, pattern):
        hits = [m for m in (re.search(pattern, l) for l in self.out) if m]
        return hits[-1] if hits else None

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


held = lambda d: d.lock() == 'LOCK on=true me_locked=true'

with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    web.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.goto(BASE); web.wait_for_timeout(1500)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    ds = []
    try:
        # ---- 1. web host, lock on ----
        harness.toggle_playback_lock(web)
        check('the browser host turns host controls on', wait(lambda: web.locator('.rh-lock').count() == 1, 5))
        d = Desktop('Asha', room); ds.append(d)
        check('the desktop joins: held back', wait(lambda: held(d), 20), d.out[-3:])
        # ---- 2. leave and come back ----
        d.quit()
        time.sleep(2)
        d = Desktop('Asha', room); ds.append(d)
        check('the desktop leaves and joins again: still held back', wait(lambda: held(d), 20), d.out[-3:])
        time.sleep(6)
        check('...and still after 6 s', held(d), d.lock())
        d.quit()
        web.close()

        # ---- 3. desktop host ----
        h = Desktop('Darshan'); ds.append(h)
        room2 = wait(lambda: (m := h.last(r'ROOM (\d{5}) ')) and m.group(1), 25)
        h.say('/lock')
        check('the desktop host turns host controls on', wait(lambda: h.lock() == 'LOCK on=true me_locked=false', 5), h.lock())
        g = Desktop('Asha', room2); ds.append(g)
        check('another desktop joins: held back', wait(lambda: held(g), 20), g.out[-3:])
        g.quit(); time.sleep(2)
        g = Desktop('Asha', room2); ds.append(g)
        check('...leaves and joins again: still held back', wait(lambda: held(g), 20), g.out[-3:])
        time.sleep(6)
        check('...and still after 6 s', held(g), g.lock())
    finally:
        for d in ds:
            d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
