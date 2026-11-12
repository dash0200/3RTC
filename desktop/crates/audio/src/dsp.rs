//! Sample-buffer pieces with no I/O: resampling, downmixing, levels, the limiter and the noise
//! gate. Everything works on fixed buffers so it can run in the audio threads without
//! allocating (`Resampler::new` allocates once, up front).

/// The rate the whole pipeline runs at (WebRTC's and RNNoise's native rate).
pub const RATE: u32 = 48_000;
/// One frame: 10 ms at 48 kHz (what WebRTC, APM and RNNoise all take).
pub const FRAME: usize = 480;

/// Zero crossings of the sinc on each side of a resampled sample (32 taps in all).
const HALF: usize = 16;
/// Kernel table resolution between two input samples.
const PHASES: usize = 256;
/// Input samples one call can take; longer inputs are split.
const CHUNK: usize = 4096;

/// A streaming band-limited resampler (windowed sinc, 32 taps), mono `f32`.
#[derive(Debug, Clone)]
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Where the next output sample sits, in input samples from `buf[0]`.
    pos: f64,
    buf: Vec<f32>,
    /// The kernel at `PHASES` points per input sample, from 0 to `HALF`.
    table: Vec<f32>,
    /// Kernel scale (the cutoff, below 1 when going down in rate).
    cutoff: f64,
    bypass: bool,
}

impl Resampler {
    /// From `from` Hz to `to` Hz. Equal rates pass samples straight through.
    #[must_use]
    pub fn new(from: u32, to: u32) -> Self {
        let step = f64::from(from) / f64::from(to);
        // lowpass just below the lower of the two Nyquist frequencies
        let cutoff = (1.0 / step).min(1.0) * 0.94;
        let table = (0..=HALF * PHASES)
            .map(|i| {
                #[allow(clippy::cast_precision_loss)]
                let x = i as f64 / PHASES as f64;
                #[allow(clippy::cast_possible_truncation)]
                let v = (kernel(x, cutoff)) as f32;
                v
            })
            .collect();
        Self {
            step,
            pos: HALF as f64,
            // history of HALF zeros so the first samples have something before them
            buf: {
                let mut b = Vec::with_capacity(CHUNK + 4 * HALF);
                b.resize(HALF, 0.0);
                b
            },
            table,
            cutoff,
            bypass: from == to,
        }
    }

    fn tap(&self, distance: f64) -> f32 {
        let d = distance.abs() * PHASES as f64;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let i = d as usize;
        if i >= HALF * PHASES {
            return 0.0;
        }
        #[allow(clippy::cast_possible_truncation)]
        let frac = (d - i as f64) as f32;
        self.table[i] * (1.0 - frac) + self.table[i + 1] * frac
    }

    /// Resamples `input`, handing each output sample to `out`.
    pub fn process(&mut self, input: &[f32], mut out: impl FnMut(f32)) {
        if self.bypass {
            for s in input {
                out(*s);
            }
            return;
        }
        for chunk in input.chunks(CHUNK) {
            self.buf.extend_from_slice(chunk);
            // each output needs HALF samples after it
            while self.pos + (HALF as f64) < self.buf.len() as f64 {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let centre = self.pos.floor() as usize;
                let mut acc = 0.0f32;
                for k in (centre + 1).saturating_sub(HALF)..=(centre + HALF).min(self.buf.len() - 1) {
                    #[allow(clippy::cast_precision_loss)]
                    let distance = self.pos - k as f64;
                    acc += self.buf[k] * self.tap(distance);
                }
                #[allow(clippy::cast_possible_truncation)]
                out(acc * self.cutoff as f32);
                self.pos += self.step;
            }
            // keep only the history the next outputs need
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let keep_from = (self.pos.floor() as usize).saturating_sub(HALF);
            self.buf.drain(..keep_from);
            #[allow(clippy::cast_precision_loss)]
            {
                self.pos -= keep_from as f64;
            }
        }
    }
}

/// The windowed sinc at `x` input samples from the centre (Blackman window over `HALF`).
fn kernel(x: f64, cutoff: f64) -> f64 {
    use std::f64::consts::PI;
    if x >= HALF as f64 {
        return 0.0;
    }
    let arg = PI * x * cutoff;
    let sinc = if arg.abs() < 1e-9 { 1.0 } else { arg.sin() / arg };
    let w = x / HALF as f64; // 0..1 from the centre
    let window = 0.42 + 0.5 * (PI * w).cos() + 0.08 * (2.0 * PI * w).cos();
    sinc * window
}

/// Averages interleaved channels into mono.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut impl FnMut(f32)) {
    if channels <= 1 {
        for s in interleaved {
            out(*s);
        }
        return;
    }
    #[allow(clippy::cast_precision_loss)]
    let scale = 1.0 / channels as f32;
    for frame in interleaved.chunks_exact(channels) {
        out(frame.iter().sum::<f32>() * scale);
    }
}

