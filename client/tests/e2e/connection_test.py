"""Two people: P2P link, bulk channel, voice, speaking ring, chat, signaling restart, ICE restart, rebuild, leaving."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.dev()
harness.signaling()
import re, subprocess, time, json, os, signal
from playwright.sync_api import sync_playwright

INIT = r"""
localStorage.setItem('webrtc_signal_url', 'ws://localhost:8080');
window.__pcs = []; window.__sig = []; window.__chan = [];
const OrigPC = window.RTCPeerConnection;
class PC extends OrigPC {
  constructor(...a) { super(...a); this.__fake = null; window.__pcs.push(this);
    this.addEventListener('datachannel', (e) => window.__chan.push(e.channel)); }
  get connectionState() { return this.__fake || super.connectionState; }
  createDataChannel(...a) { const c = super.createDataChannel(...a); window.__chan.push(c); return c; }
}
window.RTCPeerConnection = PC;
window.__fail = (state) => { for (const pc of window.__pcs) if (pc.signalingState !== 'closed') {
  pc.__fake = state; pc.dispatchEvent(new Event('connectionstatechange')); } };
const OrigWS = window.WebSocket;
window.WebSocket = class extends OrigWS { constructor(...a) { super(...a);
  this.addEventListener('message', (e) => { try { window.__sig.push(JSON.parse(e.data)); } catch {} }); } };
window.__state = () => window.__pcs.map((pc) => ({ conn: pc.connectionState, sig: pc.signalingState,
  ufrag: (pc.localDescription?.sdp.match(/a=ice-ufrag:(\S+)/) || [])[1] }));
