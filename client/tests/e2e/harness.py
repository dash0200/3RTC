"""
Shared setup for the browser tests: finds the repo, starts the servers a suite needs (only if
they aren't already answering), makes the test media, and offers small helpers.

Servers (all local):
  dev        Vite dev server              http://localhost:5199   (app source, dev-only features)
  preview    production build             http://localhost:4173   (service worker, streaming)
  signaling  server/server.js             ws://localhost:8080
  quickpicks fake YouTube API + 2nd signaling server with quick picks   ws://localhost:8091

Everything a run writes (logs, screenshots, media) goes to client/tests/e2e/.out (git-ignored).
"""
import atexit
import re
import json
import os
import signal
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLIENT = HERE.parents[1]
REPO = CLIENT.parent
SERVER = REPO / 'server'
OUT = HERE / '.out'
MEDIA = OUT / 'media'
OUT.mkdir(exist_ok=True)
MEDIA.mkdir(exist_ok=True)

DEV = 'http://localhost:5199/'
PREVIEW = 'http://localhost:4173/'
SIGNAL = 'ws://localhost:8080'
SIGNAL_QP = 'ws://localhost:8091'

_started = []  # processes this run started (stopped at exit unless KEEP_SERVERS=1)
IS_WIN = os.name == 'nt'
PIDS = OUT / 'servers.json'  # name -> pid of servers started by tests (shared between suites)


def _pids():
    try:
        return json.loads(PIDS.read_text())
    except Exception:  # noqa: BLE001
        return {}


def _save_pid(name, pid):
    pids = _pids()
    if pid is None:
        pids.pop(name, None)
    else:
        pids[name] = pid
    PIDS.write_text(json.dumps(pids))


def _kill_pid(pid):
    try:
        if IS_WIN:
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
        else:
            os.killpg(pid, signal.SIGTERM)  # started in its own session: stops npx and its children
    except (ProcessLookupError, PermissionError, OSError):
        pass


def _answers(url, must_contain=None):
    try:
        req = urllib.request.Request(url)
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=2) as r:
            body = r.read(4096).decode('utf-8', 'ignore')
            return must_contain is None or must_contain in body
    except Exception as e:  # noqa: BLE001 - any failure means "not up"
        return getattr(e, 'code', None) is not None and must_contain is None  # e.g. 503 still means up


def _wait_for(url, seconds=60, must_contain=None):
    end = time.time() + seconds
    while time.time() < end:
        if _answers(url, must_contain):
            return True
        time.sleep(0.5)
    raise RuntimeError(f'{url} did not come up (see logs in {OUT})')


def _spawn(cmd, cwd, log_name, env=None, name=None):
    exe = shutil.which(cmd[0]) or cmd[0]
    log = open(OUT / log_name, 'a')
    kwargs = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if IS_WIN else {'start_new_session': True}
    proc = subprocess.Popen([exe, *cmd[1:]], cwd=str(cwd), stdout=log, stderr=subprocess.STDOUT,
                            env={**os.environ, **(env or {})}, **kwargs)
    _started.append(proc)
    if name:
        _save_pid(name, proc.pid)
    return proc


def _stop(proc):
    if proc.poll() is not None:
        return
    # The whole process group: npx alone would leave its child (vite, node) running
    _kill_pid(proc.pid)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


# Stopped from outside (Ctrl+C, `timeout`): still stop the servers we started
if not IS_WIN:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))


def _stop_listener(port):
    """Stop whatever serves `port` that isn't ours to reuse (a leftover from an earlier run)."""
    if IS_WIN:
        return
    needle = f'--port {port}'
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            cmd = open(f'/proc/{entry}/cmdline', 'rb').read().replace(b'\0', b' ').decode('utf-8', 'ignore')
        except OSError:
            continue
        if 'vite' in cmd and needle in cmd and int(entry) != os.getpid():
            try:
                os.kill(int(entry), signal.SIGTERM)
            except OSError:
                pass


@atexit.register
def _cleanup():
    if os.environ.get('KEEP_SERVERS') == '1':
        return
    for proc in reversed(_started):
        _stop(proc)
    mine = {p.pid for p in _started}
    PIDS.write_text(json.dumps({k: v for k, v in _pids().items() if v not in mine}))


def stop_all():
    """Stop every server the tests started (run_all.py calls this at the end)."""
    for pid in _pids().values():
        _kill_pid(pid)
    PIDS.write_text('{}')


def _wait_gone(url, timeout=15):
    end = time.time() + timeout
    while time.time() < end and _answers(url):
        time.sleep(0.2)


