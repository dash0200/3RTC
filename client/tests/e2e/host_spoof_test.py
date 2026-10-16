"""A guest whose app lies about who it is (as a modified app could): it says it's the host in every
message, puts an outside image link and a fake "Receiving" card in its chat messages, and tries to
turn on the host-only playback lock. Everyone else must see through it: the host is whoever the
signaling server says made the room."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.signaling())
EVIL = 'http://127.0.0.1:9/evil.png'
# The lying app: rewrites what it sends, and keeps its channels for sending made-up messages
LIAR = """(() => {
  const send = RTCDataChannel.prototype.send;
  window.__chans = new Set();
  RTCDataChannel.prototype.send = function (d) {
    window.__chans.add(this);
    if (typeof d === 'string') {
      try {
        const m = JSON.parse(d);
        if ('isHost' in m || m.type === 'peer-identity' || m.type === 'chat') m.isHost = true;
        if (m.type === 'peer-identity') m.playbackLock = true;
        if (m.type === 'chat') {
          m.image = { url: '%s' };
          m.imageTransfer = { transferId: 'x', isTransferring: true, percent: 42, fileName: 'stuck.png', fileSize: 1 };
          m.sender = 'Mallory';
        }
        d = JSON.stringify(m);
      } catch (e) { /* binary or not ours */ }
    }
    return send.call(this, d);
  };
})();""" % EVIL
errors = []
requests = []

with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    pages = {}
    for name in ('host', 'liar', 'guest'):
        pg = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
        pg.add_init_script(INIT + (LIAR if name == 'liar' else ''))
        pg.add_init_script(f"localStorage.setItem('webrtc_username', '{name.capitalize()}y');")
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('request', lambda r: requests.append(r.url))
        pages[name] = pg
    host, liar, guest = pages['host'], pages['liar'], pages['guest']

    host.goto(BASE); host.wait_for_timeout(1200)
    host.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    host.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    for pg in (liar, guest):
        pg.goto(f'{BASE}?room={room}'); pg.wait_for_timeout(1200)
        pg.get_by_role('button', name='Join room').click()
    check('all three in the room', wait(lambda: all(pg.locator('.stage-voice-chip').count() >= 3 for pg in (host, liar, guest)), 30))
    time.sleep(2)

    def roster_hosts(pg):
        pg.locator('.chat-tab-btn', has_text='Peers').first.click(); time.sleep(0.5)
        tags = pg.evaluate("[...document.querySelectorAll('.host-tag')].map((t) => t.parentElement?.innerText || '')")
        pg.locator('.chat-tab-btn', has_text='Chat').first.click()
        return tags

    for name, pg in (('host', host), ('guest', guest)):
        tags = roster_hosts(pg)
        check(f'{name}: only the real host has the HOST tag, not the guest who claims it',
              len(tags) == 1 and not any('Liary' in t for t in tags) and (name == 'host' or 'Hosty' in tags[0]), tags)

    # The lying guest chats (its app adds the host flag, an image link and a fake transfer card)
    box = liar.get_by_placeholder(re.compile('Type a message'))
    box.fill('hello from the guest'); box.press('Enter')
    for name, pg in (('host', host), ('guest', guest)):
        check(f'{name}: the message arrives', wait(lambda: pg.get_by_text('hello from the guest').count() > 0, 8))
        bubble = pg.locator('.wa-message, [class*=message]', has_text='hello from the guest').last
        check(f'{name}: with no HOST badge', pg.locator('.wa-host-badge').count() == 0, pg.locator('.wa-host-badge').count())
        check(f'{name}: under its real name, not the one in the message', 'Liary' in pg.content() and pg.get_by_text('Mallory').count() == 0)
        check(f'{name}: no outside image and no fake "Receiving" card', pg.locator(f'img[src="{EVIL}"]').count() == 0 and pg.get_by_text('stuck.png').count() == 0)
    check('nobody loaded the outside image', not any('evil.png' in u for u in requests))

    # It tries to turn on the host-only playback lock
    liar.evaluate("for (const c of window.__chans) if (c.readyState === 'open') c.send(JSON.stringify({ type: 'room-settings', playbackLock: true }))")
    time.sleep(1.5)
    for name, pg in (('host', host), ('guest', guest)):
        check(f"{name}: a guest can't turn on host controls", pg.locator('.header-lock-pill').count() == 0)

    # The real host still can
    host.locator('.stage-more-wrap .circle-action-btn').click()
    host.get_by_role('menuitemcheckbox', name=re.compile('Only I control playback')).click()
    check('the real host can (the guest sees "Host controls")', wait(lambda: guest.locator('.header-lock-pill').count() > 0, 5))
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
