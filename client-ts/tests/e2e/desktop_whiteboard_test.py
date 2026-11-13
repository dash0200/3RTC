"""Desktop ↔ web: the Whiteboard, with the desktop deciding (its Rust rules check every stroke).

1. The desktop opens the Whiteboard; the browser joins it.
2. The browser draws a pen stroke and a box: they're saved in the desktop's copy of chunk 0
   (cleaned the same way: whole numbers, kept on the board).
3. While the browser draws, its stroke streams to the desktop (`wb-live`) and its pointer too
   (`wb-cursor`).
4. The desktop adds a stroke (`/act`): the browser shows 3 drawings. A bad stroke changes nothing.
5. The desktop's pointer shows on the browser's board with its name.
6. The board turns dark (from the browser); the desktop host clears it: a new epoch, empty, on both.
Needs the desktop example built: `cargo build -p rtc-engine --example chat` in desktop/ (skipped if not)."""
import json, os, re, subprocess, sys, threading, time
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
    def __init__(self):
        self.out = []
        self.proc = subprocess.Popen([str(CLI), SIGNAL, 'Darshan'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, bufsize=1, env=dict(os.environ, RUST_LOG='warn'))
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.out.append(re.sub(r'\x1b\[[0-9;]*m', '', line.rstrip()))

    def say(self, cmd):
        self.proc.stdin.write(cmd + '\n'); self.proc.stdin.flush()

    def last(self, pattern, since=0):
        hits = [m for m in (re.search(pattern, l) for l in self.out[since:]) if m]
        return hits[-1] if hits else None

    def mark(self):
        return len(self.out)

    def store(self, key):
        m = self.last(r'STORE ' + re.escape(key) + r' v=\d+ authority=\S+ state=(.*)$')
        return json.loads(m.group(1)) if m else None

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def drawings(pg):
    return pg.locator('.wb-foot').inner_text() if pg.locator('.wb-foot').count() else ''


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = b.new_context(viewport={'width': 1400, 'height': 900}).new_page()
    web.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    web.on('pageerror', lambda e: errors.append(str(e)))
    d = Desktop()
    try:
        room = wait(lambda: (m := d.last(r'ROOM (\d{5}) ')) and m.group(1), 25)
        check('the desktop creates the room (it hosts, so it decides)', room, d.out[-3:])
        web.goto(f'{BASE}/?room={room}'); web.wait_for_timeout(1500)
        web.get_by_role('button', name='Join room').click()
        check('the browser joins', wait(lambda: d.last(r'members=Riya\+'), 25), d.out[-2:])
        time.sleep(2)

        # ---- 1. open ----
        d.say('/startgame whiteboard')
        check('the desktop opens the Whiteboard', wait(lambda: d.store('act:whiteboard') is not None, 8), d.out[-3:])
        d.say('/open act:whiteboard:0:0')
        harness.join_activity(web)
        check('the browser joins it', wait(lambda: web.locator('canvas.wb-over').count() == 1, 10))
        time.sleep(1)
        over = web.locator('canvas.wb-over')
        box = over.bounding_box()
        sx = box['width'] / 1600

        # ---- 2 + 3. the browser draws ----
        m = d.mark()
        web.mouse.move(box['x'] + 200 * sx, box['y'] + 200 * sx)
        web.mouse.down()
        for i in range(1, 25):
            web.mouse.move(box['x'] + (200 + i * 20) * sx, box['y'] + (200 + (i % 5) * 12) * sx)
            time.sleep(0.02)
        check("while the browser draws, its stroke streams to the desktop (wb-live)", wait(lambda: d.last(r'BOARD live \S+ .*"pts"', m), 5), d.out[-2:])
        web.mouse.up()
        check('...and its pointer (wb-cursor, with its name)', d.last(r'BOARD cursor \S+ .*"name":"Riya"', m) is not None)
        check('the pen stroke is saved in the desktop\'s chunk 0 (its rules cleaned it)',
              wait(lambda: (c := d.store('act:whiteboard:0:0')) and len(c['strokes']) == 1, 8), d.store('act:whiteboard:0:0'))
        st = d.store('act:whiteboard:0:0')['strokes'][0]
        check('...a pen stroke by Riya, whole numbers on the board',
              st['k'] == 'pen' and st['by'] == 'Riya' and all(isinstance(v, int) and 0 <= v <= 1600 for v in st['p']), st)
        web.get_by_role('button', name='Box').click()
        web.mouse.move(box['x'] + 800 * sx, box['y'] + 500 * sx); web.mouse.down()
        web.mouse.move(box['x'] + 1000 * sx, box['y'] + 650 * sx, steps=6); web.mouse.up()
        check('a box too', wait(lambda: (c := d.store('act:whiteboard:0:0')) and [x['k'] for x in c['strokes']] == ['pen', 'rect'], 8),
              d.store('act:whiteboard:0:0') and [x['k'] for x in d.store('act:whiteboard:0:0')['strokes']])

        # ---- 4. the desktop draws ----
        good = {'id': 'desk1', 'by': 'Darshan', 'k': 'line', 'c': '#2F7FE0', 'w': 6.4, 'p': [100, 900, 1700, 50.6]}
        d.say('/act act:whiteboard:0:0 ' + json.dumps({'kind': 'add', 'strokes': [good]}))
        check('the desktop adds a line: the browser shows 3 drawings', wait(lambda: '3 drawings' in drawings(web), 8), drawings(web))
        line = d.store('act:whiteboard:0:0')['strokes'][-1]
        check('...cleaned: colour lower-case, width rounded, kept on the board',
              line['c'] == '#2f7fe0' and line['w'] == 6 and line['p'] == [100, 900, 1600, 51], line)
        before = d.last(r'STORE act:whiteboard:0:0 v=(\d+)').group(1)
        d.say('/act act:whiteboard:0:0 ' + json.dumps({'kind': 'add', 'strokes': [{'id': 'bad', 'k': 'blob', 'c': '#fff', 'w': 3, 'p': [1, 2]}]}))
        time.sleep(1)
        check('a bad stroke changes nothing', d.last(r'STORE act:whiteboard:0:0 v=(\d+)').group(1) == before)

        # ---- 5. the desktop's pointer ----
        d.say('/board cursor ' + json.dumps({'x': 400, 'y': 300, 'name': 'Darshan'}))
        check("the desktop's pointer shows on the browser's board", wait(lambda: web.locator('.wb-cursor', has_text='Darshan').count() == 1, 6))
        d.say('/board cursor ' + json.dumps({'gone': True}))
        check('...and goes', wait(lambda: web.locator('.wb-cursor', has_text='Darshan').count() == 0, 6))

        # ---- 6. dark board, clear ----
        web.get_by_role('button', name='Light or dark board').click()
        check('the browser turns the board dark (desktop rules)', wait(lambda: (i := d.store('act:whiteboard')) and i['bg'] == 'dark', 6), d.store('act:whiteboard'))
        d.say('/act act:whiteboard ' + json.dumps({'kind': 'clear', 'name': 'Darshan'}))
        check('the host clears it: a new epoch', wait(lambda: (i := d.store('act:whiteboard')) and i['epoch'] == 1 and i['clearedBy'] == 'Darshan', 6), d.store('act:whiteboard'))
        check('...the browser shows an empty board, cleared by Darshan', wait(lambda: 'Cleared by Darshan' in drawings(web) and '0 drawings' in drawings(web), 8), drawings(web))
    finally:
        d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