def dev():
    """The Vite dev server (app source)."""
    if not _answers(DEV):
        _spawn(['npx', 'vite', '--port', '5199', '--strictPort'], CLIENT, 'dev.log', name='dev')
        _wait_for(DEV)
    return DEV


_preview_fresh = False


def preview(build=True):
    """A production build of the current code served like the real site (service worker included).
    Rebuilt once per test process, so a server left over from an earlier run never serves old code."""
    global _preview_fresh
    if build and not _preview_fresh and _answers(PREVIEW):
        _stop_listener(4173)
        _wait_gone(PREVIEW)
    if not _answers(PREVIEW):
        _preview_fresh = True
        if build:
            subprocess.run([shutil.which('npx') or 'npx', 'vite', 'build'], cwd=str(CLIENT), check=True,
                           stdout=open(OUT / 'build.log', 'a'), stderr=subprocess.STDOUT)
        _spawn(['npx', 'vite', 'preview', '--port', '4173', '--strictPort'], CLIENT, 'preview.log', name='preview')
        _wait_for(PREVIEW)
    return PREVIEW


MEDIA_SERVER = 'http://localhost:9933'


def media_server():
    """Test media served like a CDN (byte ranges, CORS) on 9933, plus an HLS copy of test_small.mp4."""
    media('test_small.mp4')
    hls_dir = MEDIA / 'hls'
    if not (hls_dir / 'index.m3u8').exists():
        hls_dir.mkdir(exist_ok=True)
        subprocess.run([shutil.which('ffmpeg'), '-y', '-loglevel', 'error', '-i', str(MEDIA / 'test_small.mp4'), '-c', 'copy',
                        '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_time', '4', '-hls_playlist_type', 'vod',
                        '-hls_fmp4_init_filename', 'init.mp4', str(hls_dir / 'index.m3u8')], check=True)
    if not _answers(MEDIA_SERVER + '/__ping'):
        _spawn(['node', str(HERE / 'fixtures' / 'fake_media.mjs'), str(MEDIA), '9933'], HERE, 'fake_media.log', name='fake_media')
        _wait_for(MEDIA_SERVER + '/__ping')
    return MEDIA_SERVER


def signaling():
    """The signaling server on 8080."""
    if not _answers('http://localhost:8080/api/quick-picks'):
        # A fixed secret, like production's saved one: seat tokens survive restart_signaling()
        _spawn(['node', 'server.js'], SERVER, 'signaling.log', {'PORT': '8080', 'SIGNAL_SECRET': 'e2e-tests-secret'}, name='signaling')
        _wait_for('http://localhost:8080/api/quick-picks')
    return SIGNAL


def restart_signaling(down_seconds=0):
    """Stop the 8080 signaling server (it must have been started by the tests), wait, start it again."""
    pid = _pids().get('signaling')
    if not pid:
        raise RuntimeError('restart_signaling needs the signaling server started by the tests '
                           '(stop the one already running on port 8080 and run again)')
    own = next((p for p in _started if p.pid == pid), None)
    if own:
        _stop(own)
    else:
        _kill_pid(pid)
    _save_pid('signaling', None)
    end = time.time() + 10
    while _answers('http://localhost:8080/api/quick-picks') and time.time() < end:
        time.sleep(0.2)
    time.sleep(down_seconds)
    return signaling()


def quickpicks():
    """Fake YouTube API (9911) and a second signaling server (8091) that serves quick picks from it."""
    if not _answers('http://localhost:9911/__calls'):
        _spawn(['node', str(HERE / 'fixtures' / 'fake_youtube.mjs')], HERE, 'fake_youtube.log', name='fake_youtube')
        _wait_for('http://localhost:9911/__calls')
    if not _answers('http://localhost:8091/api/quick-picks', '"categories"'):
        copy = OUT / 'qpserver'
        shutil.rmtree(copy, ignore_errors=True)
        copy.mkdir()
        for f in SERVER.glob('*.js'):
            shutil.copy(f, copy)
        shutil.copy(SERVER / 'package.json', copy)
        node_modules = copy / 'node_modules'
        if IS_WIN:
            shutil.copytree(SERVER / 'node_modules', node_modules)
        else:
            node_modules.symlink_to(SERVER / 'node_modules')
        _spawn(['node', 'server.js'], copy, 'signaling8091.log',
               {'PORT': '8091', 'YOUTUBE_API_KEY': 'test-key', 'YOUTUBE_API_BASE': 'http://localhost:9911'}, name='signaling8091')
        _wait_for('http://localhost:8091/api/quick-picks', 60, '"categories"')
    return SIGNAL_QP


