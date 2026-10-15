"""Ludo while a video plays: on a computer the game moves to a small window over the video (drag,
resize, full size, minimise to a bubble); on a phone it becomes a bubble that pulses "Your turn"
and opens the game over the video (Back puts it away again). Ending the video brings the game back."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
MEDIA = harness.media_server()
FILE = f'{MEDIA}/test_small.mp4'
INIT = harness.signal_init(harness.signaling())
RIG = "(() => { const real = Math.random; window.__dice = []; Math.random = () => (window.__dice.length && /ludo\\/rules/.test(new Error().stack || '')) ? (window.__dice.shift() - 1) / 6 + 0.01 : real(); })();"
errors = []


def view(pg):
    el = pg.locator('.stage-activity')
    if not el.count():
        return None
    cls = el.get_attribute('class')
    return next((v for v in ('full', 'window', 'bubble') if f'is-{v}' in cls), None)


def vt(pg):
    return pg.evaluate("(() => { const v = document.querySelector('.link-player video'); return v ? { t: v.currentTime, paused: v.paused } : null; })()")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    host = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    phone = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2).new_page()
    host.add_init_script(INIT + RIG + "localStorage.removeItem('3rtc_activity_window');")
    phone.add_init_script(INIT)
    for pg in (host, phone):
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
    host.goto(BASE); host.wait_for_timeout(1200)
    host.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    host.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    phone.goto(f'{BASE}?room={room}'); phone.wait_for_timeout(1200); phone.get_by_role('button', name='Join room').click()
    check('both in the room', wait(lambda: host.locator('.stage-voice-chip').count() >= 2, 25))
    time.sleep(1)

    host.locator('.stage-more-wrap .circle-action-btn').click()
    host.locator('.stage-more-dropdown .dropdown-item', has_text='Ludo').click()
    wait(lambda: phone.locator('.ludo-board').count() == 1, 10)
    host.locator('.ludo-seat').nth(0).get_by_role('button', name='Sit').click()
    phone.locator('.ludo-seat').nth(2).get_by_role('button', name='Sit').click()
    wait(lambda: '(you)' in phone.locator('.ludo-seat').nth(2).inner_text(), 5)
    host.evaluate("window.__dice = [1]")  # red (host) goes first
    host.locator('.ludo-start-btn').click()
    check('the game starts, full size', wait(lambda: host.locator('.ludo-roll-btn').count() == 1, 6) and view(host) == 'full' and view(phone) == 'full')

    # A video from the phone's Add video button
    phone.get_by_role('button', name='Add video').last.click()
    phone.locator('input[placeholder*="Paste a link"]:visible').last.fill(FILE)
    phone.get_by_role('button', name=re.compile('Play for everyone')).click()
    check('computer: the game moves to a small window over the video', wait(lambda: view(host) == 'window', 10), view(host))
    check('phone: the game becomes a bubble', wait(lambda: view(phone) == 'bubble' and phone.locator('.activity-bubble').count() == 1, 10), view(phone))
    check('the video plays for both', wait(lambda: (vt(host) or {}).get('t', 0) > 1 and (vt(phone) or {}).get('t', 0) > 1, 20), [vt(host), vt(phone)])
    win = host.locator('.stage-activity').bounding_box()
    video = host.locator('.link-player').bounding_box()
    check('the window is small and in the bottom-right corner of the video', win['width'] <= 400 and win['x'] > video['x'] + video['width'] / 2
          and video['x'] + video['width'] - (win['x'] + win['width']) < 40 and video['y'] + video['height'] - (win['y'] + win['height']) < 120, [win, video])
    check('...and glows: it is your turn', 'needs-you' in host.locator('.stage-activity').get_attribute('class'))
    host.screenshot(path=str(harness.OUT / 'ludo_video_window.png'))

    # Play in the window
    host.evaluate("window.__dice = [3]")
    host.locator('.stage-activity .ludo-roll-btn').click()
    check('you can play in the small window', wait(lambda: 'Guesty' in host.locator('[data-testid=ludo-status]').inner_text() or 'yellow' in host.locator('[data-testid=ludo-status]').inner_text().lower() or host.locator('.ludo-roll-btn').count() == 0, 6),
          host.locator('[data-testid=ludo-status]').inner_text())

    # The phone's turn: the bubble pulses
    check("phone: on its turn the bubble pulses \"Your turn\"",
          wait(lambda: 'is-attention' in (phone.locator('.activity-bubble').get_attribute('class') or '') and 'Your turn' in phone.locator('.activity-bubble').inner_text(), 10),
          phone.locator('.activity-bubble').inner_text() if phone.locator('.activity-bubble').count() else None)
    phone.screenshot(path=str(harness.OUT / 'ludo_video_bubble.png'))
    bub = phone.locator('.activity-bubble').bounding_box()
    pv = phone.locator('.link-player').bounding_box()
    check("...at the side of the video, clear of Exit Video and the video's controls",
          bub['y'] > pv['y'] + 30 and bub['y'] + bub['height'] < pv['y'] + pv['height'] - 70 and bub['x'] + bub['width'] > pv['x'] + pv['width'] - 30
          and phone.get_by_role('button', name=re.compile('Exit Video')).first.is_visible(), [bub, pv])
    phone.locator('.activity-bubble').click()
    check('tapping it opens the game over the video', wait(lambda: view(phone) == 'full' and phone.locator('.ludo-roll-btn').is_visible(), 5))
    phone.screenshot(path=str(harness.OUT / 'ludo_video_phone_open.png'))
    t0 = (vt(phone) or {}).get('t', 0); time.sleep(1.2)
    check('...while the video keeps playing', (vt(phone) or {}).get('t', 0) > t0 + 0.5, [t0, vt(phone)])
    phone.locator('.ludo-roll-btn').click(); time.sleep(1.8)
    if phone.locator('.ludo-token.is-movable').count():
        phone.locator('.ludo-token.is-movable').first.click()
    phone.go_back()
    check('Back puts the game away again (still in the room)', wait(lambda: view(phone) == 'bubble', 5) and phone.locator('.phone-actionbar').count() == 1)
    phone.locator('.activity-bubble').click()
    check('...and opens again', wait(lambda: view(phone) == 'full', 5))
    btn = phone.locator('.activity-video-btn')
    check('the open game has a labelled "Video" button, on screen', btn.count() == 1 and btn.is_visible() and btn.bounding_box()['x'] + btn.bounding_box()['width'] <= 390)
    btn.click()
    check('...which goes back to the video (bubble)', wait(lambda: view(phone) == 'bubble', 5))
    phone.locator('.activity-bubble').click()
    check('back and forth as often as you like', wait(lambda: view(phone) == 'full', 5))
    phone.locator('.activity-video-btn').click()
    check('...bubble again; the room is still there', wait(lambda: view(phone) == 'bubble', 5) and phone.locator('.phone-actionbar').count() == 1)
    phone.go_back(); time.sleep(0.8)
    check('Back after using the button does not leave a stale step (still in the room)', phone.locator('.phone-actionbar').count() == 1 or 'room' in phone.url, phone.url)

    # Window: drag, resize, full size, minimise
    bar = host.locator('.stage-activity .activity-bar').bounding_box()
    before = host.locator('.stage-activity').bounding_box()
    host.mouse.move(bar['x'] + 40, bar['y'] + bar['height'] / 2); host.mouse.down()
    host.mouse.move(bar['x'] - 260, bar['y'] - 150, steps=8); host.mouse.up()
    after = host.locator('.stage-activity').bounding_box()
    check('the window can be dragged', after['x'] < before['x'] - 200 and after['y'] < before['y'] - 100, [before, after])
    grip = host.locator('.activity-resize').bounding_box()
    host.mouse.move(grip['x'] + 5, grip['y'] + 5); host.mouse.down()
    host.mouse.move(grip['x'] - 300, grip['y'] + 5, steps=8); host.mouse.up()
    check('...and resized (up to 520 px)', abs(host.locator('.stage-activity').bounding_box()['width'] - 520) < 2, host.locator('.stage-activity').bounding_box())
    host.get_by_role('button', name='Minimise').click()
    check('minimise: a bubble', wait(lambda: view(host) == 'bubble' and host.locator('.activity-bubble').count() == 1, 3))
    host.locator('.activity-bubble').click()
    check('the bubble opens the small window again, where it was', wait(lambda: view(host) == 'window', 3) and abs(host.locator('.stage-activity').bounding_box()['width'] - 520) < 2)
    host.get_by_role('button', name='Full size').click()
    check('full size covers the stage, with a way back to the small window', wait(lambda: view(host) == 'full', 3) and host.locator('.activity-window-btn').is_visible())
    host.locator('.activity-window-btn').click()
    check('...back to the small window', wait(lambda: view(host) == 'window', 3))

    # The video ends: the game comes back
    host.get_by_role('button', name=re.compile('Exit Video')).first.click()
    check('exiting the video brings the game back full size for everyone', wait(lambda: view(host) == 'full' and view(phone) == 'full', 8), [view(host), view(phone)])
    check('the game went on all along', host.locator('[data-testid=ludo-status]').count() == 1 and phone.locator('.ludo-board').count() == 1)
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
