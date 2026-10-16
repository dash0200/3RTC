"""Paste anything: direct video links, HLS streams, Vimeo, Twitch, played in sync between a computer
and a phone (play, pause, seek, late joiner, queue, exit), links that can't be played explained,
the host controls lock, and the automatic re-sync (link and YouTube)."""
import os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import check, wait  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = harness.dev()
INIT = harness.signal_init(harness.signaling())
MEDIA = harness.media_server()
FILE = f'{MEDIA}/test_small.mp4'
HLS = f'{MEDIA}/hls/index.m3u8'
errors = []

# Stand-ins for the Vimeo and Twitch player APIs and YouTube (a clock plus the same events).
# window.__players[...] calls are what a person does on the provider's own controls.
FAKES = r"""
(() => {
  const clock = (self) => { if (!self.paused) { const n = performance.now(); self.t += (n - self.at) / 1000; self.at = n; } return self.t; };
  window.__players = [];
  window.Vimeo = { Player: class {
    constructor(el, opts) { this.opts = opts; this.h = {}; this.paused = true; this.t = 0; this.at = performance.now(); this.kind = 'vimeo';
      el.appendChild(document.createElement('iframe')); window.__players.push(this);
      setTimeout(() => { this._emit('loaded', {}); if (opts.autoplay) this.play(); }, 150); }
    _emit(ev, d) { (this.h[ev] || []).forEach((f) => setTimeout(() => f(d), 20)); }
    on(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); }
    ready() { return Promise.resolve(); }
    play() { clock(this); this.at = performance.now(); if (this.paused) { this.paused = false; this._emit('play', { seconds: this.t }); } return Promise.resolve(); }
    pause() { clock(this); if (!this.paused) { this.paused = true; this._emit('pause', { seconds: this.t }); } return Promise.resolve(); }
    setCurrentTime(t) { clock(this); this.t = t; this.at = performance.now(); this._emit('seeked', { seconds: t }); return Promise.resolve(t); }
    getCurrentTime() { return Promise.resolve(clock(this)); }
    getDuration() { return Promise.resolve(600); }
    destroy() { this.gone = true; return Promise.resolve(); }
  } };
  const TP = class {
    constructor(id, opts) { this.opts = opts; this.h = {}; this.paused = true; this.t = 0; this.at = performance.now(); this.kind = 'twitch';
      document.getElementById(id).appendChild(document.createElement('iframe')); window.__players.push(this);
      setTimeout(() => { this._emit(TP.READY); if (opts.autoplay) this.play(); }, 150); }
    _emit(ev, d) { (this.h[ev] || []).forEach((f) => setTimeout(() => f(d), 20)); }
    addEventListener(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); }
    play() { clock(this); this.at = performance.now(); if (this.paused) { this.paused = false; this._emit(TP.PLAY); } }
    pause() { clock(this); if (!this.paused) { this.paused = true; this._emit(TP.PAUSE); } }
    seek(t) { clock(this); this.t = t; this.at = performance.now(); this._emit(TP.SEEK, { position: t }); }
    getCurrentTime() { return clock(this); } getDuration() { return 600; } isPaused() { return this.paused; }
  };
  Object.assign(TP, { READY: 'ready', PLAY: 'play', PAUSE: 'pause', SEEK: 'seek', ENDED: 'ended', PLAYING: 'playing', ONLINE: 'online', OFFLINE: 'offline' });
  window.Twitch = { Player: TP };
  window.YT = { PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: class {
      constructor(el, opts) { this.o = opts; this.state = -1; this.t = 0; this.rate = 1; this.at = performance.now(); window.__yt = this;
        setTimeout(() => { opts.events.onReady?.({ target: this }); }, 200); }
      _now() { if (this.state === 1) { const n = performance.now(); this.t += (n - this.at) / 1000 * this.rate; this.at = n; } return this.t; }
      _set(s) { this._now(); this.at = performance.now(); if (s !== this.state) { this.state = s; setTimeout(() => this.o.events.onStateChange?.({ data: s, target: this }), 30); } }
      playVideo() { this._set(1); } pauseVideo() { this._set(2); }
      seekTo(t) { this._now(); this.t = t; this.at = performance.now(); }
      loadVideoById() {} destroy() {} getCurrentTime() { return this._now(); } getDuration() { return 600; } getPlayerState() { return this.state; }
      getVolume() { return 100; } isMuted() { return false; } setVolume() {} mute() {} unMute() {} getVideoData() { return { title: '' }; }
    } };
})();
"""

VIDEO = "document.querySelector('.link-player-video')"


def vt(pg):
    return pg.evaluate(f"(() => {{ const v = {VIDEO}; return v ? {{ t: +v.currentTime.toFixed(2), paused: v.paused, rs: v.readyState }} : null; }})()")


