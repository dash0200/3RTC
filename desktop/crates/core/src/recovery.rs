//! Keeping a peer connection alive: `client-ts/src/webrtc/peerRecovery.ts`, as pure logic.
//!
//! The side that made the offer (the initiator) runs the recovery: ICE restarts first, then
//! rebuilding the connection. A connection that worked before is rebuilt again and again while
//! both people are still in the room; one that never worked gives up and says the network may be
//! blocking it. The other side keeps its end open for the offers. Time comes in as `now` (ms).

/// Timings (`RECOVERY` in `client-ts/src/webrtc/config.ts`).
pub mod timing {
    /// "Disconnected" often recovers by itself: restart if it lasts longer.
    pub const DISCONNECT_GRACE_MS: f64 = 3000.0;
    /// Time given to each ICE restart before trying again.
    pub const RETRY_MS: f64 = 8000.0;
    /// ICE restarts before rebuilding the connection.
    pub const MAX_ICE_RESTARTS: u32 = 4;
    /// The non-initiator drops a connection that stays broken this long (if it never worked).
    pub const MAX_WAIT_MS: f64 = 60000.0;
    /// A first connection not up by then counts as failed.
    pub const FIRST_CONNECT_MS: f64 = 25000.0;
    /// The initiator waits this long for signaling to come back before restarting.
    pub const SIGNALING_WAIT_MS: f64 = 1500.0;
}

use timing::{
    DISCONNECT_GRACE_MS, FIRST_CONNECT_MS, MAX_ICE_RESTARTS, MAX_WAIT_MS, RETRY_MS, SIGNALING_WAIT_MS,
};

