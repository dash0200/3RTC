//! What an app does on its own for a game, besides showing it: on the deciding app, playing for
//! the computer, for people who left and for idle players; on every app, asking a seat back after
//! a restart and handing secret cards back to a new deciding app. (The web app does this in each
//! game's component; here it is one place the desktop app and the test client share.)
//!
//! Each update gives the actions wanted now or after a delay. A wanted action has a key (with
//! the state's seq in it): the [`Driver`] hands each key out once.

use std::collections::VecDeque;

use serde_json::Value;

use crate::{lastcard, tycoon};

/// An action to send, after `delay_ms`.
#[derive(Debug, Clone, PartialEq)]
pub struct Want {
    /// What it is, for sending it once (`play:42`).
    pub key: String,
    /// When.
    pub delay_ms: u64,
    /// The action.
    pub action: Value,
}

/// Who we are and who is here.
#[derive(Debug, Clone, Copy)]
pub struct Seen<'a> {
    /// Our peer id.
    pub me: &'a str,
    /// Our lasting app id.
    pub client_id: &'a str,
    /// Our name.
    pub name: &'a str,
    /// Who has the state (peer ids).
    pub present: &'a [String],
    /// We decide.
    pub deciding: bool,
}

/// One game's driver: what it remembers between updates.
#[derive(Debug, Default)]
pub struct Driver {
    /// Our Last Card hand, the last time we saw it.
    hand: Option<Vec<i64>>,
    /// Keys handed out (the last few).
    sent: VecDeque<String>,
}

impl Driver {
    /// The actions newly wanted for the state under `key`.
    pub fn update(&mut self, key: &str, state: &Value, seen: &Seen<'_>) -> Vec<Want> {
        let wants = match key {
            "act:lastcard" => lastcard::State::from_value(state).map(|s| {
                let me = s.seat_of(seen.me);
                if let Some(h) = s.hand(me) {
                    self.hand = Some(h.clone());
                }
                if s.phase == "lobby" {
                    self.hand = None;
                }
                lastcard::wants(&s, seen, self.hand.as_deref())
            }),
            "act:tycoon" => tycoon::State::from_value(state).map(|s| tycoon::wants(&s, seen)),
            _ => None,
        }
        .unwrap_or_default();
        wants
            .into_iter()
            .filter(|w| {
                if self.sent.contains(&w.key) {
                    return false;
                }
                self.sent.push_back(w.key.clone());
                if self.sent.len() > 64 {
                    self.sent.pop_front();
                }
                true
            })
            .collect()
    }
}
