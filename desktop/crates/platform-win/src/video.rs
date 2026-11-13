//! What the local video player reports (`mpv.rs` on Windows).

/// A person used the player (its keys or a click on the video).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoAction {
    /// Played.
    Play,
    /// Paused.
    Pause,
    /// Jumped.
    Seek,
}

/// Video, audio or subtitles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    /// A picture track.
    Video,
    /// A sound track.
    Audio,
    /// Subtitles.
    Subtitle,
}

/// One track in the file (or a subtitle file added to it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Track {
    /// mpv's id for it (per kind).
    pub id: i64,
    /// What it is.
    pub kind: TrackKind,
    /// Its title, if the file names it.
    pub title: String,
    /// Its language code (`eng`, `hin`), if given.
    pub lang: String,
    /// Its codec (`h264`, `aac`, `subrip`).
    pub codec: String,
    /// Showing or playing now.
    pub selected: bool,
    /// Added from a separate file.
    pub external: bool,
}

/// What the player says.
#[derive(Debug, Clone, PartialEq)]
pub enum VideoEvent {
    /// The file opened: its length (0 when unknown).
    Ready {
        /// Seconds.
        duration: f64,
    },
    /// Where it is (four times a second while it plays, and on every change).
    State {
        /// Position, seconds.
        time: f64,
        /// Playing (not paused).
        playing: bool,
        /// Waiting for data.
        buffering: bool,
        /// Length, seconds.
        duration: f64,
    },
    /// A person used the player.
    User {
        /// What they did.
        action: VideoAction,
        /// Where, seconds.
        time: f64,
    },
    /// The file's tracks (on open, and when they change).
    Tracks(Vec<Track>),
    /// Volume (0–130) and mute.
    Volume {
        /// mpv's volume, 100 is the file's own level.
        volume: f64,
        /// Muted.
        muted: bool,
    },
    /// It played to the end.
    Ended,
    /// Double-click or F on the video: full screen on or off.
    Fullscreen,
    /// Esc on the video.
    Escape,
    /// It can't play (no libmpv, a broken file…).
    Error(String),
}

/// Where the player sits, in physical pixels from the parent's top left.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    /// Left.
    pub x: i32,
    /// Top.
    pub y: i32,
    /// Width.
    pub width: i32,
    /// Height.
    pub height: i32,
}

/// A file read over the network (a video someone shares): reads wait for the data to arrive.
pub trait StreamSource: Send + Sync {
    /// The file's size in bytes.
    fn size(&self) -> u64;
    /// Reads at `pos` into `buf`, waiting for the data; `Ok(0)` at the end.
    ///
    /// # Errors
    /// The stream stopped or the data never came.
    fn read_at(&self, pos: u64, buf: &mut [u8]) -> Result<usize, String>;
    /// Stops every read now and later (the player is closing).
    fn close(&self);
}

/// What the player opens.
#[derive(Clone)]
pub enum VideoSource {
    /// A file on this computer.
    File(std::path::PathBuf),
    /// A file streamed from someone in the room.
    Stream(std::sync::Arc<dyn StreamSource>),
}

impl std::fmt::Debug for VideoSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::File(p) => f.debug_tuple("File").field(p).finish(),
            Self::Stream(s) => f.debug_struct("Stream").field("size", &s.size()).finish(),
        }
    }
}

/// One encoded H.264 access unit (from [`crate::H264Encoder`]).
#[derive(Debug, Clone)]
pub struct EncodedUnit {
    /// Annex B bytes (start codes and NAL units).
    pub data: Vec<u8>,
    /// A keyframe (IDR): a viewer can start here.
    pub key: bool,
}
