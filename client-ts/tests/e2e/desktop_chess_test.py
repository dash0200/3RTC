"""Desktop ↔ web: Chess, with the desktop deciding (its Rust rules apply the browser's moves).

The desktop engine (examples/chat) creates the room, so it is the host and decides for every
shared state; the browser joins by link. `STORE act:chess … state=<json>` shows the game on the
desktop; `/act act:chess <json>` plays.

1. The desktop opens Chess; the browser joins it, sits as Black; the desktop sits as White and
   starts.
2. They play: the desktop's moves through its own rules, the browser's by clicks on its board
   (checked and applied by the desktop's rules), and the browser shows the moves by name.
3. Scholar's mate: the browser is told White wins by checkmate.
4. An illegal move from the browser's side never changes the game.
5. Rematch swaps colours.
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
FILES = 'abcdefgh'


def sq(name):
    return (8 - int(name[1])) * 8 + FILES.index(name[0])


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

    def game(self):
        m = self.last(r'STORE act:chess v=\d+ authority=\S+ state=(.*)$')
        return json.loads(m.group(1)) if m else None

    def act(self, action):
        self.say('/act act:chess ' + json.dumps(action))

    def move(self, a, b):
        self.act({'kind': 'move', 'from': sq(a), 'to': sq(b)})

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def web_click(pg, name):
    """Click a square on the browser's board (Black: it's turned around)."""
    flipped = True
    box = pg.locator('svg.chess-board').bounding_box()
    scale = box['width'] / 834
    col, row = FILES.index(name[0]), 8 - int(name[1])
    if flipped:
        col, row = 7 - col, 7 - row
    x = box['x'] + (34 + col * 100 + 50) * scale
    y = box['y'] + (row * 100 + 50) * scale
    pg.mouse.click(x, y)
    time.sleep(0.25)


def web_move(pg, a, b):
    web_click(pg, a); web_click(pg, b)


def status(pg):
    loc = pg.locator('[data-testid=chess-status]')
    return loc.inner_text() if loc.count() else ''


def moves(pg):
    loc = pg.locator('[data-testid=chess-moves]')
    return loc.inner_text() if loc.count() else ''


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

        # ---- 1. open, sit, start ----
        d.say('/startgame chess')
        check('the desktop opens Chess (loaded for it)', wait(lambda: d.last(r'ACTIVITY chess by=Darshan loaded=true'), 8), d.out[-3:])
        harness.join_activity(web)
        check('the browser joins the game', wait(lambda: web.locator('svg.chess-board').count() == 1, 10))
        web.locator('.chess-seat', has_text='Black').get_by_role('button', name='Play').click()
        d.act({'kind': 'sit', 'color': 'w', 'name': 'Darshan'})
        check('both sit: the desktop decides (Riya is Black)',
              wait(lambda: (g := d.game()) and (g['seats']['b'] or {}).get('name') == 'Riya' and (g['seats']['w'] or {}).get('name') == 'Darshan', 8),
              d.game() and d.game()['seats'])
        d.act({'kind': 'start'})
        check('the desktop starts: the browser shows the game', wait(lambda: 'Darshan to move' in status(web), 8), status(web))

        # ---- 2. play: scholar's mate (the browser loses) ----
        d.move('e2', 'e4')
        check("the desktop's move shows in the browser", wait(lambda: 'e4' in moves(web) and 'Your move' in status(web), 8), (moves(web), status(web)))
        before = d.game()['seq']
        web_move(web, 'e7', 'e4')  # illegal (own pawn can't jump)
        web_move(web, 'e7', 'e5')
        check("the browser's move is checked and applied by the desktop's rules",
              wait(lambda: (g := d.game()) and g['moves'] and g['moves'][-1]['san'] == 'e5', 8), d.game() and d.game()['moves'])
        check('...and nothing else happened (the illegal try changed nothing)', d.game()['seq'] == before + 1, d.game()['seq'])
        d.move('d1', 'h5'); wait(lambda: 'Qh5' in moves(web), 6)
        web_move(web, 'b8', 'c6'); wait(lambda: d.game()['moves'][-1]['san'] == 'Nc6', 6)
        d.move('f1', 'c4'); wait(lambda: 'Bc4' in moves(web), 6)
        web_move(web, 'g8', 'f6'); wait(lambda: d.game()['moves'][-1]['san'] == 'Nf6', 6)
        d.move('h5', 'f7')
        check('scholar\'s mate: the browser says Darshan wins by checkmate',
              wait(lambda: 'Darshan wins by checkmate' in status(web), 8), status(web))
        g = d.game()
        check('...the desktop agrees: over, White won, Qxf7#',
              g['phase'] == 'over' and g['result'] == {'winner': 'w', 'reason': 'checkmate'} and g['moves'][-1]['san'] == 'Qxf7#', (g['phase'], g['result']))

        # ---- 3. rematch from the browser ----
        web.get_by_role('button', name='Rematch').click()
        check('Rematch (from the browser): colours swap, back to the lobby',
              wait(lambda: (g := d.game()) and g['phase'] == 'lobby' and (g['seats']['w'] or {}).get('name') == 'Riya', 8), d.game() and d.game()['seats'])
    finally:
        d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
