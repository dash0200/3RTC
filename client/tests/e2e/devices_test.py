"""Choosing the microphone and the speaker (like Discord): the quick menu next to the mic button
and the Devices section in Audio settings; the chosen mic is used when the mic opens and switched
live; voices, videos and new media play through the chosen speaker; the choice is remembered."""
import os, re, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.signaling()) + r"""
window.__gum = [];
const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = (c) => { window.__gum.push(JSON.stringify(c || {})); return origGum(c); };
"""
errors = []


def options(pg, sel):
    return pg.evaluate(f"[...document.querySelectorAll('{sel} option')].map(o => [o.value, o.textContent])")


def last_mic_device(pg):
    calls = [json.loads(c) for c in pg.evaluate('window.__gum')]
    calls = [c for c in calls if isinstance(c.get('audio'), dict) and 'echoCancellation' in c['audio'] and 'deviceId' not in str(c['audio'].get('deviceId', {}).get('exact', ''))]
    if not calls:
        return None
    return (calls[-1]['audio'].get('deviceId') or {}).get('ideal', '')


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    pages = []
    for name in ('Hosty', 'Guesty'):
        pg = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
        pg.add_init_script(INIT + f"localStorage.setItem('webrtc_username', '{name}');")
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
        pages.append(pg)
    host, guest = pages
    host.goto(BASE)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 15)
    guest.goto(f'{BASE}/?room={room}')
    guest.get_by_role('button', name=re.compile('Join Room', re.I)).click()
    check('both in the room', wait(lambda: host.locator('audio[id^="remote-audio-"]').count() >= 1, 25))

    # Quick menu next to the mic button
    host.locator('.dock-mic-caret').click()
    check('the device menu opens', wait(lambda: host.locator('.dock-pop-devices').count() == 1, 3))
    ins = options(host, '.dock-pop-devices select[aria-label^="Input"]')
    outs = options(host, '.dock-pop-devices select[aria-label^="Output"]')
    check('it lists the microphones (default first)', len(ins) == 3 and ins[0][0] == '' and 'Fake Audio Input 2' in [t for _, t in ins], ins)
    check('it lists the speakers', len(outs) == 3 and 'Fake Audio Output 2' in [t for _, t in outs], outs)
    in2 = next(v for v, t in ins if t == 'Fake Audio Input 2')
    in1 = next(v for v, t in ins if t == 'Fake Audio Input 1')
    out2 = next(v for v, t in outs if t == 'Fake Audio Output 2')

    host.select_option('.dock-pop-devices select[aria-label^="Input"]', in2)
    host.keyboard.press('Escape')
    check('Escape closes the menu', wait(lambda: host.locator('.dock-pop-devices').count() == 0, 3))
    host.locator('.header-ctrl-pill', has_text='Mic Off').click()
    check('the mic opens on the chosen microphone', wait(lambda: last_mic_device(host) == in2, 8), last_mic_device(host))

    host.locator('.dock-mic-caret').click()
    host.select_option('.dock-pop-devices select[aria-label^="Input"]', in1)
    check('switching while live reopens the mic on the new one', wait(lambda: last_mic_device(host) == in1, 8), last_mic_device(host))
    check('the mic stays on', wait(lambda: host.locator('.header-ctrl-pill', has_text='Mic Live').count() == 1, 5))

    host.select_option('.dock-pop-devices select[aria-label^="Output"]', out2)
    sink = "[...document.querySelectorAll('audio[id^=\"remote-audio-\"]')].map(a => a.sinkId)"
    check('voices play through the chosen speaker', wait(lambda: host.evaluate(sink) == [out2], 5), host.evaluate(sink))
    later = host.evaluate("(async () => { const v = document.createElement('video'); document.body.appendChild(v); await new Promise(r => setTimeout(r, 300)); const id = v.sinkId; v.remove(); return id; })()")
    check('a video added later plays there too', later == out2, later)
    saved = json.loads(host.evaluate("localStorage.getItem('3rtc_audio_settings')"))
    check('the choice is remembered', saved.get('inputDeviceId') == in1 and saved.get('outputDeviceId') == out2, saved)
    host.screenshot(path=str(harness.OUT / 'devices_menu.png'))

    # Audio settings: Devices section, mic level while live
    host.locator('.header-devices-more').click()
    check('Audio settings has the devices', wait(lambda: host.locator('.audio-settings-modal-card .audio-device-picker').count() == 1, 3))
    check('...with the live mic level', host.locator('.audio-settings-modal-card .audio-device-meter').count() == 1)
    host.screenshot(path=str(harness.OUT / 'devices_settings.png'))
    host.locator('.modal-close-btn').first.click()

    # The guest tests a mic before turning it on
    guest.evaluate("document.querySelector('.dock-mic-caret') && document.querySelector('.dock-mic-caret').click()")
    guest.locator('.header-devices-more').click()
    guest.locator('.audio-device-test-btn', has_text='Test mic').click()
    fill = "parseFloat(document.querySelector('.audio-settings-modal-card .audio-device-meter-fill').style.width)"
    check('Test mic shows the level before joining the call', wait(lambda: guest.evaluate(fill) > 0, 6), guest.evaluate(fill))
    guest.locator('.audio-device-test-btn', has_text='Stop test').click()

    # After a reload the speaker is still the chosen one
    host.reload()
    host.wait_for_timeout(1500)
    # (the browser may give devices new ids after a reload: the name finds the speaker again)
    later = host.evaluate("""(async () => { const a = document.createElement('audio'); document.body.appendChild(a);
        await new Promise(r => setTimeout(r, 600)); const d = await navigator.mediaDevices.enumerateDevices();
        return (d.find(x => x.deviceId === a.sinkId) || {}).label || a.sinkId; })()""")
    check('after a reload, sound still goes to the chosen speaker', later == 'Fake Audio Output 2', later)
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
