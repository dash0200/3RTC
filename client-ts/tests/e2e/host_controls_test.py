"""Host controls lock, wake lock, chat timestamps."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.dev()
harness.signaling()
import re, time
from playwright.sync_api import sync_playwright
INIT = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'youtube_sync_test.py')).read().split('INIT = r"""')[1].split('"""')[0]
INIT += r"""
window.__wake = []; if (navigator.wakeLock) { navigator.wakeLock.request = async (t) => { window.__wake.push('lock'); const s = new EventTarget(); s.release = async () => { window.__wake.push('release'); s.dispatchEvent(new Event('release')); }; return s; }; }
"""
res = []
def check(n, ok, d=''): res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + (f'  [{d}]' if d else ''), flush=True)
def st(pg): return pg.evaluate("window.__yt ? { s: window.__yt.state, t: +window.__yt.getCurrentTime().toFixed(1) } : null")
def wait(f, t=8):
    end = time.time() + t
    while time.time() < end:
        try:
            if f(): return True
        except Exception: pass
        time.sleep(0.2)
    return False
def toasts(pg): return pg.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    host = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    phone = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page()
    guest = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    for pg in (host, phone, guest): pg.add_init_script(INIT); pg.add_init_script(harness.PEOPLE_INIT); pg.on('pageerror', lambda e: print('ERR', e))
    host.goto('http://localhost:5199/'); host.wait_for_timeout(1500)
    harness.create_room(host); host.wait_for_timeout(800)
    room = next(m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created')
    phone.goto(f'http://localhost:5199/?room={room}'); phone.wait_for_timeout(1200); phone.get_by_role('button', name='Join room').click()
    wait(lambda: harness.people(phone) >= 2, 15); time.sleep(1.5)
    host.get_by_placeholder(re.compile(r'Paste a (YouTube|link)|or \.mp4 link')).first.fill('https://youtu.be/aqz-KE-bpKQ'); host.get_by_role('button', name=re.compile('Play for everyone|Load for All')).click()
    wait(lambda: st(host) and st(phone), 8); time.sleep(1)
    host.evaluate('window.__user.play()'); wait(lambda: st(phone)['s'] == 1, 6); time.sleep(1.5)
    check('screen kept on while a video is loaded in a room', 'lock' in host.evaluate('window.__wake') and 'lock' in phone.evaluate('window.__wake'), [host.evaluate('window.__wake'), phone.evaluate('window.__wake')])

    # host turns the lock on from the ⋮ menu
    harness.toggle_playback_lock(host)
    check('phone guest sees the lock (top bar)', wait(lambda: phone.locator('.phone-lock-pill').count() == 1, 5))
    check('host sees "Host controls" in the header', host.locator('.rh-lock').count() == 1)
    # guest pauses on YouTube's own controls: reverted, host keeps playing
    phone.evaluate('window.__user.pause()'); time.sleep(0.4)
    check('guest pause does not reach the host', st(host)['s'] == 1, st(host))
    check('guest is told why', wait(lambda: 'Only the host can control playback' in toasts(phone), 3), toasts(phone)[:80])
    check("guest's player snaps back to the host (playing)", wait(lambda: st(phone)['s'] == 1, 6), st(phone))
    phone.evaluate('window.__user.seek(300)'); time.sleep(0.5)
    check('guest seek does not move the host', st(host)['t'] < 100, st(host))
    check("guest's player goes back to the host's position", wait(lambda: abs(st(phone)['t'] - st(host)['t']) < 3, 6), f"phone {st(phone)} host {st(host)}")
    # guest tries to change the video from the Add video sheet
    phone.get_by_role('button', name='Add video').last.click(); phone.get_by_placeholder(re.compile(r'Paste a (YouTube|link)|or \.mp4 link')).fill('https://youtu.be/dQw4w9WgXcQ')
    phone.locator('.phone-sheet button[type=submit]').click(); time.sleep(0.5)
    check("guest can't change the video for the host", host.evaluate("window.__yt.o.videoId") == 'aqz-KE-bpKQ')
    check("guest's own video goes back to the host's", wait(lambda: phone.evaluate("window.__yt.o.videoId") == 'aqz-KE-bpKQ', 8), phone.evaluate("window.__yt && window.__yt.o.videoId"))
    # host still controls everyone
    host.evaluate('window.__user.pause()')
    check('host pause reaches the guest', wait(lambda: st(phone)['s'] == 2, 6), st(phone))
    # someone joining later learns about the lock
    guest.goto(f'http://localhost:5199/?room={room}'); guest.wait_for_timeout(1200); guest.get_by_role('button', name='Join Room').click()
    check('a new joiner sees the lock', wait(lambda: guest.locator('.rh-lock').count() == 1, 15))
    # chat timestamps (lock on: guest blocked, host allowed)
    phone.locator('.chat-tab-btn', has_text='Chat').first.click()
    phone.locator('.chat-pill-textarea').fill('the best part is at 2:30'); phone.locator('.chat-pill-send-btn').click()
    check('timestamps in chat become links', wait(lambda: host.locator('.chat-timestamp', has_text='2:30').count() > 0, 6))
    host.locator('.chat-timestamp', has_text='2:30').first.click()
    check('host clicks 2:30: everyone jumps there', wait(lambda: abs(st(phone)['t'] - 150) < 2 and abs(st(guest)['t'] - 150) < 2, 8), f"phone {st(phone)} guest {st(guest)} host {st(host)}")
    # host turns the lock off: guests can control again
    harness.toggle_playback_lock(host)
    check('lock off: pill disappears for guests', wait(lambda: phone.locator('.phone-lock-pill').count() == 0 and guest.locator('.rh-lock').count() == 0, 5))
    phone.evaluate('window.__user.play()')
    check('lock off: guest play reaches the host', wait(lambda: st(host)['s'] == 1, 6), st(host))
    # lock on again, then the host leaves: the lock goes away
    harness.toggle_playback_lock(host)
    wait(lambda: phone.locator('.phone-lock-pill').count() == 1, 5)
    host.context.close()
    check('host leaves: the lock is released after a few seconds', wait(lambda: phone.locator('.phone-lock-pill').count() == 0 and guest.locator('.rh-lock').count() == 0, 40))
    guest.evaluate('window.__user.pause()')
    check('then guests control playback again', wait(lambda: st(phone)['s'] == 2, 6), st(phone))
    b.close()
print(f'\n{sum(res)}/{len(res)} passed')
