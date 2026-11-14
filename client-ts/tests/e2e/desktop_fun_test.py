"""Desktop ↔ web: reactions, the soundboard and chat pictures, both ways.

The web app hosts, the desktop engine (examples/chat) joins. Reactions and soundboard clips go
each way and show on the other side; a picture goes each way over the bulk channel and arrives
byte for byte (the desktop prints each picture's size and FNV-1a hash; the browser's are read
from the image it shows).
Needs the desktop example built: `cargo build -p rtc-engine --example chat` in desktop/ (skipped if not)."""
import os, re, struct, subprocess, sys, tempfile, threading, zlib
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


def saw(pattern):
    return next((m for m in (re.search(pattern, l) for l in out) if m), None)


def fnv(data):
    h = 0xcbf29ce484222325
    for b in data:
        h = ((h ^ b) * 0x100000001b3) & 0xffffffffffffffff
    return f'{h:016x}'


def png(width, height, seed):
    """A real PNG of noise (so it doesn't compress small): several 60 KB frames."""
    rows = b''.join(b'\x00' + bytes((x * 7 + y * 13 + seed * 31 + (x * y) % 251) % 256 for x in range(width * 3))
                    for y in range(height))
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows, 0)) + chunk(b'IEND', b''))


tmp = tempfile.mkdtemp(prefix='3rtc-fun-')
desk_png = os.path.join(tmp, 'from-desktop.png')
web_png = os.path.join(tmp, 'from-web.png')
with open(desk_png, 'wb') as f:
    f.write(png(160, 300, 1))  # ~144 KB: three frames
with open(web_png, 'wb') as f:
    f.write(png(120, 250, 2))
web_bytes = open(web_png, 'rb').read()
desk_bytes = open(desk_png, 'rb').read()

with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    pg = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    pg.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    pg.goto(BASE); pg.wait_for_timeout(1200)
    harness.create_room(pg)
    wait(lambda: any(m.get('type') == 'room-created' for m in pg.evaluate('window.__sig')), 10)
    room = next(m['roomId'] for m in pg.evaluate('window.__sig') if m.get('type') == 'room-created')

    proc = subprocess.Popen([str(CLI), SIGNAL, 'Darshan', str(room)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1, env=dict(os.environ, RUST_LOG='warn'))
    threading.Thread(target=read, args=(proc,), daemon=True).start()

    def say(cmd):
        proc.stdin.write(cmd + '\n'); proc.stdin.flush()

    try:
        check('desktop joins and connects', wait(lambda: saw(r'members=Riya\+'), 25), out[-3:])
        pg.wait_for_timeout(1000)

        # ---- reactions ----
        say('/react 🔥')
        check('desktop → web reaction floats up', wait(lambda: pg.locator('.floating-reaction-item', has_text='🔥').count() > 0, 8))
        check('...with the desktop user\'s name', wait(lambda: pg.locator('.reaction-sender-tag', has_text='Darshan').count() > 0, 5))
        pg.get_by_role('button', name='Reactions', exact=True).click()
        pg.locator('.dock-react').first.click()
        first = pg.locator('.dock-react').first.inner_text().strip()
        check('web → desktop reaction arrives', wait(lambda: saw(rf'REACTION Riya {re.escape(first)} x1'), 8), out[-3:])
        pg.keyboard.press('Escape')

        # ---- soundboard ----
        say('/sound airhorn')
        check('desktop → web soundboard clip: the web shows who played it',
              wait(lambda: 'Darshan played' in pg.locator('body').inner_text(), 8))
        pg.get_by_role('button', name='Soundboard', exact=True).click()
        pg.get_by_role('button', name='Play sound effect: Quack').click()
        check('web → desktop soundboard clip arrives', wait(lambda: saw(r'SOUND Riya quack'), 8), out[-3:])
        pg.keyboard.press('Escape')

        # ---- pictures ----
        pg.get_by_role('tab', name=re.compile('Chat')).first.click() if pg.get_by_role('tab', name=re.compile('Chat')).count() else None
        say(f'/image {desk_png} from the desktop')
        check('desktop → web picture shows in the chat', wait(lambda: pg.locator('.chat-image-card img').count() > 0, 15))
        got = pg.evaluate("""(async () => { const img = document.querySelector('.chat-image-card img');
            const buf = new Uint8Array(await (await fetch(img.src)).arrayBuffer()); return Array.from(buf); })()""")
        check('...byte for byte', bytes(got) == desk_bytes, f'{len(got)} vs {len(desk_bytes)}')
        check('...with its caption', 'from the desktop' in pg.locator('body').inner_text())

        pg.locator('input[type=file][accept="image/*"]').set_input_files(web_png)
        pg.wait_for_timeout(300)
        pg.get_by_role('button', name='Send message').click()
        check('web → desktop picture is announced', wait(lambda: saw(r'IMAGE_START \S+ from-web\.png'), 10), out[-3:])
        check('...and arrives byte for byte',
              wait(lambda: saw(rf'IMAGE_READY \S+ {len(web_bytes)} {fnv(web_bytes)}'), 15), out[-3:])
    finally:
        try:
            say('/quit'); proc.wait(timeout=10)
        except Exception:
            proc.kill()
        b.close()
harness.summary()
