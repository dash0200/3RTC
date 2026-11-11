"""Takes the reference screenshots the desktop app's UI is built to match
(desktop/docs/ui-reference/*.png): every screen, panel tab, popover, dialog and game of the web
app at 1440x900. Run after any web UI change: `python client-ts/tests/e2e/capture_ui_reference.py`.
Each shot is best-effort: a step that fails is reported and the rest still run."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = harness.REPO / 'desktop' / 'docs' / 'ui-reference'
OUT.mkdir(parents=True, exist_ok=True)
BASE = harness.dev()
SIGNAL = harness.signaling()
failed = []


def shot(pg, name):
    pg.wait_for_timeout(500)
    pg.screenshot(path=str(OUT / f'{name}.png'))
    print('shot', name)


def step(name, fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        failed.append(name)
        print('FAILED', name, str(e).splitlines()[0][:160])


def close_pop(pg):
    pg.keyboard.press('Escape'); pg.mouse.click(540, 300); pg.wait_for_timeout(300)


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    size = {'width': 1440, 'height': 900}
    host = b.new_context(viewport=size).new_page()
    host.set_default_timeout(6000)
    host.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT)
    host.goto(BASE); host.wait_for_timeout(2500)
    shot(host, '01-home')
    step('home-server-settings', lambda: (host.get_by_text('Server settings').first.click(), shot(host, '01b-home-server-settings'), host.keyboard.press('Escape')))
    host.evaluate("localStorage.setItem('webrtc_username', 'Darshan')")
    host.reload(); host.wait_for_timeout(1500)
    shot(host, '01c-home-named')
    harness.create_room(host)
    wait(lambda: any(m.get('type') == 'room-created' for m in host.evaluate('window.__sig')), 10)
    room = next(m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created')
    host.wait_for_timeout(2500)
    shot(host, '02-room-alone-invite-tab')

    # a friend joins by link: the pre-join screen, then two people in the room
    guest = b.new_context(viewport=size).new_page()
    guest.set_default_timeout(6000)
    guest.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT)
    guest.goto(f'{BASE}/?room={room}'); guest.wait_for_timeout(2500)
    shot(guest, '03-invite-link-screen')

    def guest_in():
        guest.get_by_role('textbox').first.fill('Riya')
        guest.get_by_role('button', name='Join room').click()
        guest.wait_for_timeout(1500)
        wait(lambda: host.evaluate("window.__pcs.some(pc => pc.connectionState === 'connected')"), 20)
    step('guest-joins', guest_in)
    host.wait_for_timeout(2500)
    shot(host, '04-room-two-people')

    for tab in ('Chat', 'Queue', 'People', 'Logs'):  # the Invite tab shows only while you're alone (02)
        def open_tab(tab=tab):
            host.get_by_role('tab', name=re.compile(f'^{tab}')).first.click()
            if tab == 'Chat':
                box = host.get_by_placeholder(re.compile('Message', re.I)).first
                box.fill('This scene is so good'); box.press('Enter')
                g = guest.get_by_placeholder(re.compile('Message', re.I)).first
                if g.count():
                    g.fill('wait, rewind 10s'); g.press('Enter')
                host.wait_for_timeout(800)
            shot(host, f'05-panel-{tab.lower()}')
        step(f'panel-{tab}', open_tab)

    pops = [('Choose microphone and speaker', '06-dock-devices'), ('Reactions', '06-dock-reactions'),
            ('Soundboard', '06-dock-soundboard'), ('Games', '06-dock-games-menu'), ('More options', '06-dock-more-menu')]
    for label, name in pops:
        step(name, lambda label=label, name=name: (host.get_by_role('button', name=label, exact=True).click(), shot(host, name), close_pop(host)))
    step('add-video', lambda: (host.get_by_role('button', name='Add a video', exact=True).click(), shot(host, '07-add-video-sheet'), close_pop(host)))
    step('hide-panel', lambda: (host.get_by_role('button', name=re.compile('Hide side panel')).click(), shot(host, '08-room-panel-hidden'),
                                host.get_by_role('button', name=re.compile('Open chat and queue panel')).click()))
    step('network', lambda: (host.locator('.rh-conn').click(), shot(host, '09-connection-details'), close_pop(host)))

    def more_items():
        host.get_by_role('button', name='More options', exact=True).click()
        items = host.locator('.dock-menu [role^=menuitem]').all_inner_texts()
        print('MORE MENU:', items)
        close_pop(host)
        for i, text in enumerate(items):
            label = text.strip().splitlines()[0]
            if re.search('control playback|Leave|End', label):
                continue
            def one(label=label, i=i):
                host.get_by_role('button', name='More options', exact=True).click()
                host.locator('.dock-menu [role^=menuitem]').nth(i).click()
                shot(host, f'11-more-{i}-{re.sub("[^a-z0-9]+", "-", label.lower())[:30]}')
                close_pop(host); close_pop(host)
            step(f'more-{label}', one)
    step('more-items', more_items)

    for game in ('Ludo', 'Chess', 'Last Card', 'Tycoon', 'Whiteboard'):
        def play(game=game):
            harness.open_activity(host, game); host.wait_for_timeout(2000)
            slug = game.lower().replace(' ', '-')
            shot(host, f'12-game-{slug}-lobby')
            for label in ('Join the game', 'Play'):
                btn = host.locator('.stage-activity').get_by_role('button', name=re.compile(f'^{label}$'))
                if btn.count():
                    btn.first.click(); break
            comp = host.locator('.stage-activity').get_by_role('button', name=re.compile(r'^\+ Computer'))
            if comp.count():
                comp.first.click()
            start = host.locator('.stage-activity').get_by_role('button', name=re.compile('^Start'))
            if start.count() and start.first.is_enabled():
                start.first.click()
            host.wait_for_timeout(2500)
            shot(host, f'12-game-{slug}-playing')
            shot(guest, f'12-game-{slug}-as-guest')
            harness.end_game(host); host.wait_for_timeout(800)
        step(f'game-{game}', play)

    step('leave', lambda: (host.get_by_role('button', name=re.compile('^Leave')).first.click(), shot(host, '13-leave-dialog'), close_pop(host)))
    b.close()
print('failed:', failed or 'none')
