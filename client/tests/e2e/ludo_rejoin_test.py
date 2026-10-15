"""Ludo when the host comes back (reload / reopened tab, so a new connection): the host gets the
game as it is, its colour back, and stays the one who runs it; the others keep their colours and
don't get the host's buttons. In the lobby and in the middle of a game."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.signaling())
errors = []
COLORS = ['red', 'green', 'yellow', 'blue']


def seat(pg, color):
    return pg.locator('.ludo-seat').nth(COLORS.index(color)).inner_text()


def board(pg):
    return pg.evaluate("Object.fromEntries([...document.querySelectorAll('[data-token]')].map(t => [t.dataset.token, +t.dataset.progress]))")


def come_back(pg):
    """Reload-like: leave the site and open it again, then Rejoin."""
    pg.goto(BASE + '/about')
    pg.wait_for_timeout(400)
    pg.goto(BASE)
    card = pg.get_by_role('region', name='Rejoin your last room')
    wait(lambda: card.count() == 1, 8)
    card.get_by_role('button', name='Rejoin').click()
    return wait(lambda: pg.locator('.ludo-board').count() == 1, 20)


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)

    def page(name):
        pg = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
        pg.add_init_script(INIT + f"localStorage.setItem('webrtc_username', '{name}');")
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
        return pg

    host, guest = page('Hosty'), page('Guesty')
    host.goto(BASE); host.wait_for_timeout(1200)
    host.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    host.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    guest.goto(f'{BASE}?room={room}'); guest.wait_for_timeout(1200); guest.get_by_role('button', name='Join Room').click()
    wait(lambda: host.locator('.stage-voice-chip').count() >= 2, 25); time.sleep(1)
    host.locator('.stage-more-wrap .circle-action-btn').click()
    host.locator('.stage-more-dropdown .dropdown-item', has_text='Ludo').click()
    wait(lambda: guest.locator('.ludo-board').count() == 1, 10)
    host.locator('.ludo-seat').nth(0).get_by_role('button', name='Sit').click()
    guest.locator('.ludo-seat').nth(3).get_by_role('button', name='Sit').click()
    check('lobby: host red, guest blue', wait(lambda: '(you)' in seat(host, 'red') and '(you)' in seat(guest, 'blue'), 6))

    # ---- the host comes back in the lobby
    check('the host comes back to the game it left', come_back(host))
    check('...in its own colour (red), automatically', wait(lambda: '(you)' in seat(host, 'red'), 8), seat(host, 'red'))
    check('...and the guest keeps blue', '(you)' in seat(guest, 'blue') and 'Hosty' in seat(guest, 'red'), [seat(guest, 'red'), seat(guest, 'blue')])
    check('only the host can start (the guest has no Start)', wait(lambda: host.locator('.ludo-start-btn').count() == 1 and guest.locator('.ludo-start-btn').count() == 0, 5))
    check("the guest sees the rules as the host's", 'host sets these' in guest.locator('.ludo-rules-title').first.inner_text().lower())

    host.locator('.ludo-start-btn').click()
    check('the game starts for both', wait(lambda: host.locator('[data-testid=ludo-status]').count() and guest.locator('[data-testid=ludo-status]').count() and board(host) == board(guest) and board(host), 8))
    for _ in range(4):  # a few turns
        for pg in (host, guest):
            if pg.locator('.ludo-roll-btn').count():
                pg.locator('.ludo-roll-btn').click(); time.sleep(1.7)
                if pg.locator('.ludo-token.is-movable').count():
                    pg.locator('.ludo-token.is-movable').first.click(); time.sleep(0.8)
    before = board(guest)

    # ---- the host comes back in the middle of the game
    check('mid-game: the host comes back to the same game', come_back(host))
    check('...as red again, with its tokens where they were', wait(lambda: '(you)' in seat(host, 'red') and board(host) == before, 8), [seat(host, 'red'), board(host), before])
    check('...the guest is still blue', '(you)' in seat(guest, 'blue'))
    check('...both see the same game', wait(lambda: host.locator('[data-testid=ludo-status]').inner_text().replace('You', '') != '' and board(host) == board(guest), 6))
    turn_ok = wait(lambda: any(pg.locator('.ludo-roll-btn').count() for pg in (host, guest)), 25)
    check('...and play goes on (someone can roll)', turn_ok)
    host.screenshot(path=str(harness.OUT / 'ludo_rejoin_host.png'))
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
