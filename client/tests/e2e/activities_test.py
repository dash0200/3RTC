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
def menu(pg, name):
    pg.locator('.stage-more-wrap .circle-action-btn').click()
    pg.locator('.stage-more-dropdown .dropdown-item', has_text=name).click()

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    def page(mobile=False):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True) if mobile else b.new_context(viewport={'width': 1440, 'height': 900})
        pg = ctx.new_page(); pg.add_init_script(INIT); pg.on('pageerror', lambda e: errors.append(str(e))); return pg
    host, guest = page(), page()
    host.goto(BASE); host.wait_for_timeout(1500)
    host.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    host.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    wait(lambda: any(m.get('type') == 'room-created' for m in host.evaluate('window.__sig')), 10)
    room = next(m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created')
    guest.goto(f'{BASE}?room={room}'); guest.wait_for_timeout(1200); guest.get_by_role('button', name='Join Room').click()
    wait(lambda: guest.locator('.stage-voice-chip').count() >= 2 and host.locator('.stage-voice-chip').count() >= 2, 20); time.sleep(1)

    host.locator('.stage-more-wrap .circle-action-btn').click()
    check('the ⋮ menu lists activities under "Play together"', host.locator('.stage-more-dropdown .dropdown-label', has_text='Play together').count() == 1)
    host.locator('.stage-more-dropdown .dropdown-item', has_text='Sample counter').click()
    check('starting an activity opens it for the host', wait(lambda: host.locator('.stage-activity [data-testid=sample-count]').count() == 1, 8))
    check('...and for the guest', wait(lambda: guest.locator('.stage-activity [data-testid=sample-count]').count() == 1, 8))
    check('the bar says who started it', 'started by you' in host.locator('.activity-bar').inner_text() and 'started by' in guest.locator('.activity-bar').inner_text(), guest.locator('.activity-bar').inner_text())

    guest.get_by_role('button', name='+1').click(); guest.get_by_role('button', name='+1').click(); host.get_by_role('button', name='+1').click()
    check('both see the same count after clicks on both sides', wait(lambda: count(host) == '3' and count(guest) == '3', 6), f'{count(host)} / {count(guest)}')
    check('the host sees Reset, the guest does not', host.get_by_role('button', name='Reset').count() == 1 and guest.get_by_role('button', name='Reset').count() == 0)

    late = page(mobile=True)
    late.goto(f'{BASE}?room={room}'); late.wait_for_timeout(1200); late.get_by_role('button', name='Join room').click()
    check('someone joining later (phone) gets the open activity and its state', wait(lambda: late.locator('[data-testid=sample-count]').count() == 1 and count(late) == '3', 20), late.locator('.stage-activity').count())
    late.get_by_role('button', name='−1').click()
    check("the late joiner's click reaches everyone", wait(lambda: count(host) == '2' and count(guest) == '2', 6), f'{count(host)} / {count(guest)}')

    host.get_by_role('button', name='Reset').click()
    check('host reset reaches everyone', wait(lambda: count(guest) == '0' and count(late) == '0', 6))

    # Host controls lock: guests can't close it
    host.locator('.activity-bar').wait_for()
    host.locator('.stage-more-wrap .circle-action-btn').click(); host.get_by_role('menuitemcheckbox', name=re.compile('Only I control playback')).click()
    wait(lambda: guest.locator('.header-lock-pill').count() == 1, 5)
    guest.locator('.activity-close-btn').click(); time.sleep(0.8)
    check('with the lock on, a guest cannot close the activity', host.locator('.stage-activity').count() == 1 and guest.locator('.stage-activity').count() == 1)
    check('...and is told why', 'Only the host' in toasts(guest), toasts(guest))
    host.locator('.activity-close-btn').click()
    check('the host closes it for everyone', wait(lambda: guest.locator('.stage-activity').count() == 0 and late.locator('.stage-activity').count() == 0 and host.locator('.stage-activity').count() == 0, 6))

    # Leaving resets: start again, leave, make a new room: nothing open
    menu(host, 'Sample counter'); wait(lambda: guest.locator('.stage-activity').count() == 1, 6)
    guest.once('dialog', lambda d: d.accept())
    guest.get_by_role('button', name=re.compile('Leave', re.I)).first.click()
    check('after leaving, the activity is gone', wait(lambda: guest.locator('.stage-activity').count() == 0, 6))
    check('the others still have it', host.locator('.stage-activity').count() == 1 and late.locator('.stage-activity').count() == 1)
    check('no page errors', not errors, errors[:3])
    b.close()
print(f'\n{sum(res)}/{len(res)} passed')
