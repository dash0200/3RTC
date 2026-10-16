"""A network that blocks direct connections (3RTC has no relay server): instead of waiting forever,
both sides are told plainly what's wrong and what to try. Simulated by making one browser use
relays only, with no relay to use. Someone on a normal network still connects, with no warning."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.signaling())
BLOCKED = """(() => {
  const Real = window.RTCPeerConnection;
  window.RTCPeerConnection = function (config = {}) { return new Real({ ...config, iceServers: [], iceTransportPolicy: 'relay' }); };
  window.RTCPeerConnection.prototype = Real.prototype;
})();"""
errors = []


def said(pg, pattern):
    banner = pg.locator('.network-blocked-banner')
    return banner.count() > 0 and banner.is_visible() and re.search(pattern, banner.inner_text()) is not None


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    host = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    blocked = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page()
    host.add_init_script(INIT)
    blocked.add_init_script(INIT + BLOCKED)
    for pg in (host, blocked):
        pg.on('pageerror', lambda e: errors.append(str(e)))
    host.goto(BASE); host.wait_for_timeout(1200)
    host.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    host.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    blocked.goto(f'{BASE}?room={room}'); blocked.wait_for_timeout(1200)
    blocked.get_by_role('button', name='Join room').click()
    start = time.time()
    check('blocked network: a notice stays on screen saying what is wrong (within ~30 s)',
          wait(lambda: said(blocked, 'blocks? direct connections'), 45), f'{time.time() - start:.0f}s')
    check('...it names their own network', said(blocked, 'your network seems to block|your network or theirs'))
    check('...and suggests switching networks or the VPN', said(blocked, 'mobile data') and said(blocked, 'VPN'))
    check('the host is told too', wait(lambda: said(host, 'blocks? direct connections'), 20))
    blocked.screenshot(path=str(harness.OUT / 'network_blocked_phone.png'))
    time.sleep(4)
    check('...and it stays (not a passing toast)', said(blocked, 'blocks? direct connections'))
    blocked.locator('.network-blocked-dismiss').click()
    check('it can be dismissed', blocked.locator('.network-blocked-banner').count() == 0)

    # Someone on a normal network connects as usual, with no warning (the blocked guest left first:
    # it would be unreachable for them too, and they'd rightly be told)
    blocked.close()
    time.sleep(2)
    ok = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    ok.add_init_script(INIT)
    ok.on('pageerror', lambda e: errors.append(str(e)))
    ok.goto(f'{BASE}?room={room}'); ok.wait_for_timeout(1200)
    ok.get_by_role('button', name='Join room').click()
    check('a normal network still connects to the host', wait(lambda: ok.evaluate("document.body.innerText.includes('Direct P2P')"), 25))
    time.sleep(28)  # past the first-connection check
    check('...with no blocked-network warning', ok.locator('.network-blocked-banner').count() == 0)
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
