//! Shared room state (`core/sharedState.ts`): one value per key that everyone in the room sees
//! the same, changed only through actions that one app (the "authority") checks and applies.
//! The open activity and every game are built on it.
//!
//! - The authority is the host when present, otherwise the connected peer with the smallest id,
//!   among the people who have the store ([`pick_authority`]).
//! - Anyone's action goes to the authority, which runs the [`Reducer`]; a new state gets the
//!   next version and goes to everyone (a copy per peer when the state has secrets).
//! - Versions only go up; a peer takes states only from the authority. The authority itself takes
//!   someone's state only while catching up (the first 3 s, with nothing yet).
//! - Late joiners ask (`room-state-request`); everyone with a state sends it to each peer whose
//!   channel opens.
//! - `room-state-gone`: that peer doesn't have the store (they left the game); they stop counting
//!   until they send anything for it again.
//!
//! [`Stores`] holds every store this app has and answers for the activity stores it doesn't.
//! Pure: the room feeds it messages and channel events and sends what it returns.

use std::collections::{BTreeMap, BTreeSet};

use rtc_games::{Meta, Reducer};
use rtc_protocol::PeerId;
use rtc_protocol::peer::PeerMessage;
use serde_json::Value;

/// How long a new store takes someone's state, though it decides (ms).
const CATCH_UP_MS: f64 = 3000.0;

/// A pseudo-random number in [0, 1) (xorshift64*: plenty for dice and shuffles).
fn xorshift(seed: &mut u64) -> f64 {
    let mut x = *seed;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *seed = x;
    #[allow(clippy::cast_precision_loss)]
    let v = (x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64;
    v
}

/// Who decides: the host if they're here, else the smallest peer id among us and `peers`
/// (`pickAuthority`).
#[must_use]
pub fn pick_authority(self_id: Option<&str>, self_is_host: bool, peers: &[(&str, bool)]) -> Option<String> {
    if self_is_host {
        return self_id.map(str::to_owned);
    }
    if let Some((p, _)) = peers.iter().find(|(_, host)| *host) {
        return Some((*p).to_owned());
    }
    self_id
        .into_iter()
        .chain(peers.iter().map(|(p, _)| *p))
        .min()
        .map(str::to_owned)
}

/// The room as a store sees it.
#[derive(Debug, Clone, Copy)]
pub struct Ctx<'a> {
    /// Us.
    pub self_id: &'a PeerId,
    /// We are the host.
    pub self_is_host: bool,
    /// The host's id, if there is one.
    pub host: Option<&'a PeerId>,
    /// Peers whose channel is open, with whether they're the host.
    pub open: &'a [PeerId],
    /// Lasting app ids by peer.
    pub clients: &'a BTreeMap<PeerId, String>,
    /// The host locked controls.
    pub playback_lock: bool,
    /// Now (ms since 1970).
    pub now_ms: f64,
}

/// What a store asks the room to do.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    /// Send to one peer.
    To(PeerId, PeerMessage),
    /// Send to every connected peer.
    All(PeerMessage),
    /// A store's state changed (redraw).
    Changed(String),
}

/// Who decides for a store and who has it (`getPresence`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Presence {
    /// The deciding peer.
    pub authority: Option<PeerId>,
    /// Everyone who has it, us included, sorted.
    pub members: Vec<PeerId>,
}