def media(name):
    """Test media made with ffmpeg on first use: test.mp4 (720p), test_small.mp4 (180p),
    uneven.mp4 (heavy first half, calm second), speech.wav (talking with pauses), photo.jpg."""
    path = MEDIA / name
    if path.exists():
        return str(path)
    ff = shutil.which('ffmpeg')
    if not ff:
        raise RuntimeError('ffmpeg is needed to make test media (or put the file in ' + str(MEDIA) + ')')
    if name == 'speech.wav':
        return _make_speech(ff, path)
    if name == 'subs.mkv':
        return _make_subs_mkv(ff, path)
    lavfi = {
        'test.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=60',
                     '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '4M', '-c:a', 'libopus', '-shortest'],
        'test_small.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=60',
                           '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M', '-c:a', 'libopus', '-shortest'],
        'photo.jpg': ['-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1'],
        # Uneven bitrate like a real film: a heavy first half (noise), then a calm one
        'uneven.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=24:duration=70', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=70',
                       '-vf', "noise=alls=45:allf=t+u:enable='between(t,0,35)'", '-c:v', 'libvpx-vp9', '-deadline', 'realtime',
                       '-cpu-used', '8', '-crf', '30', '-b:v', '9M', '-c:a', 'libopus', '-shortest', '-movflags', '+faststart'],
        # Plays as video, but its audio (AC-3) doesn't play in Chromium: the format check warns
        'ac3.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20',
                    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'ac3', '-shortest'],
        # Plays nowhere in a browser (MPEG-4 Part 2 video in AVI)
        'old.avi': ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=5', '-c:v', 'mpeg4', '-an'],
    }[name]
    subprocess.run([ff, '-y', '-loglevel', 'error', *lavfi, str(path)], check=True)
    return str(path)


SRT_LINES = [(1, 3, 'Hello from the English track'), (4, 6, 'Second line\nwith two rows'), (8, 10, 'Third English line')]
ASS_LINES = [(1, 3, 'Hola desde la pista'), (5, 7, '{\\i1}Segunda{\\i0} linea')]


def _make_subs_mkv(ff, path):
    """An MKV (VP9 + two Opus audio tracks) with an English SRT track and a Spanish ASS track."""
    clock = lambda s: f'00:00:{s:02d},000'
    srt = MEDIA / 'subs_en.srt'
    srt.write_text(''.join(f'{i + 1}\n{clock(a)} --> {clock(b)}\n{t}\n\n' for i, (a, b, t) in enumerate(SRT_LINES)))
    ass = MEDIA / 'subs_es.ass'
    ass.write_text('[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
                   'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n'
                   '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
                   + ''.join(f'Dialogue: 0,0:00:{a:02d}.00,0:00:{b:02d}.00,Default,,0,0,0,,{t}\n' for a, b, t in ASS_LINES))
    subprocess.run([ff, '-y', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=20',
                    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=20',
                    '-i', str(srt), '-i', str(ass),
                    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
                    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus', '-c:s:0', 'srt', '-c:s:1', 'ass',
                    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=hin', '-metadata:s:a:1', 'title=Hindi dub',
                    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=spa', '-metadata:s:s:1', 'title=Spanish',
                    '-t', '20', str(path)], check=True)
    return str(path)


def _make_speech(ff, path):
    """Voice for the fake microphone: real synthesized speech with pauses (ffmpeg's flite), so the
    noise removal keeps it like a person talking. Without flite: a voice-like buzz in bursts."""
    clip = MEDIA / 'speech_clip.wav'
    text = 'Hello everyone. Can you hear me now?'
    made = subprocess.run([ff, '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', f"flite=text='{text}'",
                           '-af', 'apad=pad_dur=1.2', '-ar', '48000', '-ac', '1', str(clip)]).returncode == 0
    if not made:
        voice = '+'.join(f'{1 / k:.3f}*sin(2*PI*{140 * k}*t)' for k in range(1, 12))
        subprocess.run([ff, '-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        f"aevalsrc='({voice})*0.25*(0.6+0.4*sin(2*PI*4*t))*lt(mod(t,3),2)':s=48000:d=6",
                        str(clip)], check=True)
    subprocess.run([ff, '-y', '-loglevel', 'error', '-stream_loop', '12', '-i', str(clip), '-t', '30',
                    '-ar', '48000', '-ac', '1', str(path)], check=True)
    return str(path)


# ---- helpers used by the suites --------------------------------------------------------------
_results = []


