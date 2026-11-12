//! Peer connections for 3RTC on Google's libwebrtc (the engine inside Chrome), through
//! LiveKit's Rust bindings.
//!
//! This crate is an adapter: it turns the protocol's browser-shaped values into libwebrtc's
//! and back, and opens the data channels exactly as the web app does, so a desktop app and a
//! browser connect to each other directly.

#![deny(missing_docs)]

pub mod channels;
pub mod convert;
pub mod factory;
pub mod native_log;
pub mod sdp;
pub mod stats;
pub mod voice;

pub use libwebrtc;