/// One shared state.
pub struct Store {
    key: String,
    reducer: Box<dyn Reducer>,
    state: Value,
    version: u64,
    /// Until when the authority still takes someone's state (`initialCatchUp`).
    catch_up_until: f64,
    /// Peers that said they don't have it.
    absent: BTreeSet<PeerId>,
    presence: Presence,
    /// Pseudo-random numbers for reducers (`Math.random`), seeded per store.
    seed: u64,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("key", &self.key)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

impl Store {
    fn new(key: &str, reducer: Box<dyn Reducer>, ctx: &Ctx<'_>, out: &mut Vec<Out>) -> Self {
        let state = reducer.initial();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let seed = (ctx.now_ms as u64)
            ^ key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
                (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3)
            });
        let mut s = Self {
            key: key.to_owned(),
            reducer,
            state,
            version: 0,
            catch_up_until: ctx.now_ms + CATCH_UP_MS,
            absent: BTreeSet::new(),
            presence: Presence::default(),
            seed: seed | 1,
        };
        // a store made after people are here: ask for what they have
        out.push(Out::All(PeerMessage::RoomStateRequest { key: key.to_owned() }));
        s.refresh(ctx, out);
        s
    }

    /// Its key.
    #[must_use]
    pub fn key(&self) -> &str {
        &self.key
    }

    /// The state now.
    #[must_use]
    pub const fn state(&self) -> &Value {
        &self.state
    }

    /// Its version (0: nothing yet).
    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }

    /// Who decides and who has it.
    #[must_use]
    pub const fn presence(&self) -> &Presence {
        &self.presence
    }

    fn members<'a>(&self, ctx: &Ctx<'a>) -> Vec<&'a PeerId> {
        ctx.open.iter().filter(|p| !self.absent.contains(*p)).collect()
    }

    /// [`pick_authority`] among us and the members.
    fn authority(&self, ctx: &Ctx<'_>) -> Option<PeerId> {
        if ctx.self_is_host {
            return Some(ctx.self_id.clone());
        }
        let members = self.members(ctx);
        if let Some(h) = members.iter().find(|p| ctx.host == Some(**p)) {
            return Some((*h).clone());
        }
        std::iter::once(ctx.self_id).chain(members).min().cloned()
    }

    fn is_authority(&self, ctx: &Ctx<'_>) -> bool {
        self.authority(ctx).as_ref() == Some(ctx.self_id)
    }

    /// Recomputes who decides and who has it.
    fn refresh(&mut self, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        let mut members: Vec<PeerId> = std::iter::once(ctx.self_id.clone())
            .chain(self.members(ctx).into_iter().cloned())
            .collect();
        members.sort();
        let next = Presence {
            authority: self.authority(ctx),
            members,
        };
        if next == self.presence {
            return;
        }
        let previous = self.presence.authority.take();
        self.presence = next;
        if previous.is_some() && self.presence.authority != previous {
            // who decides changed while we still have nothing: ask again
            if self.version == 0
                && let Some(new) = self.presence.authority.clone()
            {
                if &new == ctx.self_id {
                    self.catch_up_until = ctx.now_ms + CATCH_UP_MS;
                    out.push(Out::All(PeerMessage::RoomStateRequest {
                        key: self.key.clone(),
                    }));
                } else {
                    out.push(Out::To(
                        new,
                        PeerMessage::RoomStateRequest {
                            key: self.key.clone(),
                        },
                    ));
                }
            }
        }
        out.push(Out::Changed(self.key.clone()));
    }

    fn add_member(&mut self, peer: &PeerId, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        if self.absent.remove(peer) {
            self.refresh(ctx, out);
        }
    }

    fn copy_for(&self, peer: &str) -> Value {
        if !self.reducer.redacts() {
            return self.state.clone();
        }
        // a broken redact must never leak the full state
        self.reducer
            .redact(&self.state, peer)
            .unwrap_or_else(|| self.reducer.initial())
    }

    fn state_message(&self, peer: &str) -> PeerMessage {
        PeerMessage::RoomState {
            key: self.key.clone(),
            v: self.version,
            state: self.copy_for(peer),
        }
    }

    fn send_state(&self, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        if self.reducer.redacts() {
            for p in ctx.open {
                out.push(Out::To(p.clone(), self.state_message(p.as_str())));
            }
        } else {
            out.push(Out::All(PeerMessage::RoomState {
                key: self.key.clone(),
                v: self.version,
                state: self.state.clone(),
            }));
        }
    }

    fn apply(&mut self, action: &Value, by: &PeerId, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        let present: Vec<String> = std::iter::once(ctx.self_id.to_string())
            .chain(self.members(ctx).into_iter().map(ToString::to_string))
            .collect();
        let host_id = if ctx.self_is_host {
            Some(ctx.self_id)
        } else {
            ctx.host
        };
        let clients = ctx.clients;
        let client_of = |p: &str| {
            clients
                .iter()
                .find(|(k, _)| k.as_str() == p)
                .map(|(_, c)| c.clone())
        };
        let mut seed = self.seed;
        let mut random = || xorshift(&mut seed);
        let mut meta = Meta {
            by: by.as_str(),
            is_host: ctx.host == Some(by) || (ctx.self_is_host && by == ctx.self_id),
            self_id: ctx.self_id.as_str(),
            host_id: host_id.map(PeerId::as_str),
            present: &present,
            client_of: &client_of,
            playback_lock: ctx.playback_lock,
            now_ms: ctx.now_ms,
            random: &mut random,
        };
        let next = self.reducer.reduce(&self.state, action, &mut meta);
        self.seed = seed;
        // `None` rejects; any state returned is a change (as the web app's store, which compares
        // by reference), even one equal to the last
        let Some(next) = next else { return };
        self.catch_up_until = 0.0;
        self.state = next;
        self.version += 1;
        out.push(Out::Changed(self.key.clone()));
        self.send_state(ctx, out);
    }

    /// Our own action: applied here if we decide, else sent to whoever does.
    fn dispatch(&mut self, action: &Value, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        if self.is_authority(ctx) {
            self.apply(action, ctx.self_id, ctx, out);
        } else if let Some(a) = self.authority(ctx) {
            out.push(Out::To(
                a,
                PeerMessage::RoomStateAction {
                    key: self.key.clone(),
                    action: action.clone(),
                },
            ));
        }
    }

    fn message(&mut self, from: &PeerId, m: &PeerMessage, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        match m {
            PeerMessage::RoomState { v, state, .. } => {
                self.add_member(from, ctx, out);
                if *v <= self.version {
                    return;
                }
                let authority = self.authority(ctx);
                if authority.as_ref() == Some(ctx.self_id) {
                    // the authority only takes a state while catching up, with nothing yet
                    if ctx.now_ms >= self.catch_up_until || self.version > 0 {
                        return;
                    }
                } else if authority.as_ref() != Some(from) {
                    return;
                }
                self.state = state.clone();
                self.version = *v;
                out.push(Out::Changed(self.key.clone()));
            }
            PeerMessage::RoomStateAction { action, .. } => {
                self.add_member(from, ctx, out);
                if self.is_authority(ctx) {
                    self.apply(action, from, ctx, out);
                }
            }
            PeerMessage::RoomStateRequest { .. } => {
                self.add_member(from, ctx, out);
                if self.version > 0 {
                    out.push(Out::To(from.clone(), self.state_message(from.as_str())));
                }
            }
            PeerMessage::RoomStateGone { .. } if self.absent.insert(from.clone()) => {
                self.refresh(ctx, out);
            }
            _ => {}
        }
    }

    fn reset(&mut self, out: &mut Vec<Out>) {
        self.absent.clear();
        self.catch_up_until = f64::INFINITY;
        self.state = self.reducer.initial();
        self.version = 0;
        self.presence = Presence::default();
        out.push(Out::Changed(self.key.clone()));
    }
}

