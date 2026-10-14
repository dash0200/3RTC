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
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


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


def dev():
    """The Vite dev server (app source)."""
    if not _answers(DEV):
        _spawn(['npx', 'vite', '--port', '5199', '--strictPort'], CLIENT, 'dev.log', name='dev')
        _wait_for(DEV)
    return DEV


def preview(build=True):
    """A production build served like the real site (service worker included)."""
    if not _answers(PREVIEW):
        if build:
            subprocess.run([shutil.which('npx') or 'npx', 'vite', 'build'], cwd=str(CLIENT), check=True,
                           stdout=open(OUT / 'build.log', 'a'), stderr=subprocess.STDOUT)
        _spawn(['npx', 'vite', 'preview', '--port', '4173', '--strictPort'], CLIENT, 'preview.log', name='preview')
        _wait_for(PREVIEW)
    return PREVIEW


def signaling():
    """The signaling server on 8080."""
    if not _answers('http://localhost:8080/api/quick-picks'):
        _spawn(['node', 'server.js'], SERVER, 'signaling.log', {'PORT': '8080'}, name='signaling')
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
    speech.wav (talking with pauses), photo.jpg."""
    path = MEDIA / name
    if path.exists():
        return str(path)
    ff = shutil.which('ffmpeg')
    if not ff:
        raise RuntimeError('ffmpeg is needed to make test media (or put the file in ' + str(MEDIA) + ')')
    if name == 'speech.wav':
        return _make_speech(ff, path)
    lavfi = {
        'test.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=60',
                     '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '4M', '-c:a', 'libopus', '-shortest'],
        'test_small.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=60',
                           '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M', '-c:a', 'libopus', '-shortest'],
        'photo.jpg': ['-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1'],
    }[name]
    subprocess.run([ff, '-y', '-loglevel', 'error', *lavfi, str(path)], check=True)
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


def signal_init(url):
    """Init script: use this signaling server and record what it sends (window.__sig)."""
    return ("localStorage.setItem('webrtc_signal_url', '%s');localStorage.removeItem('3rtc_quick_picks');"
            "window.__sig=[];const __O=window.WebSocket;window.WebSocket=class extends __O{constructor(...a){super(...a);"
            "this.addEventListener('message',e=>{try{window.__sig.push(JSON.parse(e.data))}catch{}})}};" % url)


CHROMIUM_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
