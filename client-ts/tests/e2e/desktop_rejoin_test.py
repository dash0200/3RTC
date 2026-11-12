"""Desktop hosts, a web user leaves and rejoins in the same tab (so with the same peer id) twice:
the desktop must hear them every time. Each time the last connection closes, libwebrtc shuts its
voice engine down and starts it again on the next one. Before the 3RTC patch in
`vendor/webrtc-sys/src/adm_proxy.cpp` (`AdmProxy::Init`), the restart left the audio device
stopped: packets arrived, nothing was decoded, nobody was heard.
`RTC_MIC=pipeline` runs the desktop on our own audio path (the default in the app).
Needs the desktop example built: `cargo build -p rtc-engine --example chat` in desktop/ (skipped if not)."""
import os, re, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CLI = harness.REPO / 'desktop' / 'target' / 'debug' / 'examples' / ('chat.exe' if harness.IS_WIN else 'chat')
if not CLI.exists():
    print(f'skipping: build {CLI} first')
    sys.exit(0)

BASE = harness.dev()
SIGNAL = harness.signaling()
out = []


def read(proc):
    for line in proc.stdout:
        out.append(re.sub(r'\x1b\[[0-9;]*m', '', line.rstrip()))


def speaking_lines():
    return sum('members=Riya+~' in l for l in out)


env = dict(os.environ, RUST_LOG='info')
proc = subprocess.Popen([str(CLI), SIGNAL, 'Darshan'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, text=True, bufsize=1, env=env)
threading.Thread(target=read, args=(proc,), daemon=True).start()
try:
    check('the desktop creates a room', wait(lambda: any(re.search(r'ROOM \d{5}', l) for l in out), 20))
    room = next(re.search(r'ROOM (\d{5})', l).group(1) for l in out if re.search(r'ROOM \d{5}', l))
    with sync_playwright() as p:
        b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
        pg = b.new_context(viewport={'width': 1300, 'height': 850}).new_page()
        pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT)
        pg.goto(f'{BASE}/?room={room}'); pg.wait_for_timeout(2000)
        pg.get_by_role('textbox').first.fill('Riya'); pg.get_by_role('button', name='Join room').click()
        for n in (1, 2, 3):
            wait(lambda: pg.get_by_role('button', name='Turn microphone on').count() > 0, 20)
            before = speaking_lines()
            pg.get_by_role('button', name='Turn microphone on').click()
            label = 'the desktop hears the web user' if n == 1 else f'...and again after leaving and rejoining ({n - 1})'
            check(label, wait(lambda: speaking_lines() > before, 15), out[-2:])
            if n == 3:
                break
            # leave in the app (not a reload: the tab keeps its peer id), then rejoin
            pg.locator('.dock-leave').click(); pg.wait_for_timeout(800)
            for name in ('Leave room', 'Leave'):
                btn = pg.get_by_role('button', name=name, exact=True)
                if btn.count() > 0 and btn.first.is_visible():
                    btn.first.click()
                    break
            pg.wait_for_timeout(2500)
            rejoin = pg.get_by_text(re.compile('Rejoin|Return to room', re.I))
            if rejoin.count() > 0:
                rejoin.first.click()
            else:
                pg.get_by_role('textbox').last.fill(room); pg.keyboard.press('Enter')
            pg.wait_for_timeout(3000)
        b.close()
finally:
    try:
        proc.stdin.write('/quit\n'); proc.stdin.flush()
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
harness.summary()
