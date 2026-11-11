//! 3RTC room logic, with no I/O: a functional core.
//!
//! [`Room::update`] takes one [`Input`] (a user command, a server message, a peer message, a
//! channel event) and returns the [`Effect`]s to carry out (send this, open that connection,
//! tell the UI). The shell (signaling socket, peer connections, window) does the I/O. Because
//! the core is pure, every rule here is tested without a network.

#![deny(missing_docs)]

mod room;

pub use room::{ChatLine, Command, Effect, Identity, Input, Member, Phase, RemoteSignal, Room, UiEvent};
