"""Six people in one room: mesh, voice bitrate, local video shared between the viewers (swarm)."""
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
window.__sig = []; window.__rng = 0; window.__pcs = []; localStorage.setItem('3rtc_debug', '1');
const OrigWS = window.WebSocket;
window.WebSocket = class extends OrigWS { constructor(...a) { super(...a);
  this.addEventListener('message', (e) => { try { window.__sig.push(JSON.parse(e.data)); } catch {} }); } };
const OrigPC = window.RTCPeerConnection;
window.RTCPeerConnection = class extends OrigPC { constructor(...a) { super(...a); window.__pcs.push(this); } };
const origSend = RTCDataChannel.prototype.send;
RTCDataChannel.prototype.send = function (d) {
  if (d instanceof ArrayBuffer && d.byteLength > 16 && new DataView(d).getUint32(0) === 0x524E4731) window.__rng += d.byteLength;
  return origSend.call(this, d);
};
"""
def wait(cond, timeout=20, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            r = cond()
        except Exception:
            r = None
        if r: return r
        time.sleep(step)
    return None
res = []
def check(n, ok, d=''): res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + (f'  [{d}]' if d else ''), flush=True)
VID = "document.querySelector('video')"
def vstate(pg):
    return pg.evaluate(f"(() => {{ const v = {VID}; if (!v) return null; return {{ t: +v.currentTime.toFixed(1), paused: v.paused, rs: v.readyState }}; }})()")
def chat(pg): return pg.content()

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    names = ['Owner', 'Asha', 'Ben', 'Chen', 'Dev', 'Eli']
    ctxs = [b.new_context(viewport={'width': 1280, 'height': 800}) for _ in names]
    pages = [c.new_page() for c in ctxs]
    for pg, nm in zip(pages, names):
        pg.add_init_script(INIT + f"localStorage.setItem('webrtc_username', '{nm}');"); pg.on('dialog', lambda d: d.accept())
        pg.goto(BASE + '/')
        if not wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10):
            pg.reload(); wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10)
    owner, guests = pages[0], pages[1:]
    owner.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    owner.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: next((m['roomId'] for m in owner.evaluate('window.__sig') if m.get('type') == 'room-created'), None))
    for g in guests:
        g.goto(f'{BASE}/?room={room}'); wait(lambda: g.evaluate('!!navigator.serviceWorker.controller'), 10)
        g.get_by_role('button', name='Join Room').click()
        time.sleep(1.5)
    def open_links(pg):
        return pg.evaluate("window.__pcs.filter(pc => pc.connectionState === 'connected').length")
    ok = wait(lambda: all(open_links(pg) >= 5 for pg in pages), 40)
    check('6 people: everyone connected directly to the other 5', ok, [open_links(pg) for pg in pages])
    check('header shows 6 / 6', '6 / 6' in owner.locator('header').inner_text(), owner.locator('header').inner_text()[:80].replace('\n', ' '))

    # 7th person is turned away
    extra = b.new_context().new_page(); extra.add_init_script(INIT); extra.goto(f'{BASE}/?room={room}'); extra.wait_for_timeout(1500)
    extra.get_by_role('button', name='Join Room').click()
    full = wait(lambda: next((m['message'] for m in extra.evaluate('window.__sig') if m.get('type') == 'error'), None), 8)
    check('a 7th person gets "room is full"', full and 'full' in full, full)
    extra.context.close()

    # voice: 64 kbps per connection in a room of 6
    rates = owner.evaluate("""window.__pcs.filter(pc => pc.connectionState === 'connected').map(pc => {
        const t = pc.getTransceivers().find(t => (t.receiver.track && t.receiver.track.kind === 'audio') || (t.sender.track && t.sender.track.kind === 'audio'));
        const e = t && t.sender.getParameters().encodings; return e && e[0] ? e[0].maxBitrate : null; })""")
    check('voice capped at 64 kbps per connection with 6 people', rates and all(r == 64000 for r in rates), rates)

    # local video: owner shares, viewers stream one by one
    owner.set_input_files('input[accept*="video/mp4"]', harness.media('test_small.mp4'))
    for g in guests:
        btn = g.get_by_role('button', name=re.compile('Stream from Peer'))
        wait(lambda: btn.count() > 0, 15); btn.first.click()
        wait(lambda: (vstate(g) or {}).get('rs', 0) >= 2, 25); time.sleep(0.5)
    ready = [(vstate(g) or {}).get('rs', 0) >= 2 for g in guests]
    check('all 5 viewers can play the video', all(ready), ready)

    owner.evaluate(f"{VID}.muted = true; {VID}.play()")
    played = wait(lambda: all((vstate(g) or {}).get('t', 0) > 8 for g in guests), 40, 0.5)
    check('all viewers play along', played, [vstate(g) for g in guests])
    # Once everyone has (nearly) the whole film: how much of it came from the owner
    def buffered(pg):
        el = pg.query_selector('.local-filesize-text')
        m = re.search(r'\((\d+)%', el.inner_text() if el else '')
        return int(m.group(1)) if m else 0
    check('every viewer buffers the film', wait(lambda: all(buffered(g) >= 90 for g in guests), 40, 0.5), [buffered(g) for g in guests])
    sent = [pg.evaluate('window.__rng') for pg in pages]
    for g, nm in zip(guests, names[1:]):
        print(nm, g.evaluate("(() => { const r = window.__3rtcStream; return r && { swarm: r.swarm, stats: r.stats, counts: r.counts, have: [...r.peerHave].map(([k, h]) => h.reduce((a, x) => a + x, 0)), penalty: r.penalty.size, banned: r.banned.size }; })()"), flush=True)
    total = sum(sent)
    relays = [nm for nm, x in zip(names[1:], sent[1:]) if x > 0]
    check('viewers pass the video on to each other', len(relays) >= 2, relays)
    check("owner's upload is a fraction of the total (no longer 5 copies)", sent[0] < 0.55 * total,
          f"owner {sent[0]/1e6:.1f} MB of {total/1e6:.1f} MB sent in total; per person (MB): {[round(x/1e6,1) for x in sent]}")

    guests[1].locator('.chat-tab-btn', has_text='Peers').first.click(); guests[1].wait_for_timeout(300); guests[1].mouse.move(10, 10)
    guests[1].screenshot(path=str(harness.OUT / 'six-viewer.png'))
    # a viewer others fetch from leaves mid-video: the rest keep watching
    parents = [i for i, g in enumerate(guests) if sent[i + 1] > 1e6]
    gone = parents[0] if parents else 0
    gone_name = names[gone + 1]
    ctxs[gone + 1].close()
    owner.evaluate(f"{VID}.currentTime = 40")   # new, never-fetched part of the file
    rest = [g for i, g in enumerate(guests) if i != gone]
    ok = wait(lambda: all((vstate(g) or {}).get('t', 0) > 41.5 and (vstate(g) or {}).get('rs', 0) >= 3 for g in rest), 40, 0.5)
    check(f'{gone_name} (a relay) leaves; everyone else keeps playing after a seek', ok, [vstate(g) for g in rest])
    owner.locator('.chat-tab-btn', has_text='Peers').first.click(); owner.wait_for_timeout(400)
    owner.screenshot(path=str(harness.OUT / 'six-owner.png'))
    b.close()
print(f"\n{sum(res)}/{len(res)} passed")