/// `f32` (-1..1) to `i16`, clipped.
#[must_use]
pub fn to_i16(s: f32) -> i16 {
    #[allow(clippy::cast_possible_truncation)]
    let v = (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
    v
}

/// `i16` to `f32` (-1..1).
#[must_use]
pub fn to_f32(s: i16) -> f32 {
    f32::from(s) / 32_768.0
}

/// The loudest sample, 0..1 (WebRTC's `audioLevel` is the same idea).
#[must_use]
pub fn peak(frame: &[f32]) -> f32 {
    frame.iter().fold(0.0f32, |m, s| m.max(s.abs())).min(1.0)
}

/// Keeps the mix out of clipping: gain drops at once on a peak and comes back over ~0.2 s.
#[derive(Debug, Clone)]
pub struct Limiter {
    gain: f32,
}

impl Default for Limiter {
    fn default() -> Self {
        Self { gain: 1.0 }
    }
}

impl Limiter {
    /// The ceiling (just under full scale).
    const CEILING: f32 = 0.97;
    /// Per-sample recovery towards no reduction.
    const RELEASE: f32 = 0.0001;

    /// Limits `frame` in place.
    pub fn process(&mut self, frame: &mut [f32]) {
        for s in frame {
            let level = s.abs() * self.gain;
            if level > Self::CEILING {
                self.gain = Self::CEILING / s.abs();
            }
            *s *= self.gain;
            self.gain += (1.0 - self.gain) * Self::RELEASE;
        }
    }
}

/// Mutes the mic between words when what's left after noise removal is only a whisper of
/// noise: opens at once, holds 300 ms after the voice stops, then fades over 20 ms.
#[derive(Debug, Clone)]
pub struct NoiseGate {
    /// Frames left to hold open.
    hold: u32,
    gain: f32,
}

impl Default for NoiseGate {
    fn default() -> Self {
        Self { hold: 0, gain: 1.0 }
    }
}

impl NoiseGate {
    /// Below this peak (about −46 dBFS) a frame counts as quiet.
    const OPEN_ABOVE: f32 = 0.005;
    /// 300 ms of 10 ms frames.
    const HOLD_FRAMES: u32 = 30;

    /// Gates one frame in place; `voice` is RNNoise's voice probability (or 1 without it).
    pub fn process(&mut self, frame: &mut [f32], voice: f32) {
        if peak(frame) > Self::OPEN_ABOVE && voice > 0.2 {
            self.hold = Self::HOLD_FRAMES;
        } else {
            self.hold = self.hold.saturating_sub(1);
        }
        let target = if self.hold > 0 { 1.0 } else { 0.0 };
        #[allow(clippy::cast_precision_loss)]
        let step = (target - self.gain) / frame.len() as f32 / 2.0;
        for s in frame {
            self.gain = (self.gain + step).clamp(0.0, 1.0);
            *s *= self.gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FRAME, Limiter, NoiseGate, Resampler, downmix, peak, to_f32, to_i16};

    fn sine(hz: f64, rate: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
                let v = (0.5 * (std::f64::consts::TAU * hz * i as f64 / f64::from(rate)).sin()) as f32;
                v
            })
            .collect()
    }

    /// Strength of `hz` in `x` (one Goertzel bin), as an amplitude.
    fn tone(x: &[f32], hz: f64, rate: u32) -> f64 {
        let w = std::f64::consts::TAU * hz / f64::from(rate);
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        for v in x {
            let s = f64::from(*v) + 2.0 * w.cos() * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        #[allow(clippy::cast_precision_loss)]
        let n = x.len() as f64;
        (s1 * s1 + s2 * s2 - 2.0 * w.cos() * s1 * s2).sqrt() * 2.0 / n
    }

    #[test]
    fn resampling_keeps_the_tone_and_the_length() {
        for (from, to) in [
            (44_100, 48_000),
            (16_000, 48_000),
            (48_000, 44_100),
            (48_000, 48_000),
        ] {
            let input = sine(1000.0, from, from as usize); // one second
            let mut out = Vec::new();
            let mut r = Resampler::new(from, to);
            // in uneven pieces, as a sound card delivers them
            for piece in input.chunks(441) {
                r.process(piece, |s| out.push(s));
            }
            // the resampler holds back HALF input samples of history (48 outputs at 16→48 kHz)
            let expected = to as usize;
            assert!(
                out.len().abs_diff(expected) <= 50,
                "{from}->{to}: {} samples",
                out.len()
            );
            let a = tone(&out[2000..out.len() - 2000], 1000.0, to);
            assert!((a - 0.5).abs() < 0.02, "{from}->{to}: 1 kHz at {a}");
        }
    }

    #[test]
    fn going_down_in_rate_removes_what_wont_fit() {
        // 30 kHz can't exist at 44.1 kHz (Nyquist 22 kHz): it must not fold back as noise
        let input = sine(30_000.0, 96_000, 96_000);
        let mut out = Vec::new();
        Resampler::new(96_000, 44_100).process(&input, |s| out.push(s));
        assert!(peak(&out[1000..out.len() - 1000]) < 0.02);
    }

    #[test]
    fn stereo_becomes_mono() {
        let mut out = Vec::new();
        downmix(&[0.2, 0.4, -0.2, -0.4], 2, &mut |s| out.push(s));
        assert_eq!(out, vec![0.3f32, -0.3]);
        assert_eq!(to_i16(1.5), i16::MAX);
        assert!((to_f32(to_i16(0.25)) - 0.25).abs() < 1e-3);
    }

    #[test]
    fn the_limiter_stops_clipping_and_lets_go() {
        let mut l = Limiter::default();
        let mut loud = vec![1.8f32; FRAME];
        l.process(&mut loud);
        assert!(peak(&loud) <= 0.971);
        let mut quiet = vec![0.1f32; FRAME * 100];
        l.process(&mut quiet);
        assert!((quiet[quiet.len() - 1] - 0.1).abs() < 0.005, "gain recovers");
    }

    #[test]
    fn the_gate_holds_through_short_pauses_then_closes() {
        let mut g = NoiseGate::default();
        let mut voice = vec![0.3f32; FRAME];
        g.process(&mut voice, 0.9);
        let mut pause = vec![0.001f32; FRAME];
        g.process(&mut pause, 0.0);
        assert!(peak(&pause) > 0.0009, "still open just after talking");
        for _ in 0..40 {
            pause = vec![0.001f32; FRAME];
            g.process(&mut pause, 0.0);
        }
        assert!(peak(&pause) < 1e-6, "closed after the hold");
    }
}