window.__chans = () => window.__chan.map((c) => `${c.label}:${c.readyState}`);
"""

def wait(cond, timeout=20, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        r = cond()
        if r: return r
        time.sleep(step)
    return None

def live(page):
    return [s for s in page.evaluate("window.__state()") if s['conn'] != 'closed' and s['sig'] != 'closed']

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + harness.media('speech.wav')])
    host = b.new_context().new_page(); guest = b.new_context().new_page()
    guest_logs = []
    guest.on('console', lambda m: guest_logs.append(m.text))
    for pg in (host, guest):
        pg.add_init_script(INIT); pg.on('dialog', lambda d: d.accept())
    host.goto('http://localhost:5199/'); host.wait_for_timeout(1500)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None))
    check('host created room', room, room)

    guest.goto(f'http://localhost:5199/?room={room}'); guest.wait_for_timeout(1500)
    guest.get_by_role('button', name='Join Room').click()

    ok = wait(lambda: len(live(host)) == 1 and live(host)[0]['conn'] == 'connected'
              and len(live(guest)) == 1 and live(guest)[0]['conn'] == 'connected', 20)
    check('P2P connected', ok)
    bulk = wait(lambda: 'bulk:open' in host.evaluate('window.__chans()') and 'bulk:open' in guest.evaluate('window.__chans()'), 10)
    check('bulk channel open on both sides', bulk, f"host {host.evaluate('window.__chans()')} guest {guest.evaluate('window.__chans()')}")

    # bulk channel delivers data to the peer
    guest.evaluate("window.__bulkGot = 0; for (const c of window.__chan) if (c.label === 'bulk') c.addEventListener('message', (e) => { window.__bulkGot += e.data.byteLength || e.data.length; })")
    host.evaluate("for (const c of window.__chan) if (c.label === 'bulk' && c.readyState === 'open') for (let i = 0; i < 64; i++) c.send(new ArrayBuffer(16384))")
    got = wait(lambda: guest.evaluate('window.__bulkGot') >= 64 * 16384, 10)
    check('bulk channel carries data (1 MB)', got, str(guest.evaluate('window.__bulkGot')))

    # voice: guest unmutes, host must receive audio packets from the guest
    harness.mic_button(guest).click()
    def host_audio_bytes():
        return host.evaluate("""async () => { let n = 0; for (const pc of window.__pcs) { if (pc.signalingState === 'closed') continue;
            const st = await pc.getStats(); st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.packetsReceived || 0; }); } return n; }""")
    b0 = host_audio_bytes(); time.sleep(3); b1 = host_audio_bytes()
    check('voice: host receives guest audio after unmute', b1 - b0 > 100, f'{b1 - b0} packets in 3 s')
    gate = guest.evaluate("""async () => { for (const pc of window.__pcs) { const s = pc.getSenders().find((x) => x.track && x.track.kind === 'audio'); if (s) return { label: s.track.label, enabled: s.track.enabled, prio: s.getParameters().encodings[0]?.priority }; } return null; }""")
    check('voice: guest sends the processed pipeline track with high priority', gate and gate['prio'] == 'high', str(gate))

    # speaking rings: the guest's chip on the host lights up while the fake mic tone plays
    host.locator('.chat-tab-btn', has_text='People').first.click()  # (the people list shows who's talking)
    host.evaluate("""() => { window.__ring = 0; window.__ringObs = setInterval(() => {
        if (document.querySelector('.peer-voice-badge.is-speaking, .vpo-av.is-speaking')) window.__ring++; else window.__dark = (window.__dark || 0) + 1; }, 50); }""")
    time.sleep(6)
    rings = host.evaluate("clearInterval(window.__ringObs), window.__ring")
    dark = host.evaluate("window.__dark || 0")
    check('speaking ring follows the talking peer (on while talking, off in pauses)', rings > 3 and dark > 3, f'{rings} samples lit, {dark} dark')

    host.locator('.chat-tab-btn', has_text='Chat').first.click()
    # chat: guest types a message, host shows it
    guest.locator('.chat-pill-textarea').fill('hello from guest')
    guest.locator('.chat-pill-send-btn').click()
    check('chat: message delivered', wait(lambda: 'hello from guest' in host.content(), 5))

    # --- 1. signaling server restart: P2P must survive, host keeps the same room code ---
    harness.restart_signaling(down_seconds=1.5)
    resumed = wait(lambda: next((m for m in host.evaluate('window.__sig') if m.get('type') == 'room-resumed'), None), 20)
    check('host resumed the SAME room after server restart', resumed and resumed['roomId'] == room,
          resumed and resumed.get('roomId'))
    time.sleep(4)
    check('P2P link survived signaling restart (no rebuild)',
          len(host.evaluate('window.__pcs')) == 1 and live(host)[0]['conn'] == 'connected' and live(guest)[0]['conn'] == 'connected',
          f"host pcs {host.evaluate('window.__state()')} guest {guest.evaluate('window.__state()')}")

    # --- 2. P2P path breaks then comes back: initiator (host) does an ICE restart ---
    before = live(host)[0]['ufrag']
    host.evaluate("window.__fail('failed')")
    restarted = wait(lambda: host.evaluate("window.__pcs[0].localDescription.sdp.match(/a=ice-ufrag:(\\S+)/)[1]") != before
                     and host.evaluate('window.__pcs[0].signalingState') == 'stable', 10)
    check('ICE restart offer sent and answered', restarted,
          f"ufrag {before} -> {host.evaluate('window.__state()')[0]['ufrag']}")
    host.evaluate("for (const pc of window.__pcs) { pc.__fake = null; pc.dispatchEvent(new Event('connectionstatechange')); }")
    check('UI shows "Reconnected" toast', wait(lambda: 'Reconnected' in host.content(), 5, 0.1))

    # --- 3. path stays broken: after 4 ICE restarts the host rebuilds the connection ---
    t0 = time.time()
    host.evaluate("window.__fail('failed')")
    rebuilt = wait(lambda: len(host.evaluate('window.__pcs')) >= 2 and len(live(host)) == 1 and live(host)[0]['conn'] == 'connected'
                   and len(live(guest)) == 1 and live(guest)[0]['conn'] == 'connected'
                   and guest.evaluate('window.__pcs.length') >= 2, 60, 0.5)
    check('stuck connection rebuilt from scratch', rebuilt, f'{time.time() - t0:.0f}s, host {host.evaluate("window.__state()")} guest {guest.evaluate("window.__state()")}')
    check('fresh connection has bulk channel', wait(lambda: host.evaluate("window.__chans()").count('bulk:open') == 1, 10),
          str(host.evaluate('window.__chans()')))

    # --- 4. guest leaves on purpose: host cleans up immediately (no reconnect attempts) ---
    guest.evaluate("""() => { const b = [...document.querySelectorAll('button')].find(x => /leave/i.test(x.textContent + (x.title||'') + (x.getAttribute('aria-label')||''))); b && b.click(); return !!b; }""")
    gone = wait(lambda: len(live(host)) == 0, 8)
    check('host dropped the connection right after guest left', gone, str(host.evaluate('window.__state()')))
    time.sleep(10)
    check('host made no reconnect attempt after a deliberate leave',
          len(host.evaluate('window.__pcs')) == len([1 for _ in host.evaluate('window.__pcs')]) and len(live(host)) == 0)
    b.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} passed")
