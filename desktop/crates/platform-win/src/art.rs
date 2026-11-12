//! Sounds and pictures the app makes itself: the push-to-talk chirps (`utils/sound.ts`) and the
//! tray and window icon (the 3RTC logo: a white play mark on the red rounded square).

/// Sample rate of the chirps.
const RATE: u32 = 48_000;

/// A short sine chirp as a 16-bit mono WAV file: the frequency and the volume glide
/// exponentially from the first value to the second over `secs` (Web Audio's
/// `exponentialRampToValueAtTime`, as the web app's chirps).
#[must_use]
pub fn chirp(from_hz: f64, to_hz: f64, from_gain: f64, to_gain: f64, secs: f64) -> Vec<u8> {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let n = (secs * f64::from(RATE)).round() as usize;
    let mut samples = Vec::with_capacity(n);
    let mut phase = 0.0_f64;
    for i in 0..n {
        #[allow(clippy::cast_precision_loss)]
        let t = i as f64 / n as f64;
        let hz = from_hz * (to_hz / from_hz).powf(t);
        let gain = from_gain * (to_gain / from_gain).powf(t);
        phase += std::f64::consts::TAU * hz / f64::from(RATE);
        #[allow(clippy::cast_possible_truncation)]
        samples.push((phase.sin() * gain * f64::from(i16::MAX)) as i16);
    }
    wav(&samples)
}

/// The "talking" chirp: up from 680 to 1020 Hz in 45 ms.
#[must_use]
pub fn ptt_on() -> Vec<u8> {
    chirp(680.0, 1020.0, 0.06, 0.001, 0.045)
}

/// The "stopped talking" chirp: down from 920 to 540 Hz in 50 ms.
#[must_use]
pub fn ptt_off() -> Vec<u8> {
    chirp(920.0, 540.0, 0.04, 0.001, 0.05)
}

/// 48 kHz mono 16-bit samples as a WAV file (for [`crate::play_wav`]).
#[must_use]
pub fn wav(samples: &[i16]) -> Vec<u8> {
    let data_len = u32::try_from(samples.len() * 2).unwrap_or(u32::MAX);
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes()); // bytes per second
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// The logo as `size`×`size` RGBA pixels (straight alpha): a red (#E5143D) square with
/// corners rounded by 27% of its size, and the white play mark (`logo-play.svg`, 42% of the
/// size) in the middle. Edges are smoothed with 4×4 samples per pixel.
#[must_use]
pub fn logo_rgba(size: u32) -> Vec<u8> {
    const SUB: u32 = 4;
    let s = f64::from(size);
    let radius = s * 0.27;
    // the play mark: viewBox 14×14, path M3 1.5 v11 l9.5 -5.5 z, drawn 42% of the size, centered
    let mark = s * 0.42;
    let scale = mark / 14.0;
    let origin = (s - mark) / 2.0;
    let tri = [
        (origin + 3.0 * scale, origin + 1.5 * scale),
        (origin + 3.0 * scale, origin + 12.5 * scale),
        (origin + 12.5 * scale, origin + 7.0 * scale),
    ];
    let mut out = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let (mut square, mut white) = (0u32, 0u32);
            for sy in 0..SUB {
                for sx in 0..SUB {
                    let px = f64::from(x) + (f64::from(sx) + 0.5) / f64::from(SUB);
                    let py = f64::from(y) + (f64::from(sy) + 0.5) / f64::from(SUB);
                    if in_rounded_square(px, py, s, radius) {
                        square += 1;
                        if in_triangle(px, py, tri) {
                            white += 1;
                        }
                    }
                }
            }
            let total = SUB * SUB;
            // colour: red mixed with white by how much of the pixel the mark covers
            let mix = |red: u32| -> u8 {
                if square == 0 {
                    return 0;
                }
                u8::try_from((red * (square - white) + 255 * white) / square).unwrap_or(u8::MAX)
            };
            out.extend_from_slice(&[
                mix(0xE5),
                mix(0x14),
                mix(0x3D),
                u8::try_from(255 * square / total).unwrap_or(u8::MAX),
            ]);
        }
    }
    out
}

fn in_rounded_square(x: f64, y: f64, s: f64, r: f64) -> bool {
    let cx = x.clamp(r, s - r);
    let cy = y.clamp(r, s - r);
    (x - cx).powi(2) + (y - cy).powi(2) <= r * r
}

fn in_triangle(x: f64, y: f64, [a, b, c]: [(f64, f64); 3]) -> bool {
    let side = |(x1, y1): (f64, f64), (x2, y2): (f64, f64)| (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    let (d1, d2, d3) = (side(a, b), side(b, c), side(c, a));
    let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(neg && pos)
}

#[cfg(test)]
mod tests {
    use super::{logo_rgba, ptt_off, ptt_on};

    #[test]
    fn chirps_are_short_wav_files() {
        for (wav, ms) in [(ptt_on(), 45), (ptt_off(), 50)] {
            assert_eq!(&wav[0..4], b"RIFF");
            assert_eq!(&wav[8..16], b"WAVEfmt ");
            let samples = (wav.len() - 44) / 2;
            assert_eq!(samples, 48 * ms);
            // quiet, like the web app's (gain 0.06 at most)
            let loudest = wav[44..]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs())
                .max()
                .unwrap_or(0);
            assert!(loudest > 500 && loudest < 2100, "{loudest}");
        }
    }

    #[test]
    fn logo_is_red_with_a_white_middle_and_clear_corners() {
        let size = 32;
        let px = logo_rgba(size);
        assert_eq!(px.len(), 32 * 32 * 4);
        let at = |x: usize, y: usize| &px[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4];
        assert_eq!(at(0, 0)[3], 0, "the corner is transparent");
        assert_eq!(at(16, 2), &[0xE5, 0x14, 0x3D, 255], "red edge");
        assert_eq!(at(15, 16), &[255, 255, 255, 255], "the play mark is white");
    }
}
