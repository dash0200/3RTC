//! Activities (`features/activities/useActivities.ts`, `useActivityLoad.ts`): which one the room
//! has open (shared state `activity`), whether it's loaded here, and the shared stores of games.
//!
//! An activity loads for the person who opened it and for whoever joins it ("Join <game>");
//! "Leave" unloads it here (its stores are dropped and the others told, so they stop counting
//! us); "End" closes it for everyone. While it isn't loaded, messages for its stores are answered
//! "gone".

use rtc_games::activity::{self, Current};
use rtc_protocol::PeerId;
use rtc_protocol::peer::PeerMessage;
use serde_json::Value;

use super::{Effect, Phase, Room, UiEvent};
use crate::shared::{Ctx, Out, Presence, Stores};

/// What the user did about activities.
#[derive(Debug, Clone, PartialEq)]
pub enum ActivityCommand {
    /// Open an activity for the room (`start`).
    Start(String),
    /// Close it for everyone ("End").
    End,
    /// Load it here ("Join <game>").
    Join,
    /// Unload it here ("Leave": it goes on for the others).
    Leave,
    /// An action on a shared store we have (a move in the game).
    Dispatch {
        /// The store (`act:<id>`, …).
        key: String,
        /// The action.
        action: Value,
    },
    /// Open another store of the loaded activity (`act:<id>:…`, e.g. whiteboard pages).
    Open(String),
    /// Drop stores of the loaded activity whose keys start with this.
    Release(String),
}

/// The open activity as the UI shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct ActivityView {
    /// Which, who opened it and when.
    pub current: Current,
    /// Loaded on this device (else only its "Join" bubble shows).
    pub loaded: bool,
    /// This app has it (else: "Update app").
    pub known: bool,
}

/// One shared store as the UI sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreView {
    /// Its state.
    pub state: Value,
    /// Its version (0: nothing yet).
    pub version: u64,
    /// Who decides and who has it.
    pub presence: Presence,
}

/// Activities in the room.
#[derive(Debug)]
pub(super) struct Activities {
    pub(super) stores: Stores,
    /// The opening (`<id>:<startedAt>`) loaded here.
    loaded: Option<String>,
    /// The last opening seen (to notice a new one once).
    seen: Option<String>,
    /// The opening we told the room we don't have (not loaded here).
    said_gone: Option<String>,
    /// Development examples are listed (debug builds, like the web app's dev builds).
    pub(super) dev: bool,
}

impl Activities {
    pub(super) const fn new() -> Self {
        Self {
            stores: Stores::new(),
            loaded: None,
            seen: None,
            said_gone: None,
            dev: false,
        }
    }
}

impl Room {
    /// Lists the development example activities too (debug builds; the web app's dev builds do).
    pub fn set_dev_activities(&mut self, dev: bool) {
        self.activities.dev = dev;
    }

    /// The open activity, if any.
    #[must_use]
    pub fn activity(&self) -> Option<ActivityView> {
        let current = activity::current(self.activities.stores.get(activity::KEY)?.state())?;
        let load_key = current.load_key();
        Some(ActivityView {
            known: rtc_games::find_activity(&current.id, self.activities.dev).is_some(),
            loaded: self.activities.loaded.as_deref() == Some(load_key.as_str()),
            current,
        })
    }

    /// A shared store we have.
    #[must_use]
    pub fn store(&self, key: &str) -> Option<StoreView> {
        let s = self.activities.stores.get(key)?;
        Some(StoreView {
            state: s.state().clone(),
            version: s.version(),
            presence: s.presence().clone(),
        })
    }

    /// The keys of the shared stores we have.
    #[must_use]
    pub fn store_keys(&self) -> Vec<String> {
        self.activities.stores.keys().cloned().collect()
    }

    /// Development example activities are listed.
    #[must_use]
    pub const fn dev_activities(&self) -> bool {
        self.activities.dev
    }

    /// The opening loaded here (`<id>:<startedAt>`), to keep across a restart.
    #[must_use]
    pub fn loaded_activity(&self) -> Option<&str> {
        self.activities.loaded.as_deref()
    }

    /// The opening loaded before a restart: it loads again if the room still has it open.
    pub fn restore_loaded_activity(&mut self, load_key: Option<String>) {
        self.activities.loaded = load_key;
    }

