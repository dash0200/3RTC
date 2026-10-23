"""YouTube play / pause / seek sync between a computer and a phone."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.dev()
harness.signaling()
import re, time
from playwright.sync_api import sync_playwright
# Stand-in for the YouTube IFrame API with a real state machine and clock
INIT = r"""
localStorage.setItem('webrtc_signal_url', 'ws://localhost:8080');
window.__sig = [];
const OWS = window.WebSocket; window.WebSocket = class extends OWS { constructor(...a) { super(...a); this.addEventListener('message', e => { try { window.__sig.push(JSON.parse(e.data)); } catch {} }); } };
window.YT = { PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  Player: class {
    constructor(el, opts) { this.o = opts; this.state = -1; this.t = 0; this.at = performance.now(); window.__yt = this;
      setTimeout(() => { opts.events.onReady?.({ target: this }); }, 200); }
    _now() { if (this.state === 1) { const n = performance.now(); this.t += (n - this.at) / 1000; this.at = n; } return this.t; }
    _set(s) { this._now(); this.at = performance.now(); if (s !== this.state) { this.state = s; setTimeout(() => this.o.events.onStateChange?.({ data: s, target: this }), 30); } }
    playVideo() { clearTimeout(this._resume); this._set(1); }
    pauseVideo() { clearTimeout(this._resume); this._set(2); }
    seekTo(t) { this._now(); this.t = t; this.at = performance.now(); if (this.state === 1) { this._set(3); clearTimeout(this._resume); this._resume = setTimeout(() => this._set(1), 120); } }
    loadVideoById() {} destroy() {} getCurrentTime() { return this._now(); } getDuration() { return 600; } getPlayerState() { return this.state; }
    getVolume() { return 100; } isMuted() { return false; } setVolume() {} mute() {} unMute() {} getVideoData() { return { title: '' }; }
  } };
// what a person does on YouTube's own controls: same calls, reported as user actions
window.__user = { play: () => window.__yt.playVideo(), pause: () => window.__yt.pauseVideo(), seek: (t) => window.__yt.seekTo(t) };
"""
res = []
def check(n, ok, d=''): res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + (f'  [{d}]' if d else ''), flush=True)
def st(pg): return pg.evaluate("window.__yt ? { s: window.__yt.state, t: +window.__yt.getCurrentTime().toFixed(1) } : null")
def wait(f, t=6):
    end = time.time() + t
    while time.time() < end:
        try:
            if f(): return True
        except Exception: pass
        time.sleep(0.15)
    return False
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    pc = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    phone = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page()
    for pg in (pc, phone): pg.add_init_script(INIT); pg.add_init_script(harness.PEOPLE_INIT); pg.on('pageerror', lambda e: print('ERR', e))
    pc.goto('http://localhost:5199/'); pc.wait_for_timeout(1500)
    harness.create_room(pc); pc.wait_for_timeout(800)
    room = next(m['roomId'] for m in pc.evaluate('window.__sig') if m.get('type') == 'room-created')
    phone.goto(f'http://localhost:5199/?room={room}'); phone.wait_for_timeout(1200); phone.get_by_role('button', name='Join room').click()
    wait(lambda: harness.people(phone) >= 2, 15); time.sleep(1.5)
    pc.get_by_placeholder(re.compile(r'Paste a (YouTube|link)|or \.mp4 link')).first.fill('https://youtu.be/aqz-KE-bpKQ'); pc.get_by_role('button', name=re.compile('Play for everyone|Load for All')).click()
    wait(lambda: st(pc) and st(phone), 8); time.sleep(1)
    pc.evaluate('window.__user.play()'); wait(lambda: st(phone)['s'] == 1, 6); time.sleep(2.5)
    steps = [('phone', 'pause'), ('pc', 'play'), ('pc', 'pause'), ('phone', 'play'), ('pc', 'seek', 120), ('phone', 'seek', 200), ('pc', 'pause'), ('phone', 'play'), ('pc', 'pause')]
    for step in steps:
        who, what = step[0], step[1]
        actor, other = (pc, phone) if who == 'pc' else (phone, pc)
        if what == 'seek':
            actor.evaluate(f'window.__user.seek({step[2]})')
            ok = wait(lambda: abs(st(other)['t'] - step[2]) < 3, 6)
        else:
            actor.evaluate(f'window.__user.{what}()')
            want = 1 if what == 'play' else 2
            ok = wait(lambda: st(other)['s'] == want, 6)
        check(f'{who} {what}{" to " + str(step[2]) + "s" if what == "seek" else ""} -> the {"phone" if who == "pc" else "PC"} follows', ok, f'pc {st(pc)} phone {st(phone)}')
        time.sleep(1.6)
    b.close()
print(f'\n{sum(res)}/{len(res)} passed')