def check(name, ok, detail=''):
    _results.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail != '' else ''), flush=True)
    return ok


def wait(cond, timeout=10, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        try:
            r = cond()
            if r:
                return r
        except Exception:  # noqa: BLE001 - element not there yet, page navigating...
            pass
        time.sleep(step)
    return None


def summary():
    """Print 'N/M passed' (run_all.py reads it) and exit non-zero on failures."""
    print(f'\n{sum(_results)}/{len(_results)} passed', flush=True)
    sys.exit(0 if _results and all(_results) else 1)


# People really connected (peer connections up), whatever the UI looks like: see people(pg). Part of
# signal_init(); suites with their own init script add it themselves.
PEOPLE_INIT = ("if(!window.__people){window.__pcs=window.__pcs||[];const __P=window.RTCPeerConnection;if(__P){window.RTCPeerConnection=class extends __P{"
               "constructor(...a){super(...a);window.__pcs.push(this)}}}"
               "window.__people=()=>1+window.__pcs.filter(p=>p.connectionState==='connected').length;}")


def signal_init(url):
    """Init script: use this signaling server and record what it sends (window.__sig)."""
    return ("localStorage.setItem('webrtc_signal_url', '%s');localStorage.removeItem('3rtc_quick_picks');"
            "window.__sig=[];const __O=window.WebSocket;window.WebSocket=class extends __O{constructor(...a){super(...a);"
            "this.addEventListener('message',e=>{try{window.__sig.push(JSON.parse(e.data))}catch{}})}};"
            % url) + PEOPLE_INIT


def people(pg):
    """How many people this page is connected with, itself included (live peer connections)."""
    return pg.evaluate("window.__people ? window.__people() : 1")


CHROMIUM_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']


def create_room(pg):
    """Create a room from the home screen (desktop or phone): the "Create a room" button."""
    pg.get_by_role('button', name=re.compile(r'Create a room', re.I)).first.click()


def open_activity(pg, name):
    """Start a game / activity from the menu (phone: More sheet; computer: the Games button)."""
    if pg.locator('.phone-actionbar').count():
        pg.locator('.phone-actionbar').get_by_role('button', name='More').click()
        pg.locator('.phone-row', has_text=name).first.click()
    else:
        pg.get_by_role('button', name='Games').click()
        pg.get_by_role('menuitem', name=re.compile(name)).first.click()


def join_activity(pg, timeout=10):
    """Load a game someone else started: tap its "Join" bubble."""
    bubble = pg.locator('.activity-bubble.is-invite')
    end = time.time() + timeout
    while time.time() < end and bubble.count() == 0:
        time.sleep(0.2)
    bubble.first.click()


def toggle_playback_lock(pg):
    """Host: turn "Only I control playback" on or off (computer: More options menu)."""
    pg.get_by_role('button', name='More options').click()
    pg.get_by_role('menuitemcheckbox', name=re.compile('Only I control playback')).click()


def leave_room(pg):
    """Leave the room with its own button (not a game's Leave)."""
    if pg.locator('.dock-leave').count():
        pg.locator('.dock-leave').click()
    else:
        pg.locator('.phone-actionbar').get_by_role('button', name='More').click()
        pg.get_by_role('button', name=re.compile(r'^\s*Leave room')).click()
    # "Leave room 12345?" (when a video or game is open): confirm
    confirm = pg.locator('.leave-dialog-leave')
    end = time.time() + 2
    while time.time() < end and confirm.count() == 0:
        time.sleep(0.1)
    if confirm.count():
        confirm.first.click()


def mic_button(pg):
    """The microphone on/off button (computer: the dock; phone: the action bar)."""
    if pg.locator('.phone-actionbar').count():
        return pg.locator('.phone-actionbar .phone-action').first
    return pg.locator('.dock-mic-toggle')


def stream_pill(pg):
    """The streamed-video status as text: "Streaming · 42% | <name> · 3.1 MB/s · 60% from viewers"."""
    return pg.evaluate("""(() => { const p = document.querySelector('.local-file-info-pill.is-streamed');
        if (!p) { const old = document.querySelector('.local-filesize-text'); return old ? old.innerText : ''; }
        const label = p.querySelector('.rd-stream-label'); return (label ? label.innerText : '') + ' | ' + (p.title || ''); })()""")


def stream_percent(pg):
    """How much of a streamed video this viewer has (100 once it's all here), or None."""
    text = stream_pill(pg).split(' | ')[0]
    if 'Streamed to you' in text:
        return 100
    m = re.search(r'(\d+)%', text)
    return int(m.group(1)) if m else None
