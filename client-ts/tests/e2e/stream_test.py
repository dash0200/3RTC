"""Sharing a local video file: on-demand streaming, seeking, cancelling."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.preview()
harness.signaling()
import re, time
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:4173'
INIT = r"""
localStorage.setItem('webrtc_signal_url', 'ws://localhost:8080');
window.__sig = [];
const OrigWS = window.WebSocket;
window.WebSocket = class extends OrigWS { constructor(...a) { super(...a);
  this.addEventListener('message', (e) => { try { window.__sig.push(JSON.parse(e.data)); } catch {} }); } };
"""

def wait(cond, timeout=20, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        try:
            r = cond()
        except Exception:
            r = None
        if r: return r
        time.sleep(step)
    return None

results = []
def check(name, ok, detail=''):
    results.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

VID = "document.querySelector('video')"
def vstate(pg):
    return pg.evaluate(f"(() => {{ const v = {VID}; if (!v) return null; return {{ t: +v.currentTime.toFixed(2), paused: v.paused, rs: v.readyState, src: (v.currentSrc||'').slice(0, 40), err: v.error && v.error.code }}; }})()")
def pill(pg):
    return harness.stream_pill(pg)
def pct(pg):
    return harness.stream_percent(pg)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    host = b.new_context().new_page(); guest = b.new_context().new_page()
    for pg in (host, guest):
        pg.add_init_script(INIT); pg.on('dialog', lambda d: d.accept())

    # service worker must control both pages before joining
    for pg in (host, guest):
        pg.goto(BASE + '/')
        if not wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10):
            pg.reload(); wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10)
    check('service worker controls both pages', host.evaluate('!!navigator.serviceWorker.controller') and guest.evaluate('!!navigator.serviceWorker.controller'))

    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None))
    guest.goto(f'{BASE}/?room={room}'); wait(lambda: guest.evaluate('!!navigator.serviceWorker.controller'), 10)
    guest.get_by_role('button', name='Join Room').click()
    check('peers connected', wait(lambda: 'Direct P2P' in host.content() and guest.get_by_text(re.compile('PEER|Peer')).count() >= 0, 15))
    time.sleep(2)

    host.locator('input[accept*=".mp4"]').first.set_input_files(harness.media('test.mp4'))
    btn = guest.get_by_role('button', name=re.compile('Stream from'))
    check('guest offered the stream', wait(lambda: btn.count() > 0, 15))
    t0 = time.time()
    btn.first.click()

    ready = wait(lambda: (vstate(guest) or {}).get('rs', 0) >= 3, 30, 0.1)
    t_ready = time.time() - t0
    p_ready = pct(guest)
    check('guest video playable quickly (old code: only after 100%)', ready and t_ready < 8,
          f'{t_ready:.1f}s, {p_ready}% of file received, video {vstate(guest)}')
    check('playable after receiving a small part of the file', p_ready is not None and p_ready < 35, f'{p_ready}%')

    host.evaluate(f"{VID}.muted = true; {VID}.play()")
    played = wait(lambda: (vstate(guest) or {}).get('t', 0) > 3 and not vstate(guest)['paused'], 25, 0.25)
    check('guest plays along with host', played, f'guest {vstate(guest)} | {pill(guest)}')

    # a buffer builds up ahead of playback (more fetched than played); how far is capped (unit tests)
    time.sleep(4)
    g = vstate(guest)
    p_play = pct(guest)
    check('builds a buffer ahead of playback', p_play is not None and p_play > g['t'] / 60 * 100 + 10,
          f'at {g["t"]}s of 60s: {p_play}% fetched | {pill(guest)}')

    # seek far ahead (into data never fetched): host jumps to 50 s, guest follows
    host.evaluate(f"{VID}.currentTime = 50")
    t1 = time.time()
    sought = wait(lambda: (vstate(guest) or {}).get('t', 0) > 50.5 and (vstate(guest) or {}).get('rs', 0) >= 3, 25, 0.2)
    check('seek to an unfetched part plays within seconds', sought, f'{time.time() - t1:.1f}s, guest {vstate(guest)} | {pill(guest)}')

    # back to the start: already cached, so nothing new should be needed
    before = guest.evaluate("0")
    p_before = pct(guest)
    host.evaluate(f"{VID}.currentTime = 2")
    back = wait(lambda: 2 < (vstate(guest) or {}).get('t', 99) < 10 and vstate(guest)['rs'] >= 3, 20, 0.2)
    check('seeking back into watched part works', back, f'guest {vstate(guest)} | {pill(guest)}')
    print('progress pill:', pill(guest))

    # A viewer whose page was hard-refreshed (Ctrl+Shift+R): the service worker doesn't control it,
    # which used to fall back to downloading the whole file before anything played
    late = b.new_context().new_page()
    late.add_init_script(INIT); late.on('dialog', lambda d: d.accept())
    late.goto(f'{BASE}/?room={room}')
    wait(lambda: late.evaluate('!!navigator.serviceWorker.controller'), 10)
    cdp = late.context.new_cdp_session(late)
    cdp.send('Network.enable'); cdp.send('Network.setBypassServiceWorker', {'bypass': True})
    late.reload(); late.wait_for_timeout(1500)
    cdp.send('Network.setBypassServiceWorker', {'bypass': False})
    check('hard-refreshed page starts without the service worker', not late.evaluate('!!navigator.serviceWorker.controller'))
    late.get_by_role('button', name='Join Room').click()
    lbtn = late.get_by_role('button', name=re.compile('Stream from'))
    check('hard-refreshed viewer offered the stream', wait(lambda: lbtn.count() > 0, 20))
    t2 = time.time()
    lbtn.first.click()
    late_ready = wait(lambda: (vstate(late) or {}).get('rs', 0) >= 3, 30, 0.1)
    check('hard-refreshed viewer still streams on demand (plays quickly, not after a full download)',
          late_ready and time.time() - t2 < 12 and 'downloading' not in pill(late),
          f'{time.time() - t2:.1f}s, controller={late.evaluate("!!navigator.serviceWorker.controller")}, {pill(late)}')
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