    fn shared_ctx_parts(&self) -> (Vec<PeerId>, std::collections::BTreeMap<PeerId, String>) {
        let open = self
            .members
            .iter()
            .filter(|(_, m)| m.connected)
            .map(|(p, _)| p.clone())
            .collect();
        let mut clients: std::collections::BTreeMap<PeerId, String> = self
            .members
            .iter()
            .filter_map(|(p, m)| m.client_id.clone().map(|c| (p.clone(), c)))
            .collect();
        clients.insert(self.me.peer_id.clone(), self.me.client_id.as_str().to_owned());
        (open, clients)
    }

    /// Runs `f` on the stores with the room as it is now, and turns what they ask into effects.
    fn with_stores(
        &mut self,
        now_ms: f64,
        fx: &mut Vec<Effect>,
        f: impl FnOnce(&mut Stores, &Ctx<'_>, &mut Vec<Out>),
    ) {
        let (open, clients) = self.shared_ctx_parts();
        let me = self.me.peer_id.clone();
        let host = self.host.clone().filter(|h| *h == me || open.contains(h));
        let ctx = Ctx {
            self_id: &me,
            self_is_host: self.is_host(),
            host: host.as_ref(),
            open: &open,
            clients: &clients,
            playback_lock: self.playback_lock,
            now_ms,
        };
        let mut out = Vec::new();
        f(&mut self.activities.stores, &ctx, &mut out);
        let mut changed = false;
        for o in out {
            match o {
                Out::To(peer, m) => {
                    let envelope = self.envelope(m, now_ms);
                    fx.push(Effect::SendToPeer { peer, envelope });
                }
                Out::All(m) => fx.push(Effect::Broadcast(self.envelope(m, now_ms))),
                Out::Changed(_) => changed = true,
            }
        }
        if changed {
            fx.push(Effect::Ui(UiEvent::Changed));
        }
    }

    pub(super) fn activity_command(&mut self, c: ActivityCommand, now_ms: f64, fx: &mut Vec<Effect>) {
        if !matches!(self.phase, Phase::InRoom(_)) {
            return;
        }
        let locked = self.playback_lock && !self.is_host();
        match c {
            ActivityCommand::Start(id) => {
                if locked {
                    fx.push(Effect::Ui(UiEvent::Notice(
                        "🔒 Only the host can start activities right now".into(),
                    )));
                    return;
                }
                let action = activity::start(&id, &self.me.username);
                self.with_stores(now_ms, fx, |s, ctx, out| {
                    s.dispatch(activity::KEY, &action, ctx, out);
                });
            }
            ActivityCommand::End => {
                if locked {
                    fx.push(Effect::Ui(UiEvent::Notice(
                        "🔒 Only the host can close the activity right now".into(),
                    )));
                    return;
                }
                let action = activity::stop();
                self.with_stores(now_ms, fx, |s, ctx, out| {
                    s.dispatch(activity::KEY, &action, ctx, out);
                });
            }
            ActivityCommand::Join => {
                if let Some(a) = self.activity() {
                    self.activities.loaded = Some(a.current.load_key());
                    fx.push(Effect::Ui(UiEvent::Changed));
                }
            }
            ActivityCommand::Leave => {
                self.activities.loaded = None;
                fx.push(Effect::Ui(UiEvent::Changed));
            }
            ActivityCommand::Dispatch { key, action } => {
                self.with_stores(now_ms, fx, |s, ctx, out| s.dispatch(&key, &action, ctx, out));
            }
            ActivityCommand::Open(key) => {
                let Some(a) = self.activity().filter(|a| a.loaded) else {
                    return;
                };
                if !rtc_games::is_activity_key(&a.current.id, &key) {
                    return;
                }
                if let Some(r) = rtc_games::reducer_for(&key) {
                    self.with_stores(now_ms, fx, |s, ctx, out| s.open(&key, r, ctx, out));
                }
            }
            ActivityCommand::Release(prefix) => {
                self.with_stores(now_ms, fx, |s, _, out| s.release(|k| k.starts_with(&prefix), out));
            }
        }
        self.activity_after(now_ms, fx);
    }

    /// A shared-state message from a peer.
    pub(super) fn shared_message(
        &mut self,
        from: &PeerId,
        m: &PeerMessage,
        now_ms: f64,
        fx: &mut Vec<Effect>,
    ) {
        self.with_stores(now_ms, fx, |s, ctx, out| s.message(from, m, ctx, out));
        self.activity_after(now_ms, fx);
    }

    /// A peer's channel opened: our states go to them (and "gone" for an activity not loaded).
    pub(super) fn shared_channel_open(&mut self, peer: &PeerId, now_ms: f64, fx: &mut Vec<Effect>) {
        self.with_stores(now_ms, fx, |s, ctx, out| s.peer_open(peer, ctx, out));
        if let Some(a) = self.activity().filter(|a| !a.loaded) {
            let envelope = self.envelope(
                PeerMessage::RoomStateGone {
                    key: rtc_games::activity_key(&a.current.id),
                },
                now_ms,
            );
            fx.push(Effect::SendToPeer {
                peer: peer.clone(),
                envelope,
            });
        }
    }

    /// We left the room: every store back to its start.
    pub(super) fn shared_reset(&mut self, fx: &mut Vec<Effect>) {
        let mut out = Vec::new();
        self.activities.stores.reset(&mut out);
        self.activities.seen = None;
        self.activities.said_gone = None;
        if !out.is_empty() {
            fx.push(Effect::Ui(UiEvent::Changed));
        }
    }

    /// After anything: the activity store exists in a room, who decides is up to date, and the
    /// open activity is loaded or unloaded here as it should be.
    pub(super) fn activity_after(&mut self, now_ms: f64, fx: &mut Vec<Effect>) {
        if !matches!(self.phase, Phase::InRoom(_)) {
            return;
        }
        if self.activities.stores.get(activity::KEY).is_none() {
            self.with_stores(now_ms, fx, |s, ctx, out| {
                s.open(activity::KEY, Box::new(activity::Activity), ctx, out);
            });
        }
        self.with_stores(now_ms, fx, Stores::refresh);

        let current = self.activity();
        let load_key = current.as_ref().map(|a| a.current.load_key());
        // a new opening: loaded for whoever opened it, an invitation for everyone else
        if load_key.is_some() && load_key != self.activities.seen {
            self.activities.seen.clone_from(&load_key);
            if let Some(a) = &current {
                if a.current.started_by == self.me.peer_id.as_str() || self.activities.loaded == load_key {
                    self.activities.loaded.clone_from(&load_key);
                    fx.push(Effect::Ui(UiEvent::Changed));
                } else if let Some(def) = rtc_games::find_activity(&a.current.id, self.activities.dev) {
                    let who = if a.current.started_by_name.is_empty() {
                        "Someone"
                    } else {
                        &a.current.started_by_name
                    };
                    fx.push(Effect::Ui(UiEvent::Notice(format!(
                        "{icon} {who} started {name}: tap {icon} to join",
                        icon = def.icon,
                        name = def.name
                    ))));
                }
            }
        }
        if load_key.is_none() {
            self.activities.seen = None;
        }
        let current = self.activity();
        // the activity's own store: open while loaded here, dropped (and "gone" said) otherwise
        let keep = current
            .as_ref()
            .filter(|a| a.loaded)
            .map(|a| a.current.id.clone());
        let drop_ids: Vec<String> = self
            .activities
            .stores
            .keys()
            .filter_map(|k| k.strip_prefix("act:"))
            .map(|rest| rest.split(':').next().unwrap_or(rest).to_owned())
            .filter(|id| Some(id) != keep.as_ref())
            .collect();
        for id in drop_ids {
            self.with_stores(now_ms, fx, |s, _, out| {
                s.release(|k| rtc_games::is_activity_key(&id, k), out);
            });
        }
        // not loaded here: tell the others once, so they stop counting us
        match current.as_ref() {
            Some(a) if !a.loaded => {
                let lk = a.current.load_key();
                if self.activities.said_gone.as_ref() != Some(&lk) {
                    self.activities.said_gone = Some(lk);
                    let m = PeerMessage::RoomStateGone {
                        key: rtc_games::activity_key(&a.current.id),
                    };
                    fx.push(Effect::Broadcast(self.envelope(m, now_ms)));
                }
            }
            _ => self.activities.said_gone = None,
        }
        if let Some(id) = keep {
            let key = rtc_games::activity_key(&id);
            if self.activities.stores.get(&key).is_none()
                && let Some(r) = rtc_games::reducer_for(&key)
            {
                self.with_stores(now_ms, fx, |s, ctx, out| s.open(&key, r, ctx, out));
            }
        }
    }
}
