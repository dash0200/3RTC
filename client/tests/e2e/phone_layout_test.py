"""Phone layout: home, room, sheets, video (screenshots in .out/phone)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.dev()
harness.signaling()
import re, time, os, sys
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else str(harness.OUT / 'phone')
os.makedirs(OUT, exist_ok=True)
BASE = 'http://localhost:5199'
INIT = r"""
localStorage.setItem('webrtc_signal_url', 'ws://localhost:8080');
window.__sig = [];
const OrigWS = window.WebSocket;
window.WebSocket = class extends OrigWS { constructor(...a) { super(...a);
  this.addEventListener('message', (e) => { try { window.__sig.push(JSON.parse(e.data)); } catch {} }); } };
"""
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))
def wait(cond, timeout=15, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        try:
            r = cond()
        except Exception:
            r = None
        if r: return r
        time.sleep(step)
    return None
def shot(pg, name):
    pg.wait_for_timeout(500); pg.screenshot(path=f'{OUT}/{name}.png')

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    phone = dict(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    host = b.new_context(**phone).new_page(); guest = b.new_context(**phone).new_page()
    for pg in (host, guest):
        pg.add_init_script(INIT); pg.on('dialog', lambda d: d.accept())
        pg.on('pageerror', lambda e: print('PAGE ERROR', e))
    host.goto(BASE + '/'); host.wait_for_timeout(1500)
    check('phone home shown', host.locator('.phone-home').count() == 1 and host.locator('.chat-section').count() == 0)
    host.locator('#phone-name').fill('Darshan')
    shot(host, '01-home')
    host.get_by_role('button', name='Create a room').click()
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None))
    check('room created from phone home', room, room)
    wait(lambda: host.locator('.phone-actionbar').count() == 1, 5)
    check('room screen: video, tabs, action bar', host.locator('.stage-phone').count() == 1 and host.locator('.chat-section.embedded').count() == 1 and host.locator('.phone-actionbar').count() == 1)
    check('empty video shows "Nothing playing yet"', host.get_by_text('Nothing playing yet').is_visible())
    shot(host, '02-room-empty')

    guest.goto(f'{BASE}/?room={room}'); guest.wait_for_timeout(1500)
    code = ''.join(guest.locator('.phone-code-box').evaluate_all('els => els.map(e => e.value)'))
    check('code prefilled from shared link', code == room, code)
    check('no desktop join popup on phone', guest.locator('.modal-overlay, .join-modal').count() == 0 or not guest.locator('.modal-overlay').first.is_visible())
    guest.locator('#phone-name').fill('Riya')
    shot(guest, '03-guest-join')
    guest.get_by_role('button', name='Join room').click()
    check('guest joined and connected', wait(lambda: host.locator('.phone-status-pill.ok').count() == 1 and 'P2P' in host.locator('.phone-status-pill').inner_text(), 15))

    for t in ['hey! ready to watch?', '🍿']:
        guest.locator('.chat-pill-textarea').fill(t); guest.locator('.chat-pill-send-btn').click()
    host.locator('.chat-pill-textarea').fill('yes, adding a video now 👋'); host.locator('.chat-pill-send-btn').click()
    check('chat works on phone', wait(lambda: 'adding a video now' in guest.content() and 'ready to watch' in host.content(), 5))
    shot(host, '04-room-chat')

    host.get_by_role('button', name='Add video').last.click()
    check('Add video sheet opens', wait(lambda: host.get_by_role('dialog', name='Add video').is_visible(), 3))
    shot(host, '05-add-video-sheet')
    with host.expect_file_chooser() as fc:
        host.get_by_role('button', name='Choose a video file').click()
    fc.value.set_files(harness.media('test.mp4'))
    check('sheet closes after picking a file', wait(lambda: host.get_by_role('dialog').count() == 0, 3))
    check('host plays local file in the video area', wait(lambda: host.locator('.stage-phone video').count() > 0, 5))
    shot(host, '06-host-local-video')
    check('guest sees compact stream offer', wait(lambda: guest.locator('.phone-stream-offer').is_visible(), 8))
    shot(guest, '07-guest-offer')

    for tab, name in (('Queue', '08-queue'), ('Peers', '09-people')):
        guest.locator('.chat-tab-btn', has_text=tab).first.click(); shot(guest, name)
    guest.locator('.chat-tab-btn', has_text='Chat').first.click()

    guest.get_by_role('button', name='More').click()
    check('More sheet opens', wait(lambda: guest.get_by_role('dialog', name='More').is_visible(), 3))
    shot(guest, '10-more-sheet')
    guest.get_by_role('button', name='Soundboard').click()
    check('Soundboard sheet opens from More', wait(lambda: guest.get_by_role('dialog', name='Soundboard').is_visible(), 3))
    shot(guest, '11-soundboard-sheet')
    guest.keyboard.press('Escape')

    # mic button toggles
    before = guest.locator('.phone-action').first.inner_text()
    guest.locator('.phone-action').first.click(); guest.wait_for_timeout(800)
    after = guest.locator('.phone-action').first.inner_text()
    check('mic button toggles', before != after, f'{before!r} -> {after!r}')
    shot(guest, '12-mic-on')
    # guest streams the host's video from the compact offer
    guest.get_by_role('button', name=re.compile('Stream from')).click()
    check('guest video starts after tapping Stream', wait(lambda: guest.evaluate("(() => { const v = document.querySelector('.stage-phone video'); return !!(v && v.readyState >= 2); })()"), 30))
    shot(guest, '13-guest-streaming')
    b.close()
print(f"\n{sum(results)}/{len(results)} passed")
