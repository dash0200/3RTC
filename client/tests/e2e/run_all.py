"""
Run every browser suite (or the ones named), one after another, and print a summary.

    python client/tests/e2e/run_all.py                 # all
    python client/tests/e2e/run_all.py queue host_controls

Needs: Node (with `npm install` done in client/ and server/), Python with Playwright
(`pip install playwright` then `playwright install chromium`), and ffmpeg for the test media.
Servers are started as needed and stopped at the end (set KEEP_SERVERS=1 to keep them).
Logs and screenshots: client/tests/e2e/.out/
"""
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ORDER = [
    'connection', 'devices', 'chat_attach', 'youtube_sync', 'youtube_unavailable', 'host_controls', 'queue', 'quick_picks_region',
    'activities', 'ludo', 'ludo_stack', 'ludo_rejoin', 'ludo_video', 'room_basics', 'host_spoof', 'phone_layout', 'back_button', 'media_links', 'stream', 'stream_uneven',
    'local_video_sync', 'file_format', 'swarm', 'media_session', 'six_people',
]


def main(names):
    suites = [f'{n}_test.py' for n in (names or ORDER)]
    out = HERE / '.out'
    out.mkdir(exist_ok=True)
    env = {**os.environ, 'KEEP_SERVERS': '1'}  # suites share the servers; stopped below
    results = []
    try:
        for suite in suites:
            start = time.time()
            log = out / f'{suite[:-3]}.log'
            with open(log, 'w') as f:
                code = subprocess.run([sys.executable, str(HERE / suite)], cwd=str(HERE), stdout=f, stderr=subprocess.STDOUT, env=env, timeout=900).returncode
            text = log.read_text(errors='ignore')
            m = re.findall(r'^(\d+)/(\d+) passed', text, re.M)
            passed, total = (int(m[-1][0]), int(m[-1][1])) if m else (0, 0)
            ok = bool(m) and passed == total and total > 0
            fails = [line for line in text.splitlines() if line.startswith('FAIL')]
            results.append((suite, ok, passed, total, time.time() - start))
            status = 'ok  ' if ok else 'FAIL'
            print(f'{status} {suite:32} {passed}/{total}  ({time.time() - start:.0f}s)' + ('' if ok or m else f'  crashed (exit {code}), see {log}'), flush=True)
            for line in fails:
                print('       ' + line, flush=True)
    finally:
        # stop the servers the suites started (they were told to keep them for the next suite)
        if os.environ.get('KEEP_SERVERS') != '1':
            sys.path.insert(0, str(HERE))
            import harness
            harness.stop_all()
    passed = sum(r[2] for r in results)
    total = sum(r[3] for r in results)
    bad = [r[0] for r in results if not r[1]]
    print(f'\n{passed}/{total} checks passed in {len(results)} suites' + (f'; failing: {", ".join(bad)}' if bad else ''))
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
