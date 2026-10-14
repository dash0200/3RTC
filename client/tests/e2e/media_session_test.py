"""Media Session (lock screen / headset controls)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.preview()
harness.signaling()
import re, time
from playwright.sync_api import sync_playwright
BASE='http://localhost:4173'
INIT = "window.__ms = {}; if (navigator.mediaSession) { const o = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession); navigator.mediaSession.setActionHandler = (a, h) => { window.__ms[a] = h; try { o(a, h); } catch (e) {} }; }localStorage.setItem('webrtc_signal_url','ws://localhost:8080');window.__sig=[];const O=window.WebSocket;window.WebSocket=class extends O{constructor(...a){super(...a);this.addEventListener('message',e=>{try{window.__sig.push(JSON.parse(e.data))}catch{}})}};"
res=[]
def check(n, ok, d=''): res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ')+n+(f'  [{d}]' if d else ''), flush=True)
V="document.querySelector('video')"
def st(pg): return pg.evaluate(f"(() => {{ const v={V}; return v ? {{ p: v.paused, t: +v.currentTime.toFixed(1), rs: v.readyState }} : null; }})()")
def wait(f, t=10):
    end=time.time()+t
    while time.time()<end:
        try:
            if f(): return True
        except Exception: pass
        time.sleep(0.2)
    return False
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    pc=b.new_context(viewport={'width':1440,'height':900}).new_page()
    phone=b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True).new_page()
    for pg in (pc,phone):
        pg.add_init_script(INIT); pg.goto(BASE+'/')
        if not wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10): pg.reload(); wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10)
    pc.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    pc.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click(); pc.wait_for_timeout(800)
    room=next(m['roomId'] for m in pc.evaluate('window.__sig') if m.get('type')=='room-created')
    phone.goto(f'{BASE}/?room={room}'); wait(lambda: phone.evaluate('!!navigator.serviceWorker.controller'), 10); phone.get_by_role('button', name='Join room').click()
    wait(lambda: 'P2P' in phone.locator('.phone-status-pill').inner_text(), 15); time.sleep(1.5)
    pc.set_input_files('input[accept*="video/mp4"]', harness.media('test_small.mp4'))
    btn=phone.get_by_role('button', name=re.compile('Stream from')); wait(lambda: btn.count()>0, 15); btn.first.click()
    wait(lambda: (st(phone) or {}).get('rs',0)>=2, 25)
    pc.evaluate(f"{V}.muted=true; {V}.play()"); wait(lambda: st(phone) and not st(phone)['p'], 10); time.sleep(2)
    title = phone.evaluate("navigator.mediaSession.metadata && navigator.mediaSession.metadata.title")
    check('lock screen shows the video title', title == 'test_small', title)
    check('lock screen controls registered', all(phone.evaluate(f"typeof window.__ms['{a}'] === 'function'") for a in ('play','pause','seekto','seekforward','seekbackward')))
    phone.evaluate("window.__ms.pause()")
    check('lock-screen pause on the phone pauses the PC', wait(lambda: st(pc)['p'], 8), st(pc))
    phone.evaluate("window.__ms.seekto({ seekTime: 30 })")
    check('lock-screen seek on the phone moves the PC', wait(lambda: abs(st(pc)['t'] - 30) < 2, 10), st(pc))
    phone.evaluate("window.__ms.seekforward({})")
    check('headphone/notification +10 s moves the PC', wait(lambda: abs(st(pc)['t'] - 40) < 2.5, 10), st(pc))
    phone.evaluate("window.__ms.play()")
    check('lock-screen play plays the PC', wait(lambda: not st(pc)['p'], 8), st(pc))
    b.close()
print(f'\n{sum(res)}/{len(res)} passed')
