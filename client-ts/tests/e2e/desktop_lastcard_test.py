"""Desktop ↔ web: Last Card, with secret hands.

Part A, the desktop decides (it creates the room, so it hosts): its Rust rules deal, apply the
browser's cards and play the computer; the browser is sent only its own hand.
1. The desktop opens Last Card; the browser joins the table; the desktop joins, adds a computer
   and deals.
2. The browser's hand on screen is exactly its hand in the desktop's copy; the desktop's copy
   has every hand (it decides).
3. They play several rounds: the browser by tapping cards (a colour for wilds) or drawing, the
   desktop through `/act`, the computer by the desktop's own timer. Every move shows on both.
4. A card played out of turn changes nothing.

Part B, the deciding app changes mid-game (the browser hosts and decides, then closes):
5. The desktop, left with only its own hand, asks for the cards back (`resync`), waits, and deals
   again what nobody sent: its own hand is unchanged, the deck adds up to 108 cards.
6. The game goes on with the desktop deciding (it plays for the computer and for Riya, away).
7. Riya comes back (same browser, new page): she gets her seat back and sees a hand, and the
   desktop keeps the hand it had.
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
COLORS = ['r', 'y', 'g', 'b']
COLOR_NAMES = {'r': 'Red', 'y': 'Yellow', 'g': 'Green', 'b': 'Blue'}
VALUE_NAMES = {'S': 'Skip', 'R': 'Reverse', 'D': 'Draw Two', 'W': 'Wild', 'F': 'Wild Draw Four'}


def card(i):
    if i >= 104:
        return 'w', 'F'
    if i >= 100:
        return 'w', 'W'
    k = i % 25
    c = COLORS[i // 25]
    if k == 0:
        return c, '0'
    if k <= 18:
        return c, str((k + 1) // 2)
    return c, 'SRD'[(k - 19) // 2]


def card_name(i):
    c, v = card(i)
    return VALUE_NAMES[v] if c == 'w' else f'{COLOR_NAMES[c]} {VALUE_NAMES.get(v, v)}'


def can_play(g, i):
    if not g['discard']:
        return True
    c, v = card(i)
    _, tv = card(g['discard'][-1])
    if g['pendingDraw'] > 0:
        if not g['rules']['stacking']:
            return False
        return v == 'F' or (v == 'D' and tv == 'D')
    return c == 'w' or c == g['color'] or v == tv


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

    def last(self, pattern, since=0):
        hits = [m for m in (re.search(pattern, l) for l in self.out[since:]) if m]
        return hits[-1] if hits else None

    def mark(self):
        return len(self.out)

    def game(self):
        m = self.last(r'STORE act:lastcard v=\d+ authority=\S+ state=(.*)$')
        return json.loads(m.group(1)) if m else None

    def authority(self):
        m = self.last(r'STORE act:lastcard v=\d+ authority=(\S+) ')
        return m.group(1) if m else None

    def act(self, action):
        self.say('/act act:lastcard ' + json.dumps(action))

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def seat(g, name):
    return next((i for i, p in enumerate(g['players']) if p['name'] == name and not p.get('bot')), -1)


def web_hand(pg):
    return pg.locator('.lc-hand-card').evaluate_all('els => els.map(e => e.getAttribute("aria-label"))')


def web_turn(pg):
    """The browser's move: a card it can play (red for a wild), else keep the drawn card, else draw."""
    ok = pg.locator('.lc-hand-card.is-playable')
    if ok.count():
        try:  # the top card of the fan (the others are partly covered)
            ok.last.click(timeout=3000)
        except Exception:  # the hand re-drew under the pointer (a card just arrived): tap it anyway
            ok.last.click(force=True, timeout=3000)
        time.sleep(0.3)
        if pg.locator('.lc-picker').count():
            pg.get_by_role('button', name='Red').click()
        return 'play'
    keep = pg.locator('.lc-actions button', has_text='Keep it')
    if keep.count():
        keep.first.click(); return 'keep'
    pg.locator('.lc-actions button').first.click()
    return 'draw'


def desktop_turn(d, g, me):
    hand = g['hands'][me] or []
    if g['drewThisTurn']:
        last = hand[-1]
        if can_play(g, last):
            d.act({'kind': 'play', 'card': last, 'color': 'r'} if last >= 100 else {'kind': 'play', 'card': last})
        else:
            d.act({'kind': 'pass'})
        return
    ok = [c for c in hand if can_play(g, c)]
    if ok:
        c = ok[0]
        d.act({'kind': 'play', 'card': c, 'color': 'b'} if c >= 100 else {'kind': 'play', 'card': c})
    else:
        d.act({'kind': 'draw'})


