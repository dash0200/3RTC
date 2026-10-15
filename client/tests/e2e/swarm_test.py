"""Local video shared between viewers like a torrent: viewers fetch blocks from each other, not
only from the owner; a viewer sending damaged blocks is caught by the owner's checksums and
ignored (the video still plays right); an app from before the swarm still streams in the same room."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.preview()
INIT = harness.signal_init(harness.signaling()) + r"""
window.__rng = 0; window.__corrupt = false; localStorage.setItem('3rtc_debug', '1');
const origSend = RTCDataChannel.prototype.send;
RTCDataChannel.prototype.send = function (d) {
  if (d instanceof ArrayBuffer && d.byteLength > 16 && new DataView(d).getUint32(0) === 0x524E4731) {
    window.__rng += d.byteLength;
    if (window.__corrupt) { const u = new Uint8Array(d); for (let i = 16; i < u.length; i += 997) u[i] ^= 0x5a; }
  }
  return origSend.call(this, d);
};
"""
VID = "document.querySelector('video')"


def vstate(pg):
    return pg.evaluate(f"(() => {{ const v = {VID}; if (!v) return null; return {{ t: +v.currentTime.toFixed(1), paused: v.paused, rs: v.readyState, err: v.error && v.error.code }}; }})()")


def pill(pg):
    el = pg.query_selector('.local-filesize-text')
    return el.inner_text() if el else ''


def pct(pg):
    m = re.search(r'\((\d+)%', pill(pg))
    return int(m.group(1)) if m else 0


def from_viewers(pg):
    m = re.search(r'(\d+)% from viewers', pill(pg))
    return int(m.group(1)) if m else 0


def page(b, name, old=False, corrupt=False):
    pg = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    pg.add_init_script(INIT + f"localStorage.setItem('webrtc_username', '{name}');"
                       + ("localStorage.setItem('3rtc_no_swarm', '1');" if old else "")
                       + ("window.__corrupt = true;" if corrupt else ""))
    pg.on('dialog', lambda d: d.accept())
    pg.goto(BASE + '/')
    if not wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10):
        pg.reload()
        wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10)
    return pg


def join_and_stream(pg, room, buffered=95, owner=None):
    """Join, stream, play a moment (the background buffer starts once the player reads), then
    pause: the buffer keeps filling, and paused videos keep the test machine's CPU free."""
    pg.goto(f'{BASE}/?room={room}')
    wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10)
    pg.get_by_role('button', name='Join Room').click()
    btn = pg.get_by_role('button', name=re.compile('Stream from Peer'))
    wait(lambda: btn.count() > 0, 20)
    time.sleep(2)  # the others' "have" announcements arrive
    btn.first.click()
    wait(lambda: (vstate(pg) or {}).get('rs', 0) >= 2, 30)
    owner.evaluate(f"{VID}.muted = true; {VID}.currentTime = 1; {VID}.play()")
    wait(lambda: (vstate(pg) or {}).get('t', 0) > 2, 20)
    owner.evaluate(f"{VID}.pause()")
    return wait(lambda: pct(pg) >= buffered, 60, 0.5)


def dbg(pg):
    return pg.evaluate("""(() => { const r = window.__3rtcStream; if (!r) return null;
      const now = Date.now();
      return { swarm: r.swarm, stats: r.stats, banned: [...r.banned], penalty: [...r.penalty].map(([k, v]) => [k.slice(0, 6), v - now]),
        pending: [...r.pending].map(([b, at]) => [b, (r.sourceOf.get(b) || '?').slice(0, 6), now - at]).slice(0, 20),
        checking: [...r.blocks].filter(([b, e]) => e.checking).map(([b]) => b), have: [...r.peerHave].map(([k, h]) => [k.slice(0, 6), h.reduce((a, x) => a + x, 0)]),
        counts: r.counts, hashes: r.hashes.size, owner: (r.ownerId || '').slice(0, 6), window: r.window }; })()""")


def play_from(pg, t):
    pg.evaluate(f"{VID}.muted = true; {VID}.currentTime = {t}; {VID}.play()")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    owner = page(b, 'Owner')
    owner.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    owner.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: (re.search(r'room=(\d+)', owner.evaluate('location.href')) or [None, None])[1], 15)
    owner.set_input_files('input[type=file][accept*="video/"]', harness.media('test.mp4'))
    size = os.path.getsize(harness.media('test.mp4'))
    wait(lambda: owner.evaluate(f"{VID} && {VID}.readyState >= 2"), 10)

    asha = page(b, 'Asha')
    check('first viewer buffers the film from the owner', join_and_stream(asha, room, owner=owner), pill(asha))
    check('...all of it from the owner (nobody else has it)', from_viewers(asha) == 0, pill(asha))

    ben = page(b, 'Ben', corrupt=True)  # will send damaged blocks to other viewers
    check('second viewer buffers the film', join_and_stream(ben, room, owner=owner), pill(ben))
    check('...a good part of it from the first viewer', from_viewers(ben) >= 30, f'{pill(ben)} {dbg(ben)}')

    chen = page(b, 'Chen')
    owner_before = owner.evaluate('window.__rng')
    check('third viewer buffers the film', join_and_stream(chen, room, owner=owner), pill(chen))
    owner_for_chen = owner.evaluate('window.__rng') - owner_before
    check('...mostly from the other viewers', from_viewers(chen) >= 50, f'{pill(chen)} {dbg(chen)}')
    check("...so the owner sent well under a full copy for them", owner_for_chen < 0.5 * size, f'{owner_for_chen / 1e6:.1f} MB of {size / 1e6:.1f} MB')
    state = dbg(chen)
    check('damaged blocks from Ben were caught by the checksums', state['stats']['rejected'] > 0, state)
    check('...only the ones already asked for when the first was caught', state['stats']['rejected'] <= 12 and len(state['banned']) == 1, state)

    # The film plays correctly for everyone (the damaged blocks were replaced)
    play_from(owner, 30)
    viewers = [asha, ben, chen]
    ok = wait(lambda: all((vstate(v) or {}).get('t', 0) > 33 and not vstate(v)['err'] for v in viewers), 30, 0.5)
    check('everyone plays along after a seek, no decode errors', ok, [vstate(v) for v in viewers])

    # An app from before the swarm joins the same room: fetched from the owner / relay tree, as before
    dev = page(b, 'Dev', old=True)
    check('an older app still streams in the same room', join_and_stream(dev, room, buffered=50, owner=owner), pill(dev))
    check("...without the swarm (it doesn't know it)", from_viewers(dev) == 0, pill(dev))
    play_from(owner, 2)
    ok = wait(lambda: (vstate(dev) or {}).get('t', 0) > 3 and not vstate(dev)['paused'], 30, 0.5)
    check('...and plays along', ok, vstate(dev))

    # A viewer others fetch from leaves: the rest carry on
    asha.context.close()
    play_from(owner, 5)
    rest = [ben, chen, dev]
    ok = wait(lambda: all(6 < (vstate(v) or {}).get('t', 0) < 25 and (vstate(v) or {}).get('rs', 0) >= 3 for v in rest), 30, 0.5)
    check('a viewer leaves; the others keep playing after a seek', ok, [vstate(v) for v in rest])
    chen.screenshot(path=str(harness.OUT / 'swarm_viewer.png'))
    b.close()
harness.summary()
