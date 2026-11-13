"""Desktop → desktop: remote control of a shared screen (`screen-control`, `screen-input`).

Two desktop engines (examples/chat) and a browser in one room. Darshan (desktop) shares his screen.

1. Only desktop viewers can ask: Asha (desktop) sees she can; the browser gets no control messages.
2. Asha asks; Darshan sees the request and says no: Asha is told, nothing changes.
3. Asha asks again; Darshan allows it: Asha controls, everyone on the desktop sees who controls.
4. Asha's clicks and keys reach Darshan's app to play back (in order); before she had control,
   none were taken.
5. Darshan takes control back: Asha's inputs are ignored again.
6. Darshan offers control; Asha takes it; Asha lets go.
7. Control held when the share stops ends with it.
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

DISPLAY = ':96'
xvfb = subprocess.Popen(['Xvfb', DISPLAY, '-screen', '0', '1280x720x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)


class Desktop:
    def __init__(self, name, room):
        self.out = []
        e = dict(os.environ, RUST_LOG='warn,rtc_engine=info', DISPLAY=DISPLAY, RTC_MIC='silence')
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

    def all(self, pattern, since=0):
        return [m for m in (re.search(pattern, l) for l in self.out[since:]) if m]

    def control(self, since=0):
        hits = self.all(r'CONTROL (.*)$', since)
        if not hits:
            return None
        return dict(kv.split('=', 1) for kv in hits[-1].group(1).split(' '))

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
                        # every data-channel message the web app reads: none should be remote control
                        + "window.__ctl = []; window.__dcMsgs = 0; const _d = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');"
                        + "Object.defineProperty(RTCDataChannel.prototype, 'onmessage', { configurable: true, get() { return _d.get.call(this); },"
                        + " set(f) { _d.set.call(this, f && function (ev) { window.__dcMsgs++;"
                        + " if (typeof ev.data === 'string' && /screen-(control|input)/.test(ev.data)) window.__ctl.push(ev.data); return f.call(this, ev); }); } });")
    web.on('pageerror', lambda e: errors.append(str(e)))
    web.goto(BASE); web.wait_for_timeout(1500)
    harness.create_room(web)
    room = wait(lambda: next((m['roomId'] for m in web.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    sharer = Desktop('Darshan', room)
    viewer = Desktop('Asha', room)
    try:
        everyone = lambda d: d.saw(r'members=(?=.*Riya)(?=.*(Asha|Darshan))')
        check('both desktops join and connect', wait(lambda: everyone(sharer) and everyone(viewer), 30),
              (sharer.out[-2:], viewer.out[-2:]))
        time.sleep(3)

        # ---- 1. only desktop viewers can ask ----
        sharer.say('/screenopts 0 30 0')
        sharer.say('/sharescreen')
        check('Darshan shares; Asha (desktop) can ask for control',
              wait(lambda: (c := viewer.control()) and c['can_ask'] == 'true', 15), viewer.out[-3:])
        check("...and Darshan's app lists Asha (not the browser) as someone to offer control to",
              wait(lambda: (c := sharer.control()) and c['viewers'] == 'Asha', 10), sharer.control())

        # inputs before control: ignored
        m = sharer.mark()
        viewer.say('/control click 0.5 0.5')
        time.sleep(1.5)
        check('before she has control, Asha\'s clicks are not sent (nor played back)', not sharer.saw(r'control: input', m))

        # ---- 2. ask, denied ----
        viewer.say('/control ask')
        check('Asha asks: she waits', wait(lambda: (c := viewer.control()) and c['asked'] == 'true', 8), viewer.control())
        check("...Darshan's app shows her request", wait(lambda: (c := sharer.control()) and c['asks'] == 'Asha', 8), sharer.control())
        mv = viewer.mark()
        sharer.say('/control deny Asha')
        check('Darshan says no: Asha is told', wait(lambda: viewer.saw(r'NOTICE Darshan said no', mv), 8), viewer.out[-3:])
        check('...and stops waiting; nobody controls', wait(lambda: (c := viewer.control()) and c['asked'] == 'false' and c['mine'] == 'false', 5))

        # ---- 3. ask, allowed ----
        viewer.say('/control ask')
        wait(lambda: (c := sharer.control()) and c['asks'] == 'Asha', 8)
        mv = viewer.mark()
        sharer.say('/control allow Asha')
        check('Darshan allows it: Asha controls his screen',
              wait(lambda: (c := viewer.control()) and c['mine'] == 'true' and c['controller'] == 'Asha', 8), viewer.control())
        check("...Darshan's app says Asha controls; her request is answered",
              wait(lambda: (c := sharer.control()) and c['controller'] == 'Asha' and c['asks'] == '', 5), sharer.control())

        # ---- 4. her input is played back, in order ----
        m = sharer.mark()
        viewer.say('/control move 0.2 0.3')
        viewer.say('/control rclick 0.25 0.75')
        viewer.say('/control key 65')
        played = lambda: sharer.all(r'control: input (\w+) \{ (.*) \}', m)
        check("Asha's right-click and key reach Darshan's app to play back",
              wait(lambda: len(played()) >= 4, 8), [x.group(0) for x in played()])
        got = [(x.group(1), x.group(2)) for x in played()][:4]
        check('...in order, where she clicked (0.25, 0.75)',
              [g[0] for g in got] == ['Button', 'Button', 'Key', 'Key']
              and 'button: Right, down: true, x: 0.25, y: 0.75' in got[0][1] and 'down: false' in got[1][1]
              and 'vk: 65, down: true' in got[2][1] and 'vk: 65, down: false' in got[3][1], got)

        # the browser never sees any of it
        check('the browser gets no control messages (it reads the others: %d)' % web.evaluate('window.__dcMsgs'),
              web.evaluate('window.__ctl.length') == 0 and web.evaluate('window.__dcMsgs') > 0, web.evaluate('window.__ctl.slice(0,3)'))

        # ---- 5. Darshan takes control back ----
        mv = viewer.mark()
        sharer.say('/control revoke')
        check('Darshan takes control back: Asha is told', wait(lambda: viewer.saw(r'NOTICE Darshan took back control', mv), 8), viewer.out[-3:])
        check('...she no longer controls', wait(lambda: (c := viewer.control()) and c['mine'] == 'false' and c['controller'] == '-', 5), viewer.control())
        m = sharer.mark()
        viewer.say('/control click 0.5 0.5')
        time.sleep(1.5)
        check('...and her clicks are ignored again', not sharer.saw(r'control: input', m))

        # ---- 6. offer, accept, release ----
        sharer.say('/control offer Asha')
        check('Darshan offers control: Asha sees the offer', wait(lambda: (c := viewer.control()) and c['offered'] == 'true', 8), viewer.control())
        check("...Darshan's app marks Asha as offered", wait(lambda: (c := sharer.control()) and c['viewers'] == 'Asha*', 5), sharer.control())
        viewer.say('/control accept')
        check('Asha takes it: she controls', wait(lambda: (c := viewer.control()) and c['mine'] == 'true', 8), viewer.control())
        ms = sharer.mark()
        viewer.say('/control release')
        check('Asha lets go: Darshan is told', wait(lambda: sharer.saw(r'NOTICE Asha stopped controlling your screen', ms), 8), sharer.out[-3:])
        check('...nobody controls', wait(lambda: (c := sharer.control()) and c['controller'] == '-', 5), sharer.control())

        # ---- 7. the share stops while she controls ----
        viewer.say('/control ask')
        wait(lambda: (c := sharer.control()) and c['asks'] == 'Asha', 8)
        sharer.say('/control allow Asha')
        wait(lambda: (c := viewer.control()) and c['mine'] == 'true', 8)
        mv = viewer.mark()
        sharer.say('/stopscreen')
        check('Darshan stops sharing: Asha\'s control ends with it',
              wait(lambda: (c := viewer.control(mv)) and c['mine'] == 'false' and c['can_ask'] == 'false', 8), viewer.control())
        check("...Darshan's app says so", sharer.saw(r'NOTICE Control ended: you stopped sharing') is not None, sharer.out[-4:])
    finally:
        sharer.quit()
        viewer.quit()
        xvfb.kill()
    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
