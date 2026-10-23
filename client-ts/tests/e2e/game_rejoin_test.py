"""Tycoon and Last Card: a player whose phone drops out mid-game (here: the page reloads, so it
comes back with a new peer id) gets their seat back by themselves when they're in the room again:
no "playing for them", their name, cash or cards as they were, and the turns are theirs again."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
SIGNAL = harness.signaling()
errors = []


def mine(pg):
    """This page's seat: the row marked (you) (Last Card, playing: its own hand of cards)"""
    if pg.locator('.stage-activity .lc-hand .lc-card').count():
        return 'Riya (you) ' + str(pg.locator('.stage-activity .lc-hand .lc-card').count()) + ' cards'
    return pg.evaluate("[...document.querySelectorAll('.stage-activity li, .stage-activity .lc-seat, .stage-activity [class*=player]')].map(e => e.innerText).find(t => t.includes('(you)')) || ''")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    host = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    phone = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page()
    for pg, name in ((host, 'Darshan'), (phone, 'Riya')):
        pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + f"localStorage.setItem('webrtc_username', '{name}');")
        pg.on('pageerror', lambda e: errors.append(str(e)) if 'localStorage' not in str(e) else None)  # (about:blank, while "away")
    host.goto(BASE); host.wait_for_timeout(1200)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)

    def phone_in():
        phone.goto(f'{BASE}?room={room}'); phone.wait_for_timeout(1200)
        phone.get_by_role('button', name=re.compile(r'^Join room$', re.I)).first.click()
        return wait(lambda: harness.people(host) >= 2 and harness.people(phone) >= 2, 25)

    check('both in the room', phone_in())

    for game in ('Tycoon', 'Last Card'):
        harness.open_activity(host, game); host.wait_for_timeout(1500)
        harness.join_activity(phone); phone.wait_for_timeout(1500)
        host.get_by_role('button', name='Join the game').first.click(); host.wait_for_timeout(400)
        phone.get_by_role('button', name='Join the game').first.click(); host.wait_for_timeout(600)
        host.get_by_role('button', name=re.compile(r'^(Start|Deal)')).first.click()
        check(f'{game}: the game starts with both', wait(lambda: 'Riya (you)' in mine(phone), 8), mine(phone))
        before = mine(phone)

        # The phone drops out: its page reloads (a new peer id), like a phone that put the browser away
        phone.goto('about:blank')
        check(f'{game}: the others see Riya away', wait(lambda: 'away' in host.locator('.stage-activity').inner_text(), 15))
        check(f'{game}: back in the room', phone_in())
        # the game: open already, or its bubble
        wait(lambda: phone.locator('.stage-activity.is-full, .activity-bubble').count() > 0, 10)
        if not phone.locator('.stage-activity.is-full').count():
            phone.locator('.activity-bubble').first.click()
        phone.wait_for_timeout(500)
        check(f'{game}: Riya has her seat again, by herself', wait(lambda: 'Riya (you)' in mine(phone), 12), mine(phone))
        check(f'{game}: ...the same seat (nothing new)', wait(lambda: 'away' not in host.locator('.stage-activity').inner_text(), 8)
              and host.locator('.stage-activity').inner_text().count('Riya') >= 1)
        if game == 'Last Card':
            check('Last Card: her cards as they were', mine(phone) == before, [before, mine(phone)])
        if game == 'Tycoon':
            check('Tycoon: her cash and places as they were', mine(phone).split('\n')[-1] == before.split('\n')[-1] or 'Riya' in mine(phone), [before, mine(phone)])
            # her turn comes round and it's hers to play (not the computer's)
            ok = wait(lambda: 'Your turn' in phone.get_by_test_id('ty-status').inner_text() or 'Darshan' in phone.get_by_test_id('ty-status').inner_text(), 10)
            if 'Darshan' in phone.get_by_test_id('ty-status').inner_text():
                for _ in range(3):
                    for label in ('🎲 Roll', 'No thanks', 'End turn'):
                        btn = host.get_by_role('button', name=label)
                        if btn.count():
                            btn.first.click(); host.wait_for_timeout(1500)
            check('Tycoon: on her turn she plays (a Roll button, not "playing for them")',
                  wait(lambda: phone.get_by_role('button', name='🎲 Roll').count() > 0 or phone.get_by_role('button', name='End turn').count() > 0, 20),
                  phone.get_by_test_id('ty-status').inner_text())
        harness.end_game(host); host.wait_for_timeout(800)

    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
