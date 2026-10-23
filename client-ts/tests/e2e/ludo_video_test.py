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
_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'media_links_test.py')).read()
FAKES = _src.split('FAKES = r"""', 1)[1].split('"""', 1)[0]  # fake YouTube / Vimeo / Twitch players
errors = []


def swipe(pg, x, y, dy, dx=0, steps=8):
    """A finger drag (real touch events)."""
    cdp = pg.context.new_cdp_session(pg)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
    for i in range(1, steps + 1):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x + dx * i / steps, 'y': y + dy * i / steps}]}); time.sleep(0.02)
    mid = pg.evaluate("document.querySelector('.stage-activity').style.transform")
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    cdp.detach()
    return mid


def on_top(pg, sel):
    """Is the middle of `sel` the thing a tap there would hit?"""
    return pg.evaluate(f"(() => {{ const el = document.querySelector('{sel}'); if (!el) return false; const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && el.contains(hit); }})()")


def view(pg):
    el = pg.locator('.stage-activity')
    if not el.count():
        return None
    cls = el.get_attribute('class')
    return next((v for v in ('full', 'sidebar', 'window', 'bubble') if f'is-{v}' in cls), None)


def vt(pg):
    return pg.evaluate("(() => { const v = document.querySelector('.link-player video'); return v ? { t: v.currentTime, paused: v.paused } : null; })()")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    host = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    phone = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2).new_page()
    host.add_init_script(INIT + RIG + "localStorage.removeItem('3rtc_activity_window');"); host.add_init_script(FAKES)
    phone.add_init_script(INIT + "localStorage.removeItem('3rtc_activity_bubble');"); phone.add_init_script(FAKES)
    for pg in (host, phone):
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
    host.goto(BASE); host.wait_for_timeout(1200)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    phone.goto(f'{BASE}?room={room}'); phone.wait_for_timeout(1200); phone.get_by_role('button', name='Join room').click()
    check('both in the room', wait(lambda: harness.people(host) >= 2, 25))
    time.sleep(1)

    harness.open_activity(host, 'Ludo')
    harness.join_activity(phone)
    wait(lambda: phone.locator('.ludo-board').count() == 1, 10)
    host.locator('.ludo-seat').nth(0).get_by_role('button', name='Sit').click()
    phone.locator('.ludo-seat').nth(2).get_by_role('button', name='Sit').click()
    wait(lambda: '(you)' in phone.locator('.ludo-seat').nth(2).inner_text(), 5)
    host.evaluate("window.__dice = [1]")  # red (host) goes first
    host.locator('.ludo-start-btn').click()
    check('the game starts, full size', wait(lambda: host.locator('.ludo-roll-btn').count() == 1, 6) and view(host) == 'full' and view(phone) == 'full')

    # No video: the game can be minimised all the same
    check('phone, no video: the game has a "Minimise" button', phone.locator('.activity-video-btn').inner_text().strip().endswith('Minimise'))
    cb = phone.locator('.stage-activity .activity-close-btn').bounding_box()
    check('...and the bar still fits on the phone (Close on screen)', cb['x'] + cb['width'] <= 390, cb)
    phone.screenshot(path=str(harness.OUT / 'ludo_novideo_phone.png'))
    phone.locator('.activity-video-btn').click()
    check('...it minimises to the bubble', wait(lambda: view(phone) == 'bubble' and phone.locator('.activity-bubble').count() == 1, 5))
    phone.locator('.activity-bubble').click()
    check('...which opens it again', wait(lambda: view(phone) == 'full', 5))
    board = phone.locator('.ludo-board').bounding_box()
    swipe(phone, board['x'] + board['width'] / 2, board['y'] + 80, 220)
    check('...swipe down works without a video too', wait(lambda: view(phone) == 'bubble', 5))
    phone.locator('.activity-bubble').click()
    wait(lambda: view(phone) == 'full', 5)
    phone.go_back()
    check('...and so does Back', wait(lambda: view(phone) == 'bubble', 5) and phone.locator('.phone-actionbar').count() == 1)
    phone.locator('.activity-bubble').click()
    wait(lambda: view(phone) == 'full', 5)
    harness.show_game_bar(host)
    host.locator('.activity-window-btn').click()
    check('computer, no video: the game can go to a small window', wait(lambda: view(host) == 'window', 3))
    host.get_by_role('button', name='Minimise').click()
    check('...or a bubble', wait(lambda: view(host) == 'bubble', 3))
    host.locator('.activity-bubble').click()
    check('...which opens back to the small window', wait(lambda: view(host) == 'window', 3))
    host.get_by_role('button', name='Full size').click()
    wait(lambda: view(host) == 'full', 3)

    # A video from the phone's Add video button
    phone.get_by_role('button', name='Add video').last.click()
    phone.locator('input[placeholder*="Paste a"]:visible, input[placeholder*=".mp4 link"]:visible').last.fill(FILE)
    phone.get_by_role('button', name=re.compile('Play for everyone')).click()
    check('computer: the game docks into the sidebar beside the video', wait(lambda: view(host) == 'sidebar', 10), view(host))
    check('phone: the game becomes a bubble', wait(lambda: view(phone) == 'bubble' and phone.locator('.activity-bubble').count() == 1, 10), view(phone))
    check('the video plays for both', wait(lambda: (vt(host) or {}).get('t', 0) > 1 and (vt(phone) or {}).get('t', 0) > 1, 20), [vt(host), vt(phone)])
    host.locator('.stage-activity .activity-window-btn').click()
    check('...or it can play in a small window over the video', wait(lambda: view(host) == 'window', 3), view(host))
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
    # Drag it off the video (a finger): it snaps to the nearest side edge and stays there
    bub = phone.locator('.activity-bubble').bounding_box()
    swipe(phone, bub['x'] + 25, bub['y'] + 25, 520, dx=-260, steps=12); time.sleep(0.5)
    moved = phone.locator('.activity-bubble').bounding_box()
    check('the bubble can be dragged off the video; it snaps to the left edge', view(phone) == 'bubble' and moved['x'] < 20 and moved['y'] > bub['y'] + 400, [bub, moved])
    check("...its tag moves to the bubble's right", 'is-left' in phone.locator('.activity-bubble').get_attribute('class')
          and phone.locator('.activity-bubble-tag').bounding_box()['x'] > moved['x'] + moved['width'])
    check('...and it is on top there (over the chat)', on_top(phone, '.activity-bubble'))
    phone.screenshot(path=str(harness.OUT / 'ludo_video_bubble_moved.png'))
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
    again = phone.locator('.activity-bubble').bounding_box()
    check('...back where you left it', abs(again['x'] - moved['x']) < 3 and abs(again['y'] - moved['y']) < 3, [moved, again])
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
    # Swipe the game down anywhere, like the YouTube app (real touch events)
    phone.locator('.activity-bubble').click()
    wait(lambda: view(phone) == 'full', 5)
    check('the open game shows a grab handle', phone.locator('.activity-grab').is_visible())
    board = phone.locator('.ludo-board').bounding_box()
    cx, cy = board['x'] + board['width'] / 2, board['y'] + board['height'] / 3
    swipe(phone, cx, cy, 25); time.sleep(0.4)
    check('a small pull on the board springs back', view(phone) == 'full' and not phone.evaluate("document.querySelector('.stage-activity').style.transform"))
    swipe(phone, cx, cy, -40, dx=180); time.sleep(0.3)
    check('a sideways drag is not a swipe', view(phone) == 'full')
    swipe(phone, cx, cy + 200, -200); time.sleep(0.4)
    check('dragging up (to scroll the game) is not a swipe', view(phone) == 'full')
    mid = swipe(phone, cx, cy, 220)
    check('a swipe down on the board: the game follows the finger and goes away', 'translateY' in (mid or '') and wait(lambda: view(phone) == 'bubble', 5), mid)
    phone.locator('.activity-bubble').click()
    wait(lambda: view(phone) == 'full', 5)
    bar = phone.locator('.stage-activity .activity-bar').bounding_box()
    swipe(phone, bar['x'] + 60, bar['y'] + 12, 200)
    check('...and on the title bar', wait(lambda: view(phone) == 'bubble', 5))
    phone.locator('.activity-bubble').click()
    wait(lambda: view(phone) == 'full', 5)
    # (a shorter phone: the game scrolls)
    scrolled = phone.evaluate("(() => { const b = document.querySelector('.stage-activity .activity-body'); b.style.maxHeight = '300px'; const e = b.querySelector('.ludo'); e.scrollTop = 120; return e.scrollTop; })()")
    swipe(phone, cx, cy, 200); time.sleep(0.4)
    check('scrolled down inside the game, a pull down scrolls instead of closing', scrolled > 0 and view(phone) == 'full', scrolled)
    phone.evaluate("(() => { const b = document.querySelector('.stage-activity .activity-body'); b.querySelector('.ludo').scrollTop = 0; b.style.maxHeight = ''; })()")
    swipe(phone, cx, cy, 220)
    check('...back at the top it swipes away', wait(lambda: view(phone) == 'bubble', 5))
    t0 = (vt(phone) or {}).get('t', 0); time.sleep(1)
    check('...the video is still playing', (vt(phone) or {}).get('t', 0) > t0 + 0.5)
    phone.go_back(); time.sleep(0.8)
    check('Back after that has nothing of the game left to close: it asks before leaving the room', phone.get_by_role('button', name='Stay').is_visible())
    phone.get_by_role('button', name='Stay').click(); time.sleep(0.3)

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
    hb = host.locator('.activity-bubble').bounding_box()
    host.mouse.move(hb['x'] + 29, hb['y'] + 29); host.mouse.down()
    host.mouse.move(300, 200, steps=10); host.mouse.up(); time.sleep(0.5)
    hb2 = host.locator('.activity-bubble').bounding_box()
    check('computer: the bubble can be dragged too (snaps to the left edge, does not open)', view(host) == 'bubble' and hb2['x'] < 20 and abs(hb2['y'] - 171) < 20, hb2)
    host.locator('.activity-bubble').click()
    check('the bubble opens the small window again, where it was', wait(lambda: view(host) == 'window', 3) and abs(host.locator('.stage-activity').bounding_box()['width'] - 520) < 2)
    host.get_by_role('button', name='Full size').click()
    wait(lambda: view(host) == 'full', 3)
    harness.show_game_bar(host)
    check('full size covers the stage, with a way back to the small window', view(host) == 'full' and host.locator('.activity-window-btn').is_visible())
    host.locator('.activity-window-btn').click()
    check('...back to the small window', wait(lambda: view(host) == 'window', 3))

    # The video ends: the game comes back
    host.get_by_role('button', name=re.compile('Exit Video')).first.click()
    check('exiting the video brings the game back full size for everyone', wait(lambda: view(host) == 'full' and view(phone) == 'full', 8), [view(host), view(phone)])
    # A YouTube video: the game opens above YouTube's own bar
    phone.get_by_role('button', name='Add video').last.click()
    phone.locator('input[placeholder*="Paste a"]:visible, input[placeholder*=".mp4 link"]:visible').last.fill('https://youtu.be/aqz-KE-bpKQ')
    phone.get_by_role('button', name=re.compile('Play for everyone')).click()
    check('YouTube: the game shrinks to the bubble again', wait(lambda: view(phone) == 'bubble' and phone.locator('.yt-fullstage-player').count() == 1, 10), view(phone))
    phone.locator('.activity-bubble').click()
    check("YouTube: the open game's bar is on top, not under YouTube's bar",
          wait(lambda: view(phone) == 'full' and on_top(phone, '.stage-activity .activity-video-btn') and on_top(phone, '.stage-activity .activity-close-btn'), 10))  # (after any notice fades)
    phone.screenshot(path=str(harness.OUT / 'ludo_video_youtube_open.png'))
    board = phone.locator('.ludo-board').bounding_box()
    swipe(phone, board['x'] + board['width'] / 2, board['y'] + 80, 220)
    check('YouTube: swipe down goes back to the video', wait(lambda: view(phone) == 'bubble', 5))
    # (exited from the computer: phones have no Exit for a YouTube video in the redesign yet)
    host.get_by_title(re.compile('Exit video')).first.click()
    check('...exit it: the game is back full size', wait(lambda: view(phone) == 'full', 8))
    check('the game went on all along', host.locator('[data-testid=ludo-status]').count() == 1 and phone.locator('.ludo-board').count() == 1)
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
