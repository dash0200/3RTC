"""Desktop ↔ web: Tycoon, with the desktop deciding (its Rust rules roll the dice, move tokens,
charge rent, and play the computer).

1. The desktop opens Tycoon; the browser joins the table; the desktop joins and adds a computer;
   the browser picks a token and turns on the Coffee Break pot; the browser starts.
2. They play several rounds: the browser with its buttons (Roll, Buy or No thanks, Pay, End turn),
   the desktop through `/act`, the computer by the desktop's own timer. After every move the
   browser shows the cash the desktop's rules say.
3. Out of turn, a roll changes nothing.
4. A deal: the desktop offers the browser $100; the browser accepts; the cash moves.
5. "End game now" from the desktop (the host): the richest wins, on both.
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

    def game(self):
        m = self.last(r'STORE act:tycoon v=\d+ authority=\S+ state=(.*)$')
        return json.loads(m.group(1)) if m else None

    def act(self, action):
        self.say('/act act:tycoon ' + json.dumps(action))

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def money(n):
    return '$' + f'{round(n):,}'


def seat(g, name):
    return next((i for i, p in enumerate(g['players']) if p['name'] == name and not p.get('bot')), -1)


def status(pg):
    loc = pg.locator('[data-testid=ty-status]')
    return loc.inner_text() if loc.count() else ''


def web_cash(pg):
    return pg.locator('.ty-standing .ty-cash').all_inner_texts()


def button(pg, pattern):
    loc = pg.locator('.ty-actions button', has_text=re.compile(pattern))
    return loc.first if loc.count() else None


def web_turn(pg, g):
    """The browser's move for the step it's at (its buttons show once the token stops walking)."""
    end = time.time() + 8
    while time.time() < end:
        did = web_try(pg)
        if did:
            return did
        time.sleep(0.25)
    return None


def web_try(pg):
    try:
        return web_try_once(pg)
    except Exception:  # the panel re-drew under us: look again
        return None


def web_try_once(pg):
    for pattern in (r'Roll', r'^Buy', r'^Pay \$', r'End turn'):
        b = button(pg, pattern)
        if b is not None and b.is_enabled(timeout=500):
            b.click(timeout=1000); return pattern
    b = button(pg, r'No thanks')
    if b is not None:
        b.click(timeout=1000); return 'skip'
    b = button(pg, r'Declare bankruptcy')
    if b is not None:
        b.click(); time.sleep(0.3)
        y = button(pg, r'bankrupt')
        if y is not None:
            y.click()
        return 'bankrupt'
    return None


def desktop_turn(d, g):
    me = g['turn']
    p = g['players'][me]
    step = g['step']
    if step == 'roll':
        d.act({'kind': 'roll'})
    elif step == 'buy':
        price = {'kind': 'buy'} if p['cash'] >= 6000 else {'kind': 'skip'}
        d.act(price)
    elif step == 'debt':
        total = sum(x['amount'] for x in g['debt']['payees'])
        d.act({'kind': 'pay-debt'} if p['cash'] >= total else {'kind': 'bankrupt'})
    else:
        d.act({'kind': 'end-turn'})


def play(d, pg, moves):
    web_moves = desk_moves = 0
    end = time.time() + 150
    while time.time() < end and (web_moves < moves or desk_moves < moves):
        g = d.game()
        if not g or g['phase'] != 'playing':
            break
        cur = g['players'][g['turn']]
        seq = g['seq']
        if cur.get('bot'):
            if not wait(lambda: (x := d.game()) and x['seq'] != seq, 8):
                errors.append(f'the computer never moved at seq {seq}')
                break
            continue
        if cur['name'] == 'Darshan':
            desktop_turn(d, g)
            if not wait(lambda: (x := d.game()) and x['seq'] != seq, 6):
                errors.append(f'the desktop move ({g["step"]}) at seq {seq} did nothing')
                break
            desk_moves += 1
            continue
        if not wait(lambda: pg.locator('.ty-actions button').count() > 0, 8):
            errors.append(f'the browser never saw its turn at seq {seq} ({g["step"]})')
            break
        did = web_turn(pg, g)
        if not did or not wait(lambda: (x := d.game()) and x['seq'] != seq, 6):
            errors.append(f'the browser move {did} at seq {seq} ({g["step"]}) never reached the desktop')
            break
        web_moves += 1
    return web_moves, desk_moves


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
        d.say('/startgame tycoon')
        check('the desktop opens Tycoon (loaded for it)', wait(lambda: d.last(r'ACTIVITY tycoon by=Darshan loaded=true'), 8), d.out[-3:])
        harness.join_activity(web)
        check('the browser opens the lobby', wait(lambda: web.get_by_role('button', name='Join the game').count() == 1, 10))
        web.get_by_role('button', name='Join the game').click()
        d.act({'kind': 'join', 'name': 'Darshan'})
        d.act({'kind': 'add-bot'})
        check('Riya, Darshan and a computer at the table',
              wait(lambda: (g := d.game()) and [x['name'] for x in g['players']] == ['Riya', 'Darshan', 'Computer 1'], 8),
              d.game() and [x['name'] for x in d.game()['players']])
        web.get_by_role('button', name='Plane').click()
        check("the browser picks the plane: the desktop's rules agree",
              wait(lambda: (g := d.game()) and g['players'][0]['token'] == 'plane', 6), d.game() and d.game()['players'][0]['token'])
        d.act({'kind': 'rules', 'rules': {'jackpot': True}})
        check('the host (desktop) turns on the Coffee Break pot: the browser shows it',
              wait(lambda: web.locator('.ty-rule input[type=checkbox]').first.is_checked(), 6))
        web.get_by_role('button', name='Start (3 players)').click()
        check("the browser starts: the desktop's rules begin the game",
              wait(lambda: (g := d.game()) and g['phase'] == 'playing' and len(g['decks']['s']) == 16, 8), d.game() and d.game()['phase'])
        g = d.game()
        check('...everyone has $15,000; the browser shows it', wait(lambda: web_cash(web) == ['$15,000'] * 3, 8), web_cash(web))

        # ---- 3. out of turn ----
        if wait(lambda: (x := d.game()) and x['players'][x['turn']]['name'] == 'Riya', 20):
            before = d.game()['seq']
            d.act({'kind': 'roll'})
            d.act({'kind': 'end-turn'})
            time.sleep(1)
            check('out of turn, a roll changes nothing', d.game()['seq'] == before, d.game()['seq'])

        # ---- 2. play ----
        wm, dm = play(d, web, 6)
        g = d.game()
        check('they play: the browser and the desktop moved, the computer too', (wm >= 6 and dm >= 6) or g['phase'] != 'playing', (wm, dm, g['phase']))
        check("...the browser shows the cash the desktop's rules say",
              wait(lambda: web_cash(web) == [money(x['cash']) for x in d.game()['players']], 8),
              (web_cash(web), [x['cash'] for x in d.game()['players']]))
        check('...and every amount is whole dollars',
              all(isinstance(x['cash'], int) for x in g['players']), [x['cash'] for x in g['players']])

        # ---- 4. a deal ----
        g = d.game()
        if g['phase'] == 'playing' and not g['trade']:
            riya = seat(g, 'Riya')
            before = g['players'][riya]['cash']
            d.act({'kind': 'trade', 'to': riya, 'giveCash': 100, 'getCash': 0, 'giveProps': [], 'getProps': []})
            check('the desktop offers Riya $100: the browser is asked',
                  wait(lambda: web.locator('.ty-offer', has_text='offers you $100').count() == 1, 8))
            web.locator('.ty-offer').get_by_role('button', name='Accept').click()
            check('...she accepts: the cash moves (desktop rules)',
                  wait(lambda: (x := d.game()) and x['trade'] is None and x['players'][riya]['cash'] == before + 100, 8),
                  d.game() and (d.game()['players'][riya]['cash'], before))

        # ---- 5. end the game ----
        d.act({'kind': 'end-game'})
        check('the host ends the game: over, the richest wins',
              wait(lambda: (x := d.game()) and x['phase'] == 'over' and x['winner'] is not None, 8), d.game() and d.game()['phase'])
        g = d.game()
        winner = g['players'][g['winner']]['name']
        check('...the browser says who won', wait(lambda: (f'{winner} won!' in status(web)) or ('You won!' in status(web) and winner == 'Riya'), 8), status(web))
    finally:
        d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