/// Every shared store this app has, by key.
#[derive(Debug, Default)]
pub struct Stores {
    stores: BTreeMap<String, Store>,
}

impl Stores {
    /// No stores.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            stores: BTreeMap::new(),
        }
    }

    /// A store, if we have it.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Store> {
        self.stores.get(key)
    }

    /// The keys we have.
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.stores.keys()
    }

    /// Opens a store (once per key; it then follows the room until released) with these rules.
    pub fn open(&mut self, key: &str, reducer: Box<dyn Reducer>, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        if self.stores.contains_key(key) {
            return;
        }
        let s = Store::new(key, reducer, ctx, out);
        self.stores.insert(key.to_owned(), s);
        out.push(Out::Changed(key.to_owned()));
    }

    /// Our action on `key` (nothing if we don't have it).
    pub fn dispatch(&mut self, key: &str, action: &Value, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        if let Some(s) = self.stores.get_mut(key) {
            s.dispatch(action, ctx, out);
        }
    }

    /// Drops the stores `matches` picks (`releaseSharedStores`): the others are told we don't
    /// have them.
    pub fn release(&mut self, matches: impl Fn(&str) -> bool, out: &mut Vec<Out>) {
        let gone: Vec<String> = self.stores.keys().filter(|k| matches(k)).cloned().collect();
        for key in gone {
            self.stores.remove(&key);
            out.push(Out::All(PeerMessage::RoomStateGone { key: key.clone() }));
            out.push(Out::Changed(key));
        }
    }

    /// A shared-state message from a peer. Messages for activity stores (`act:…`) we don't have
    /// are answered "gone" (`answerForMissingStores`).
    pub fn message(&mut self, from: &PeerId, m: &PeerMessage, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        let (PeerMessage::RoomState { key, .. }
        | PeerMessage::RoomStateAction { key, .. }
        | PeerMessage::RoomStateRequest { key }
        | PeerMessage::RoomStateGone { key }) = m
        else {
            return;
        };
        if let Some(s) = self.stores.get_mut(key) {
            s.message(from, m, ctx, out);
        } else if key.starts_with("act:") && !matches!(m, PeerMessage::RoomStateGone { .. }) {
            out.push(Out::To(
                from.clone(),
                PeerMessage::RoomStateGone { key: key.clone() },
            ));
        }
    }

    /// A peer's channel opened: everyone with a state sends it.
    pub fn peer_open(&mut self, peer: &PeerId, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        for s in self.stores.values_mut() {
            if s.version > 0 {
                out.push(Out::To(peer.clone(), s.state_message(peer.as_str())));
            }
            s.refresh(ctx, out);
        }
    }

    /// Someone connected or left, or the host changed: who decides may have changed.
    pub fn refresh(&mut self, ctx: &Ctx<'_>, out: &mut Vec<Out>) {
        for s in self.stores.values_mut() {
            s.refresh(ctx, out);
        }
    }

    /// We left the room: every store back to its start.
    pub fn reset(&mut self, out: &mut Vec<Out>) {
        for s in self.stores.values_mut() {
            s.reset(out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_decides_else_the_smallest_id() {
        assert_eq!(
            pick_authority(Some("m"), true, &[("a", false)]).as_deref(),
            Some("m")
        );
        assert_eq!(
            pick_authority(Some("m"), false, &[("z", true), ("a", false)]).as_deref(),
            Some("z")
        );
        assert_eq!(
            pick_authority(Some("m"), false, &[("z", false), ("c", false)]).as_deref(),
            Some("c")
        );
        assert_eq!(
            pick_authority(Some("a"), false, &[("z", false)]).as_deref(),
            Some("a")
        );
        assert_eq!(pick_authority(None, false, &[]), None);
    }
}
