//! Where the app saves what it gets: one folder in Downloads, `Downloads\3RTC`, with a folder
//! per kind (`Torrents`, `Files`, `Folders`, `Pictures`), so nothing is scattered in Downloads.

use std::path::{Path, PathBuf};

/// The kinds of things saved, each in its own folder under `Downloads\3RTC`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Torrents kept after watching (qBittorrent's "Original" layout inside).
    Torrents,
    /// Files sent to us in chat.
    Files,
    /// Folders sent to us in chat, each in its own layout.
    Folders,
    /// Pictures saved from chat (the save dialog starts here).
    Pictures,
}

impl Kind {
    /// The folder's name.
    #[must_use]
    pub const fn folder(self) -> &'static str {
        match self {
            Self::Torrents => "Torrents",
            Self::Files => "Files",
            Self::Folders => "Folders",
            Self::Pictures => "Pictures",
        }
    }
}

/// The user's Downloads folder (the temp folder when there's no home).
#[must_use]
pub fn downloads() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map_or_else(std::env::temp_dir, |h| PathBuf::from(h).join("Downloads"))
}

/// `Downloads\3RTC`.
#[must_use]
pub fn root() -> PathBuf {
    root_in(&downloads())
}

/// The folder for `kind`: `Downloads\3RTC\<kind>`.
#[must_use]
pub fn dir(kind: Kind) -> PathBuf {
    dir_in(&downloads(), kind)
}

/// `3RTC` inside `downloads`.
#[must_use]
pub fn root_in(downloads: &Path) -> PathBuf {
    downloads.join("3RTC")
}

/// The folder for `kind` inside `downloads`.
#[must_use]
pub fn dir_in(downloads: &Path, kind: Kind) -> PathBuf {
    root_in(downloads).join(kind.folder())
}

#[cfg(test)]
mod tests {
    use super::{Kind, dir_in, root_in};
    use std::path::Path;

    #[test]
    fn everything_goes_in_one_3rtc_folder_by_kind() {
        let d = Path::new("D");
        assert_eq!(root_in(d), d.join("3RTC"));
        for (kind, name) in [
            (Kind::Torrents, "Torrents"),
            (Kind::Files, "Files"),
            (Kind::Folders, "Folders"),
            (Kind::Pictures, "Pictures"),
        ] {
            assert_eq!(dir_in(d, kind), d.join("3RTC").join(name));
        }
    }
}