def play_rounds(d, pg, moves, label):
    """Plays until both humans moved `moves` times (or the game ends). Returns (web, desktop) moves."""
    web_moves = desk_moves = 0
    end = time.time() + 120
    while time.time() < end and (web_moves < moves or desk_moves < moves):
        g = d.game()
        if not g or g['phase'] != 'playing':
            break
        if g['restoring']:
            time.sleep(0.3); continue
        # say "Last card!" when caught out
        if g['exposed'] is not None and g['players'][g['exposed']]['name'] == 'Darshan':
            d.act({'kind': 'call'})
        if pg.locator('.lc-call-btn.is-urgent').count():
            pg.locator('.lc-call-btn').first.click()
        who = g['players'][g['turn']]
        seq = g['seq']
        if who.get('bot'):
            wait(lambda: (x := d.game()) and x['seq'] != seq, 6)
            continue
        if who['name'] == 'Darshan':
            desktop_turn(d, g, g['turn'])
            if not wait(lambda: (x := d.game()) and x['seq'] != seq, 6):
                errors.append(f'{label}: the desktop move at seq {seq} did nothing')
                break
            desk_moves += 1
            continue
        if not wait(lambda: pg.locator('.lc.is-my-turn').count() == 1, 8):
            errors.append(f'{label}: the browser never saw its turn at seq {seq}')
            break
        web_turn(pg)
        if not wait(lambda: (x := d.game()) and x['seq'] != seq, 6):
            errors.append(f'{label}: the browser move at seq {seq} never reached the desktop')
            break
        web_moves += 1
    return web_moves, desk_moves


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    ctx = b.new_context(viewport={'width': 1400, 'height': 900})
    ctx.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    web = ctx.new_page()
    web.on('pageerror', lambda e: errors.append(str(e)))

    # ================= Part A: the desktop decides =================
    d = Desktop()
    try:
        room = wait(lambda: (m := d.last(r'ROOM (\d{5}) ')) and m.group(1), 25)
        check('A. the desktop creates the room (it hosts, so it decides)', room, d.out[-3:])
        web.goto(f'{BASE}/?room={room}'); web.wait_for_timeout(1500)
        web.get_by_role('button', name='Join room').click()
        check('the browser joins', wait(lambda: d.last(r'members=Riya\+'), 25), d.out[-2:])
        time.sleep(2)

        d.say('/startgame lastcard')
        check('the desktop opens Last Card (loaded for it)', wait(lambda: d.last(r'ACTIVITY lastcard by=Darshan loaded=true'), 8), d.out[-3:])
        harness.join_activity(web)
        check('the browser opens the lobby', wait(lambda: web.get_by_role('button', name='Join the game').count() == 1, 10))
        web.get_by_role('button', name='Join the game').click()
        d.act({'kind': 'join', 'name': 'Darshan'})
        d.act({'kind': 'add-bot'})
        d.act({'kind': 'rules', 'rules': {'drawToMatch': True}})
        check('Riya, Darshan and a computer at the table (the desktop decides)',
              wait(lambda: (g := d.game()) and [x['name'] for x in g['players']] == ['Riya', 'Darshan', 'Computer 1'], 8),
              d.game() and [x['name'] for x in d.game()['players']])
        check('...the browser shows them and the house rule',
              wait(lambda: web.get_by_role('button', name='Deal (3 players)').count() == 1
                   and web.locator('.lc-rule input').nth(1).is_checked(), 8))
        web.get_by_role('button', name='Deal (3 players)').click()
        check('the browser deals: the desktop\'s rules deal 7 each',
              wait(lambda: (g := d.game()) and g['phase'] == 'playing' and g['counts'] == [7, 7, 7], 8), d.game() and d.game()['counts'])
        g = d.game()
        check("the desktop's copy has every hand and the draw pile (it decides)",
              all(h is not None and len(h) == 7 for h in g['hands']) and g['drawPile'] is not None and len(g['drawPile']) == g['drawCount'] == 108 - 21 - 1,
              (g['drawCount'],))
        rs = seat(g, 'Riya')
        check("the browser's hand on screen is exactly its hand in the desktop's copy",
              wait(lambda: sorted(web_hand(web)) == sorted(card_name(c) for c in d.game()['hands'][rs]), 8),
              (web_hand(web), [card_name(c) for c in d.game()['hands'][rs]]))

        # out of turn: nothing changes (checked on Riya's turn: nobody else moves then)
        if wait(lambda: (x := d.game()) and x['players'][x['turn']]['name'] == 'Riya', 15):
            g = d.game()
            before = g['seq']
            d.act({'kind': 'play', 'card': g['hands'][seat(g, 'Darshan')][0]})
            d.act({'kind': 'pass'})
            time.sleep(1)
            check('a card played out of turn changes nothing', d.game()['seq'] == before, d.game()['seq'])

        wm, dm = play_rounds(d, web, 5, 'A')
        g = d.game()
        check('they play: the browser and the desktop moved, the computer too',
              (wm >= 5 and dm >= 5) or g['phase'] == 'over', (wm, dm, g['phase']))
        check('...every card is somewhere (hands + draw pile + discard = 108)',
              sum(len(h) for h in g['hands']) + len(g['drawPile']) + len(g['discard']) == 108,
              (g['counts'], len(g['drawPile']), len(g['discard'])))
        if g['phase'] == 'playing':
            check("...the browser's hand still matches the desktop's copy",
                  wait(lambda: sorted(web_hand(web)) == sorted(card_name(c) for c in d.game()['hands'][rs]), 8),
                  (web_hand(web), d.game()['hands'][rs]))
        d.say('/endgame')
        check('the desktop ends it: the browser closes the game', wait(lambda: web.locator('.stage-activity').count() == 0, 8))
    finally:
        d.quit()
    web.close()
    time.sleep(1)

    # ================= Part B: the deciding app changes =================
    web = ctx.new_page()
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.goto(BASE); web.wait_for_timeout(1500)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    d = Desktop(room)
    try:
        check('B. the browser hosts; the desktop joins', wait(lambda: d.last(r'members=Riya\+'), 25), d.out[-3:])
        time.sleep(2)
        harness.open_activity(web, 'Last Card')
        check('the browser opens Last Card', wait(lambda: web.get_by_role('button', name='Join the game').count() == 1, 8))
        d.say('/joingame')
        web.get_by_role('button', name='Join the game').click()
        web.get_by_role('button', name='+ Computer').click()
        d.act({'kind': 'join', 'name': 'Darshan'})
        check('the browser decides: three at the table',
              wait(lambda: (g := d.game()) and len(g['players']) == 3, 8), d.game() and d.game()['players'])
        d.act({'kind': 'start'})
        check('the desktop deals (the browser decides)', wait(lambda: (g := d.game()) and g['phase'] == 'playing', 8))
        g = d.game()
        ds = seat(g, 'Darshan')
        check("the desktop's copy has only its own hand (secret cards)",
              g['hands'][ds] is not None and all(h is None for i, h in enumerate(g['hands']) if i != ds) and g['drawPile'] is None,
              [h is not None for h in g['hands']])
        play_rounds(d, web, 2, 'B')
        g = d.game()
        mine = sorted(g['hands'][ds])
        m = d.mark()
        web.close()  # the host leaves: the desktop now decides, with only its own cards
        check('the browser goes: the desktop decides and asks for the cards back',
              wait(lambda: d.last(r'STORE act:lastcard v=\d+ authority=\S+ state=.*"restoring":true', m), 15), d.out[-3:])
        check('...nobody sends any: it deals again what nobody holds (after 6 s)',
              wait(lambda: (x := d.game()) and not x['restoring'] and (x['event'] or {}).get('kind') in ('restored', 'play', 'draw', 'pass', 'take', 'caught', 'called', 'win'), 20)
              and d.last(r'"kind":"restored"', m) is not None, d.game() and d.game()['event'])
        g = d.game()
        check("...its own hand is the one it had (each card still in its hand or played)",
              all(c in g['hands'][ds] or c in g['discard'] for c in mine), (mine, g['hands'][ds]))
        check('...and the deck adds up: hands + draw pile + discard = 108',
              all(h is not None for h in g['hands']) and sum(len(h) for h in g['hands']) + len(g['drawPile']) + len(g['discard']) == 108,
              (g['counts'], g['drawCount'], len(g['discard'])))
        s0 = g['seq']
        check('the game goes on: the desktop plays for the computer and for Riya (away)',
              wait(lambda: (x := d.game()) and (x['seq'] >= s0 + 2 or x['phase'] == 'over'), 20)
              or (d.game()['players'][d.game()['turn']]['name'] == 'Darshan'), d.game() and d.game()['seq'])
        # Darshan plays if it's his turn
        for _ in range(3):
            g = d.game()
            if g['phase'] == 'playing' and g['players'][g['turn']]['name'] == 'Darshan':
                seq = g['seq']; desktop_turn(d, g, g['turn']); wait(lambda: d.game()['seq'] != seq, 6)
        before_back = sorted(d.game()['hands'][ds] or [])

        # Riya comes back: same browser (same app id), new page
        web = ctx.new_page()
        web.on('pageerror', lambda e: errors.append(str(e)))
        web.goto(f'{BASE}/?room={room}'); web.wait_for_timeout(1500)
        web.get_by_role('button', name='Join room').click()
        check('Riya comes back', wait(lambda: d.last(r'members=.*Riya'), 25), d.out[-2:])
        if web.locator('.activity-bubble.is-invite').count() or wait(lambda: web.locator('.activity-bubble.is-invite').count() > 0, 5):
            harness.join_activity(web)
        g0 = d.game()
        if g0['phase'] == 'playing':
            check('...she gets her seat back and sees a hand of the right size',
                  wait(lambda: (x := d.game()) and x['phase'] != 'playing'
                       or (len(web_hand(web)) > 0 and len(web_hand(web)) == x['counts'][seat(x, 'Riya')]), 25),
                  (web_hand(web), d.game() and d.game()['counts']))
            wait(lambda: not d.game()['restoring'], 10)
            x = d.game()
            check('...and the desktop keeps the hand it had (each card still in its hand or played)',
                  x['phase'] != 'playing' or all(c in (x['hands'][ds] or []) or c in x['discard'] for c in before_back),
                  (before_back, x['hands'][ds]))
            print('   (after Riya came back, the deciding app is', d.authority(), ')')
    finally:
        d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
