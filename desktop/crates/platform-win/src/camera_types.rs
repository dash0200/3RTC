//! What the camera capture (`camera.rs` on Windows) gives and says. ADR 0010.

/// A camera on this computer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraInfo {
    /// Its id (Windows' device link); pass it to `Camera::open`.
    pub id: String,
    /// Its name ("HD Webcam").
    pub name: String,
}

/// The picture asked for: the camera's mode closest to this (never bigger).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CameraWant {
    /// Pixels across, at most.
    pub width: u32,
    /// Lines, at most.
    pub height: u32,
    /// Frames a second, at most.
    pub fps: u32,
}

/// One picture, NV12: a full-size luma plane, then half-height interleaved chroma, both with
/// `stride` bytes a row.
#[derive(Debug)]
pub struct CameraFrame<'a> {
    /// Pixels across.
    pub width: u32,
    /// Lines.
    pub height: u32,
    /// Bytes a row in both planes.
    pub stride: u32,
    /// The luma plane (`stride * height` bytes or more).
    pub y: &'a [u8],
    /// The chroma plane (`stride * height / 2` bytes or more).
    pub uv: &'a [u8],
}

/// Why the camera didn't open, or stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CameraError {
    /// No camera (or not the one asked for).
    NotFound,
    /// Another app has it.
    Busy,
    /// Windows' camera privacy settings don't let desktop apps use it.
    Blocked,
    /// Anything else (the details, for the log).
    Failed(String),
}

impl std::fmt::Display for CameraError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("no camera found"),
            Self::Busy => f.write_str("the camera is in use by another app"),
            Self::Blocked => f.write_str("Windows' camera privacy settings block it"),
            Self::Failed(why) => write!(f, "the camera failed: {why}"),
        }
    }
}

/// What happened to the capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CameraEvent {
    /// Pictures are coming, this size and rate.
    Started {
        /// Pixels across.
        width: u32,
        /// Lines.
        height: u32,
        /// Frames a second.
        fps: u32,
    },
    /// It stopped (asked to, unplugged: `None`) or never started (why).
    Stopped(Option<CameraError>),
}

/// Called with each picture, on the capture's thread.
pub type CameraFrames = Box<dyn FnMut(&CameraFrame<'_>) + Send>;
/// Called when it starts and when it stops, on the capture's thread.
pub type CameraEvents = Box<dyn Fn(CameraEvent) + Send>;

/// Picks the camera mode to ask for: within `want` if any is (else the smallest), at least 24
/// frames a second if possible, then the biggest picture, then the frame rate nearest `want.fps`.
/// `modes` are (width, height, frames a second); the answer is an index into it.
#[must_use]
pub fn best_mode(modes: &[(u32, u32, u32)], want: CameraWant) -> Option<usize> {
    let fits = |&(w, h, _): &(u32, u32, u32)| w <= want.width && h <= want.height;
    let any_fits = modes.iter().any(fits);
    modes
        .iter()
        .enumerate()
        .filter(|(_, m)| !any_fits || fits(m))
        .max_by_key(|(_, m)| {
            let (w, h, fps) = **m;
            let area = u64::from(w) * u64::from(h);
            (
                (24..=want.fps.max(24)).contains(&fps),
                if any_fits { area } else { u64::MAX - area },
                std::cmp::Reverse(fps.abs_diff(want.fps)),
            )
        })
        .map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WANT: CameraWant = CameraWant {
        width: 1920,
        height: 1080,
        fps: 30,
    };

    #[test]
    fn the_biggest_picture_within_the_limit_at_a_smooth_rate() {
        let modes = [
            (640, 480, 30),
            (1280, 720, 30),
            (1920, 1080, 30),
            (3840, 2160, 30),
            (1920, 1080, 5),
        ];
        assert_eq!(best_mode(&modes, WANT), Some(2));
        // only 5 fps at 1080p: 720p at 30 is better
        let modes = [(1280, 720, 30), (1920, 1080, 5)];
        assert_eq!(best_mode(&modes, WANT), Some(0));
        // 60 is more than wanted: 30 at the same size wins
        let modes = [(1280, 720, 60), (1280, 720, 30)];
        assert_eq!(best_mode(&modes, WANT), Some(1));
    }

    #[test]
    fn a_camera_that_only_does_big_pictures_gives_its_smallest() {
        let modes = [(3840, 2160, 30), (2560, 1440, 30)];
        assert_eq!(best_mode(&modes, WANT), Some(1));
        assert_eq!(best_mode(&[], WANT), None);
    }
}
