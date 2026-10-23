"""The host hands the room to someone else: only the host can, a second tap confirms, everyone sees
the new host, host controls move with it, and after reopening the app the old host is a guest while
the new host gets the room back as host."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
SIGNAL = harness.signaling()
errors = []


def page(b, name, phone=False):
    ctx = b.new_context(viewport={'width': 390, 'height': 844} if phone else {'width': 1440, 'height': 900},
                        is_mobile=phone, has_touch=phone)
    pg = ctx.new_page()
    pg.add_init_script(harness.signal_init(SIGNAL) + f"localStorage.setItem('webrtc_username', '{name}');")
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('dialog', lambda d: d.accept())
    return pg


def people_tab(pg):
    pg.locator('.chat-tab-btn', has_text='People').first.click()
    pg.wait_for_timeout(300)


def host_badges(pg):
    """Names shown with a HOST tag in this page's People tab (others' cards)."""
    return pg.evaluate("[...document.querySelectorAll('.voice-user-card.peer-card')].filter(c => c.querySelector('.host-tag')).map(c => c.querySelector('.card-username').innerText)")


def make_host_buttons(pg):
    return pg.locator('.card-make-host-btn').count()


def toasts(pg):
    return pg.evaluate("window.__toasts || []")


TOASTS = "window.__toasts=[];new MutationObserver(()=>{const t=document.querySelector('.toast');if(t&&window.__toasts[window.__toasts.length-1]!==t.innerText)window.__toasts.push(t.innerText)}).observe(document,{subtree:true,childList:true,characterData:true});"

with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    priya, arjun, meera = page(b, 'Priya'), page(b, 'Arjun'), page(b, 'Meera', phone=True)
    for pg in (priya, arjun, meera):
        pg.add_init_script(TOASTS)
    priya.goto(BASE); priya.wait_for_timeout(1500)
    harness.create_room(priya)
    room = wait(lambda: next((m['roomId'] for m in priya.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    for pg in (arjun, meera):
        pg.goto(f'{BASE}?room={room}'); pg.wait_for_timeout(1200)
        pg.get_by_role('button', name=re.compile(r'^Join room$', re.I)).first.click()
    check('three people connected', wait(lambda: all(harness.people(pg) >= 3 for pg in (priya, arjun, meera)), 30))
    for pg in (priya, arjun, meera):
        people_tab(pg)

    check('the host sees "Make host" on each other person', wait(lambda: make_host_buttons(priya) == 2, 5), make_host_buttons(priya))
    check('guests see no "Make host"', make_host_buttons(arjun) == 0 and make_host_buttons(meera) == 0)
    check('everyone sees Priya as the host', wait(lambda: host_badges(arjun) == ['Priya'] and 'Priya' in host_badges(meera), 5), [host_badges(arjun), host_badges(meera)])

    # One tap asks; it changes nothing yet
    card = priya.locator('.voice-user-card.peer-card', has_text='Arjun')
    card.locator('.card-make-host-btn').click()
    check('first tap asks to confirm', 'Make Arjun host?' in card.locator('.card-make-host-btn').inner_text(), card.locator('.card-make-host-btn').inner_text())
    time.sleep(0.8)
    check('...and changes nothing yet', host_badges(arjun) == ['Priya'])
    card.locator('.card-make-host-btn').click()

    check('Arjun is the host for everyone', wait(lambda: host_badges(priya) == ['Arjun'] and host_badges(meera) == ['Arjun'], 6), [host_badges(priya), host_badges(meera)])
    check('...and Arjun sees no host but himself among the others', host_badges(arjun) == [], host_badges(arjun))
    check('Arjun is told', wait(lambda: any('Priya made you the host' in t for t in toasts(arjun)), 4), toasts(arjun))
    check('Priya is told', any('Arjun is now the host' in t for t in toasts(priya)), toasts(priya))
    check('Meera is told', any('Priya made Arjun the host' in t for t in toasts(meera)), toasts(meera))
    check('now Arjun can make someone host, Priya cannot', wait(lambda: make_host_buttons(arjun) == 2 and make_host_buttons(priya) == 0, 5),
          [make_host_buttons(arjun), make_host_buttons(priya)])

    # Host controls follow: Arjun can lock playback, Priya no longer can
    priya.get_by_role('button', name='More options').click()
    check("Priya's menu has no host controls any more", priya.get_by_role('menuitemcheckbox', name=re.compile('Only I control playback')).count() == 0)
    priya.keyboard.press('Escape')
    harness.toggle_playback_lock(arjun)
    check("Arjun turns on host controls; Priya and Meera are locked", wait(lambda: priya.locator('.rh-lock').count() == 1 and meera.locator('.rh-lock, .phone-lock, [class*=lock]').count() >= 1, 6))
    harness.toggle_playback_lock(arjun)
    wait(lambda: priya.locator('.rh-lock').count() == 0, 6)

    # Reopening the app: the old host comes back as a guest, the new host as the host
    priya.goto(BASE); priya.wait_for_timeout(1500)  # closes the room page and opens the app again
    card = priya.get_by_role('region', name='Rejoin your last room')
    check("Priya's Rejoin card no longer says it's her room", wait(lambda: card.count() == 1, 5) and 'Your room' not in card.inner_text(), card.inner_text() if card.count() else None)
    card.get_by_role('button', name='Rejoin').click()
    check('Priya is back, as a guest', wait(lambda: harness.people(priya) >= 3, 25) and wait(lambda: (people_tab(priya) or True) and host_badges(priya) == ['Arjun'], 8), host_badges(priya))
    check('Priya cannot take the room back with her old token', not any(m.get('type') == 'room-resumed' for m in priya.evaluate('window.__sig')))

    arjun.goto(BASE); arjun.wait_for_timeout(1500)  # closes the room page and opens the app again
    card = arjun.get_by_role('region', name='Rejoin your last room')
    check("Arjun's Rejoin card says it's his room", wait(lambda: card.count() == 1, 5) and 'Your room' in card.inner_text(), card.inner_text() if card.count() else None)
    card.get_by_role('button', name='Rejoin').click()
    check('Arjun gets the room back as host', wait(lambda: any(m.get('type') == 'room-resumed' for m in arjun.evaluate('window.__sig')), 15))
    check('...and everyone sees him as host again', wait(lambda: harness.people(arjun) >= 3 and (people_tab(priya) or True) and host_badges(priya) == ['Arjun']
                                                       and (people_tab(meera) or True) and 'Arjun' in host_badges(meera), 25), [host_badges(priya), host_badges(meera)])

    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
