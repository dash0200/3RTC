"""The desktop app's window, driven like a person would (Linux: Xvfb + xdotool), with a web user
in the same room: create a room in the window, the browser joins by link, chat both ways, voice
reaches the browser, the People / Logs tabs, the devices and More popovers, the QR code, voice
settings, and Leave. Screenshots of each step go to desktop/docs/progress/window-*.png.

Needs: the app built (`cargo build -p rtc-app` in desktop/), Xvfb, xdotool, ImageMagick's
`import`, Mesa's software Vulkan (mesa-vulkan-drivers). Skipped when any is missing."""
import os, re, shutil, subprocess, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

APP = harness.REPO / 'desktop' / 'target' / 'debug' / '3rtc'
LVP = '/usr/share/vulkan/icd.d/lvp_icd.json'
missing = [n for n in ('Xvfb', 'xdotool', 'import') if not shutil.which(n)]
if harness.IS_WIN or not APP.exists() or missing or not os.path.exists(LVP):
    print(f'skipping: needs Linux, {APP}, Xvfb, xdotool, ImageMagick and {LVP}')
    sys.exit(0)

OUT = harness.REPO / 'desktop' / 'docs' / 'progress'
OUT.mkdir(parents=True, exist_ok=True)
BASE = harness.dev()
SIGNAL = harness.signaling()
DISPLAY = ':93'
home = tempfile.mkdtemp(prefix='3rtc-home-')
log_path = os.path.join(home, 'app.log')
env = dict(os.environ, DISPLAY=DISPLAY)


def x(*args):
    subprocess.run(['xdotool', *args], env=env, check=False)


def click(px, py):
    x('mousemove', str(px), str(py), 'click', '1')
    time.sleep(0.4)


def shot(name):
    subprocess.run(['import', '-window', 'root', str(OUT / f'window-{name}.png')], env=env, check=False)


def log():
    with open(log_path, encoding='utf-8', errors='replace') as f:
        return f.read()


def web_hears(pg):
    return pg.evaluate("""(async () => { let best = 0;
      for (const pc of window.__pcs) (await pc.getStats()).forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') best = Math.max(best, r.audioLevel || 0); });
      return best; })()""")


xvfb = subprocess.Popen(['Xvfb', DISPLAY, '-screen', '0', '1440x900x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
app = subprocess.Popen([str(APP)], env=dict(env, HOME=home, XDG_CONFIG_HOME=home, VK_ICD_FILENAMES=LVP,
                       RTC_SIGNAL_URL=SIGNAL, RTC_FAKE_MIC='tone', RUST_LOG='warn,rtc_engine=info'),
                       stdout=open(log_path, 'w'), stderr=subprocess.STDOUT)
try:
    check('the window opens and reaches the server', wait(lambda: 'Connected to Local signaling' in log(), 40))
    time.sleep(3)
    shot('home')
    click(300, 483); x('type', '--delay', '40', 'Darshan')
    click(318, 541)
    check('Create a room works', wait(lambda: re.search(r'You created room (\d{5})', log()), 15))
    room = re.search(r'You created room (\d{5})', log()).group(1)
    time.sleep(1); x('mousemove', '700', '600'); shot('alone')

    with sync_playwright() as p:
        b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
        pg = b.new_context(viewport={'width': 1200, 'height': 800}).new_page()
        pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT)
        pg.goto(f'{BASE}/?room={room}'); pg.wait_for_timeout(2000)
        pg.get_by_role('textbox').first.fill('Riya'); pg.get_by_role('button', name='Join room').click()
        check('a web user joins by the invite link and connects', wait(lambda: 'DataChannel established' in log(), 20))
        box = pg.get_by_placeholder(re.compile('Message the room')).first
        box.fill('hey Darshan, can you hear me?'); box.press('Enter')
        click(1230, 862); x('type', '--delay', '30', 'Loud and clear!'); x('key', 'Return')
        check('chat from the window reaches the browser', wait(lambda: 'Loud and clear!' in pg.locator('body').inner_text(), 10))
        check('...under the desktop user\'s name', 'Darshan' in pg.evaluate("[...document.querySelectorAll('.cm-name')].map(e => e.textContent)"))
        click(348, 860)  # mic on
        check('the mic button sends voice (the browser hears it)', wait(lambda: web_hears(pg) > 0.05, 10), web_hears(pg))
        pg.get_by_role('button', name='Turn microphone on').click()
        time.sleep(2); x('mousemove', '700', '500'); shot('chat-voice')
        click(1303, 96); time.sleep(0.6); shot('people')
        click(1385, 96); time.sleep(0.6); shot('logs')
        click(400, 860); time.sleep(0.6); shot('devices'); x('key', 'Escape')
        click(771, 860); time.sleep(0.6); shot('more')
        click(790, 730); time.sleep(0.6); shot('voice-settings'); x('key', 'Escape')
        x('key', 'q'); time.sleep(0.6); shot('qr'); x('key', 'Escape')
        click(348, 860)  # mic off
        check('the mic button mutes (the browser hears silence)', wait(lambda: web_hears(pg) < 0.01, 10), web_hears(pg))
        click(1023, 860); time.sleep(0.6); shot('leave')
        click(720, 520)
        check('Leave returns to the home screen', wait(lambda: 'You left the room.' in log(), 5))
        check('...and the browser sees the desktop user go',
              wait(lambda: pg.evaluate("window.__pcs.every(pc => pc.connectionState !== 'connected')"), 15))
        b.close()
finally:
    app.terminate(); xvfb.terminate()
    try:
        app.wait(5)
    except subprocess.TimeoutExpired:
        app.kill()
harness.summary()
