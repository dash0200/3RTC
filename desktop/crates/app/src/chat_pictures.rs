//! Chat pictures kept out of memory: a picture's bytes wait in a file (`%TEMP%\3RTC\chat`, or the
//! file it was picked from), the bubble shows a small preview, and the lightbox decodes a
//! screen-sized copy only while it's open.
//!
//! Before, every chat picture stayed in memory twice for as long as its line was among the last
//! 300: its bytes, and gpui's full-size decoded copy (a phone photo decodes to 50–150 MB), and
//! gpui's copy was never freed even after the line went.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::RenderImage;
use image::{AnimationDecoder as _, DynamicImage, Frame, ImageFormat, RgbaImage, imageops};

/// The bubble's preview: at most this many pixels on its longest side (the bubble is 240
/// logical pixels, so this stays sharp at 200% display scaling).
pub(crate) const PREVIEW_MAX: u32 = 480;
/// The lightbox's copy: at most this many pixels on its longest side.
pub(crate) const LIGHTBOX_MAX: u32 = 2560;
/// At most this many frames of an animated GIF are kept (the rest are left out).
const MAX_FRAMES: usize = 150;

/// Where chat pictures wait while their line is on screen (emptied at start and when leaving).
pub(crate) fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("3RTC").join("chat")
}

/// Empties the cache (nothing in it is the user's own file).
pub(crate) fn clear_cache() {
    let _ = std::fs::remove_dir_all(cache_dir());
}

/// The cache file for a transfer: its id cleaned (it comes from a peer) and an extension.
pub(crate) fn cache_path(transfer_id: &str, mime: &str) -> PathBuf {
    let safe: String = transfer_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    let stem = if safe.is_empty() {
        "picture".to_owned()
    } else {
        safe
    };
    let ext = mime.strip_prefix("image/").map_or("bin", |e| match e {
        "jpeg" => "jpg",
        "png" | "gif" | "webp" | "bmp" | "tiff" => e,
        _ => "bin",
    });
    cache_dir().join(format!("{stem}.{ext}"))
}

/// Writes `bytes` to `path`'s cache file.
pub(crate) fn store(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, bytes)
}

/// Whether `path` is one of our cache files (those are deleted; the user's own files never are).
pub(crate) fn is_cached(path: &Path) -> bool {
    path.starts_with(cache_dir())
}

/// The size to show a `w`×`h` picture at so its longest side is at most `max`.
pub(crate) fn fit(w: u32, h: u32, max: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= max || long == 0 {
        return (w.max(1), h.max(1));
    }
    let scale = f64::from(max) / f64::from(long);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let s = |v: u32| ((f64::from(v) * scale).round() as u32).max(1);
    (s(w), s(h))
}

/// gpui draws BGRA: swap red and blue in place.
fn to_bgra(mut img: RgbaImage) -> RgbaImage {
    for p in img.pixels_mut() {
        p.0.swap(0, 2);
    }
    img
}

/// `bytes` decoded to at most `max` pixels on the longest side, ready to draw (every frame of an
/// animated GIF, up to [`MAX_FRAMES`]). `None` when it isn't a picture we can decode.
pub(crate) fn decode_scaled(bytes: &[u8], max: u32) -> Option<Arc<RenderImage>> {
    let format = image::guess_format(bytes).ok()?;
    if format == ImageFormat::Gif
        && let Ok(decoder) = image::codecs::gif::GifDecoder::new(Cursor::new(bytes))
    {
        let mut frames = Vec::new();
        for frame in decoder.into_frames().take(MAX_FRAMES) {
            let Ok(frame) = frame else { break };
            let delay = frame.delay();
            let buf = frame.into_buffer();
            let (w, h) = fit(buf.width(), buf.height(), max);
            let buf = if (w, h) == buf.dimensions() {
                buf
            } else {
                imageops::resize(&buf, w, h, imageops::FilterType::Triangle)
            };
            frames.push(Frame::from_parts(to_bgra(buf), 0, 0, delay));
        }
        if !frames.is_empty() {
            return Some(Arc::new(RenderImage::new(frames)));
        }
    }
    let img: DynamicImage = image::load_from_memory_with_format(bytes, format).ok()?;
    let (w, h) = fit(img.width(), img.height(), max);
    let img = if (w, h) == (img.width(), img.height()) {
        img
    } else {
        img.thumbnail(w, h)
    };
    Some(Arc::new(RenderImage::new(vec![Frame::new(to_bgra(
        img.to_rgba8(),
    ))])))
}

#[cfg(test)]
mod tests {
    use super::{cache_dir, cache_path, decode_scaled, fit, is_cached};

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([255, 0, 0, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn previews_are_small_whatever_the_picture() {
        assert_eq!(fit(4000, 3000, 480), (480, 360));
        assert_eq!(fit(300, 200, 480), (300, 200), "small ones stay as they are");
        assert_eq!(fit(10, 9000, 480), (1, 480));
        let big = decode_scaled(&png(1600, 1200), 480).unwrap();
        let size = big.size(0);
        assert_eq!((size.width.0, size.height.0), (480, 360));
        // gpui draws BGRA: red comes out in the third byte
        assert_eq!(&big.as_bytes(0).unwrap()[..4], &[0, 0, 255, 255]);
        assert!(decode_scaled(b"not a picture", 480).is_none());
    }

    #[test]
    fn cache_files_stay_in_the_cache_whatever_the_id() {
        let p = cache_path("../../evil\\name", "image/jpeg");
        assert!(is_cached(&p));
        assert_eq!(p, cache_dir().join("evilname.jpg"));
        assert_eq!(cache_path("", "image/x-what"), cache_dir().join("picture.bin"));
        assert!(!is_cached(std::path::Path::new("C:/Users/me/Pictures/cat.png")));
    }
}
