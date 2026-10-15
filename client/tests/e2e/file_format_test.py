"""Local video format check and subtitles inside the file.

- A file whose audio this browser can't play (AC-3): viewers are told "no sound" before they
  stream, and the sharer sees who is affected.
- A file browsers can't play at all (AVI): the sharer is told.
- An MKV with an SRT and an ASS subtitle track: anyone can pick a track; the sharer's app reads it
  out of the file and everyone gets the subtitles. Someone joining late also learns the format.
"""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.preview()
INIT = harness.signal_init(harness.signaling())
VIDEO_INPUT = 'input[type=file][accept*="video/"]'
errors = []


def notice(pg, kind):
    loc = pg.locator(f'[data-notice="{kind}"]')
    return loc.first.inner_text() if loc.count() else ''


def cues(pg):
    """Text of the subtitle cues loaded in the video element."""
    return pg.evaluate("""(() => { const v = document.querySelector('video'); if (!v) return [];
        const out = []; for (const t of v.textTracks) for (const c of (t.cues || [])) out.push(c.text); return out; })()""")


def page(b, name):
    pg = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    pg.add_init_script(INIT)
    pg.add_init_script(f"localStorage.setItem('webrtc_username', '{name}');")
    pg.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    pg.on('dialog', lambda d: d.accept())
    pg.goto(BASE + '/')
    if not wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10):
        pg.reload()
        wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10)
    return pg


def join(pg, room):
    pg.goto(f'{BASE}/?room={room}')
    wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10)
    pg.get_by_role('button', name='Join Room').click()


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    host = page(b, 'Hosty')
    guest = page(b, 'Guesty')
    host.evaluate("window.__sig = window.__sig || []")
    host.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    host.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: re.search(r'room=(\d+)', host.evaluate('location.href')) and re.search(r'room=(\d+)', host.evaluate('location.href')).group(1), 15)
    check('room created', room, host.evaluate('location.href'))
    join(guest, room)
    check('guest joined', wait(lambda: 'Direct P2P' in host.content(), 20))
    time.sleep(1.5)

    # ---- AC-3 audio: plays here as picture only --------------------------------------------
    host.set_input_files(VIDEO_INPUT, harness.media('ac3.mp4'))
    check('guest is offered the stream', wait(lambda: guest.get_by_role('button', name=re.compile('Stream from Peer')).count() > 0, 15))
    check('guest is told there will be no sound, before streaming',
          wait(lambda: 'No sound on this device' in notice(guest, 'own') and 'AC-3' in notice(guest, 'own'), 10), notice(guest, 'own'))
    check('the host sees its own warning', wait(lambda: 'No sound' in notice(host, 'own'), 10), notice(host, 'own'))
    check('the host sees who is affected', wait(lambda: 'Guesty' in notice(host, 'others') and 'no sound' in notice(host, 'others'), 10), notice(host, 'others'))
    host.locator('[data-notice="own"] .file-notice-close').click()
    check('a warning can be closed', wait(lambda: notice(host, 'own') == '', 3))

    # ---- AVI: plays nowhere ----------------------------------------------------------------
    host.set_input_files(VIDEO_INPUT, harness.media('old.avi'))
    check('the host is told an AVI won\'t play', wait(lambda: "won't play" in notice(host, 'own') and 'AVI' in notice(host, 'own'), 10), notice(host, 'own'))
    check('the guest too', wait(lambda: "won't play" in notice(guest, 'own'), 10), notice(guest, 'own'))

    # ---- MKV with subtitle tracks ------------------------------------------------------------
    host.set_input_files(VIDEO_INPUT, harness.media('subs.mkv'))
    check('the host sees the subtitle tracks in the file',
          wait(lambda: 'English' in notice(host, 'subs') and 'Spanish' in notice(host, 'subs'), 10), notice(host, 'subs'))
    check('no format warning for a file that plays', notice(host, 'own') == '' and notice(host, 'others') == '', notice(host, 'others'))
    check('the guest is told only the first audio track plays', wait(lambda: '2 audio tracks' in notice(guest, 'audio'), 10), notice(guest, 'audio'))
    guest.get_by_role('button', name=re.compile('Stream from Peer')).first.click()
    check('guest stream starts', wait(lambda: guest.evaluate("(document.querySelector('video')||{}).readyState >= 1"), 30))
    check('the guest sees the subtitle tracks too', wait(lambda: 'Spanish' in notice(guest, 'subs'), 10), notice(guest, 'subs'))

    # The guest picks Spanish (ASS): the host's app reads it out of the file and shares it
    guest.locator('[data-notice="subs"] .file-notice-track', has_text='Spanish').click()
    check('the guest gets the Spanish subtitles', wait(lambda: 'Hola desde la pista' in cues(guest), 15), cues(guest))
    check('ASS styling tags are removed', wait(lambda: 'Segunda linea' in cues(guest), 5), cues(guest))
    check('the host has them too', wait(lambda: 'Hola desde la pista' in cues(host), 10), cues(host))
    check('the picker goes away once subtitles are on', wait(lambda: notice(host, 'subs') == '' and notice(guest, 'subs') == '', 5))

    # A third person joins late: the format reaches them too
    late = page(b, 'Latey')
    join(late, room)
    check('someone joining late learns the format', wait(lambda: '2 audio tracks' in notice(late, 'audio'), 25), notice(late, 'audio'))

    # The host switches to English (SRT) from the subtitle menu: remove, then pick
    host.locator('.local-remove-sub-btn').first.click()
    check('the picker is back after removing the subtitles', wait(lambda: 'English' in notice(host, 'subs'), 5), notice(host, 'subs'))
    host.locator('[data-notice="subs"] .file-notice-track', has_text='English').click()
    check('everyone gets the English track (multi-line cue kept)',
          wait(lambda: 'Second line\nwith two rows' in cues(guest) and 'Hello from the English track' in cues(host), 15), cues(guest))
    host.screenshot(path=str(harness.OUT / 'file_format_host.png'))
    guest.screenshot(path=str(harness.OUT / 'file_format_guest.png'))

    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
