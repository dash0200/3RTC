"""Ludo on a phone: tokens sharing a square stay visible and tappable, the ones you can move are
on top, and tapping one moves exactly that one (rigged dice: 6, 6, 3 puts two red tokens on the
start square, both movable)."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.signaling())
# The host's app rolls the dice: window.__dice = [6] makes the next roll a 6
RIG = "(() => { const real = Math.random; window.__dice = []; Math.random = () => (window.__dice.length && /ludo\\/rules/.test(new Error().stack || '')) ? (window.__dice.shift() - 1) / 6 + 0.01 : real(); })();"
errors = []


def progress(pg, token):
    return pg.evaluate(f"+document.querySelector('[data-token=\"{token}\"]').dataset.progress")


def body_box(pg, token):
    return pg.locator(f'[data-token="{token}"] .ludo-token-body').bounding_box()


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    pg = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2).new_page()
    pg.add_init_script(INIT); pg.add_init_script(RIG)
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE); pg.wait_for_timeout(1200)
    pg.get_by_role('button', name=re.compile('Create a room', re.I)).click()
    check('in a room', wait(lambda: pg.locator('.phone-actionbar').count() == 1, 15))
    pg.get_by_role('button', name='More').click()
    pg.get_by_role('button', name=re.compile('Ludo')).click()
    check('Ludo opens', wait(lambda: pg.locator('.ludo-board').count() == 1, 10))
    pg.locator('.ludo-seat').nth(0).get_by_role('button', name='Sit').click()
    pg.locator('.ludo-seat').nth(1).get_by_role('button', name=re.compile('Computer')).click()
    pg.evaluate("window.__dice = [1]")  # red goes first
    pg.locator('.ludo-start-btn').click()
    check('the game starts with red (you)', wait(lambda: pg.locator('.ludo-roll-btn').count() == 1, 6))

    def roll(value):
        pg.evaluate(f"window.__dice = [{value}]")
        pg.locator('.ludo-roll-btn').click()
        time.sleep(1.6)  # the dice animate, then the result shows

    roll(6)  # every token is in base: the game brings one out by itself
    check('a 6 brings the first token out', wait(lambda: progress(pg, 'red-0') == 0, 4))
    roll(5)  # only that one can move: it moves by itself
    wait(lambda: progress(pg, 'red-0') == 5, 4)
    # the computer plays its turn, then it's red again
    check("red's turn comes back", wait(lambda: pg.locator('.ludo-roll-btn').count() == 1, 25))
    roll(6)
    wait(lambda: pg.locator('[data-token="red-1"].is-movable').count() == 1, 4)
    pg.locator('[data-token="red-1"]').click()
    roll(6)
    wait(lambda: pg.locator('[data-token="red-2"].is-movable').count() == 1, 4)
    pg.locator('[data-token="red-2"]').click()
    check('two red tokens share the start square', wait(lambda: progress(pg, 'red-1') == 0 and progress(pg, 'red-2') == 0, 4))
    roll(3)  # red-0 (further on) or one of the two on the start square: a real choice
    check('both stacked tokens are movable', wait(lambda: pg.locator('[data-token="red-1"].is-movable').count() == 1 and pg.locator('[data-token="red-2"].is-movable').count() == 1, 4))

    a, c = body_box(pg, 'red-1'), body_box(pg, 'red-2')
    overlap_x = max(0, min(a['x'] + a['width'], c['x'] + c['width']) - max(a['x'], c['x']))
    check('they sit side by side, not on top of each other', overlap_x < a['width'] * 0.15, f'{a} {c}')
    order = pg.evaluate("[...document.querySelectorAll('.ludo-token')].map((t) => t.dataset.token).slice(-3).sort()")
    check('the movable ones are drawn on top', order == ['red-0', 'red-1', 'red-2'], order)
    pg.screenshot(path=str(harness.OUT / 'ludo_stack.png'))

    # a real tap at the middle of red-1 moves red-1
    pg.mouse.click(c['x'] + c['width'] / 2, c['y'] + c['height'] / 2)
    check('tapping the second stacked token moves exactly that one', wait(lambda: progress(pg, 'red-2') == 3 and progress(pg, 'red-1') == 0 and progress(pg, 'red-0') == 5, 4),
          [progress(pg, 'red-0'), progress(pg, 'red-1'), progress(pg, 'red-2')])
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
