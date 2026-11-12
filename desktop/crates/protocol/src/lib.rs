//! 3RTC wire protocol: every message the desktop app exchanges with the signaling server and
//! with other apps (web or desktop), as typed Rust values.
//!
//! This crate is the Rust side of `docs/PROTOCOL.md` and `client-ts/src/types/protocol.ts`.
//! It follows the protocol's compatibility rules:
//!
//! 1. **Ignore what you don't know.** Unknown message types parse as an `Unknown` variant and
//!    unknown fields are skipped, so newer apps can add features without breaking this one.
//! 2. **Never rename** a shipped type or field: the serde attributes pin every wire name.
//!
//! The crate does no I/O; it only turns JSON into values and back.

#![deny(missing_docs)]

mod ids;
pub mod image;
pub mod peer;
pub mod sdp;
pub mod signaling;

pub use ids::{ClientId, IdError, PeerId, RoomId};

/// Protocol version this app speaks (`proto` in `peer-identity`). It changes only for a break
/// older apps can't ignore.
pub const PROTOCOL_VERSION: u32 = 2;

/// Errors from reading a message off the wire.
#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    /// Not JSON, or JSON of the wrong shape for its `type`.
    #[error("malformed message: {0}")]
    Malformed(#[from] serde_json::Error),
    /// Valid JSON that isn't an object with a string `type`.
    #[error("message has no `type`")]
    NoType,
}
