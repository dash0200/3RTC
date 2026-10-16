"""The Back button in a room (phone): it closes what's open on top, asks before leaving, never
closes a video or the game; the room code stays in the address; Rejoin after leaving (guest and
host); closing the tab mid-video asks first."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.signaling())
errors = []


def back(pg):
    """The phone's Back button / back gesture."""
    try:
        pg.go_back(timeout=1500)
    except Exception:  # noqa: BLE001 - same-page history step: no navigation to wait for
        pass
    pg.wait_for_timeout(400)


def url(pg):
    # (page.url can lag behind history.replaceState; ask the page)
    return pg.evaluate('location.href')


def in_room(pg):
    return pg.locator('.phone-actionbar, .stage-voice-chip').count() > 0 and pg.locator('.phone-home').count() == 0


def leave_dialog(pg):
    return pg.get_by_role('alertdialog').count() > 0


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    hctx = b.new_context(viewport={'width': 1280, 'height': 800})
    pctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    host, phone = hctx.new_page(), pctx.new_page()
    for pg in (host, phone):
        pg.add_init_script(INIT)
        pg.on('pageerror', lambda e: errors.append(str(e)))
    host.on('dialog', lambda d: d.accept())

    # Arrive from another page first, so a Back that escaped would really leave the site
    phone.goto(BASE + '/about')
    host.goto(BASE); host.wait_for_timeout(1500)
    host.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    host.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    check('the host address carries the room code', wait(lambda: f'room={room}' in url(host), 5), url(host))
    phone.goto(f'{BASE}/?room={room}'); phone.wait_for_timeout(1500)
    phone.get_by_role('button', name='Join room').click()
    ok = check('phone joined', wait(lambda: host.locator('.stage-voice-chip').count() >= 2 and in_room(phone), 25))
    if not ok:
        print('ERRORS', errors[:3]); phone.screenshot(path=str(harness.OUT / 'back_phone_join.png')); host.screenshot(path=str(harness.OUT / 'back_host_join.png'))

    # Sheets: Back closes the top one and stays in the room
    phone.get_by_role('button', name='More').click()
    wait(lambda: phone.get_by_role('dialog', name='More').is_visible(), 3)
    phone.get_by_role('button', name='Soundboard').click()
    wait(lambda: phone.get_by_role('dialog', name='Soundboard').is_visible(), 3)
    back(phone)
    check('Back closes the open sheet, still in the room',
          phone.get_by_role('dialog', name='Soundboard').count() == 0 and in_room(phone) and f'room={room}' in url(phone), url(phone))
    phone.get_by_role('button', name='Add video').last.click()
    wait(lambda: phone.get_by_role('dialog', name='Add video').is_visible(), 3)
    back(phone)
    check('Back closes the Add video sheet', wait(lambda: phone.get_by_role('dialog', name='Add video').count() == 0, 3) and in_room(phone))

    # Nothing open: asks before leaving
    back(phone)
    check('Back with nothing open asks "Leave room?"', wait(lambda: leave_dialog(phone), 3) and str(room) in phone.get_by_role('alertdialog').inner_text())
    back(phone)
    check('Back again just closes the question (stays)', wait(lambda: not leave_dialog(phone), 3) and in_room(phone))
    back(phone)
    wait(lambda: leave_dialog(phone), 3)
    phone.get_by_role('button', name='Stay').click()
    check('Stay keeps you in the room', not leave_dialog(phone) and in_room(phone) and host.locator('.stage-voice-chip').count() >= 2)
    for _ in range(4):  # many Backs never leave the site
        back(phone)
        if leave_dialog(phone):
            phone.get_by_role('button', name='Stay').click()
    check('pressing Back again and again never leaves the site', '/about' not in url(phone) and in_room(phone), url(phone))

    # A game open: Back closes the phone's chat view first, then minimises the game, then asks
    host.locator('.stage-more-wrap .circle-action-btn').click()
    host.locator('.stage-more-dropdown .dropdown-item', has_text='Ludo').click()
    check('a game opens on the phone', wait(lambda: phone.locator('.ludo-board').count() == 1, 15))
    if not phone.locator('.stage-activity.is-chat-split').count():
        phone.locator('.activity-chat-btn').click()
    wait(lambda: phone.locator('.stage-activity.is-chat-split').count() == 1, 3)
    back(phone)
    check("Back closes the game's chat view, the game stays",
          wait(lambda: phone.locator('.stage-activity.is-chat-split').count() == 0, 3) and phone.locator('.ludo-board').count() == 1)
    back(phone)
    check('Back in a game minimises it to its bubble (the game goes on)',
          wait(lambda: phone.locator('.activity-bubble').count() == 1 and 'is-bubble' in (phone.locator('.stage-activity').get_attribute('class') or ''), 3) and not leave_dialog(phone))
    back(phone)
    check('Back again asks about the room, the game stays', wait(lambda: leave_dialog(phone), 3) and phone.locator('.ludo-board').count() == 1)
    phone.get_by_role('button', name='Stay').click()
    host.locator('.activity-close-btn').click()
    wait(lambda: phone.locator('.ludo-board').count() == 0, 6)

    # A video open: Back doesn't close it (it has its own Exit button)
    host.set_input_files('input[accept*="video/mp4"]', harness.media('test_small.mp4'))
    check('host shares a video; the phone sees it', wait(lambda: phone.get_by_role('button', name=re.compile('Stream', re.I)).count() > 0, 15))
    back(phone)
    check('Back during a video asks about the room, the video stays',
          wait(lambda: leave_dialog(phone), 3) and phone.get_by_role('button', name=re.compile('Stream', re.I)).count() > 0)
    phone.get_by_role('button', name='Stay').click()
    # Closing the tab mid-video: the browser asks first
    asked = []
    phone.on('dialog', lambda d: (asked.append(d.type), d.accept()))
    phone.close(run_before_unload=True)
    host.wait_for_timeout(1200)
    check('closing the tab mid-video asks first', 'beforeunload' in asked, asked)

    # Reopening after the tab closed: Rejoin on the home screen
    phone = pctx.new_page()
    phone.add_init_script(INIT)
    phone.on('pageerror', lambda e: errors.append(str(e)))
    phone.goto(BASE + '/'); phone.wait_for_timeout(1200)
    card = phone.get_by_role('region', name='Rejoin your last room')
    check('home screen offers "Rejoin room"', wait(lambda: card.count() == 1, 5) and str(room) in card.inner_text())
    card.get_by_role('button', name='Rejoin').click()
    check('Rejoin puts you back in the room', wait(lambda: in_room(phone) and host.locator('.stage-voice-chip').count() >= 2, 25))

    # Leaving through Back: the code leaves the address, Rejoin is offered
    back(phone)
    wait(lambda: leave_dialog(phone), 3)
    phone.get_by_role('button', name='Leave room').click()
    check('leaving from the question goes home; the address loses the code',
          wait(lambda: phone.locator('.phone-home').count() == 1 and 'room=' not in url(phone), 8), url(phone))
    check('home offers Rejoin after leaving', wait(lambda: phone.get_by_role('region', name='Rejoin your last room').count() == 1, 3))
    phone.get_by_role('button', name='Dismiss').click()
    check('Rejoin can be dismissed', phone.get_by_role('region', name='Rejoin your last room').count() == 0)

    # The host leaves and gets the same room back
    host.get_by_role('button', name=re.compile('Leave', re.I)).first.click()
    wait(lambda: host.locator('.stage-overlay .initial-actions').count() == 1, 8)
    card = host.get_by_role('region', name='Rejoin your last room')
    check('the host is offered their room back', wait(lambda: card.count() == 1, 3) and 'Your room' in card.inner_text())
    card.get_by_role('button', name='Rejoin').click()
    check('the host is back in the same room, as host',
          wait(lambda: f'room={room}' in url(host) and host.locator('.stage-voice-chip').count() >= 1, 10),
          f"{url(host)} {[m.get('type') for m in host.evaluate('window.__sig')][-6:]}")

    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
