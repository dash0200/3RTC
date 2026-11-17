//! Our chat files' bytes: in memory (pictures and small files, as before), or still on disk (big
//! files and folders), read in chunks as they're sent so a 10 GB file is never held in memory.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

/// Where one of our files' bytes are.
#[derive(Debug, Clone)]
pub(crate) enum Source {
    /// Read already.
    Memory(Arc<[u8]>),
    /// On disk: read when sent.
    Disk {
        /// The file.
        path: PathBuf,
        /// Its size when picked.
        size: u64,
    },
}

impl Source {
    /// Its size in bytes.
    pub(crate) fn size(&self) -> u64 {
        match self {
            Self::Memory(b) => b.len() as u64,
            Self::Disk { size, .. } => *size,
        }
    }

    /// Its SHA-256 (a file's read in blocks, off the async threads).
    pub(crate) async fn sha256(&self) -> io::Result<[u8; 32]> {
        match self {
            Self::Memory(b) => {
                let b = Arc::clone(b);
                tokio::task::spawn_blocking(move || -> [u8; 32] { Sha256::digest(&b[..]).into() })
                    .await
                    .map_err(io::Error::other)
            }
            Self::Disk { path, .. } => crate::quic::sha256_file(path).await,
        }
    }

    /// Reads it from the start, chunk by chunk.
    pub(crate) fn reader(&self) -> Reader {
        Reader {
            source: self.clone(),
            file: None,
            at: 0,
        }
    }
}

/// Reads a [`Source`] in order.
pub(crate) struct Reader {
    source: Source,
    file: Option<tokio::fs::File>,
    at: u64,
}

impl Reader {
    /// The next `len` bytes (fewer at the end, none after it).
    pub(crate) async fn next(&mut self, len: usize) -> io::Result<Vec<u8>> {
        match &self.source {
            Source::Memory(b) => {
                let start = usize::try_from(self.at).unwrap_or(usize::MAX).min(b.len());
                let end = start.saturating_add(len).min(b.len());
                self.at = end as u64;
                Ok(b[start..end].to_vec())
            }
            Source::Disk { path, size } => {
                if self.file.is_none() {
                    self.file = Some(tokio::fs::File::open(path).await?);
                }
                let left = size.saturating_sub(self.at);
                let want = usize::try_from(left.min(len as u64)).unwrap_or(len);
                let mut buf = vec![0u8; want];
                let Some(file) = self.file.as_mut() else {
                    return Err(io::Error::other("file closed"));
                };
                file.read_exact(&mut buf).await?;
                self.at += want as u64;
                Ok(buf)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_and_disk_read_the_same() {
        let bytes: Vec<u8> = (0..250_000u32).map(|i| (i % 251) as u8).collect();
        let path = std::env::temp_dir().join(format!("3rtc-source-{}", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let memory = Source::Memory(bytes.clone().into());
        let disk = Source::Disk {
            path: path.clone(),
            size: bytes.len() as u64,
        };
        assert_eq!(memory.size(), disk.size());
        assert_eq!(memory.sha256().await.unwrap(), disk.sha256().await.unwrap());
        for source in [memory, disk] {
            let mut r = source.reader();
            let mut all = Vec::new();
            loop {
                let chunk = r.next(61_440).await.unwrap();
                if chunk.is_empty() {
                    break;
                }
                all.extend(chunk);
            }
            assert_eq!(all, bytes);
        }
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn a_file_that_got_shorter_is_an_error() {
        let path = std::env::temp_dir().join(format!("3rtc-short-{}", std::process::id()));
        std::fs::write(&path, [1u8; 100]).unwrap();
        let mut r = Source::Disk {
            path: path.clone(),
            size: 1000,
        }
        .reader();
        assert!(r.next(500).await.is_err());
        let _ = std::fs::remove_file(path);
    }
}
