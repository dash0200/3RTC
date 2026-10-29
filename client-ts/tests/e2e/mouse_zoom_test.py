"""Computer: the mouse wheel over a game zooms it around the pointer; zoomed in, the pointer is a
hand and dragging moves the game (a click without dragging still plays); the chess board and the
whiteboard keep their own drag; wheeling back out (or "Reset zoom") goes back to 1x."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
SIGNAL = harness.signaling()
errors = []


def zoom(pg):
    t = pg.evaluate("(() => { const z = document.querySelector('.stage-activity .activity-zoom'); return z ? z.style.transform : ''; })()")
    m = re.search(r'scale\(([\d.]+)\)', t or '')
    return float(m.group(1)) if m else 1.0


def body(pg):
    return pg.evaluate("(() => { const b = document.querySelector('.stage-activity .activity-body'); const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, left: b.scrollLeft, top: b.scrollTop, cursor: getComputedStyle(b).cursor }; })()")


def wheel_in(pg, x, y, notches=6):
    pg.mouse.move(x, y)
    for _ in range(notches):
        pg.mouse.wheel(0, -120); time.sleep(0.05)
    time.sleep(0.3)


def drawings(pg):
    m = re.search(r'(\d+) drawing', pg.locator('.wb-over').get_attribute('aria-label') or '')
    return int(m.group(1)) if m else -1


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    pg = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Darshan');")
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE); pg.wait_for_timeout(1200)
    harness.create_room(pg)
    wait(lambda: any(m.get('type') == 'room-created' for m in pg.evaluate('window.__sig')), 10)

    # ---- Tycoon: zoom at the pointer, hand cursor, drag to move, a click still plays ----
    harness.open_activity(pg, 'Tycoon'); pg.wait_for_timeout(1200)
    bb = body(pg)
    check('1x: the normal pointer', bb['cursor'] != 'grab', bb['cursor'])
    target = pg.get_by_role('button', name='Join the game').first.bounding_box()
    tx, ty = target['x'] + target['width'] / 2, target['y'] + target['height'] / 2
    wheel_in(pg, tx, ty)
    z = zoom(pg)
    check('the wheel zooms the game in', z > 1.8, z)
    after = pg.get_by_role('button', name='Join the game').first.bounding_box()
    check('...around the pointer (what was under it stays under it)', abs(after['x'] + after['width'] / 2 - tx) < 25 and abs(after['y'] + after['height'] / 2 - ty) < 25, [tx, ty, after])
    check('zoomed in: a hand over the game', body(pg)['cursor'] == 'grab', body(pg)['cursor'])
    check('"Reset zoom" shows', pg.locator('.activity-zoom-reset').is_visible())
    # drag from an empty part of the lobby card
    spot = pg.evaluate("""(() => { const b = document.querySelector('.stage-activity .activity-body').getBoundingClientRect();
      for (let y = b.top + 40; y < b.bottom - 140; y += 30) for (let x = b.left + 40; x < b.right - 160; x += 40) {
        const e = document.elementFromPoint(x, y);
        if (e && e.closest('.activity-zoom') && !e.closest('button, a, input, select, label, textarea')) return [x, y];
      } return null; })()""")
    sx, sy = spot
    b0 = body(pg)
    pg.mouse.move(sx, sy); pg.mouse.down(); pg.mouse.move(sx - 120, sy - 80, steps=8)
    grabbing = pg.evaluate("getComputedStyle(document.querySelector('.stage-activity .activity-body')).cursor")
    pg.mouse.up()
    b1 = body(pg)
    check('dragging moves the game', b1['left'] > b0['left'] + 60 and b1['top'] >= b0['top'], [b0, b1])
    check('...with a grabbing hand while dragging', grabbing == 'grabbing', grabbing)
    btn = pg.get_by_role('button', name='Join the game').first
    btn.scroll_into_view_if_needed()
    btn.click()
    check('zoomed in, a click still plays ("Join the game")', wait(lambda: '(you)' in pg.locator('.stage-activity').inner_text(), 4))
    # a drag that starts on a button doesn't move the game (and doesn't press it)
    bx = pg.get_by_role('button', name='+ Computer').first.bounding_box()
    b0 = body(pg)
    pg.mouse.move(bx['x'] + 10, bx['y'] + 10); pg.mouse.down(); pg.mouse.move(bx['x'] - 100, bx['y'] - 60, steps=6); pg.mouse.up()
    check('a drag on a button doesn\'t move the game', abs(body(pg)['left'] - b0['left']) < 2, [b0, body(pg)])
    # wheel back out
    pg.mouse.move(bb['x'] + bb['w'] / 2, bb['y'] + bb['h'] / 2)
    for _ in range(14):
        pg.mouse.wheel(0, 120); time.sleep(0.04)
    time.sleep(0.3)
    check('the wheel zooms back out to 1x', zoom(pg) == 1.0 and pg.locator('.activity-zoom-reset').count() == 0 and body(pg)['cursor'] != 'grab', [zoom(pg), body(pg)['cursor']])
    harness.end_game(pg); pg.wait_for_timeout(600)

    # ---- Whiteboard: drawing while zoomed draws (no moving); the wheel on the board zooms ----
    harness.open_activity(pg, 'Whiteboard'); pg.wait_for_timeout(1200)
    wb = pg.locator('.wb-over').bounding_box()
    wheel_in(pg, wb['x'] + wb['width'] / 2, wb['y'] + wb['height'] / 2, 5)
    check('whiteboard: the wheel zooms it', zoom(pg) > 1.5, zoom(pg))
    bb = body(pg)
    x0, y0 = bb['x'] + bb['w'] / 2, bb['y'] + bb['h'] / 2
    pg.mouse.move(x0, y0); pg.mouse.down(); pg.mouse.move(x0 + 100, y0 + 20, steps=8); pg.mouse.up(); pg.wait_for_timeout(400)
    check('...zoomed in, dragging on the board draws', drawings(pg) == 1, drawings(pg))
    check('...and doesn\'t move the game', abs(body(pg)['left'] - bb['left']) < 2 and abs(body(pg)['top'] - bb['top']) < 2)
    # the middle button moves it anywhere
    pg.mouse.move(x0, y0); pg.mouse.down(button='middle'); pg.mouse.move(x0 - 80, y0 - 50, steps=6); pg.mouse.up(button='middle')
    check('...the middle button moves it, even on the board', body(pg)['left'] > bb['left'] + 40 and drawings(pg) == 1, [bb, body(pg), drawings(pg)])
    pg.locator('.activity-zoom-reset').click(); pg.wait_for_timeout(300)
    check('"Reset zoom" goes back to 1x', zoom(pg) == 1.0)
    harness.end_game(pg); pg.wait_for_timeout(600)

    # ---- Chess: dragging a piece still moves it, zoomed in ----
    harness.open_activity(pg, 'Chess'); pg.wait_for_timeout(1200)
    pg.locator('.chess-mini-btn', has_text=re.compile(r'^Play$')).first.click(); pg.wait_for_timeout(300)
    pg.locator('.chess-mini-btn', has_text='+ Computer').first.click(); pg.wait_for_timeout(1500)
    svg = pg.locator('.chess svg').first.bounding_box()
    wheel_in(pg, svg['x'] + svg['width'] / 2, svg['y'] + svg['height'] / 2, 3)
    check('chess: the wheel zooms the board', zoom(pg) > 1.2, zoom(pg))
    b0 = body(pg)
    svg = pg.locator('.chess svg').first.bounding_box()
    pg.mouse.move(svg['x'] + svg['width'] / 2, svg['y'] + svg['height'] / 2); pg.mouse.down(); pg.mouse.move(svg['x'] + svg['width'] / 2 + 60, svg['y'] + svg['height'] / 2 + 60, steps=6); pg.mouse.up()
    check('...a drag on the board is the game\'s (it doesn\'t move the view)', abs(body(pg)['left'] - b0['left']) < 2 and abs(body(pg)['top'] - b0['top']) < 2, [b0, body(pg)])
    harness.end_game(pg); pg.wait_for_timeout(600)

    # ---- Ludo, Last Card: the wheel zooms them too ----
    for name in ('Ludo', 'Last Card'):
        harness.open_activity(pg, name); pg.wait_for_timeout(1200)
        bb = body(pg)
        wheel_in(pg, bb['x'] + bb['w'] / 2, bb['y'] + bb['h'] / 3, 5)
        check(f'{name}: the wheel zooms it', zoom(pg) > 1.5, zoom(pg))
        harness.end_game(pg); pg.wait_for_timeout(600)

    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
