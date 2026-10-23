"""Ludo: lobby and rules, a real game between a computer and a phone, spectators, the same board
for everyone, a player leaving (the computer takes over), taking an empty seat, a late joiner."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.signaling())
errors = []


def board(pg):
    return pg.evaluate("Object.fromEntries([...document.querySelectorAll('[data-token]')].map(t => [t.dataset.token, +t.dataset.progress]))")


def status(pg):
    return pg.locator('[data-testid=ludo-status]').inner_text()


def seat_row(pg, color):
    return pg.locator('.ludo-seat').nth(['red', 'green', 'yellow', 'blue'].index(color))


def play_turn(pg):
    """If it's this page's turn: roll, and pick a token when asked. Returns True if it acted."""
    if pg.locator('.ludo-roll-btn').count():
        pg.locator('.ludo-roll-btn').click()
        time.sleep(0.4)
        if pg.locator('.ludo-token.is-movable').count():
            pg.locator('.ludo-token.is-movable').first.click()
        return True
    if pg.locator('.ludo-token.is-movable').count():
        pg.locator('.ludo-token.is-movable').first.click()
        return True
    return False


def same_board(pages, timeout=8):
    return wait(lambda: len({str(sorted(board(p).items())) for p in pages}) == 1 and board(pages[0]), timeout)


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)

    def page(mobile=False):
        ctx = (b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
               if mobile else b.new_context(viewport={'width': 1440, 'height': 900}))
        pg = ctx.new_page()
        pg.add_init_script(INIT)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
        return pg

    host, phone, watcher = page(), page(mobile=True), page()
    host.goto(BASE); host.wait_for_timeout(1500)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    phone.goto(f'{BASE}?room={room}'); phone.wait_for_timeout(1200); phone.get_by_role('button', name='Join room').click()
    watcher.goto(f'{BASE}?room={room}'); watcher.wait_for_timeout(1200); watcher.get_by_role('button', name='Join Room').click()
    check('three people connected', wait(lambda: harness.people(host) >= 3, 25))
    time.sleep(1)

    # open Ludo from the menu
    harness.open_activity(host, 'Ludo')
    check('Ludo opens for the host; the others are invited (nothing loaded)', wait(lambda: host.locator('.ludo-board').count() == 1 and all(
        pg.locator('.activity-bubble.is-invite').count() == 1 and pg.locator('.ludo-board').count() == 0 for pg in (phone, watcher)), 15))
    for pg in (phone, watcher):
        harness.join_activity(pg)
    check('...they join (phone too)', wait(lambda: all(pg.locator('.ludo-board').count() == 1 for pg in (host, phone, watcher)), 15))

    # lobby: seats, computer, rules
    seat_row(host, 'red').get_by_role('button', name='Sit').click()
    seat_row(phone, 'yellow').get_by_role('button', name='Sit').click()
    check('players see each other in their seats', wait(lambda: '(you)' in seat_row(phone, 'yellow').inner_text() and 'User' in seat_row(watcher, 'red').inner_text(), 6))
    check('only the host can change the rules', watcher.locator('.ludo-rule input').first.is_disabled() and not host.locator('.ludo-rule input').first.is_disabled())
    check('default rules: all on, the computer plays for people who leave',
          all(host.locator('.ludo-rule input[type=checkbox]').nth(i).is_checked() for i in range(5)) and host.locator('.ludo-rule input[type=radio]').first.is_checked())
    host.locator('.ludo-rule', has_text='Star squares are safe').locator('input').click()
    check("the host's rule change shows for everyone", wait(lambda: not watcher.locator('.ludo-rule', has_text='Star squares are safe').locator('input').is_checked(), 5))
    host.locator('.ludo-rule', has_text='Star squares are safe').locator('input').click()
    seat_row(host, 'green').get_by_role('button', name='+ Computer').click()
    check('the host can add a computer player', wait(lambda: 'Computer' in seat_row(phone, 'green').inner_text(), 5))
    check('the watcher is told the host starts', watcher.locator('.ludo-start-btn').count() == 0 and 'host starts' in watcher.locator('.ludo-panel').inner_text())
    host.locator('.ludo-start-btn').click()
    check('the game starts for everyone', wait(lambda: all(len(board(pg)) == 12 for pg in (host, phone, watcher)), 8))

    # play: host (red), computer (green), phone (yellow)
    acted = 0
    rolls_by_others = True
    saw_computer_turn = False
    end = time.time() + 70
    while time.time() < end and acted < 24:
        did = False
        for pg in (host, phone):
            if play_turn(pg):
                did = True
                acted += 1
        if watcher.locator('.ludo-roll-btn').count():
            rolls_by_others = False
        if "Computer's turn" in status(watcher) or 'Computer rolled' in status(watcher):
            saw_computer_turn = True
        time.sleep(0.6 if did else 0.3)
    check('people take turns rolling and moving (24 turns)', acted >= 24, acted)
    check('a watcher never gets the Roll button', rolls_by_others)
    time.sleep(1.5)
    check('everyone sees exactly the same board', same_board([host, phone, watcher]), board(host))

    # Chat while playing: the phone's chat list is hidden behind the game, so new messages pop up on it
    phone.evaluate("localStorage.removeItem('3rtc_activity_chat')")
    if phone.locator('.stage-activity.is-chat-split').count():
        phone.locator('.activity-chat-btn').click()
    host.get_by_placeholder(re.compile('Message the room|Type a message')).first.fill('good luck 🎲'); host.keyboard.press('Enter')
    check('chat pops up over the game on the phone', wait(lambda: 'good luck' in ' '.join(phone.locator('.chat-peek-item').all_inner_texts()), 6))
    check('the phone game bar counts it', wait(lambda: phone.locator('.activity-chat-badge').inner_text() == '1', 4))
    phone.locator('.chat-peek-item').first.click()
    check('tapping it shows the chat below the game (game still there)',
          wait(lambda: phone.locator('.stage-activity.is-chat-split').count() == 1 and phone.get_by_text('good luck 🎲').count() > 0 and phone.locator('.ludo-board').is_visible(), 4))
    check('no unread count while the chat is in view', phone.locator('.activity-chat-badge').count() == 0)
    phone.locator('.activity-chat-btn').click()
    check('the Chat button brings back the bigger board', wait(lambda: phone.locator('.stage-activity.is-chat-split').count() == 0, 3))
    # its turns come and go (the game would stop at green otherwise)
    check('the computer (green) plays its turns', saw_computer_turn and acted >= 24)

    # someone joining now gets the game as it is
    late = page()
    late.goto(f'{BASE}?room={room}'); late.wait_for_timeout(1200); late.get_by_role('button', name='Join Room').click()
    harness.join_activity(late, 20)
    check('a late joiner sees the same game', wait(lambda: late.locator('.ludo-board').count() == 1, 20) and same_board([host, late], 15), board(late))

    # the phone player leaves: the computer plays yellow; the watcher can take the seat
    phone.context.close()
    check('the leaver is shown as away', wait(lambda: 'away' in seat_row(host, 'yellow').inner_text(), 20))
    # yellow's name shows as the one to play, then the turn comes back round to the host
    phone_name = seat_row(host, 'yellow').inner_text().split('\n')[0].replace('away', '').strip()
    saw_yellow_turn = False
    host_after = 0
    end = time.time() + 60
    while time.time() < end and not (saw_yellow_turn and host_after >= 1):
        if f"{phone_name}'s turn" in status(host):
            saw_yellow_turn = True
        if play_turn(host) and saw_yellow_turn:
            host_after += 1
        time.sleep(0.4)
    check("the game goes on through the leaver's turns", saw_yellow_turn and host_after >= 1, phone_name)
    take = seat_row(watcher, 'yellow').get_by_role('button', name='Take seat')
    check('a watcher can take the empty seat', take.count() == 1)
    take.click()
    check('...and then plays yellow', wait(lambda: '(you)' in seat_row(watcher, 'yellow').inner_text(), 6))
    end = time.time() + 40
    watcher_played = False
    while time.time() < end and not watcher_played:
        play_turn(host)
        watcher_played = play_turn(watcher)
        time.sleep(0.5)
    check('the new yellow player gets turns', watcher_played)
    time.sleep(1.5)
    check('boards still match', same_board([host, watcher, late]))

    host.screenshot(path=str(harness.OUT / 'ludo-desktop.png'))
    harness.end_game(host)
    check('closing Ludo closes it for everyone', wait(lambda: watcher.locator('.ludo-board').count() == 0 and late.locator('.ludo-board').count() == 0, 6))
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
