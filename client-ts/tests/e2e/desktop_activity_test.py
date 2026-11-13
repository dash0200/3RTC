"""Desktop ↔ web: activities and shared state (M6 part 1), with the development example game.

The desktop engine (examples/chat) stands in for the desktop app: `ACTIVITY <id> by=<name>
loaded=<bool> known=<bool>` says what the room has open, `STORE <key> v=<n> authority=<peer>
state=<json>` each change of the loaded game's state; `/startgame`, `/endgame`, `/joingame`,
`/leavegame` and `/act <key> <json>` act.

1. The browser (host) opens Sample counter: the desktop sees it, not loaded (an invitation).
2. The desktop joins: it gets the count as it is; clicks on both sides reach both (the host decides).
3. The desktop leaves: the game goes on in the browser without it.
4. The desktop ends it for everyone: the browser's game closes.
5. The desktop opens it: the browser gets the "Join" bubble, joins, and both play.
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

BASE = harness.dev()  # development build: it lists Sample counter
SIGNAL = harness.signaling()
errors = []


class Desktop:
    def __init__(self, room=None):
        self.out = []
        args = [str(CLI), SIGNAL, 'Darshan'] + ([str(room)] if room else [])
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, env=dict(os.environ, RUST_LOG='warn', RTC_DEV_ACTIVITIES='1'))
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

    def count(self):
        m = self.last(r'STORE act:sample-counter v=(\d+) authority=\S+ state=(.*)$')
        return json.loads(m.group(2)).get('count') if m else None

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def count(pg):
    loc = pg.locator('[data-testid=sample-count]')
    return loc.inner_text().strip() if loc.count() else None


def toasts(pg):
    return ' | '.join(pg.locator('.toast, [role=status]').all_inner_texts())


def add(d, step):
    d.say('/act act:sample-counter ' + json.dumps({'kind': 'add', 'step': step, 'name': 'Darshan'}))


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    web.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.goto(BASE); web.wait_for_timeout(1500)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    d = Desktop(room)
    try:
        check('desktop joins and connects', wait(lambda: d.last(r'members=Riya\+'), 25), d.out[-3:])
        time.sleep(2)

        # ---- 1. the browser opens the game ----
        m = d.mark()
        harness.open_activity(web, 'Sample counter')
        check('the browser opens Sample counter', wait(lambda: count(web) == '0', 8))
        check('the desktop sees it open, not loaded (an invitation)',
              wait(lambda: d.last(r'ACTIVITY sample-counter by=Riya loaded=false known=true', m), 8), d.out[-3:])
        check('...and is told who started it', wait(lambda: d.last(r'started Sample counter: tap', m), 4), d.out[-4:])
        web.get_by_role('button', name='+1').click()
        wait(lambda: count(web) == '1', 4)
        check("...its state doesn't come to the desktop until it joins", d.last(r'STORE act:sample-counter', m) is None)

        # ---- 2. the desktop joins ----
        m = d.mark()
        d.say('/joingame')
        check('the desktop joins and gets the count as it is (1)', wait(lambda: d.count() == 1, 8), d.out[-3:])
        auth = d.last(r'STORE act:sample-counter v=\d+ authority=(\S+)', m)
        check('...the host (the browser) decides', auth and auth.group(1) != '-', auth.group(0) if auth else None)
        add(d, 1)
        check("the desktop's click reaches the browser (2)", wait(lambda: count(web) == '2', 6), count(web))
        check("...and says who: Darshan added 1", wait(lambda: 'Darshan added 1' in web.locator('[data-testid=sample-last]').inner_text(), 4))
        web.get_by_role('button', name='−1').click()
        check("the browser's click reaches the desktop (1)", wait(lambda: d.count() == 1, 6), d.out[-2:])

        # ---- 3. the desktop leaves ----
        m = d.mark()
        d.say('/leavegame')
        check('the desktop leaves: not loaded any more', wait(lambda: d.last(r'ACTIVITY sample-counter by=Riya loaded=false', m), 6), d.out[-3:])
        web.get_by_role('button', name='+1').click(); web.get_by_role('button', name='+1').click()
        check('...the game goes on in the browser (3)', wait(lambda: count(web) == '3', 6), count(web))

        # ---- 4. the desktop ends it for everyone ----
        d.say('/endgame')
        check('the desktop ends it: the browser closes the game', wait(lambda: count(web) is None and web.locator('.stage-activity').count() == 0, 8))

        # ---- 5. the desktop opens it ----
        m = d.mark()
        d.say('/startgame sample-counter')
        check('the desktop opens Sample counter (loaded for it)',
              wait(lambda: d.last(r'ACTIVITY sample-counter by=Darshan loaded=true', m), 8), d.out[-3:])
        check('...the browser gets the Join bubble',
              wait(lambda: web.locator('.activity-bubble.is-invite').count() == 1 and 'Join Sample counter' in web.locator('.activity-bubble').inner_text(), 8))
        check('...and a note that Darshan started it', wait(lambda: 'Darshan started Sample counter' in toasts(web), 4), toasts(web))
        harness.join_activity(web)
        check('the browser joins: count 0', wait(lambda: count(web) == '0', 8), count(web))
        add(d, 1); add(d, 1)
        web.get_by_role('button', name='+1').click()
        check('both play: 3 on both sides', wait(lambda: count(web) == '3' and d.count() == 3, 8), (count(web), d.count()))
    finally:
        d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
