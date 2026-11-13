//! 3RTC room logic, with no I/O: a functional core.
//!
//! [`Room::update`] takes one [`Input`] (a user command, a server message, a peer message, a
//! channel event) and returns the [`Effect`]s to carry out (send this, open that connection,
//! tell the UI). The shell (signaling socket, peer connections, window) does the I/O. Because
//! the core is pure, every rule here is tested without a network.

#![deny(missing_docs)]

pub mod files;
pub mod fun;
pub mod recovery;
mod room;

pub use room::{
    BLOCKED_MESSAGE, BLOCKED_TOAST, ChatImage, ChatLine, Command, Effect, HEARTBEAT_MS, Identity, Input,
    LinkState, MAX_CHAT_CHARS, Member, NAME_MAX, Phase, PlayerCmd, PlayerReport, Reaction, RemoteSignal,
    Room, Showing, Sound, UiEvent, UserAction, WatchCommand, WatchView, clean_name,
};
