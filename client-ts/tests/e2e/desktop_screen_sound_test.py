"""Desktop → desktop: a shared screen's sound, in stereo, on its own line (not the voice's).

Two desktop engines (examples/chat) and a browser in one room. The sharer's "computer sound" is
a test tone (`RTC_TEST_SCREEN_SOUND=tone`: 440 Hz at 0.3 on the left, 660 Hz at 0.1 on the
right), standing in for Windows' loopback capture of everything but 3RTC.

1. Darshan (desktop) shares his screen with sound: Asha's connection gets a sound line (an
   offer on the open connection); Riya's (web) doesn't (the web app would take it for a voice).
2. Asha hears it in stereo: 2 channels, left louder than right, as sent.
3. The browser still hears Darshan's voice line only, and is told the share has no sound for it.
4. Darshan stops; sharing again without sound adds nothing.
Needs the desktop example built: `cargo build -p rtc-engine --example chat` in desktop/ (skipped
if not) and Xvfb (skipped if not)."""
import os, re, shutil, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CLI = harness.REPO / 'desktop' / 'target' / 'debug' / 'examples' / ('chat.exe' if harness.IS_WIN else 'chat')
if not CLI.exists():
    print(f'skipping: build {CLI} first')
    sys.exit(0)
if harness.IS_WIN or not shutil.which('Xvfb'):
    print('skipping: needs Xvfb')
    sys.exit(0)

BASE = harness.dev()
SIGNAL = harness.signaling()
errors = []

DISPLAY = ':97'
xvfb = subprocess.Popen(['Xvfb', DISPLAY, '-screen', '0', '1280x720x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)


class Desktop:
    def __init__(self, name, room, **env):
        self.out = []
        e = dict(os.environ, RUST_LOG='warn,rtc_engine=info,rtc_webrtc::voice=info', DISPLAY=DISPLAY, **env)
        self.proc = subprocess.Popen([str(CLI), SIGNAL, name, str(room)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, bufsize=1, env=e)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.out.append(re.sub(r'\x1b\[[0-9;]*m', '', line.rstrip()))

    def say(self, cmd):
        self.proc.stdin.write(cmd + '\n'); self.proc.stdin.flush()

    def saw(self, pattern, since=0):
        return next((m for m in (re.search(pattern, l) for l in self.out[since:]) if m), None)

    def last(self, pattern, since=0):
        hits = [m for m in (re.search(pattern, l) for l in self.out[since:]) if m]
        return hits[-1] if hits else None

    def mark(self):
        return len(self.out)

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    web.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');"
                        + "window.__pcs = []; const _PC = window.RTCPeerConnection; window.RTCPeerConnection = function (...a) "
                        + "{ const pc = new _PC(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = _PC.prototype;")
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.goto(BASE); web.wait_for_timeout(1500)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    sharer = Desktop('Darshan', room, RTC_TEST_SCREEN_SOUND='tone', RTC_MIC='silence')
    viewer = Desktop('Asha', room, RTC_MIC='pipeline')
    try:
        everyone = lambda d: d.saw(r'members=(?=.*Riya)(?=.*(Asha|Darshan))')
        check('both desktops join and connect', wait(lambda: everyone(sharer) and everyone(viewer), 30),
              (sharer.out[-2:], viewer.out[-2:]))
        time.sleep(3)

        # ---- 1. sharing with sound: a sound line to the desktop only ----
        m, mv = sharer.mark(), viewer.mark()
        sharer.say('/sharescreen')
        check('Darshan shares: a sound line goes to Asha (desktop) on the open connection',
              wait(lambda: sharer.saw(r'screen: sound line to \S+; offering it', m), 15), sharer.out[-4:])
        time.sleep(2)
        lines = [l for l in sharer.out[m:] if 'sound line to' in l]
        check('...one line, to Asha only (not to the web app)', len(lines) == 1, lines)

        # ---- 2. Asha hears it in stereo ----
        check("Asha hears Darshan's screen: 48 kHz, 2 channels",
              wait(lambda: viewer.saw(r"hearing \S+'s screen \(48000 Hz, 2 channels\)", mv), 15), viewer.out[-4:])
        level = lambda: viewer.last(r"\S+'s screen: \d+ frames, left ([\d.]+), right ([\d.]+)", mv)
        check('...left louder than right, as sent (about 0.3 and 0.1)',
              wait(lambda: (l := level()) and 0.2 < float(l.group(1)) < 0.4 and 0.05 < float(l.group(2)) < 0.15, 20),
              level().group(0) if level() else viewer.out[-3:])

        # ---- 3. the browser: still one audio line from Darshan, no "Audio" badge ----
        audio_lines = web.evaluate("""window.__pcs.filter(pc => pc.connectionState === 'connected')
            .map(pc => pc.getTransceivers().filter(t => t.receiver.track && t.receiver.track.kind === 'audio').length)""")
        check('the browser has one audio line per person (no extra line from the sharer)',
              audio_lines and all(n == 1 for n in audio_lines), audio_lines)
        check("...and its screen share shows no 'Audio' badge (it can't get the sound)",
              wait(lambda: web.locator('.screen-share-stage').count() == 1, 10)
              and web.locator('.screen-share-audio-badge').count() == 0)

        # ---- 4. stop; again without sound ----
        sharer.say('/stopscreen')
        check('Darshan stops: Asha is told', wait(lambda: viewer.saw(r'SCREEN sharer=- ', mv), 10), viewer.out[-3:])
        m = sharer.mark()
        sharer.say('/screenopts 0 60 0')
        sharer.say('/sharescreen')
        check('sharing again without sound: shared, no new sound line',
              wait(lambda: viewer.saw(r'SCREEN sharer=Darshan', viewer.mark() - 5), 10) and not sharer.saw(r'sound line to', m),
              sharer.out[-3:])
        sharer.say('/stopscreen')
    finally:
        sharer.quit()
        viewer.quit()
        xvfb.kill()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
