"""Desktop → desktop and web: screen sharing at the screen's own size, per viewer.

Two desktop engines (examples/chat) and a browser in one room. The sharer's GPU encoder is
replaced by a file of H.264 access units (`RTC_TEST_H264=file@WxH`, made here with ffmpeg), so
this checks everything around a hardware encoder: H.264 negotiated between desktops, the
pass-through sender, keyframes, and the other desktop decoding it. The browser here has no
H.264, so it gets the software path at web size: each viewer gets their own picture.

1. Darshan (desktop) shares a 2560×1600 screen: Asha (desktop) is sent the GPU stream at full
   size, Riya (web) the software one at 1440p, and both see it moving.
2. Asha shows it in a 960×540 window: her frames arrive at 1920×1080 (the file) and are scaled
   to 960×540 for drawing.
3. Asha asks for 720p (`screen-quality`): Darshan's viewers list says so.
4. Darshan limits his share to 1080p at 30 fps: Riya's picture drops to 1080 lines.
Needs the desktop example built: `cargo build -p rtc-engine --example chat` in desktop/ (skipped
if not), ffmpeg with libx264 and Xvfb (skipped if not)."""
import os, re, shutil, subprocess, sys, tempfile, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CLI = harness.REPO / 'desktop' / 'target' / 'debug' / 'examples' / ('chat.exe' if harness.IS_WIN else 'chat')
if not CLI.exists():
    print(f'skipping: build {CLI} first')
    sys.exit(0)
if harness.IS_WIN or not shutil.which('Xvfb') or not shutil.which('ffmpeg'):
    print('skipping: needs Xvfb and ffmpeg')
    sys.exit(0)

# what the "GPU" sends: 1920x1080 test pictures, a keyframe each second, delimiters between frames
H264 = os.path.join(tempfile.mkdtemp(), 'screen.h264')
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
                '-t', '4', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0',
                '-x264-params', 'aud=1', '-f', 'h264', H264], check=True)

BASE = harness.dev()
SIGNAL = harness.signaling()
errors = []

DISPLAY = ':96'
xvfb = subprocess.Popen(['Xvfb', DISPLAY, '-screen', '0', '2560x1600x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
if shutil.which('xsetroot'):
    subprocess.run(['xsetroot', '-display', DISPLAY, '-solid', '#33aaff'], check=False)


class Desktop:
    def __init__(self, name, room, **env):
        self.out = []
        e = dict(os.environ, RUST_LOG='warn', DISPLAY=DISPLAY, **env)
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


def remote_video(pg):
    return pg.evaluate("""(() => { const v = [...document.querySelectorAll('.screen-share-stage video')].find(x => x.srcObject);
        return v ? { w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(2) } : null; })()""")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    web.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.goto(BASE); web.wait_for_timeout(1500)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    sharer = Desktop('Darshan', room, RTC_TEST_H264=f'{H264}@1920x1080')
    viewer = Desktop('Asha', room, RTC_SCREEN_TARGET='960x540')
    try:
        everyone = lambda d: d.saw(r'members=(?=.*Riya)(?=.*(Asha|Darshan))')
        check('both desktops join and connect', wait(lambda: everyone(sharer) and everyone(viewer), 30),
              (sharer.out[-2:], viewer.out[-2:]))
        time.sleep(3)

        # ---- 1. full size to the desktop (GPU path), 1440p to the web (software) ----
        m, mv = sharer.mark(), viewer.mark()
        sharer.say('/sharescreen')
        sending = lambda: sharer.last(r'SCREEN_SENDING encoder=(.+?) viewers=(\S+)', m)
        routed = lambda: (s := sending()) and re.search(r'Asha:1600:hw:desktop', s.group(2)) and re.search(r'Riya:1440:sw:web', s.group(2))
        check('the sharer sends Asha (desktop) the GPU stream at full size and Riya (web) 1440p in software',
              wait(routed, 20), sending().group(0) if sending() else sharer.out[-4:])
        check("...the encoder is named", sending() and sending().group(1) == 'test file', sending().group(0) if sending() else None)
        check('Asha is told who shares', wait(lambda: viewer.saw(r'SCREEN sharer=Darshan mine=false', mv), 10), viewer.out[-3:])
        stats = lambda: viewer.last(r'SCREEN_STATS (\d+)x(\d+) fps=(\d+)', mv)
        moving = lambda: (s := stats()) and s.group(1) == '1920' and int(s.group(3)) >= 15
        check("...Asha decodes the GPU stream: 1920x1080 (the file's size), moving",
              wait(moving, 30), stats().group(0) if stats() else viewer.out[-4:])
        check('...the browser shows its picture playing',
              wait(lambda: (remote_video(web) or {}).get('t', 0) > 1, 30), remote_video(web))
        check('...at 1440 lines (the web limit; 2304x1440)',
              wait(lambda: (remote_video(web) or {}).get('h', 0) == 1440, 30), remote_video(web))

        # ---- 2. shown small: scaled to the window ----
        frame = lambda: viewer.last(r'SCREEN_FRAME (\d+)x(\d+) lit=(\d+)', mv)
        check("Asha's frames are scaled to her 960x540 window before drawing",
              wait(lambda: (f := frame()) and f.group(1) == '960' and f.group(2) == '540' and int(f.group(3)) > 1000, 15),
              frame().group(0) if frame() else None)

        # ---- 3. the viewer asks for 720p ----
        m = sharer.mark()
        viewer.say('/quality 720')
        check('Asha asks for 720p: the sharer sends her 720 lines',
              wait(lambda: (s := sending()) and 'Asha:720:hw:desktop' in s.group(2), 10),
              sending().group(0) if sending() else sharer.out[-3:])

        # ---- 4. the sharer limits to 1080p at 30 fps ----
        m = sharer.mark()
        sharer.say('/screenopts 1080 30')
        check('the sharer limits to 1080p: Riya 1080 lines, Asha still 720',
              wait(lambda: (s := sending()) and 'Riya:1080:sw:web' in s.group(2) and 'Asha:720:hw' in s.group(2), 10),
              sending().group(0) if sending() else sharer.out[-3:])
        check("...the browser's picture drops to 1080 lines",
              wait(lambda: (remote_video(web) or {}).get('h', 0) == 1080, 30), remote_video(web))

        sharer.say('/stopscreen')
        check('the sharer stops: Asha is told', wait(lambda: viewer.saw(r'SCREEN sharer=- ', mv), 10), viewer.out[-3:])
    finally:
        sharer.quit()
        viewer.quit()
        xvfb.kill()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
