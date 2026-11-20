"""Makes the synthesised soundboard clips for both apps.

Every clip here is generated from scratch by the code below (oscillators, noise and envelopes,
seeded so each run gives the same result): no samples or recordings are used, so the clips are
ours and free to use (CC0). Run from the repository root:

    python desktop/packaging/make-sounds.py

It needs ffmpeg on PATH (libmp3lame). For each clip it writes
  client-ts/public/sounds/<id>.mp3            the web app's file (48 kHz mono, 96 kbit/s)
  desktop/crates/app/assets/sounds/<id>.pcm   that same MP3 decoded to 48 kHz mono s16le,
                                              as the desktop app's other clips are made
so both apps play the same sound. Add a new clip to `CLIPS` here, to `SOUNDBOARD_CLIPS` and
`SOUND_URL_MAP` in client-ts/src/utils/soundboard.ts and to `CLIPS` in
desktop/crates/app/src/sounds.rs, with the same id, name and emoji.
"""

import math
import os
import random
import struct
import subprocess
import sys
import tempfile
import wave

RATE = 48_000
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WEB = os.path.join(ROOT, "client-ts", "public", "sounds")
DESKTOP = os.path.join(ROOT, "desktop", "crates", "app", "assets", "sounds")
TAU = 2 * math.pi


def n(secs):
    return int(round(secs * RATE))


def silence(secs):
    return [0.0] * n(secs)


def mix_into(out, part, at):
    start = n(at)
    if len(out) < start + len(part):
        out.extend([0.0] * (start + len(part) - len(out)))
    for i, v in enumerate(part):
        out[start + i] += v


def osc(shape, freq, secs, env, phase=0.0):
    """freq and env are functions of time (s); shape takes a phase in 0..1."""
    out = []
    for i in range(n(secs)):
        t = i / RATE
        phase += freq(t) / RATE
        out.append(shape(phase % 1.0) * env(t))
    return out


def sine(p):
    return math.sin(TAU * p)


def square(p):
    return 1.0 if p < 0.5 else -1.0


def saw(p):
    return 2.0 * p - 1.0


def tri(p):
    return 1.0 - 4.0 * abs(p - 0.5)


def adsr(a, d, s, r, secs, peak=1.0):
    def env(t):
        if t < a:
            return peak * t / a
        if t < a + d:
            return peak * (1 - (1 - s) * (t - a) / d)
        if t < secs - r:
            return peak * s
        return peak * s * max(0.0, (secs - t) / r)

    return env


def decay(rate, peak=1.0, attack=0.004):
    def env(t):
        return peak * min(1.0, t / attack) * math.exp(-rate * t)

    return env


def lowpass(samples, cutoff):
    """One-pole low-pass; cutoff in Hz (a number or a function of time)."""
    out, y = [], 0.0
    for i, x in enumerate(samples):
        c = cutoff(i / RATE) if callable(cutoff) else cutoff
        a = 1 - math.exp(-TAU * c / RATE)
        y += a * (x - y)
        out.append(y)
    return out


def bandpass(samples, centre, q):
    """State-variable band-pass; centre in Hz, a function of time."""
    out, low, band = [], 0.0, 0.0
    for i, x in enumerate(samples):
        f = 2 * math.sin(math.pi * min(centre(i / RATE), RATE / 6) / RATE)
        high = x - low - band / q
        band += f * high
        low += f * band
        out.append(band)
    return out


def noise(secs, rng):
    return [rng.uniform(-1, 1) for _ in range(n(secs))]


def bell(freq, secs, peak, rate=3.0):
    """An inharmonic bell: a few partials, the higher ones dying sooner."""
    out = [0.0] * n(secs)
    for ratio, amp, r in ((1.0, 1.0, 1.0), (2.76, 0.5, 1.8), (5.4, 0.25, 3.0), (8.93, 0.12, 4.5)):
        part = osc(sine, lambda t, f=freq * ratio: f, secs, decay(rate * r, peak * amp, 0.002))
        for i, v in enumerate(part):
            out[i] += v
    return out


def note(f):
    """Frequency of a MIDI note number."""
    return 440.0 * 2 ** ((f - 69) / 12)


