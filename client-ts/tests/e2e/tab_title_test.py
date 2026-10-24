"""The tab's title says what's going on: who you're with, who's talking, the video, the game and
whose turn it is, messages that came while you were away (with a dot on the tab's icon and a
blinking "your turn"), reconnecting; and the page's own title again outside a room."""
import os, re, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
SIGNAL = harness.signaling()
errors = []
AWAY = "window.__away = (on) => { document.hasFocus = () => !on; window.dispatchEvent(new Event(on ? 'blur' : 'focus')); };"


def title(pg):
    return pg.evaluate('document.title')


def icon(pg):
    return pg.evaluate("document.querySelector('link[rel=\"icon\"]').getAttribute('href')")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    host = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    guest = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    for pg, name in ((host, 'Darshan'), (guest, 'Riya')):
        pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + AWAY + f"localStorage.setItem('webrtc_username', '{name}');")
        pg.on('pageerror', lambda e: errors.append(str(e)))
    host.goto(BASE); host.wait_for_timeout(1200)
    home_title = title(host)
    check('home: the page\'s own title', '3RTC' in home_title and 'Room' not in home_title, home_title)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    check('alone in the room: "waiting for friends"', wait(lambda: title(host) == f'Room {room} · waiting for friends — 3RTC', 5), title(host))

    guest.goto(f'{BASE}?room={room}'); guest.wait_for_timeout(1200)
    guest.get_by_role('button', name=re.compile(r'^Join room$', re.I)).first.click()
    wait(lambda: harness.people(host) >= 2, 25)
    check('with someone: "with Riya"', wait(lambda: title(host) == f'Room {room} · with Riya — 3RTC', 8), title(host))

    # Riya talks (the fake microphone plays a tone)
    harness.mic_button(guest).click()
    check('Riya talks: "🔊 Riya is talking"', wait(lambda: title(host).startswith('🔊 Riya is talking'), 10), title(host))
    harness.mic_button(guest).click()
    check('...and stops: back to the room', wait(lambda: title(host).startswith(f'Room {room}'), 8), title(host))

    # Messages while Darshan is in another window
    host.evaluate('window.__away(true)')
    for text in ('hey', 'are you there?'):
        guest.locator('.chat-pill-textarea').fill(text); guest.locator('.chat-pill-send-btn').click(); time.sleep(0.3)
    check('away: "(2) 💬 Riya: are you there?"', wait(lambda: title(host) == '(2) 💬 Riya: are you there? — 3RTC', 5), title(host))
    check('...and a dot on the tab\'s icon', wait(lambda: icon(host).startswith('data:image/png'), 5), icon(host)[:30])
    host.evaluate('window.__away(false)')
    check('back: the count and the dot go', wait(lambda: title(host).startswith(f'Room {room}') and icon(host) == '/favicon.svg', 5), [title(host), icon(host)[:30]])
    guest.locator('.chat-pill-textarea').fill('here now?'); guest.locator('.chat-pill-send-btn').click()
    time.sleep(1)
    check('messages while you\'re looking aren\'t counted', title(host).startswith(f'Room {room}'), title(host))

    # A game: invite, playing, your turn (blinking while away)
    harness.open_activity(guest, 'Tycoon')
    check('a game Riya started: "🏙️ Riya started Tycoon · join in"', wait(lambda: 'Riya started Tycoon · join in' in title(host), 8), title(host))
    harness.join_activity(host); host.wait_for_timeout(1000)
    check('open here: "Tycoon · Room …"', wait(lambda: f'Tycoon · Room {room}' in title(host), 5), title(host))
    host.get_by_role('button', name='Join the game').first.click(); host.wait_for_timeout(300)
    host.get_by_role('button', name='+ Computer').first.click(); host.wait_for_timeout(300)
    host.evaluate("Math.random = () => 0.01")  # Darshan goes first (the host's app deals the order)
    host.get_by_role('button', name=re.compile(r'^Start')).first.click()
    check('his turn: "🏙️ Roll! · Tycoon"', wait(lambda: 'Roll! · Tycoon' in title(host) or 'End your turn · Tycoon' in title(host), 8), title(host))
    host.evaluate('window.__away(true)')
    seen = set()
    end = time.time() + 4
    while time.time() < end:
        seen.add(title(host)); time.sleep(0.25)
    check('away on his turn: the title blinks "🔔 ROLL!"', any(t.startswith('🔔 ') for t in seen) and any('· Tycoon' in t and not t.startswith('🔔') for t in seen), seen)
    check('...with the dot on the icon', icon(host).startswith('data:image/png'))
    host.evaluate('window.__away(false)')
    check('back: no blinking', wait(lambda: not title(host).startswith('🔔') and icon(host) == '/favicon.svg', 4), title(host))
    harness.end_game(host); host.wait_for_timeout(800)

    # The video
    host.locator('input[type=file]').first.set_input_files(harness.media('test.mp4')) if host.locator('input[type=file]').count() else None
    check('a video: "▶ test.mp4"', wait(lambda: title(host).startswith('▶ test'), 10), title(host))
    exit_btn = host.locator('.exit-video-btn, .link-player-exit')
    if exit_btn.count():
        exit_btn.first.click(); host.wait_for_timeout(500)
        confirm = host.get_by_role('button', name=re.compile('Stop|End|Close', re.I))
        if 'Room' not in title(host) and confirm.count():
            confirm.first.click()

    # The connection drops
    try:
        t = threading.Thread(target=lambda: harness.restart_signaling(down_seconds=5)); t.start()
        check('signaling down: "⚠️ Reconnecting… · Room …"', wait(lambda: title(host).startswith('⚠️ Reconnecting… · Room'), 12), title(host))
        t.join()
        check('...and back', wait(lambda: not title(host).startswith('⚠️'), 20), title(host))
    except RuntimeError as e:
        print('SKIP reconnect check:', e)

    harness.leave_room(host)
    check('left the room: the page\'s own title again', wait(lambda: title(host) == home_title, 8), title(host))
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
