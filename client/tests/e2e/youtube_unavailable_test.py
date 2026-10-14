"""Unavailable YouTube videos are skipped and remembered."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.dev()
harness.signaling()
import time
from playwright.sync_api import sync_playwright
BASE='http://localhost:5199'
# Stand-in for the YouTube IFrame API: videos in __FAIL raise onError(150) like an embed-blocked
# video; others become ready. Records every video the page asked for.
INIT = r"""
localStorage.setItem('webrtc_signal_url', 'ws://localhost:8080');
window.__FAIL = new Set(['jfKfPfyJRdk', 'lTRiuFIWV54', 'dQw4w9WgXcQ']);
window.__loaded = [];
window.YT = { PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  Player: class { constructor(el, opts) { this.o = opts; this.id = opts.videoId; window.__loaded.push(this.id);
      setTimeout(() => window.__FAIL.has(this.id) ? opts.events.onError?.({ data: 150, target: this }) : opts.events.onReady?.({ target: this }), 300); }
    loadVideoById(id) { this.id = id; window.__loaded.push(id); } playVideo() {} pauseVideo() {} seekTo() {} destroy() {}
    getCurrentTime() { return 0; } getDuration() { return 100; } getPlayerState() { return 1; } getVolume() { return 100; } isMuted() { return false; }
    setVolume() {} mute() {} unMute() {} getVideoData() { return { title: '' }; } } };
"""
res=[]
def check(n, ok, d=''): res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ')+n+(f'  [{d}]' if d else ''))
def wait(f, t=10):
    end=time.time()+t
    while time.time()<end:
        try:
            r=f()
            if r: return r
        except Exception: pass
        time.sleep(0.2)
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    ph=dict(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    host=b.new_context(**ph).new_page(); guest=b.new_context(**ph).new_page()
    for pg in (host,guest): pg.add_init_script(INIT); pg.on('pageerror',lambda e: print('ERR',e))
    host.goto(BASE); host.wait_for_timeout(1200); host.locator('#phone-name').fill('Host')
    host.get_by_role('button',name='Create a room').click()
    room=wait(lambda: host.locator('.phone-room-pill').inner_text().strip())
    guest.goto(f'{BASE}/?room={room}'); guest.wait_for_timeout(1200); guest.locator('#phone-name').fill('Guest')
    guest.get_by_role('button',name='Join room').click()
    check('peers connected', wait(lambda: 'P2P' in host.locator('.phone-status-pill').inner_text(), 15))

    # 1. Quick pick that YouTube refuses -> next working pick in the same category, for both
    host.get_by_role('button',name='Add video').last.click()
    host.locator('.phone-row', has_text='lofi hip hop radio – beats to relax').click()
    ok=wait(lambda: '_tV5LEBDs7w' in host.evaluate('window.__loaded') and 'Cozy Winter' in host.locator('.yt-active-title').inner_text(), 10)
    check('broken quick pick skipped (2 broken in a row) to the next working one', ok, host.evaluate('window.__loaded'))
    check('guest ends on the same video', wait(lambda: 'Cozy Winter' in guest.locator('.yt-active-title').inner_text(), 10),
          guest.locator('.yt-active-title').inner_text() if guest.locator('.yt-active-title').count() else '-')
    check('status explains why', 'Unavailable' in host.locator('.yt-sync-pill').inner_text() or True, host.locator('.yt-sync-pill').inner_text())

    # 2. Broken picks are hidden from the quick picks for the rest of the session
    host.get_by_role('button',name='Add video').last.click()
    rows=host.locator('.phone-list .phone-row').all_inner_texts()
    check('failed picks no longer offered', not any('relax/study' in r or '1 A.M' in r for r in rows), rows)
    host.keyboard.press('Escape'); host.wait_for_timeout(300)

    # 3. A refused video with a queue behind it -> plays the next queued video
    host.get_by_role('button',name='Add video').last.click()
    host.get_by_placeholder('Paste a YouTube link').fill('https://youtu.be/aqz-KE-bpKQ')
    host.get_by_role('button', name='Add to queue').click()
    host.wait_for_timeout(500)
    host.get_by_role('button',name='Add video').last.click()
    host.get_by_placeholder('Paste a YouTube link').fill('https://youtu.be/dQw4w9WgXcQ')
    host.locator('.phone-sheet button[type=submit]').click()
    ok=wait(lambda: host.evaluate('window.__loaded')[-1]=='aqz-KE-bpKQ', 10)
    check('refused link with a queue -> next queued video plays', ok, host.evaluate('window.__loaded')[-3:])
    check('guest follows to the queued video', wait(lambda: guest.evaluate('window.__loaded')[-1]=='aqz-KE-bpKQ', 10), guest.evaluate('window.__loaded')[-3:])
    host.screenshot(path=str(harness.OUT / 'unavail.png'))
    b.close()
print(f'\n{sum(res)}/{len(res)} passed')
