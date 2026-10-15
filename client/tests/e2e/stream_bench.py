"""Streaming on a realistic connection: a variable-bitrate movie over a simulated internet link
(limited speed, ~70 ms round trip, short freezes like Wi-Fi hiccups). Measures how often and how
long the viewer's video stalls while the room plays.

    python client/tests/e2e/stream_bench.py [seconds] [MB/s] [one-way delay ms] [freeze s] [file in .out/media]
"""
import os, re, sys, time, json, shutil, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PLAY_SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 150
LINK_MBS = float(sys.argv[2]) if len(sys.argv) > 2 else 1.6
DELAY_MS = int(sys.argv[3]) if len(sys.argv) > 3 else 35
FREEZE_EVERY_S = 20
FREEZE_FOR_S = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5

BASE = harness.preview()
INIT = harness.signal_init(harness.signaling())


MOVIE = sys.argv[5] if len(sys.argv) > 5 else 'movie.mp4'


def movie():
    path = harness.MEDIA / MOVIE
    if MOVIE != 'movie.mp4':
        return str(path)  # your own file, in client/tests/e2e/.out/media
    if not path.exists():
        # Like a real film (VP9: the test browser has no H.264): calm scenes, then noisy ones that need ~3x the bits
        subprocess.run([shutil.which('ffmpeg'), '-y', '-loglevel', 'error',
                        '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=24:duration=240',
                        '-f', 'lavfi', '-i', 'sine=frequency=330:duration=240',
                        '-vf', "noise=alls=45:allf=t+u:enable='between(mod(t,45),30,42)'",
                        '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '30', '-b:v', '9M',
                        '-c:a', 'libopus', '-shortest', str(path)], check=True)
    return str(path)


# The 'bulk' data channel goes through a simulated link: a send queue drained at LINK_MBS, each
# message arriving DELAY_MS later, with periodic freezes. bufferedAmount and 'bufferedamountlow'
# reflect the queue, like a real slow connection pushing back.
LINK = r"""
(() => {
  const RATE = %(rate)f * 1024 * 1024, DELAY = %(delay)d, EVERY = %(every)d * 1000, FOR = %(for)d;
  const orig = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
    const ch = orig.call(this, label, opts);
    if (label !== 'bulk') return ch;
    const realSend = ch.send.bind(ch);
    const q = []; let queued = 0, low = 0, credit = 0, last = performance.now(), wasHigh = false;
    const t0 = performance.now();
    const size = (m) => typeof m === 'string' ? m.length : (m.byteLength ?? m.size ?? 0);
    Object.defineProperty(ch, 'bufferedAmount', { get: () => queued });
    Object.defineProperty(ch, 'bufferedAmountLowThreshold', { get: () => low, set: (v) => { low = v; } });
    const addL = ch.addEventListener.bind(ch);
    ch.addEventListener = (type, fn, o) => addL(type, type === 'bufferedamountlow' ? (e) => { if (e.__emu) fn(e); } : fn, o);
    ch.send = (m) => { if (ch.readyState !== 'open') throw new Error('closed'); q.push(m); queued += size(m); wasHigh = wasHigh || queued > low; };
    const tick = () => {
      const now = performance.now();
      const frozen = ((now - t0) %% EVERY) > EVERY - FOR;
      credit = frozen ? 0 : Math.min(credit + RATE * (now - last) / 1000, 256 * 1024);
      last = now;
      while (q.length && (typeof q[0] === 'string' || credit >= size(q[0]))) {
        const m = q.shift(); const n = size(m); queued -= n; if (typeof m !== 'string') credit -= n;
        setTimeout(() => { try { realSend(m); } catch {} }, DELAY);
      }
      if (wasHigh && queued <= low) { wasHigh = false; const e = new Event('bufferedamountlow'); e.__emu = true; ch.dispatchEvent(e); }
    };
    setInterval(tick, 5);
    return ch;
  };
})();
""" % {'rate': LINK_MBS, 'delay': DELAY_MS, 'every': FREEZE_EVERY_S, 'for': int(FREEZE_FOR_S * 1000)}

