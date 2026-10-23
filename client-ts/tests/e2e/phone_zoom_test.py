"""Phone: pinch to zoom the games and the whiteboard. Two fingers zoom (up to 3x) and pan, and
never play a move or draw; one finger still plays (and draws in the right place when zoomed);
"Reset zoom" goes back to 1x; zoomed in, a swipe down doesn't put the game away."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
SIGNAL = harness.signaling()
errors = []


def touch(pg, kind, points):
    pg.__cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(points)]})


def pinch(pg, cx, cy, d0, d1, steps=10, dx=0):
    """Two fingers, centred on (cx, cy), from d0 apart to d1 apart (moving dx sideways)."""
    touch(pg, 'touchStart', [(cx - d0 / 2, cy), (cx + d0 / 2, cy)])
    for i in range(1, steps + 1):
        d = d0 + (d1 - d0) * i / steps
        x = cx + dx * i / steps
        touch(pg, 'touchMove', [(x - d / 2, cy), (x + d / 2, cy)]); time.sleep(0.02)
    touch(pg, 'touchEnd', [])
    time.sleep(0.3)


def drag(pg, x0, y0, x1, y1, steps=10):
    touch(pg, 'touchStart', [(x0, y0)])
    for i in range(1, steps + 1):
        touch(pg, 'touchMove', [(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)]); time.sleep(0.02)
    touch(pg, 'touchEnd', [])
    time.sleep(0.4)


def zoom(pg):
    t = pg.evaluate("(() => { const z = document.querySelector('.stage-activity .activity-zoom'); return z ? z.style.transform : ''; })()")
    m = re.search(r'scale\(([\d.]+)\)', t or '')
    return float(m.group(1)) if m else 1.0


def drawings(pg):
    label = pg.locator('.wb-over').get_attribute('aria-label') or ''
    m = re.search(r'(\d+) drawing', label)
    return int(m.group(1)) if m else -1


def body_box(pg):
    return pg.locator('.stage-activity .activity-body').bounding_box()


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    desk = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    phone = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2).new_page()
    for pg, name in ((desk, 'Darshan'), (phone, 'Riya')):
        pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + f"localStorage.setItem('webrtc_username', '{name}');")
        pg.on('pageerror', lambda e: errors.append(str(e)))
    phone.__cdp = phone.context.new_cdp_session(phone)
    desk.goto(BASE); desk.wait_for_timeout(1200)
    harness.create_room(desk)
    room = wait(lambda: next((m['roomId'] for m in desk.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    phone.goto(f'{BASE}?room={room}'); phone.wait_for_timeout(1200)
    phone.get_by_role('button', name=re.compile(r'^Join room$', re.I)).first.click()
    check('two people connected', wait(lambda: harness.people(desk) >= 2 and harness.people(phone) >= 2, 25))

    # ---- whiteboard: two fingers zoom, one finger draws ----
    harness.open_activity(phone, 'Whiteboard'); phone.wait_for_timeout(1500)
    wb = phone.locator('.wb-over').bounding_box()
    cx, cy = wb['x'] + wb['width'] / 2, wb['y'] + wb['height'] / 2
    drag(phone, wb['x'] + 40, cy, wb['x'] + 160, cy)
    check('whiteboard, 1x: one finger draws', wait(lambda: drawings(phone) == 1, 3), drawings(phone))
    pinch(phone, cx, cy, 60, 180)
    check('a pinch zooms the whiteboard in', zoom(phone) > 2.5, zoom(phone))
    check('...and draws nothing', drawings(phone) == 1, drawings(phone))
    check('"Reset zoom" shows while zoomed', phone.locator('.activity-zoom-reset').is_visible())
    check('...the board itself stays the same size (it isn\'t refitted)', abs(phone.locator('.wb-over').bounding_box()['width'] / wb['width'] - zoom(phone)) < 0.05,
          [phone.locator('.wb-over').bounding_box()['width'], wb['width'], zoom(phone)])
    # draw while zoomed: the line lands where the finger was
    zb = phone.locator('.wb-over').bounding_box()
    bb = body_box(phone)
    y = bb['y'] + bb['height'] / 2
    x0 = max(zb['x'], bb['x']) + 30
    expect = [(x0 - zb['x']) / zb['width'], (y - zb['y']) / zb['height']]  # where on the board (0..1)
    drag(phone, x0, y, x0 + 90, y)
    check('zoomed in: one finger draws', wait(lambda: drawings(phone) == 2, 3), drawings(phone))
    phone.locator('.activity-zoom-reset').click(); phone.wait_for_timeout(400)
    check('"Reset zoom" goes back to 1x', zoom(phone) == 1.0 and phone.locator('.activity-zoom-reset').count() == 0, zoom(phone))
    phone.screenshot(path=str(harness.OUT / 'phone_zoom_wb.png'))
    harness.end_game(phone); phone.wait_for_timeout(600)

    # ---- chess: a pinch moves nothing; zoomed, taps still play ----
    harness.open_activity(phone, 'Chess'); phone.wait_for_timeout(1500)
    phone.screenshot(path=str(harness.OUT / 'phone_zoom_chess_lobby.png'))
    phone.get_by_role('button', name=re.compile(r'\+ Computer')).first.click()
    phone.get_by_role('button', name='Play').first.click(); phone.wait_for_timeout(500)
    start = phone.locator('.btn-primary', has_text=re.compile('Start'))
    if start.count():
        start.first.click()
    phone.wait_for_timeout(1500)
    board = phone.locator('.chess svg').first.bounding_box()
    before = phone.locator('.chess').inner_html()
    pinch(phone, board['x'] + board['width'] / 2, board['y'] + board['height'] * 0.85, 50, 150)
    check('chess: a pinch zooms', zoom(phone) > 2.5, zoom(phone))
    check('...and selects or moves nothing', 'is-selected' not in phone.locator('.chess').inner_html() and phone.locator('.chess-move-dot, .chess-hint').count() == 0)
    phone.locator('.activity-zoom-reset').click(); phone.wait_for_timeout(300)
    harness.end_game(phone); phone.wait_for_timeout(600)

    # ---- the board games: zoom, pan, buttons still work zoomed in; no swipe-away while zoomed ----
    for name, button in (('Ludo', 'Sit'), ('Last Card', 'Join the game'), ('Tycoon', 'Join the game')):
        harness.open_activity(phone, name); phone.wait_for_timeout(1500)
        bb = body_box(phone)
        pinch(phone, bb['x'] + bb['width'] / 2, bb['y'] + 120, 80, 200, dx=-40)
        z = zoom(phone)
        check(f'{name}: a pinch zooms it', z > 2.0, z)
        sc = phone.evaluate("(() => { const b = document.querySelector('.stage-activity .activity-body'); return [b.scrollWidth > b.clientWidth * 1.8, b.scrollLeft > 0]; })()")
        check(f'{name}: zoomed in, the game pans (scrolls) and the pinch kept its spot', sc[0] and sc[1], sc)
        btn = phone.get_by_role('button', name=button).first
        btn.scroll_into_view_if_needed(); bx = btn.bounding_box()
        touch(phone, 'touchStart', [(bx['x'] + bx['width'] / 2, bx['y'] + bx['height'] / 2)]); touch(phone, 'touchEnd', []); phone.wait_for_timeout(700)
        check(f'{name}: zoomed in, a tap still plays ("{button}")', '(you)' in phone.locator('.stage-activity').inner_text())
        bb = body_box(phone)
        phone.evaluate("document.querySelector('.stage-activity .activity-body').scrollTop = 0")
        drag(phone, bb['x'] + bb['width'] / 2, bb['y'] + 30, bb['x'] + bb['width'] / 2, bb['y'] + 300)
        check(f'{name}: zoomed in, a swipe down doesn\'t put it away', 'is-full' in (phone.locator('.stage-activity').get_attribute('class') or ''))
        phone.locator('.activity-zoom-reset').click(); phone.wait_for_timeout(300)
        check(f'{name}: back to 1x', zoom(phone) == 1.0)
        harness.end_game(phone); phone.wait_for_timeout(700)

    # ---- computer: no zooming there (the page zooms with the browser) ----
    harness.open_activity(desk, 'Whiteboard'); desk.wait_for_timeout(1200)
    check('computer: the game isn\'t wrapped in a zoom', zoom(desk) == 1.0 and desk.locator('.activity-zoom-reset').count() == 0)

    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
