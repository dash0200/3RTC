"""Streaming a film whose bitrate isn't even (a heavy first half): it must play straight through.
The app used to hold the player's reads back using a guess of where playback is in the file
(time x average bitrate); in heavy scenes the real position is further on, so the player waited
on a read the app held, and the video froze for good after a few seconds."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.preview()
INIT = harness.signal_init(harness.signaling())
VID = "document.querySelector('video')"

with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    host, guest = (b.new_context().new_page() for _ in range(2))
    for pg in (host, guest):
        pg.add_init_script(INIT); pg.on('dialog', lambda d: d.accept())
        pg.goto(BASE + '/')
        if not wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10):
            pg.reload(); wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    guest.goto(f'{BASE}/?room={room}'); time.sleep(1.5); guest.get_by_role('button', name='Join Room').click()
    check('peers connected', wait(lambda: harness.people(host) >= 2, 25))
    time.sleep(1.5)

    host.locator('input[accept*=".mp4"]').first.set_input_files(harness.media('uneven.mp4'))
    btn = guest.get_by_role('button', name=re.compile('Stream from'))
    check('guest offered the stream', wait(lambda: btn.count() > 0, 15))
    btn.first.click()
    check('guest video ready', wait(lambda: guest.evaluate(f"({VID} || {{}}).readyState >= 3"), 20, 0.1))
    host.evaluate(f"{VID}.muted = true; {VID}.play()")

    # Through the heavy half and into the calm one: 40 s of playing
    samples = []
    for _ in range(8):
        time.sleep(5)
        samples.append(round(guest.evaluate(f"{VID}.currentTime"), 1))
    host_t = host.evaluate(f"{VID}.currentTime")
    check('plays straight through the heavy scenes (old code: froze for good after a few seconds)',
          samples[-1] > 30 and all(b > a for a, b in zip(samples, samples[1:])),
          f'guest positions every 5 s: {samples}, host at {host_t:.1f}')
    b.close()

harness.summary()