WATCH = r"""
(() => {
  window.__stall = { count: 0, ms: 0, since: 0, started: 0, ahead: [], at: [], seeks: [], pauses: [] };
  const hook = (v) => {
    if (v.__hooked) return; v.__hooked = true;
    let lastT = 0; setInterval(() => { if (!v.seeking) lastT = v.currentTime; }, 100);
    v.addEventListener('seeking', () => window.__stall.seeks.push([+lastT.toFixed(1), +v.currentTime.toFixed(1), Math.round(performance.now() / 1000)]));
    v.addEventListener('pause', () => window.__stall.pauses.push([+v.currentTime.toFixed(1), Math.round(performance.now() / 1000)]));
    v.addEventListener('waiting', () => { const s = window.__stall; if (s.started && !s.since) { s.since = performance.now(); s.count++; s.at.push(+v.currentTime.toFixed(1)); } });
    v.addEventListener('playing', () => { const s = window.__stall; if (!s.started) s.started = performance.now();
      if (s.since) { s.ms += performance.now() - s.since; s.since = 0; } });
  };
  setInterval(() => {
    const v = document.querySelector('video'); if (!v) return; hook(v);
    let ahead = 0; for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
    window.__stall.ahead.push(+ahead.toFixed(1));
  }, 1000);
})();
"""

with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    pages = []
    for _ in range(2):
        pg = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
        pg.add_init_script(INIT); pg.add_init_script(LINK); pg.add_init_script(WATCH)
        pg.on('dialog', lambda d: d.accept())
        pages.append(pg)
    host, guest = pages
    for pg in pages:
        pg.goto(BASE + '/'); wait(lambda: pg.evaluate('!!navigator.serviceWorker.controller'), 10) or (pg.reload(), time.sleep(2))
    host.locator('button.btn.btn-primary', has_text=re.compile('Create', re.I)).first.click()
    host.get_by_role('button', name=re.compile('Generate 5-Digit Room')).click()
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    guest.goto(f'{BASE}/?room={room}'); time.sleep(1.5); guest.get_by_role('button', name='Join Room').click()
    wait(lambda: host.locator('.stage-voice-chip').count() >= 2, 25); time.sleep(2)

    host.set_input_files('input[accept*="video/mp4"]', movie())
    btn = guest.get_by_role('button', name=re.compile('Stream from Peer'))
    wait(lambda: btn.count() > 0, 20)
    t0 = time.time(); btn.first.click()
    ready = wait(lambda: guest.evaluate("(document.querySelector('video')||{}).readyState >= 3"), 60, 0.1)
    t_start = time.time() - t0
    host.evaluate("const v = document.querySelector('video'); v.muted = true; v.play()")
    end = time.time() + PLAY_SECONDS
    while time.time() < end:
        time.sleep(10)
        s = guest.evaluate("({t: document.querySelector('video').currentTime, ...window.__stall, ahead: window.__stall.ahead.slice(-1)[0]})")
        print(f"  t={s['t']:6.1f}s  stalls={s['count']}  stalled={s['ms'] / 1000:5.1f}s  buffered ahead={s['ahead']}s  {guest.locator('.local-filesize-text').inner_text() if guest.locator('.local-filesize-text').count() else ''}", flush=True)
    print('guest video:', guest.evaluate("(() => { const v = document.querySelector('video'); const r = []; for (let i = 0; i < v.buffered.length; i++) r.push([+v.buffered.start(i).toFixed(1), +v.buffered.end(i).toFixed(1)]); return { t: v.currentTime, rs: v.readyState, ns: v.networkState, paused: v.paused, seeking: v.seeking, err: v.error && [v.error.code, v.error.message], buffered: r, dur: v.duration, src: v.currentSrc.slice(0, 60) }; })()"))
    hs = host.evaluate("window.__stall")
    print('host seeks [from, to, at s]:', hs['seeks'], 'pauses:', hs['pauses'])
    print('guest seeks:', guest.evaluate("window.__stall.seeks"), 'pauses:', guest.evaluate("window.__stall.pauses"))
    print('host (plays its own file, so its stalls are this machine being too slow):', hs['count'], 'stalls at', hs['at'])
    s = guest.evaluate("window.__stall")
    hv = host.evaluate("document.querySelector('video').currentTime"); gv = guest.evaluate("document.querySelector('video').currentTime")
    ahead = s['ahead'][5:] or [0]
    print(json.dumps({'link_MBs': LINK_MBS, 'rtt_ms': 2 * DELAY_MS, 'start_s': round(t_start, 1), 'stalls': s['count'],
                      'stalled_s': round(s['ms'] / 1000, 1), 'min_ahead_s': min(ahead), 'avg_ahead_s': round(sum(ahead) / len(ahead), 1),
                      'host_t': round(hv, 1), 'guest_t': round(gv, 1), 'stall_at': s['at']}))
    b.close()
