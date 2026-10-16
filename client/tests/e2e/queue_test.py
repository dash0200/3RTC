"""Quick Watch queue buttons, Play queue, the browse window, phone sheet."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.dev()
harness.quickpicks()
import re, time
from playwright.sync_api import sync_playwright
res=[]
def check(n, ok, d=''): res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ')+n+(f'  [{d}]' if d else ''), flush=True)
INIT = "localStorage.setItem('webrtc_signal_url','ws://localhost:8091');localStorage.removeItem('3rtc_quick_picks');window.__sig=[];const O=window.WebSocket;window.WebSocket=class extends O{constructor(...a){super(...a);this.addEventListener('message',e=>{try{window.__sig.push(JSON.parse(e.data))}catch{}})}};"
def queue_titles(pg):
    pg.locator('.chat-tab-btn', has_text='Queue').first.click(); pg.wait_for_timeout(300)
    t = pg.locator('.queue-panel-wrapper').inner_text(); return t
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    host=b.new_context(viewport={'width':1440,'height':900}).new_page(); guest=b.new_context(viewport={'width':1440,'height':900}).new_page()
    for pg in (host,guest): pg.add_init_script(INIT); pg.on('pageerror', lambda e: print('ERR', e))
    host.goto('http://localhost:5199/'); host.wait_for_timeout(1500)
    harness.create_room(host)
    room=None
    for _ in range(20):
        room=next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type')=='room-created'), None)
        if room: break
        time.sleep(0.3)
    guest.goto(f'http://localhost:5199/?room={room}'); guest.wait_for_timeout(1200); guest.get_by_role('button', name='Join Room').click()
    host.wait_for_selector('.qp-card'); time.sleep(3)
    host.locator('.qp-group', has_text='Music').click(); host.wait_for_timeout(300)
    cards=host.locator('.qp-card')
    t1=cards.nth(0).locator('.qp-title').inner_text(); t2=cards.nth(1).locator('.qp-title').inner_text()
    for i in (0,1):
        cards.nth(i).hover(); cards.nth(i).locator('.qp-queue').click(); host.wait_for_timeout(500)
    check('queuing from Quick Watch does not start a video', host.locator('.yt-fullstage-player').count()==0 and host.locator('.qp-card').count()>0)
    check('queued cards show "Queued"', host.locator('.qp-card.is-queued').count()==2, host.locator('.qp-card.is-queued .qp-queue').all_inner_texts())
    check('"Play queue (2)" appears', host.locator('.qp-play-queue').inner_text().strip()=='Play queue (2)', host.locator('.qp-play-queue').inner_text())
    host.screenshot(path=str(harness.OUT / 'queue-start.png'))
    gq=queue_titles(guest)
    check('the other person sees both queued videos', t1[:25] in gq and t2[:25] in gq)
    host.locator('.qp-play-queue').click()
    ok=host.wait_for_selector('.yt-fullstage-player', timeout=8000)
    check('"Play queue" starts the first queued video', ok and t1[:20] in host.locator('.yt-active-title').inner_text(), host.locator('.yt-active-title').inner_text()[:40])
    # while playing: Queue tab -> Browse Quick Watch
    queue_titles(host)
    host.get_by_role('button', name='Browse Quick Watch').click(); host.wait_for_selector('.qp-modal')
    host.locator('.qp-modal .qp-group', has_text='Relax').click(); host.wait_for_timeout(300)
    t3=host.locator('.qp-modal .qp-card').nth(0).locator('.qp-title').inner_text()
    host.locator('.qp-modal .qp-card').nth(0).locator('.qp-card-play').click(); host.wait_for_timeout(600)
    check('in the window, clicking a video adds it to the queue', host.locator('.qp-modal .qp-card.is-queued').count()==1)
    host.screenshot(path=str(harness.OUT / 'queue-modal.png'))
    host.keyboard.press('Escape'); host.wait_for_timeout(300)
    q=host.locator('.queue-panel-wrapper').inner_text()
    check('window closes with Esc; queue now has the second + new video', host.locator('.qp-modal').count()==0 and t2[:20] in q and t3[:20] in q)
    check('current video kept playing', t1[:20] in host.locator('.yt-active-title').inner_text())
    # phone
    m=b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=2).new_page(); m.add_init_script(INIT)
    m.goto('http://localhost:5199/'); m.wait_for_timeout(1500); m.get_by_role('button',name='Create a room').click(); m.wait_for_selector('.phone-actionbar')
    m.get_by_role('button',name='Add video').last.click(); m.wait_for_timeout(500)
    m.locator('.phone-pick-queue').nth(0).click(); m.wait_for_timeout(400); m.locator('.phone-pick-queue').nth(1).click(); m.wait_for_timeout(400)
    check('phone: queuing does not start a video', m.locator('.stage-phone video, .yt-fullstage-player').count()==0)
    check('phone: queued rows show a check and "Play queue (2)" appears', m.locator('.phone-pick-queue.is-queued').count()==2 and 'Play queue (2)' in m.locator('.phone-play-queue').inner_text())
    m.screenshot(path=str(harness.OUT / 'queue-phone.png'))
    m.locator('.phone-play-queue').click()
    check('phone: Play queue starts it and closes the sheet', m.wait_for_selector('.yt-fullstage-player', timeout=8000) is not None and m.locator('.phone-sheet').count()==0)
    b.close()
print(f'\n{sum(res)}/{len(res)} passed')