def player(pg):
    return pg.evaluate("(() => { const p = (window.__players || []).filter((x) => !x.gone).pop(); if (!p) return null; "
                       "const t = p.paused ? p.t : p.t + (performance.now() - p.at) / 1000; return { kind: p.kind, t: +t.toFixed(2), paused: p.paused, opts: JSON.parse(JSON.stringify(p.opts)) }; })()")


def paste_desktop(pg, link):
    box = pg.locator('.paste-link-input') if pg.locator('.paste-link-input').count() else pg.locator('.stage-canvas').get_by_placeholder(re.compile('Paste a (new )?link')).first
    box.fill(link)
    box.press('Enter')


with sync_playwright() as p:
    b = p.chromium.launch(args=harness.CHROMIUM_ARGS)
    host = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    phone = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2).new_page()
    for pg in (host, phone):
        pg.add_init_script(INIT); pg.add_init_script(FAKES)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
    host.goto(BASE); host.wait_for_timeout(1500)
    harness.create_room(host)
    room = wait(lambda: next((m['roomId'] for m in host.evaluate('window.__sig') if m.get('type') == 'room-created'), None), 10)
    phone.goto(f'{BASE}?room={room}'); phone.wait_for_timeout(1500); phone.get_by_role('button', name='Join room').click()
    check('connected', wait(lambda: harness.people(host) >= 2, 25))
    time.sleep(1)

    # ---- links that can't be played say why, and nothing opens ----
    paste_desktop(host, 'https://www.netflix.com/watch/80100172')
    check('a Netflix link is explained (protected)', wait(lambda: 'protected' in host.locator('.yt-url-error').inner_text(), 4))
    host.locator('.stage-canvas').get_by_placeholder(re.compile(r'Paste a (YouTube|link)|or \.mp4 link')).fill('')
    paste_desktop(host, f'{MEDIA}/page')
    check('a page that isn\'t a video is explained (checked before anyone loads it)',
          wait(lambda: "isn't a video" in host.locator('.yt-url-error').inner_text(), 12) and phone.locator('.link-player').count() == 0)

    # ---- a direct video link ----
    paste_desktop(host, FILE)
    check('a pasted video link opens for both', wait(lambda: host.locator('.link-player').count() == 1 and phone.locator('.link-player').count() == 1, 10))
    check('...and plays on the phone', wait(lambda: (vt(phone) or {}).get('t', 0) > 1 and not vt(phone)['paused'], 15), vt(phone))
    check('the title is the file name', 'test_small.mp4' in phone.locator('.link-player-title').inner_text())
    host.evaluate(f"{VIDEO}.pause()")
    check('host pauses (the player\'s own controls): the phone pauses at the same spot',
          wait(lambda: vt(phone)['paused'] and abs(vt(phone)['t'] - vt(host)['t']) < 1, 5), [vt(host), vt(phone)])
    phone.evaluate(f"{VIDEO}.currentTime = 30")
    check('phone seeks: the host follows', wait(lambda: abs(vt(host)['t'] - 30) < 1, 6), vt(host))
    phone.evaluate(f"{VIDEO}.play()")
    check('phone plays: the host plays', wait(lambda: not vt(host)['paused'] and vt(host)['t'] > 30, 6), vt(host))

    # ---- automatic re-sync: the phone falls behind quietly (slow playback, no events) ----
    phone.evaluate(f"{VIDEO}.playbackRate = 0.3")
    time.sleep(4)
    phone.evaluate(f"{VIDEO}.playbackRate = 1")
    behind = vt(host)['t'] - vt(phone)['t']
    check('auto re-sync brings a drifted player back (no one pressed anything)',
          behind > 1.5 and wait(lambda: abs(vt(host)['t'] - vt(phone)['t']) < 1.2, 14), f'was {behind:.1f}s behind, now {[vt(host), vt(phone)]} drift={phone.evaluate("window.__3rtcDrift")}')

    # ---- someone joining later lands on the same video at the same spot ----
    late = b.new_context(viewport={'width': 1280, 'height': 800}).new_page()
    late.add_init_script(INIT); late.add_init_script(FAKES); late.on('pageerror', lambda e: errors.append(str(e)))
    late.goto(f'{BASE}?room={room}'); late.wait_for_timeout(1200); late.get_by_role('button', name='Join Room').click()
    check('a late joiner gets the video at the room\'s spot',
          wait(lambda: vt(late) is not None and abs(vt(late)['t'] - vt(host)['t']) < 2 and not vt(late)['paused'], 20), [vt(host), vt(late)])
    late.context.close()

    # ---- the queue takes links too ----
    host.locator('.chat-tab-btn', has_text='Queue').first.click()
    qbox = host.get_by_placeholder(re.compile(r'Paste a (YouTube|link)|or \.mp4 link'))
    qbox.fill(HLS); qbox.press('Enter')
    ok = check('a stream link goes into the queue (with its icon)', wait(lambda: host.locator('.queue-item-card .queue-item-thumb-link').count() == 1, 6))
    if not ok:
        host.screenshot(path=str(harness.OUT / 'links_queue.png'))
    nxt = host.locator('.btn-next-inline')
    if not wait(lambda: nxt.count() > 0 and nxt.first.is_visible(), 5):
        host.screenshot(path=str(harness.OUT / 'links_next.png'))
    nxt.first.click(timeout=5000)
    check('Next plays the stream (HLS) for both', wait(lambda: 'stream' in phone.locator('.link-player-badge').inner_text().lower() and (vt(phone) or {}).get('t', 0) > 1, 20), vt(phone))

    # ---- Vimeo, pasted on the phone ----
    phone.get_by_role('button', name='Add video').last.click()
    phone.get_by_placeholder(re.compile(r'Paste a (YouTube|link)|or \.mp4 link')).fill('https://vimeo.com/76979871')
    phone.get_by_role('button', name=re.compile('Play for everyone')).click()
    check('a Vimeo link from the phone opens the Vimeo player for both',
          wait(lambda: (player(host) or {}).get('kind') == 'vimeo' and (player(phone) or {}).get('kind') == 'vimeo', 10)
          and player(host)['opts']['url'] == 'https://vimeo.com/76979871')
    check('...and plays', wait(lambda: not player(host)['paused'] and not player(phone)['paused'], 5))
    host.evaluate("window.__players.filter((x) => !x.gone).pop().pause()")
    check('Vimeo pause syncs', wait(lambda: player(phone)['paused'], 5), player(phone))
    phone.evaluate("window.__players.filter((x) => !x.gone).pop().setCurrentTime(123)")
    check('Vimeo seek syncs', wait(lambda: abs(player(host)['t'] - 123) < 1, 5), player(host))

    # ---- Twitch live channel ----
    paste_desktop(host, 'https://www.twitch.tv/SomeStreamer')
    check('a Twitch channel opens live for both', wait(lambda: (player(phone) or {}).get('kind') == 'twitch' and player(phone)['opts'].get('channel') == 'somestreamer', 10)
          and 'LIVE' in phone.locator('.link-player-badge').inner_text(), [player(phone), phone.locator('.link-player-badge').all_inner_texts()])
    check('Twitch gets this site as its parent', player(host)['opts'].get('parent') == ['localhost'])
    wait(lambda: not player(host)['paused'] and not player(phone)['paused'], 5)
    phone.evaluate("window.__players.filter((x) => !x.gone).pop().pause()")
    check('Twitch pause syncs', wait(lambda: player(host)['paused'], 5), [player(host), player(phone), host.locator('.link-player-status').inner_text()])

    # ---- host controls lock applies to links ----
    host.locator('.stage-more-wrap .circle-action-btn').click(); host.get_by_role('menuitemcheckbox', name=re.compile('Only I control playback')).click()
    wait(lambda: phone.locator('.phone-lock-pill').count() == 1, 5)
    phone.get_by_role('button', name='Add video').last.click()
    phone.get_by_placeholder(re.compile(r'Paste a (YouTube|link)|or \.mp4 link')).fill(FILE)
    phone.get_by_role('button', name=re.compile('Play for everyone')).click()
    time.sleep(2)
    check('with the lock on, a guest\'s link doesn\'t replace the host\'s video', (player(host) or {}).get('kind') == 'twitch' and host.locator('.link-player-video').count() == 0)
    host.locator('.stage-more-wrap .circle-action-btn').click(); host.get_by_role('menuitemcheckbox', name=re.compile('Only I control playback')).click()

    # ---- Exit closes it for everyone ----
    host.locator('.link-player-exit').click()
    check('Exit Video closes it for both', wait(lambda: host.locator('.link-player').count() == 0 and phone.locator('.link-player').count() == 0, 5))

    # ---- automatic re-sync on YouTube too ----
    paste_desktop(host, 'https://youtu.be/aqz-KE-bpKQ')
    check('YouTube still loads from the same box', wait(lambda: phone.evaluate('!!window.__yt') and phone.evaluate('window.__yt.state') == 1, 10))
    time.sleep(6)
    phone.evaluate("window.__yt._now(); window.__yt.rate = 0.3")  # quietly falls behind, no events
    time.sleep(4.5)
    phone.evaluate("window.__yt._now(); window.__yt.rate = 1")
    yt_t = lambda pg: pg.evaluate('window.__yt.getCurrentTime()')
    gap = yt_t(host) - yt_t(phone)
    check('auto re-sync works for YouTube too', gap > 1.5 and wait(lambda: abs(yt_t(host) - yt_t(phone)) < 1.2, 14), f'was {gap:.1f}s behind, now {[yt_t(host), yt_t(phone)]}')

    check('no page errors', not errors, errors[:3])
    b.close()
harness.summary()