# ---- the clips ----------------------------------------------------------------------------------


def boing():
    secs = 0.8
    freq = lambda t: 190 + 140 * t / secs + 70 * math.sin(TAU * 11 * t) * math.exp(-3.5 * t)
    return osc(sine, freq, secs, decay(3.2, 0.8))


def laser():
    secs = 0.38
    freq = lambda t: 2400 * (180 / 2400) ** (t / secs)
    return lowpass(osc(square, freq, secs, decay(5.0, 0.35, 0.002)), 6000)


def tada():
    out = []
    mix_into(out, lowpass(osc(saw, lambda t: note(67), 0.16, adsr(0.01, 0.05, 0.7, 0.05, 0.16, 0.22)), 2600), 0)
    for k in (72, 76, 79, 84):
        tone = osc(saw, lambda t, f=note(k): f * (1 + 0.004 * math.sin(TAU * 5.5 * t)), 1.1,
                   adsr(0.02, 0.15, 0.6, 0.45, 1.1, 0.16))
        mix_into(out, lowpass(tone, 3000), 0.18)
    return out


def ding():
    return bell(1318.5, 1.6, 0.5, 2.2)


def whoosh(rng):
    secs = 0.7
    centre = lambda t: 300 * (3200 / 300) ** min(1.0, t / 0.35) if t < 0.35 else 3200 * (500 / 3200) ** ((t - 0.35) / 0.35)
    swell = lambda t: math.sin(math.pi * t / secs) ** 2
    out = bandpass(noise(secs, rng), centre, 2.5)
    return [v * swell(i / RATE) * 0.9 for i, v in enumerate(out)]


def bubble():
    out = []
    for at, base in ((0.0, 420), (0.14, 560), (0.26, 380)):
        part = osc(sine, lambda t, b=base: b * (1 + 2.2 * min(1.0, t / 0.07)), 0.12, decay(28, 0.7, 0.003))
        mix_into(out, part, at)
    return out


def coin():
    out = []
    mix_into(out, osc(square, lambda t: 1046.5, 0.07, lambda t: 0.22), 0)
    mix_into(out, osc(square, lambda t: 1568.0, 0.45, decay(7.0, 0.22, 0.002)), 0.07)
    return lowpass(out, 7000)


def levelup():
    out = []
    for i, k in enumerate((60, 64, 67, 72, 76, 79)):
        mix_into(out, osc(square, lambda t, f=note(k): f, 0.09, adsr(0.003, 0.02, 0.8, 0.02, 0.09, 0.2)), i * 0.075)
    mix_into(out, osc(square, lambda t: note(84), 0.4, decay(5.0, 0.2, 0.003)), 6 * 0.075)
    return lowpass(out, 6000)


def buzzer():
    secs = 0.75
    env = adsr(0.01, 0.05, 0.9, 0.08, secs, 0.3)
    a = osc(saw, lambda t: 110.0, secs, env)
    b = osc(square, lambda t: 116.5, secs, env)
    return lowpass([x + 0.6 * y for x, y in zip(a, b)], 2200)


def correct():
    out = []
    mix_into(out, bell(880.0, 0.5, 0.35, 4.0), 0)
    mix_into(out, bell(1318.5, 0.8, 0.35, 3.0), 0.12)
    return out


def slidewhistle():
    secs = 1.1

    def freq(t):
        x = t / secs
        base = 600 * (1900 / 600) ** (x / 0.55) if x < 0.55 else 1900 * (700 / 1900) ** ((x - 0.55) / 0.45)
        return base * (1 + 0.012 * math.sin(TAU * 6 * t))

    return osc(sine, freq, secs, adsr(0.04, 0.1, 0.85, 0.15, secs, 0.45))


def heartbeat():
    out = []
    for beat in (0.0, 0.8):
        for at, amp in ((0.0, 0.9), (0.22, 0.65)):
            thump = osc(sine, lambda t: 62 * (1 + 0.6 * math.exp(-40 * t)), 0.25, decay(16, amp, 0.006))
            mix_into(out, thump, beat + at)
    mix_into(out, silence(0.2), 1.4)
    return lowpass(out, 400)


