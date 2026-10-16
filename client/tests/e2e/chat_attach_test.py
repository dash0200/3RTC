"""Chat (desktop and phone): sending an image; web links in messages open in a new tab and text can be selected and copied."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
harness.dev()
harness.signaling()
import re, time
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'connection_test.py')).read().split("results = []")[0].split('import harness')[1].split('\n', 1)[1])
ok_all = []
def check(name, ok, detail=''):
    ok_all.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    for vp, tag in (({'width': 1400, 'height': 900}, 'desk'), ({'width': 390, 'height': 844}, 'mob')):
        host = b.new_context(viewport=vp).new_page(); guest = b.new_context(viewport=vp).new_page()
        for pg in (host, guest):
            pg.add_init_script(INIT); pg.on('dialog', lambda d: d.accept())
        host.goto('http://localhost:5199/'); host.wait_for_timeout(1500)
        if tag == 'mob':
            host.get_by_role('button', name='Create a room').click()
        else:
            harness.create_room(host)
        room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None))
        guest.goto(f'http://localhost:5199/?room={room}'); guest.wait_for_timeout(1500)
        if tag == 'mob':
            guest.get_by_role('button', name='Join room').click()
        else:
            guest.get_by_role('button', name='Join Room').evaluate('(el) => el.click()')
        wait(lambda: 'Direct P2P' in host.content() or host.locator('.phone-status-pill.ok').count() == 1, 15); time.sleep(1.5)
        btn = guest.locator('.chat-pill-attach-btn')
        check(f'{tag}: attach button visible', btn.is_visible())
        with guest.expect_file_chooser() as fc:
            btn.click()
        fc.value.set_files(harness.media('photo.jpg'))
        check(f'{tag}: picked image shows as pending', wait(lambda: guest.locator('.chat-pending-image-card').count() > 0, 5))
        guest.wait_for_timeout(300); guest.screenshot(path=str(harness.OUT) + f'/attach_{tag}_pending.png')
        send = guest.locator('.chat-pill-send-btn')
        check(f'{tag}: send enabled with image and no caption', send.is_enabled())
        send.click()
        got = wait(lambda: host.locator('img.chat-image-thumb').count() > 0, 15)
        check(f'{tag}: host received the image', got)
        host.wait_for_timeout(500); host.screenshot(path=str(harness.OUT) + f'/attach_{tag}_received.png')
        # Links and selectable text
        guest.get_by_placeholder(re.compile('Message the room|Type a message')).first.fill('watch this https://example.com/clip?t=1, at 1:05 ok')
        guest.keyboard.press('Enter')
        link = host.locator('a.chat-link')
        check(f'{tag}: a web link in a message is a link', wait(lambda: link.count() == 1, 10) and link.get_attribute('href') == 'https://example.com/clip?t=1',
              link.get_attribute('href') if link.count() else None)
        check(f'{tag}: it opens in a new tab, safely', link.get_attribute('target') == '_blank' and 'noopener' in (link.get_attribute('rel') or ''))
        text = host.locator('.cm-text', has_text='watch this')
        check(f'{tag}: message text can be selected', text.evaluate('(el) => getComputedStyle(el).userSelect') == 'text')
        text.click(click_count=3)
        sel = host.evaluate('getSelection().toString()')
        check(f'{tag}: selecting it gives the text (to copy)', 'watch this' in sel and 'example.com' in sel, sel)
        if tag == 'desk':
            host.context.route('https://example.com/**', lambda r: r.fulfill(status=200, content_type='text/html', body='<title>clip</title>ok'))
            with host.context.expect_page(timeout=5000) as newpg:
                link.click()
            newpg.value.wait_for_load_state()
            check('desk: clicking the link opens it in a new tab', 'example.com' in newpg.value.url and 'room=' in host.url, newpg.value.url)
            newpg.value.close()
        host.context.close(); guest.context.close()
    b.close()
print(f'{sum(ok_all)}/{len(ok_all)} passed')
