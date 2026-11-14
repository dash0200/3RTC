"""Desktop ↔ web: what's inside a shared file, and its subtitles.

The desktop engine (examples/chat) stands in for the desktop app: `/share <path>` plays and
offers a file (reading its header for the room's format card), `/subs <path>` shares a subtitle
file. `FILE_FORMAT`, `FILE_PROBLEMS` and `PLAYER subtitles` lines are what the app is told.

1. The desktop shares an MP4 with AC-3 sound: the browser is told "no sound" before streaming,
   and the desktop learns which viewer is affected.
2. The desktop shares an MKV with two subtitle tracks: the browser lists them; picking Spanish
   (ASS) makes the desktop read it out of the file and share it, and the browser shows it.
3. The desktop shares an .srt: the browser shows it. The browser shares one: the desktop gets it.
4. The browser shares a file: the desktop learns what's in it (and answers it can play it).
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

BASE = harness.preview()
SIGNAL = harness.signaling()
errors = []


class Desktop:
    def __init__(self, room=None):
        self.out = []
        args = [str(CLI), SIGNAL, 'Darshan'] + ([str(room)] if room else [])
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, env=dict(os.environ, RUST_LOG='warn'))
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.out.append(re.sub(r'\x1b\[[0-9;]*m', '', line.rstrip()))

    def say(self, cmd):
        self.proc.stdin.write(cmd + '\n'); self.proc.stdin.flush()

    def saw(self, pattern, since=0):
        return next((m for m in (re.search(pattern, l) for l in self.out[since:]) if m), None)

    def mark(self):
        return len(self.out)

    def quit(self):
        try:
            self.say('/quit'); self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def notice(pg, kind):
    loc = pg.locator(f'[data-notice="{kind}"]')
    return loc.first.inner_text() if loc.count() else ''


def cues(pg):
    return pg.evaluate("""(() => { const v = document.querySelector('video'); if (!v) return [];
        const out = []; for (const t of v.textTracks) for (const c of (t.cues || [])) out.push(c.text); return out; })()""")


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    web = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    web.add_init_script(harness.signal_init(SIGNAL) + harness.PEOPLE_INIT + "localStorage.setItem('webrtc_username', 'Riya');")
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.on('dialog', lambda d: d.accept())
    web.goto(BASE); wait(lambda: web.evaluate('!!navigator.serviceWorker.controller'), 10)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    d = Desktop(room)
    try:
        check('desktop joins and connects', wait(lambda: d.saw(r'members=Riya\+'), 25), d.out[-3:])
        time.sleep(2)

        # ---- 1. AC-3 sound ----
        m = d.mark()
        d.say(f"/share {harness.media('ac3.mp4')}")
        check('desktop shares an AC-3 MP4: the browser is told there will be no sound',
              wait(lambda: 'No sound on this device' in notice(web, 'own') and 'AC-3' in notice(web, 'own'), 15), notice(web, 'own'))
        check('...and the desktop learns who is affected',
              wait(lambda: d.saw(r'FILE_PROBLEMS Riya \(.+\): The picture plays, but there will be no sound', m), 10), d.out[-3:])

        # ---- 2. MKV with subtitle tracks ----
        m = d.mark()
        d.say(f"/share {harness.media('subs.mkv')}")
        check('desktop shares an MKV: nobody has a problem with it', wait(lambda: d.saw(r'FILE_PROBLEMS$', m), 10), d.out[-3:])
        wait(lambda: web.get_by_role('button', name='Stream from Darshan').count() > 0, 10)
        web.get_by_role('button', name='Stream from Darshan').click()
        check('the browser streams it', wait(lambda: web.evaluate("(document.querySelector('video')||{}).readyState >= 1"), 30))
        check('...and lists its subtitle tracks',
              wait(lambda: 'English' in notice(web, 'subs') and 'Spanish' in notice(web, 'subs'), 15), notice(web, 'subs'))
        web.locator('[data-notice="subs"] .file-notice-track', has_text='Spanish').click()
        check('the browser picks Spanish: the desktop reads it out of the file and the browser shows it',
              wait(lambda: 'Hola desde la pista' in cues(web), 20), (cues(web), d.out[-3:]))
        check('...ASS styling removed', wait(lambda: 'Segunda linea' in cues(web), 5), cues(web))

        # ---- 3. subtitle files both ways ----
        srt = harness.OUT / 'desk_subs.srt'
        srt.write_text('1\n00:00:01,000 --> 00:00:04,000\nFrom the desktop\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond cue\n')
        d.say(f'/subs {srt}')
        check('the desktop shares an .srt: the browser shows it', wait(lambda: 'From the desktop' in cues(web), 10), cues(web))
        m = d.mark()
        web.locator('input[type=file][accept*=".srt"]').first.set_input_files(harness.media('subs_en.srt'))
        check('the browser shares an .srt: the desktop player gets it',
              wait(lambda: d.saw(r'PLAYER subtitles .+ [1-9]\d* cues', m), 10), d.out[-3:])
        d.say('/exit')
        d.say('/unshare')
        wait(lambda: web.locator('video').count() == 0, 8)
        time.sleep(1)

        # ---- 4. the browser's file ----
        m = d.mark()
        web.locator('input[accept*=".mp4"]').first.set_input_files(harness.media('subs.mkv'))
        check('the browser shares an MKV: the desktop learns what is in it',
              wait(lambda: d.saw(r'FILE_FORMAT subs\.mkv: MKV · VP9 · Opus \+ 1 more audio · 2 subtitles', m), 15), d.out[-3:])
    finally:
        d.quit()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