/// What the recovery wants done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Send an offer with an ICE restart (initiator only).
    IceRestart,
    /// Throw the connection away and make a fresh one, as the initiator.
    Rebuild,
    /// Give up on this person (they're gone, or it never worked).
    Drop,
    /// Couldn't connect at all: the network may block direct connections.
    Blocked,
    /// A line in the chat.
    System(&'static str),
    /// A short toast.
    Toast(&'static str),
}

/// "Connection interrupted" line (web: the same text).
pub const MSG_INTERRUPTED: &str = "⚠️ Connection to a peer was interrupted. Reconnecting...";
/// "Restored" line.
pub const MSG_RESTORED: &str = "🔄 Connection to peer restored.";
/// "Connected after all" line.
pub const MSG_CONNECTED_AFTER_ALL: &str = "✅ Connected after all.";

/// One connection's health.
#[derive(Debug, Clone, PartialEq)]
pub struct Health {
    initiator: bool,
    ever_connected: bool,
    blocked_noted: bool,
    broken_since: Option<f64>,
    restart_attempts: u32,
    rebuilt: bool,
    rebuilds: u32,
    notice_shown: bool,
    was_interrupted: bool,
    connected: bool,
    channel_dead: bool,
    /// Signaling says they left, but the direct link was still up.
    pub signaling_gone: bool,
    due: Option<f64>,
    first_deadline: Option<f64>,
}

impl Health {
    /// A new connection, made at `now`.
    #[must_use]
    pub const fn new(initiator: bool, now: f64) -> Self {
        Self {
            initiator,
            ever_connected: false,
            blocked_noted: false,
            broken_since: None,
            restart_attempts: 0,
            rebuilt: false,
            rebuilds: 0,
            notice_shown: false,
            was_interrupted: false,
            connected: false,
            channel_dead: false,
            signaling_gone: false,
            due: None,
            first_deadline: Some(now + FIRST_CONNECT_MS),
        }
    }

    /// The fresh connection that replaces `self` after a rebuild.
    #[must_use]
    pub const fn rebuilt(&self, now: f64) -> Self {
        let mut fresh = Self::new(true, now);
        fresh.rebuilt = true;
        fresh.rebuilds = self.rebuilds + 1;
        fresh.ever_connected = self.ever_connected;
        fresh.blocked_noted = self.blocked_noted;
        fresh.was_interrupted = self.was_interrupted;
        fresh.notice_shown = self.notice_shown;
        fresh.broken_since = self.broken_since;
        if self.ever_connected {
            // the first-connection timer skips connections that worked; recover this one the same way
            fresh.first_deadline = None;
            fresh.due = Some(now + FIRST_CONNECT_MS);
        }
        fresh
    }

    /// The same, for the side that answers (after the other side rebuilt).
    #[must_use]
    pub const fn answering(mut self) -> Self {
        self.initiator = false;
        self
    }

    /// The connection works now.
    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.connected
    }

    /// It worked at some point.
    #[must_use]
    pub const fn ever_connected(&self) -> bool {
        self.ever_connected
    }

    fn schedule(&mut self, at: f64) {
        self.due = Some(at);
    }

    fn note_blocked(&mut self, out: &mut Vec<Action>) {
        if self.ever_connected || self.blocked_noted {
            return;
        }
        self.blocked_noted = true;
        out.push(Action::Blocked);
    }

    /// The peer connection reached "connected".
    pub fn on_connected(&mut self) -> Vec<Action> {
        let mut out = Vec::new();
        self.due = None;
        self.first_deadline = None;
        if self.blocked_noted && !self.ever_connected {
            out.push(Action::System(MSG_CONNECTED_AFTER_ALL));
        }
        self.ever_connected = true;
        let was_recovering = self.was_interrupted && (self.restart_attempts > 0 || self.rebuilds > 0);
        self.restart_attempts = 0;
        self.rebuilds = 0;
        self.broken_since = None;
        self.was_interrupted = false;
        self.notice_shown = false;
        self.connected = true;
        self.channel_dead = false;
        if was_recovering {
            out.push(Action::System(MSG_RESTORED));
            out.push(Action::Toast("Reconnected"));
        }
        out
    }

    /// The peer connection went "disconnected" (`failed` false) or "failed".
    pub fn on_broken(&mut self, failed: bool, now: f64) -> Vec<Action> {
        let mut out = Vec::new();
        if failed {
            self.note_blocked(&mut out);
        }
        self.connected = false;
        self.was_interrupted = true;
        self.schedule(now + if failed { 0.0 } else { DISCONNECT_GRACE_MS });
        out
    }

    /// The main data channel closed while the connection was still there.
    pub fn on_channel_closed(&mut self, now: f64) {
        self.channel_dead = true;
        self.was_interrupted = true;
        self.schedule(now + DISCONNECT_GRACE_MS);
    }

    /// Time passed: run whatever is due.
    pub fn tick(&mut self, now: f64, signaling_up: bool) -> Vec<Action> {
        let mut out = Vec::new();
        if let Some(deadline) = self.first_deadline
            && now >= deadline
        {
            self.first_deadline = None;
            if !self.ever_connected && !self.connected {
                self.note_blocked(&mut out);
                if self.due.is_none() {
                    self.schedule(now);
                }
            }
        }
        if self.due.is_some_and(|due| now >= due) {
            self.due = None;
            self.run(now, signaling_up, &mut out);
        }
        out
    }

    fn run(&mut self, now: f64, signaling_up: bool, out: &mut Vec<Action>) {
        if self.connected && !self.channel_dead {
            return;
        }
        if self.signaling_gone {
            out.push(Action::Drop);
            return;
        }
        let broken_since = *self.broken_since.get_or_insert(now);
        if !self.initiator {
            if (!self.ever_connected || !signaling_up) && now - broken_since > MAX_WAIT_MS {
                self.note_blocked(out);
                out.push(Action::Drop);
                return;
            }
            self.schedule(now + RETRY_MS);
            return;
        }
        if !signaling_up {
            self.schedule(now + SIGNALING_WAIT_MS);
            return;
        }
        if !self.channel_dead && self.restart_attempts < MAX_ICE_RESTARTS {
            self.restart_attempts += 1;
            if self.restart_attempts == 1 && !self.notice_shown {
                self.notice_shown = true;
                out.push(Action::System(MSG_INTERRUPTED));
            }
            out.push(Action::IceRestart);
            self.schedule(now + RETRY_MS);
        } else if !self.rebuilt || self.ever_connected {
            out.push(Action::Rebuild);
        } else {
            self.note_blocked(out);
            out.push(Action::Drop);
        }
    }
}

#[cfg(test)]
mod tests {
    //! The cases of `client-ts/tests/unit/peerRecovery.test.ts`, plus the steps between them.
    use super::*;

    fn run_until(h: &mut Health, from: f64, to: f64, signaling_up: bool) -> Vec<Action> {
        let mut all = Vec::new();
        let mut t = from;
        while t <= to {
            all.extend(h.tick(t, signaling_up));
            t += 500.0;
        }
        all
    }

