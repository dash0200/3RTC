"""Everyday room features between two people: reactions, soundboard, ping, vote to skip, leaving resets."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
harness.signaling()
# YouTube stand-in (same as the YouTube sync suite) so videos "play" without the real YouTube
YT = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'youtube_sync_test.py')).read().split('INIT = r"""')[1].split('"""')[0]
errors = []


def toasts(pg):
    return pg.evaluate("[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')")


def video_id(pg):
    return pg.evaluate("window.__yt && window.__yt.o && window.__yt.o.videoId")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    pages = []
    for _ in range(2):
        pg = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
        pg.add_init_script(YT)
        pg.add_init_script("window.__chan = []; const __OPC = window.RTCPeerConnection; window.RTCPeerConnection = class extends __OPC { constructor(...a) { super(...a); this.addEventListener('datachannel', (e) => window.__chan.push(e.channel)); } createDataChannel(...a) { const c = super.createDataChannel(...a); window.__chan.push(c); return c; } };")
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
        pages.append(pg)
    host, guest = pages
    host.goto(BASE); host.wait_for_timeout(1500)
    host.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    host.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    guest.goto(f'{BASE}?room={room}'); guest.wait_for_timeout(1200); guest.get_by_role('button', name='Join Room').click()
    check('two people connected', wait(lambda: guest.locator('.stage-voice-chip').count() >= 2 and host.locator('.stage-voice-chip').count() >= 2, 20))
    time.sleep(1)

    # reactions
    host.locator('.stage-more-wrap .circle-action-btn').click()
    host.locator('.dropdown-react-btn').first.click()
    check('a reaction shows up for the other person', wait(lambda: guest.locator('.floating-reaction-item').count() > 0, 5))
    check('...with the sender name on the first one', wait(lambda: guest.locator('.floating-reaction-item .reaction-sender-tag').count() > 0, 3))

    # spam: hold "3" for 2 seconds (the key auto-repeats ~30 times a second)
    host.keyboard.press('Escape'); time.sleep(2.5)
    guest.evaluate("""() => { window.__rx = 0; window.__maxItems = 0;
        const t = setInterval(() => { window.__maxItems = Math.max(window.__maxItems, document.querySelectorAll('.floating-reaction-item').length); }, 50);
        window.__stopCount = () => clearInterval(t); }""")
    host.evaluate("""() => { window.__sentReactions = 0; const o = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (d) { if (typeof d === 'string' && d.includes('"type":"reaction"')) window.__sentReactions++; return o.call(this, d); }; }""")
    for _ in range(60):
        host.keyboard.down('3'); time.sleep(0.033)
    host.keyboard.up('3')
    time.sleep(0.6)
    sent = host.evaluate('window.__sentReactions')
    check('holding a key sends ~8 a second, not 30 (2 s held)', 8 <= sent <= 22, sent)
    check('the combo counter shows for the other person', wait(lambda: guest.locator('.floating-reaction-combo').count() >= 1, 3))
    combo_text = guest.locator('.floating-reaction-combo').inner_text() if guest.locator('.floating-reaction-combo').count() else ''
    check('...counting up (x10 or more)', bool(re.search(r'×(\d+)', combo_text)) and int(re.search(r'×(\d+)', combo_text).group(1)) >= 10, combo_text)
    max_items = guest.evaluate('window.__stopCount(), window.__maxItems')
    check('on screen it stays capped', 0 < max_items <= 30, max_items)
    # a flood from a modified app: 200 messages at once are cut down by the receiver
    host.evaluate("""() => { for (const c of window.__chan || []) if (c.label.startsWith('chat') && c.readyState === 'open')
        for (let i = 0; i < 200; i++) c.send(JSON.stringify({ type: 'reaction', id: 'x' + i, emoji: '🎉', lane: 50, sender: 'Flood' })); }""")
    time.sleep(0.5)
    flood_items = guest.evaluate("document.querySelectorAll('.floating-reaction-item').length")
    check('a flood of 200 at once shows only a handful', flood_items <= 30, flood_items)
    check('the app is still responsive after the flood', guest.evaluate('1 + 1') == 2 and guest.locator('.stage-voice-chip').count() >= 2)

    # soundboard
    host.locator('.stage-soundboard-wrap .circle-action-btn').click()
    host.locator('.sfx-card').first.click()
    check('a soundboard clip shows its banner for the other person', wait(lambda: guest.locator('.stage-soundboard-hud').count() == 1, 5))
    check('...and is noted in their log', wait(lambda: 'played soundboard clip' in guest.evaluate("document.body.innerText") or 'played' in toasts(guest), 3), toasts(guest)[:80])
    host.keyboard.press('Escape')

    # ping (Network HUD): answered over the data channel
    host.locator('.stage-more-wrap .circle-action-btn').click()
    host.locator('.stage-more-dropdown .dropdown-item', has_text='Network HUD').click()
    host.locator('.btn-trigger-ping').click()
    check('ping gets an answer (RTT shown)', wait(lambda: host.locator('.stat-main-value').first.inner_text().strip().isdigit(), 8), host.locator('.stat-main-value').first.inner_text())
    host.keyboard.press('Escape'); host.wait_for_timeout(300)
    if host.locator('.network-diagnostics-modal, .hud-modal').count():
        host.mouse.click(5, 5)

    # vote to skip: with two people one vote is enough
    host.get_by_placeholder(re.compile('Paste YouTube link')).first.fill('https://youtu.be/aqz-KE-bpKQ')
    host.get_by_role('button', name=re.compile('Load for All')).click()
    check('a video loads for both', wait(lambda: video_id(host) == 'aqz-KE-bpKQ' and video_id(guest) == 'aqz-KE-bpKQ', 10))
    host.evaluate("document.querySelector('.yt-sync-wrapper')")
    guest.locator('.vote-skip-btn').first.click()
    check('vote to skip with nothing queued closes the video for both', wait(lambda: host.locator('.yt-fullstage-player').count() == 0 and guest.locator('.yt-fullstage-player').count() == 0, 8))

    # leaving resets what the room had
    host.get_by_placeholder(re.compile('Paste YouTube link')).first.fill('https://youtu.be/aqz-KE-bpKQ')
    host.get_by_role('button', name=re.compile('Load for All')).click()
    wait(lambda: video_id(guest) == 'aqz-KE-bpKQ', 10)
    guest.get_by_role('button', name=re.compile('Leave', re.I)).first.click()
    check('after leaving: back on the start screen, no video', wait(lambda: guest.locator('.stage-overlay .initial-actions').count() == 1 and guest.locator('.yt-fullstage-player').count() == 0, 8))
    check('the host sees them go', wait(lambda: host.locator('.stage-voice-chip').count() == 1, 10), host.locator('.stage-voice-chip').count())
    guest.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    guest.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    check('a new room starts clean (no video, no queue)', wait(lambda: guest.locator('.stage-voice-chip').count() == 1, 10) and guest.locator('.yt-fullstage-player').count() == 0)
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
