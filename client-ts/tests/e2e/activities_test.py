"""Activities: start, shared state, late joiner, host lock, close, leave (dev sample activity)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.dev()
harness.signaling()
import re, time
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5199/'
INIT = "localStorage.setItem('webrtc_signal_url','ws://localhost:8080');window.__sig=[];const O=window.WebSocket;window.WebSocket=class extends O{constructor(...a){super(...a);this.addEventListener('message',e=>{try{window.__sig.push(JSON.parse(e.data))}catch{}})}};"
res = []
def check(n, ok, d=''): res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + (f'  [{d}]' if d else ''), flush=True)
def wait(f, t=10):
    end = time.time() + t
    while time.time() < end:
        try:
            if f(): return True
        except Exception: pass
        time.sleep(0.2)
    return False
def count(pg): return pg.locator('[data-testid=sample-count]').inner_text().strip()
def toasts(pg): return pg.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    def page(mobile=False):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True) if mobile else b.new_context(viewport={'width': 1440, 'height': 900})
        pg = ctx.new_page(); pg.add_init_script(INIT); pg.add_init_script(harness.PEOPLE_INIT); pg.on('pageerror', lambda e: errors.append(str(e))); return pg
    host, guest = page(), page()
    host.goto(BASE); host.wait_for_timeout(1500)
    harness.create_room(host)
    wait(lambda: any(m.get('type') == 'room-created' for m in host.evaluate('window.__sig')), 10)
    room = next(m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created')
    guest.goto(f'{BASE}?room={room}'); guest.wait_for_timeout(1200); guest.get_by_role('button', name='Join Room').click()
    wait(lambda: harness.people(guest) >= 2 and harness.people(host) >= 2, 20); time.sleep(1)

    host.get_by_role('button', name='Games').click()
    check('the Games menu lists activities under "Play together"', host.locator('.dock-menu-label', has_text='Play together').count() >= 1)
    host.get_by_role('menuitem', name=re.compile('Sample counter')).click()
    check('starting an activity opens it for the host', wait(lambda: host.locator('.stage-activity [data-testid=sample-count]').count() == 1, 8))
    check("the guest doesn't load it: it gets an invitation instead", wait(lambda: guest.locator('.activity-bubble.is-invite').count() == 1, 8)
          and guest.locator('[data-testid=sample-count]').count() == 0 and 'Join Sample counter' in guest.locator('.activity-bubble').inner_text())
    check('...and a note saying who started it', wait(lambda: 'started Sample counter' in toasts(guest), 4), toasts(guest))
    harness.join_activity(guest)
    check('tapping it loads the activity for the guest', wait(lambda: guest.locator('.stage-activity [data-testid=sample-count]').count() == 1, 8))
    check('the bar says who started it', 'started by you' in host.locator('.activity-bar').inner_text() and 'started by' in guest.locator('.activity-bar').inner_text(), guest.locator('.activity-bar').inner_text())

    guest.get_by_role('button', name='+1').click(); guest.get_by_role('button', name='+1').click(); host.get_by_role('button', name='+1').click()
    check('both see the same count after clicks on both sides', wait(lambda: count(host) == '3' and count(guest) == '3', 6), f'{count(host)} / {count(guest)}')
    check('the host sees Reset, the guest does not', host.get_by_role('button', name='Reset').count() == 1 and guest.get_by_role('button', name='Reset').count() == 0)

    late = page(mobile=True)
    late.goto(f'{BASE}?room={room}'); late.wait_for_timeout(1200); late.get_by_role('button', name='Join room').click()
    check('someone joining later (phone) is invited, nothing loaded', wait(lambda: late.locator('.activity-bubble.is-invite').count() == 1, 20) and late.locator('[data-testid=sample-count]').count() == 0)
    harness.join_activity(late)
    check('...joins and gets the activity and its state', wait(lambda: late.locator('[data-testid=sample-count]').count() == 1 and count(late) == '3', 10))
    late.get_by_role('button', name='−1').click()
    check("the late joiner's click reaches everyone", wait(lambda: count(host) == '2' and count(guest) == '2', 6), f'{count(host)} / {count(guest)}')

    # Leave (just me): it unloads here and goes on for the others
    harness.show_game_bar(guest)
    guest.get_by_role('button', name=re.compile('Leave Sample counter')).click()
    check('Leave unloads it on this device (back to the invitation)', wait(lambda: guest.locator('[data-testid=sample-count]').count() == 0 and guest.locator('.activity-bubble.is-invite').count() == 1, 5))
    host.get_by_role('button', name='+1').click()
    check('...it goes on for the others', wait(lambda: count(host) == '3' and count(late) == '3', 6))
    # The host leaves it too: someone still in it now decides (the late joiner's clicks still count)
    harness.show_game_bar(host)
    host.get_by_role('button', name=re.compile('Leave Sample counter')).click()
    wait(lambda: host.locator('[data-testid=sample-count]').count() == 0, 5)
    late.get_by_role('button', name='+1').click()
    check('with the host out of it, it still works for those in it', wait(lambda: count(late) == '4', 6), count(late))
    harness.join_activity(guest)
    check('joining again gets it as it is now', wait(lambda: guest.locator('[data-testid=sample-count]').count() == 1 and count(guest) == '4', 10))
    harness.join_activity(host)
    check('the host back in: Reset is there again', wait(lambda: host.get_by_role('button', name='Reset').count() == 1 and count(host) == '4', 10))
    host.get_by_role('button', name='Reset').click()
    check('host reset reaches everyone', wait(lambda: count(guest) == '0' and count(late) == '0', 6))

    # Host controls lock: guests can't end it
    harness.toggle_playback_lock(host)
    wait(lambda: guest.locator('.rh-lock').count() == 1, 5)
    guest.get_by_role('button', name='End for everyone').click(); time.sleep(0.8)
    check('with the lock on, a guest cannot end the activity', host.locator('.stage-activity').count() == 1 and guest.locator('.stage-activity').count() == 1)
    check('...and is told why', 'Only the host' in toasts(guest), toasts(guest))
    host.get_by_role('button', name='End for everyone').click()
    check('the host ends it for everyone', wait(lambda: guest.locator('.stage-activity, .activity-bubble').count() == 0 and late.locator('.stage-activity, .activity-bubble').count() == 0 and host.locator('.stage-activity, .activity-bubble').count() == 0, 6))

    # Leaving the room resets: start again, leave, the activity is gone there
    harness.open_activity(host, 'Sample counter'); wait(lambda: guest.locator('.activity-bubble.is-invite').count() == 1, 6)
    harness.join_activity(guest); wait(lambda: guest.locator('.stage-activity').count() == 1, 6)
    guest.once('dialog', lambda d: d.accept())
    harness.leave_room(guest)
    check('after leaving the room, the activity is gone', wait(lambda: guest.locator('.stage-activity, .activity-bubble').count() == 0, 6))
    check('the others still have it', host.locator('.stage-activity').count() == 1 and late.locator('.activity-bubble, .stage-activity').count() >= 1)
    check('no page errors', not errors, errors[:3])
    b.close()
print(f'\n{sum(res)}/{len(res)} passed')
