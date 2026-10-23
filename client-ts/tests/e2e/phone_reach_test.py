"""Phone: every button can be reached. Small phones (320x568, 360x640) and a phone held sideways:
the More and Add-a-video sheets scroll instead of squeezing their rows, the QR card's Done is
reachable, the join link's button shows sideways, a game leaves the message box on screen, the
game bar's End stays on screen, and typing with the keyboard up keeps the tabs and message box."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
SIGNAL = harness.signaling()
errors = []

# Can a finger get to it? Scroll only containers a finger can scroll, then: on screen, not clipped, not covered.
REACH = r"""(el) => {
  const vw = innerWidth, vh = innerHeight;
  for (let n = el.parentElement; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (!/(auto|scroll)/.test(cs.overflowY + cs.overflowX)) continue;
    const r = el.getBoundingClientRect(), c = n.getBoundingClientRect();
    if (r.top < c.top) n.scrollTop -= c.top - r.top; else if (r.bottom > c.bottom) n.scrollTop += r.bottom - c.bottom;
  }
  const r = el.getBoundingClientRect();
  let L = Math.max(r.left, 0), T = Math.max(r.top, 0), R = Math.min(r.right, vw), B = Math.min(r.bottom, vh);
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const c = n.getBoundingClientRect();
    L = Math.max(L, c.left); T = Math.max(T, c.top); R = Math.min(R, c.right); B = Math.min(B, c.bottom);
  }
  if ((R - L) * (B - T) < 0.9 * r.width * r.height || R <= L || B <= T) return false;
  const hit = document.elementFromPoint((L + R) / 2, (T + B) / 2);
  return !!hit && (hit === el || el.contains(hit));
}"""


def reachable(loc):
    return loc.count() > 0 and all(loc.nth(i).evaluate(REACH) for i in range(loc.count()))


def unreachable(loc):
    return [loc.nth(i).inner_text().strip().split('\n')[0] for i in range(loc.count()) if not loc.nth(i).evaluate(REACH)]


def phone(b, w, h, name):
    ctx = b.new_context(viewport={'width': w, 'height': h}, is_mobile=True, has_touch=True, device_scale_factor=2)
    pg = ctx.new_page()
    pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + f"localStorage.setItem('webrtc_username', '{name}');")
    pg.on('pageerror', lambda e: errors.append(str(e)))
    return pg


def more(pg):
    pg.locator('.phone-actionbar').get_by_role('button', name='More').click()
    wait(lambda: pg.get_by_role('dialog', name='More').is_visible(), 3)
    pg.wait_for_timeout(400)  # the sheet slides up


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    host = phone(b, 360, 640, 'Darshan')
    host.goto(BASE); host.wait_for_timeout(1200)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)

    # The join link, phone held sideways
    side = phone(b, 740, 360, 'Riya')
    side.goto(f'{BASE}?room={room}'); side.wait_for_timeout(1200)
    join = side.get_by_role('button', name=re.compile(r'^Join room$', re.I)).first
    check('sideways: the join link\'s "Join room" can be reached', reachable(join))
    join.click()
    check('two people connected', wait(lambda: harness.people(host) >= 2, 25))
    host.locator('.chat-pill-textarea').fill('hi'); host.locator('.chat-pill-send-btn').click()

    for w, h in ((360, 640), (320, 568), (740, 360)):
        host.set_viewport_size({'width': w, 'height': h}); host.wait_for_timeout(400)
        tag = f'{w}x{h}:'
        more(host)
        rows = host.get_by_role('dialog', name='More').locator('.phone-row:not(.phone-row-static), .phone-switch, .phone-btn')
        missed = unreachable(rows)
        check(f'{tag} every row of More can be reached', rows.count() >= 8 and not missed, missed)
        host.keyboard.press('Escape'); host.wait_for_timeout(300)
        host.locator('.phone-actionbar').get_by_role('button', name='Add video').click(); host.wait_for_timeout(700)
        sheet = host.get_by_role('dialog', name='Add a video')
        check(f'{tag} Add a video: the quick picks keep their size', wait(lambda: sheet.locator('.av-pick').count() > 0, 8)
              and sheet.locator('.av-pick').first.bounding_box()['height'] > 120, sheet.locator('.av-pick').first.bounding_box() if sheet.locator('.av-pick').count() else None)
        check(f'{tag} Add a video: its first "+ Queue" can be reached', reachable(sheet.locator('.av-pick-queue').first))
        host.keyboard.press('Escape'); host.wait_for_timeout(300)
        check(f'{tag} room: tabs and message box on screen', reachable(host.locator('.chat-tab-btn')) and reachable(host.locator('.chat-pill-send-btn')))

    host.set_viewport_size({'width': 320, 'height': 568}); host.wait_for_timeout(300)
    more(host); host.get_by_role('button', name=re.compile('Invite with QR')).click()
    check('320x568: the QR card\'s Done can be reached', wait(lambda: host.locator('.qr-modal-card').count(), 3) and reachable(host.get_by_role('button', name='Done')))
    host.keyboard.press('Escape'); host.wait_for_timeout(400)
    if host.locator('.qr-modal-card').count():
        host.get_by_role('button', name='Done').click()

    harness.open_activity(host, 'Whiteboard'); host.wait_for_timeout(1500)
    for w, h in ((320, 568), (360, 640), (740, 360)):
        host.set_viewport_size({'width': w, 'height': h}); host.wait_for_timeout(500)
        check(f'{w}x{h}: game open: Minimise, Leave and End on screen', reachable(host.locator('.stage-activity .activity-bar button')),
              unreachable(host.locator('.stage-activity .activity-bar button')))
        check(f'{w}x{h}: game open: the message box stays on screen', reachable(host.locator('.chat-pill-send-btn')))
        check(f'{w}x{h}: game open: the game keeps room to play', host.locator('.stage-activity .activity-body').bounding_box()['height'] > 100,
              host.locator('.stage-activity .activity-body').bounding_box())
    harness.end_game(host); host.wait_for_timeout(600)

    # Typing: the keyboard takes the bottom half of a 360x640 phone
    host.set_viewport_size({'width': 360, 'height': 640})
    host.locator('.chat-pill-textarea').focus()
    host.set_viewport_size({'width': 360, 'height': 340}); host.wait_for_timeout(400)
    check('keyboard up: tabs and message box on screen', reachable(host.locator('.chat-tab-btn')) and reachable(host.locator('.chat-pill-textarea')))
    host.locator('.chat-pill-textarea').blur()
    host.set_viewport_size({'width': 360, 'height': 640}); host.wait_for_timeout(400)
    check('keyboard down: the call buttons are back', reachable(host.locator('.phone-actionbar button')))

    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
