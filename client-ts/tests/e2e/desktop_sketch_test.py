"""Desktop ↔ web: Sketch, with the desktop deciding (its Rust rules pick the words, keep time,
check guesses and keep score; the browser is never sent the word unless it draws).

1. The desktop opens Sketch and joins; the browser opens it (opening it is joining it) and starts.
2. Turn 1, the desktop draws: it picks a word; the browser sees only blanks (as many as letters)
   and the desktop's stroke on a board it can't draw on. A wrong guess shows in the feed, a near
   one says "close", the right one scores (50 to 100, the drawer 25) and ends the turn.
3. After the reveal the desktop's clock starts turn 2, the browser draws: it picks from its 3
   words, draws a stroke (saved by the desktop's rules on the turn's own board), and the desktop
   guesses it. Out of turn, a skip from the desktop changes nothing.
4. Turns 3 and 4 are skipped (one each way); the game ends with the same scores on both, and
   "Play again" goes back to the lobby.
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
KEY = 'act:sketch'


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

    def store(self, key=KEY):
        m = self.last(r'STORE ' + re.escape(key) + r' v=\d+ authority=\S+ state=(.*)$')
        return json.loads(m.group(1)) if m else None

    def version(self, key=KEY):
        m = self.last(r'STORE ' + re.escape(key) + r' v=(\d+) ')
        return int(m.group(1)) if m else -1

    def act(self, action, key=KEY):
        self.say(f'/act {key} ' + json.dumps(action))

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def phase(d):
    g = d.store()
    return g and g['phase']


def scores(g):
    return {p['name']: p['score'] for p in g['players']}


def feed(pg):
    return pg.locator('.sk-feed').inner_text() if pg.locator('.sk-feed').count() else ''


def guess(pg, text):
    box = pg.get_by_label('Your guess')
    box.fill(text)
    pg.get_by_role('button', name='Guess', exact=True).click()


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

        # ---- 1. lobby ----
        d.say('/startgame sketch')
        check('the desktop opens Sketch', wait(lambda: d.store() is not None, 8), d.out[-3:])
        d.act({'kind': 'join', 'name': 'Darshan'})
        harness.join_activity(web)
        check('the browser opens it and is in the game (opening it is joining it)',
              wait(lambda: (g := d.store()) and [x['name'] for x in g['players']] == ['Darshan', 'Riya'], 10),
              d.store() and [x['name'] for x in d.store()['players']])
        check('...the browser says 2 players ready', wait(lambda: '2 players ready' in web.locator('.sk-banner').inner_text(), 6))
        web.get_by_role('button', name='Start', exact=True).click()
        check("the browser starts: the desktop's rules make Darshan pick from 3 words",
              wait(lambda: (g := d.store()) and g['phase'] == 'picking' and len(g['choices']) == 3, 8), d.store() and d.store()['phase'])
        check('...the browser waits for him', wait(lambda: 'Darshan is picking a word' in web.locator('.sk-banner').inner_text(), 6))

        # ---- 2. the desktop draws ----
        word = d.store()['choices'][1]
        d.act({'kind': 'pick', 'index': 1})
        check('the desktop picks: drawing', wait(lambda: phase(d) == 'drawing', 6), phase(d))
        letters = len(word.replace(' ', ''))
        check(f'...the browser sees {letters} blanks, not the word',
              wait(lambda: web.locator('.sk-word .sk-letter').count() == letters, 6) and word not in web.locator('.sk-top').inner_text(),
              web.locator('.sk-top').inner_text())
        d.say('/open act:sketch:t0')
        check("...the turn's board opens (index t0)", wait(lambda: d.store('act:sketch:t0') is not None, 6))
        d.say('/open act:sketch:t0:0:0')
        time.sleep(0.5)
        line = {'id': 'desk1', 'by': 'Darshan', 'k': 'line', 'c': '#2f7fe0', 'w': 6, 'p': [200, 200, 1200, 700]}
        d.act({'kind': 'add', 'strokes': [line]}, key='act:sketch:t0:0:0')
        check("the desktop's stroke is saved on the turn's board",
              wait(lambda: (c := d.store('act:sketch:t0:0:0')) and len(c['strokes']) == 1, 6), d.store('act:sketch:t0:0:0'))
        check('...the browser shows the board, without tools (it only watches)',
              wait(lambda: web.locator('canvas.wb-over').count() == 1, 6) and web.locator('.wb-toolbar').count() == 0)

        guess(web, 'zebra crossing')
        check('a wrong guess shows in the feed (as the desktop has it)',
              wait(lambda: (g := d.store()) and any(x['kind'] == 'guess' and x['text'] == 'zebra crossing' for x in g['feed']), 6)
              and wait(lambda: 'Riya: zebra crossing' in feed(web), 4), feed(web)[-120:])
        target = word.replace(' ', '')
        if len(target) >= 4:
            guess(web, word[:-1])
            check('...a near one says "close" (not the text)',
                  wait(lambda: (g := d.store()) and g['feed'][-1]['kind'] == 'close', 6) and wait(lambda: 'Riya is close!' in feed(web), 4),
                  d.store() and d.store()['feed'][-1])
        guess(web, '  ' + word.upper() + '! ')
        check('the right guess (any case, spaces and marks aside) ends the turn: everyone got it',
              wait(lambda: phase(d) == 'reveal', 6), phase(d))
        g = d.store()
        check('...Riya scores 50 to 100, Darshan 25', 50 <= g['players'][1]['score'] <= 100 and g['players'][0]['score'] == 25, scores(g))
        check('...the browser shows the word and the points',
              wait(lambda: word in web.locator('.sk-banner').inner_text() and f"+{g['players'][1]['score']}" in web.locator('.sk-players').inner_text(), 6),
              web.locator('.sk-banner').inner_text())

        # ---- 3. the browser draws ----
        check("the desktop's clock starts turn 2: Riya picks", wait(lambda: phase(d) == 'picking' and d.store()['drawer'] != d.store()['players'][0]['id'], 10),
              d.store() and (d.store()['phase'], d.store()['turn']))
        check('...the browser shows its 3 words', wait(lambda: web.locator('.sk-choice').count() == 3, 6))
        before = d.version()
        d.act({'kind': 'skip'})
        time.sleep(1)
        check('out of turn, a skip from the desktop changes nothing', d.version() == before and phase(d) == 'picking', (before, d.version()))
        mine = web.locator('.sk-choice').nth(2).inner_text().strip()
        web.locator('.sk-choice').nth(2).click()
        check('the browser picks: the desktop has its word', wait(lambda: (g := d.store()) and g['phase'] == 'drawing' and g['word'] == mine, 6),
              d.store() and d.store()['word'])
        check('...the browser has the tools now', wait(lambda: web.locator('.wb-toolbar').count() == 1, 6))
        d.say('/open act:sketch:t1')
        wait(lambda: d.store('act:sketch:t1') is not None, 6)
        d.say('/open act:sketch:t1:0:0')
        time.sleep(0.5)
        over = web.locator('canvas.wb-over')
        box = over.bounding_box()
        sx = box['width'] / 1600
        web.mouse.move(box['x'] + 300 * sx, box['y'] + 300 * sx); web.mouse.down()
        for i in range(1, 20):
            web.mouse.move(box['x'] + (300 + i * 25) * sx, box['y'] + (300 + (i % 4) * 15) * sx)
            time.sleep(0.02)
        web.mouse.up()
        check("the browser's stroke is saved by the desktop's rules on turn 2's board",
              wait(lambda: (c := d.store('act:sketch:t1:0:0')) and len(c['strokes']) == 1, 8), d.store('act:sketch:t1:0:0'))
        d.act({'kind': 'guess', 'text': 'definitely not it'})
        check("the desktop's wrong guess shows on the browser", wait(lambda: 'Darshan: definitely not it' in feed(web), 6), feed(web)[-120:])
        d.act({'kind': 'guess', 'text': mine})
        check('the desktop guesses it: reveal', wait(lambda: phase(d) == 'reveal', 6), phase(d))

        # ---- 4. to the end ----
        check('turn 3: Darshan picks', wait(lambda: phase(d) == 'picking' and d.store()['turn'] == 2, 10), d.store() and d.store()['turn'])
        d.act({'kind': 'skip'})
        check('...and skips it', wait(lambda: phase(d) == 'reveal' and 'Darshan skipped.' in d.store()['feed'][-1]['text'], 6),
              d.store() and d.store()['feed'][-1])
        check('turn 4: Riya picks', wait(lambda: phase(d) == 'picking' and d.store()['turn'] == 3, 10), d.store() and d.store()['turn'])
        wait(lambda: web.get_by_role('button', name='Skip').count() == 1, 6)
        web.get_by_role('button', name='Skip').click()
        check('...she skips from the browser; after the reveal, the game is over',
              wait(lambda: phase(d) == 'over', 12), phase(d))
        g = d.store()
        top = max(g['players'], key=lambda x: x['score'])
        check('...the browser says who won, with the same scores',
              wait(lambda: f"{top['name']} wins!" in web.locator('.sk-banner').inner_text(), 6)
              and all(str(x['score']) in web.locator('.sk-podium').inner_text() for x in g['players']),
              (web.locator('.sk-banner').inner_text(), scores(g)))
        web.get_by_role('button', name='Play again').click()
        check('"Play again": back to the lobby, scores at 0, both still in',
              wait(lambda: (x := d.store()) and x['phase'] == 'lobby' and len(x['players']) == 2 and all(p['score'] == 0 for p in x['players']), 6),
              d.store() and d.store()['phase'])
    finally:
        d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