def siren():
    secs = 1.3
    freq = lambda t: 960.0 if int(t / 0.325) % 2 == 0 else 770.0
    tone = osc(tri, freq, secs, adsr(0.02, 0.05, 0.9, 0.1, secs, 0.4))
    return lowpass(tone, 4000)


def ticktock(rng):
    out = []
    for i in range(4):
        click = bandpass(noise(0.03, rng), lambda t, c=(2600 if i % 2 == 0 else 1700): c, 8.0)
        env = decay(160, 1.6, 0.0005)
        mix_into(out, [v * env(j / RATE) for j, v in enumerate(click)], i * 0.28)
    mix_into(out, silence(0.15), 0.84)
    return out


def doorbell():
    out = []
    mix_into(out, bell(note(76), 1.0, 0.4, 2.0), 0)
    mix_into(out, bell(note(72), 1.3, 0.4, 1.8), 0.45)
    return out


def thunder(rng):
    secs = 2.2
    brown, y = [], 0.0
    for _ in range(n(secs)):
        y = 0.98 * y + rng.uniform(-1, 1) * 0.2
        brown.append(y)
    rumble = lowpass(brown, lambda t: 900 * math.exp(-1.6 * t) + 120)
    crack = bandpass(noise(0.25, rng), lambda t: 2500, 1.2)
    env = lambda t: min(1.0, t / 0.03) * (0.4 + 0.6 * math.exp(-2.0 * t)) * max(0.0, 1 - t / secs) ** 0.6
    out = [v * env(i / RATE) * 1.6 for i, v in enumerate(rumble)]
    mix_into(out, [v * math.exp(-14 * i / RATE) * 0.5 for i, v in enumerate(crack)], 0.0)
    return out


# id: maker (all take a seeded random source when they need noise)
CLIPS = {
    "boing": lambda rng: boing(),
    "laser": lambda rng: laser(),
    "tada": lambda rng: tada(),
    "ding": lambda rng: ding(),
    "whoosh": whoosh,
    "bubble": lambda rng: bubble(),
    "coin": lambda rng: coin(),
    "levelup": lambda rng: levelup(),
    "buzzer": lambda rng: buzzer(),
    "correct": lambda rng: correct(),
    "slidewhistle": lambda rng: slidewhistle(),
    "heartbeat": lambda rng: heartbeat(),
    "siren": lambda rng: siren(),
    "ticktock": ticktock,
    "doorbell": lambda rng: doorbell(),
    "thunder": thunder,
}


def normalise(samples, rms=0.06, peak=0.9):
    """As loud as the other clips (their RMS is about 0.02-0.06), never clipping."""
    top = max(abs(v) for v in samples) or 1.0
    level = math.sqrt(sum(v * v for v in samples) / len(samples)) or 1.0
    gain = min(rms / level, peak / top)
    fade = n(0.01)
    out = [v * gain for v in samples]
    for i in range(min(fade, len(out))):
        out[-1 - i] *= i / fade
    return out


def write_wav(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767)) for v in samples))


def main():
    os.makedirs(WEB, exist_ok=True)
    os.makedirs(DESKTOP, exist_ok=True)
    only = set(sys.argv[1:])
    with tempfile.TemporaryDirectory() as tmp:
        for i, (cid, make) in enumerate(CLIPS.items()):
            if only and cid not in only:
                continue
            samples = normalise(make(random.Random(1000 + i)))
            wav = os.path.join(tmp, f"{cid}.wav")
            mp3 = os.path.join(WEB, f"{cid}.mp3")
            pcm = os.path.join(DESKTOP, f"{cid}.pcm")
            write_wav(wav, samples)
            run = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
            subprocess.run(run + ["-i", wav, "-ac", "1", "-ar", str(RATE), "-c:a", "libmp3lame", "-b:a", "96k", mp3], check=True)
            subprocess.run(run + ["-i", mp3, "-ac", "1", "-ar", str(RATE), "-f", "s16le", pcm], check=True)
            print(f"{cid}: {len(samples) / RATE:.2f} s, {os.path.getsize(mp3)} B mp3, {os.path.getsize(pcm)} B pcm")


if __name__ == "__main__":
    main()
