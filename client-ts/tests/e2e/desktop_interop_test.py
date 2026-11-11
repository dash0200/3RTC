"""Desktop ↔ web: the desktop engine (Rust, Google's libwebrtc) and the web app (Chromium) in one
room. The web app hosts, the desktop joins by code; they connect directly, swap identities (the
web app shows the desktop user's name) and chat both ways.
Needs the desktop example built: `cargo build -p rtc-engine --example chat` in desktop/ (skipped if not)."""
import os, re, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DESKTOP = harness.REPO / 'desktop'
CLI = DESKTOP / 'target' / 'debug' / 'examples' / ('chat.exe' if harness.IS_WIN else 'chat')
if not CLI.exists():
    print(f'skipping: build {CLI} first')
    sys.exit(0)

BASE = harness.dev()
SIGNAL = harness.signaling()
errors = []
out = []


def read(proc):
    for line in proc.stdout:
        out.append(line.rstrip())


def saw(pattern):
    return any(re.search(pattern, l) for l in out)


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    pg = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE); pg.wait_for_timeout(1200)
    harness.create_room(pg)
    wait(lambda: any(m.get('type') == 'room-created' for m in pg.evaluate('window.__sig')), 10)
    room = next(m['roomId'] for m in pg.evaluate('window.__sig') if m.get('type') == 'room-created')

    proc = subprocess.Popen([str(CLI), SIGNAL, 'Darshan', str(room)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    threading.Thread(target=read, args=(proc,), daemon=True).start()
    try:
        check('desktop joins the web room', wait(lambda: saw(rf'ROOM {room}'), 15), out[-5:])
        check('...connects directly and learns the host\'s name', wait(lambda: saw(r'members=Riya\+'), 20), out[-5:])
        check('the web app counts the desktop user in the room', wait(lambda: '2 / 4' in pg.locator('body').inner_text(), 15))

        box = pg.get_by_placeholder(re.compile('Message the room|Type a message')).first
        box.fill('hello from the browser'); box.press('Enter')
        check('web → desktop chat', wait(lambda: saw(r'CHAT Riya: hello from the browser'), 10), out[-5:])

        proc.stdin.write('hello from the desktop app\n'); proc.stdin.flush()
        check('desktop → web chat', wait(lambda: 'hello from the desktop app' in pg.locator('body').inner_text(), 10))
        names = pg.evaluate("[...document.querySelectorAll('.cm-name')].map(e => e.textContent)")
        check('...under the desktop user\'s name', 'Darshan' in names, names)

        proc.stdin.write('/quit\n'); proc.stdin.flush()
        proc.wait(timeout=10)
        check('desktop leaves cleanly', proc.returncode == 0, proc.returncode)
        check('...and the web app sees it go', wait(lambda: pg.evaluate("window.__pcs.every(pc => pc.connectionState !== 'connected')"), 15))
    finally:
        if proc.poll() is None:
            proc.kill()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
