"""Ludo, not for everyone: the others are invited (nothing loads until they join), and anyone can
leave the game mid-play. The host leaves (its app was playing for the computer): the game goes on
for the others, the computer still plays and the host's colour shows "away" (a computer plays for
it). The host joins again: same colour, the game as it is now. Someone who never joins never
loads the game."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.signaling())
errors = []


def seq(pg):
    """How many moves the game has had (it goes up as turns are played)."""
    return pg.evaluate("(() => { const t = document.querySelector('[data-testid=ludo-status]'); return t ? t.innerText : ''; })()")


def seat(pg, color):
    i = ['red', 'green', 'yellow', 'blue'].index(color)
    return pg.locator('.ludo-seat').nth(i).inner_text()


def ludo_loaded(pg):
    """Ludo's code and screen on this page (the game's chunk fetched, its board drawn)."""
    return pg.evaluate("performance.getEntriesByType('resource').some((r) => /ludo/i.test(r.name))"), pg.locator('.ludo-board').count() == 1


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)

    def page(name):
        pg = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
        pg.add_init_script(INIT + f"localStorage.setItem('webrtc_username', '{name}');")
        pg.on('pageerror', lambda e: errors.append(str(e)))
        return pg

    host, guest, skipper = page('Hosty'), page('Guesty'), page('Skippy')
    host.goto(BASE); host.wait_for_timeout(1200)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    for pg in (guest, skipper):
        pg.goto(f'{BASE}?room={room}'); pg.wait_for_timeout(1200); pg.get_by_role('button', name='Join room').click()
    check('three in the room', wait(lambda: harness.people(host) >= 3, 25))
    time.sleep(1)

    harness.open_activity(host, 'Ludo')
    check('the others are invited, nothing loaded', wait(lambda: all(pg.locator('.activity-bubble.is-invite').count() == 1 for pg in (guest, skipper)), 10)
          and ludo_loaded(skipper) == (False, False), ludo_loaded(skipper))
    harness.join_activity(guest)
    check('the guest joins', wait(lambda: guest.locator('.ludo-board').count() == 1, 10))
    host.locator('.ludo-seat').nth(0).get_by_role('button', name='Sit').click()
    host.locator('.ludo-seat').nth(1).get_by_role('button', name=re.compile('Computer')).click()
    guest.locator('.ludo-seat').nth(2).get_by_role('button', name='Sit').click()
    wait(lambda: '(you)' in seat(guest, 'yellow'), 5)
    host.locator('.ludo-start-btn').click()
    check('the game starts', wait(lambda: guest.locator('[data-testid=ludo-status]').count() == 1 and 'turn' in seq(guest).lower(), 8), seq(guest))

    # The host leaves the game (not the room)
    host.get_by_role('button', name=re.compile('Leave Ludo')).click()
    check('Leave: the game is gone from the host\'s screen (an invitation back)', wait(lambda: host.locator('.ludo-board').count() == 0 and host.locator('.activity-bubble.is-invite').count() == 1, 5))
    check('...the host is still in the room', harness.people(host) >= 3 and host.locator('.dock-leave').count() == 1)
    check("for the guest the host's colour is away", wait(lambda: 'away' in seat(guest, 'red'), 8), seat(guest, 'red'))
    # Play on: the guest rolls when it's its turn; the computer (green) and the away host (red) move by themselves
    played_by_others = set()
    seen_status = set()
    end = time.time() + 75  # (the status shows only the latest move: give it a few rounds)
    while time.time() < end and len(played_by_others) < 2:
        status = seq(guest)
        if guest.locator('.ludo-roll-btn').count() and guest.locator('.ludo-roll-btn').is_enabled():
            guest.locator('.ludo-roll-btn').click(); time.sleep(1.5)
            if guest.locator('.ludo-token.is-movable').count():
                guest.locator('.ludo-token.is-movable').first.click()
        seen_status.add(status)
        m = re.search(r'(Hosty|Computer|Green|Red)[^.]*rolled', status)
        if m:
            played_by_others.add('red' if m.group(1) in ('Hosty', 'Red') else 'green')
        time.sleep(0.25)
    check('the game goes on without the host: the computer and the away colour still play', played_by_others == {'red', 'green'}, [played_by_others, list(seen_status)[:8]])

    harness.join_activity(host)
    check('the host joins again and gets red back', wait(lambda: host.locator('.ludo-board').count() == 1 and '(you)' in seat(host, 'red'), 10), seat(host, 'red') if host.locator('.ludo-seat').count() else '')
    check('...no longer away for the guest', wait(lambda: 'away' not in seat(guest, 'red'), 8), seat(guest, 'red'))
    check('the one who never joined still has nothing loaded', ludo_loaded(skipper) == (False, False), ludo_loaded(skipper))
    skipper.screenshot(path=str(harness.OUT / 'ludo_invite.png'))
    skipper.get_by_role('button', name='Games').click()
    item = skipper.get_by_role('menuitem', name=re.compile('Ludo'))
    check('the Games menu offers to join the game that is on', item.is_enabled() and 'join' in (item.get_attribute('title') or '').lower(), item.get_attribute('title'))
    item.click()
    check('...and joins it', wait(lambda: skipper.locator('.ludo-board').count() == 1, 10))
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