    #[test]
    fn the_initiator_restarts_then_rebuilds_while_both_are_in_the_room() {
        let mut h = Health::new(true, 0.0);
        h.on_connected();
        assert!(
            h.on_broken(false, 1000.0).is_empty(),
            "a worked connection isn't 'blocked'"
        );
        let acts = run_until(&mut h, 1000.0, 1000.0 + DISCONNECT_GRACE_MS, true);
        assert_eq!(acts, vec![Action::System(MSG_INTERRUPTED), Action::IceRestart]);
        let acts = run_until(&mut h, 4500.0, 4500.0 + 3.0 * RETRY_MS, true);
        assert_eq!(acts.iter().filter(|a| **a == Action::IceRestart).count(), 3);
        let acts = run_until(&mut h, 29000.0, 29000.0 + RETRY_MS, true);
        assert_eq!(acts, vec![Action::Rebuild], "after 4 restarts, a rebuild");
        // the rebuilt one that doesn't come up is rebuilt again, not given up ("no rejoin the room")
        let mut fresh = h.rebuilt(40000.0);
        let acts = run_until(&mut fresh, 40000.0, 40000.0 + FIRST_CONNECT_MS + 500.0, true);
        assert_eq!(
            acts,
            vec![Action::IceRestart],
            "the notice isn't repeated after a rebuild"
        );
    }

    #[test]
    fn the_call_comes_back_with_a_notice() {
        let mut h = Health::new(true, 0.0);
        h.on_connected();
        h.on_broken(true, 1000.0);
        run_until(&mut h, 1000.0, 1000.0, true);
        assert_eq!(
            h.on_connected(),
            vec![Action::System(MSG_RESTORED), Action::Toast("Reconnected")]
        );
        assert!(h.is_connected());
    }

    #[test]
    fn the_other_side_keeps_its_end_open() {
        let mut h = Health::new(false, 0.0);
        h.on_connected();
        h.on_broken(false, 0.0);
        let acts = run_until(&mut h, 0.0, 10.0 * 60000.0, true);
        assert!(
            acts.is_empty(),
            "the non-initiator never drops a worked connection while signaling is up: {acts:?}"
        );
    }

    #[test]
    fn the_other_side_drops_after_the_wait_when_its_signaling_is_down() {
        let mut h = Health::new(false, 0.0);
        h.on_connected();
        h.on_broken(false, 0.0);
        let acts = run_until(&mut h, 0.0, 80000.0, false);
        assert_eq!(acts, vec![Action::Drop]);
    }

    #[test]
    fn when_they_leave_the_room_it_stops() {
        let mut h = Health::new(true, 0.0);
        h.on_connected();
        h.signaling_gone = true;
        h.on_broken(false, 0.0);
        assert_eq!(run_until(&mut h, 0.0, 5000.0, true), vec![Action::Drop]);
    }

    #[test]
    fn a_connection_that_never_worked_gives_up_and_says_why() {
        let mut h = Health::new(true, 0.0);
        let acts = run_until(&mut h, 0.0, FIRST_CONNECT_MS, true);
        assert_eq!(
            acts,
            vec![
                Action::Blocked,
                Action::System(MSG_INTERRUPTED),
                Action::IceRestart
            ]
        );
        let acts = run_until(
            &mut h,
            FIRST_CONNECT_MS + 500.0,
            FIRST_CONNECT_MS + 4.0 * RETRY_MS,
            true,
        );
        assert_eq!(acts.last(), Some(&Action::Rebuild));
        let mut fresh = h.rebuilt(70000.0);
        let acts = run_until(
            &mut fresh,
            70000.0,
            70000.0 + FIRST_CONNECT_MS + 5.0 * RETRY_MS,
            true,
        );
        assert_eq!(
            acts.last(),
            Some(&Action::Drop),
            "a rebuilt connection that never worked gives up"
        );
        assert!(
            !acts.contains(&Action::Blocked),
            "the blocked notice is shown once"
        );
    }

    #[test]
    fn connecting_late_says_so() {
        let mut h = Health::new(true, 0.0);
        run_until(&mut h, 0.0, FIRST_CONNECT_MS, true);
        assert_eq!(h.on_connected(), vec![Action::System(MSG_CONNECTED_AFTER_ALL)]);
    }

    #[test]
    fn the_initiator_waits_for_signaling() {
        let mut h = Health::new(true, 0.0);
        h.on_connected();
        h.on_broken(true, 0.0);
        assert!(run_until(&mut h, 0.0, 10000.0, false).is_empty());
        assert!(run_until(&mut h, 10500.0, 12000.0, true).contains(&Action::IceRestart));
    }
}
