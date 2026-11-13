//! Shared state between several apps, wired together in memory (`tests/unit/sharedRedact.test.ts`,
//! `sharedRejoin.test.ts`, the shared-state parts of `core.test.ts`).

use std::collections::BTreeMap;

use rtc_core::shared::{Ctx, Out, Stores};
use rtc_games::{Meta, Reducer};
use rtc_protocol::PeerId;
use rtc_protocol::peer::PeerMessage;
use serde_json::{Value, json};

fn pid(s: &str) -> PeerId {
    PeerId::new(s).unwrap_or_else(|_| unreachable!())
}

/// `{ secrets: { peer: n }, open }`: each player's number is theirs alone.
struct Secrets;

impl Reducer for Secrets {
    fn initial(&self) -> Value {
        json!({ "secrets": {}, "open": 0 })
    }
    fn reduce(&self, s: &Value, a: &Value, meta: &mut Meta<'_>) -> Option<Value> {
        let mut next = s.clone();
        next["secrets"][meta.by] = a["n"].clone();
        next["open"] = json!(s["open"].as_i64().unwrap_or(0) + 1);
        Some(next)
    }
    fn redacts(&self) -> bool {
        true
    }
    fn redact(&self, s: &Value, peer: &str) -> Option<Value> {
        let mut c = s.clone();
        let mine = s["secrets"].get(peer).cloned();
        c["secrets"] = mine.map_or_else(|| json!({}), |n| json!({ peer: n }));
        Some(c)
    }
}

/// `{ strokes }`: a whiteboard in miniature.
struct Board;

impl Reducer for Board {
    fn initial(&self) -> Value {
        json!({ "strokes": 0 })
    }
    fn reduce(&self, s: &Value, a: &Value, _: &mut Meta<'_>) -> Option<Value> {
        (a["kind"] == "draw").then(|| json!({ "strokes": s["strokes"].as_i64().unwrap_or(0) + 1 }))
    }
}

struct App {
    id: PeerId,
    stores: Stores,
    /// Answers "gone" for `act:` keys it doesn't have (stores does that itself).
    present: bool,
}

/// Apps in one room, every channel open. Messages arrive `delay` ms later (more for `slow` apps).
struct Mesh {
    apps: BTreeMap<String, App>,
    host: PeerId,
    now: f64,
    queue: Vec<(f64, PeerId, PeerId, PeerMessage)>,
    slow: BTreeMap<String, f64>,
    /// Every message sent, for checking what went where.
    sent: Vec<(PeerId, PeerId, PeerMessage)>,
    clients: BTreeMap<PeerId, String>,
}

impl Mesh {
    fn new(ids: &[&str], host: &str) -> Self {
        Self {
            apps: ids
                .iter()
                .map(|i| {
                    (
                        (*i).to_owned(),
                        App {
                            id: pid(i),
                            stores: Stores::default(),
                            present: true,
                        },
                    )
                })
                .collect(),
            host: pid(host),
            now: 1_000_000.0,
            queue: Vec::new(),
            slow: BTreeMap::new(),
            sent: Vec::new(),
            clients: BTreeMap::new(),
        }
    }

    fn run<R>(&mut self, who: &str, f: impl FnOnce(&mut Stores, &Ctx<'_>, &mut Vec<Out>) -> R) -> R {
        let open: Vec<PeerId> = self
            .apps
            .values()
            .filter(|a| a.present && a.id.as_str() != who)
            .map(|a| a.id.clone())
            .collect();
        let host_here = self.apps.get(self.host.as_str()).is_some_and(|a| a.present);
        let host = host_here.then(|| self.host.clone());
        let me = pid(who);
        let ctx = Ctx {
            self_id: &me,
            self_is_host: me == self.host,
            host: host.as_ref(),
            open: &open,
            clients: &self.clients,
            playback_lock: false,
            now_ms: self.now,
        };
        let mut out = Vec::new();
        let app = self.apps.get_mut(who).unwrap_or_else(|| unreachable!());
        let r = f(&mut app.stores, &ctx, &mut out);
        let delay = 1.0 + self.slow.get(who).copied().unwrap_or(0.0);
        for o in out {
            match o {
                Out::To(to, m) => self.queue.push((self.now + delay, me.clone(), to, m)),
                Out::All(m) => {
                    for to in &open {
                        self.queue
                            .push((self.now + delay, me.clone(), to.clone(), m.clone()));
                    }
                }
                Out::Changed(_) => {}
            }
        }
        r
    }

    fn open(&mut self, who: &str, key: &str, reducer: Box<dyn Reducer>) {
        self.run(who, |s, ctx, out| s.open(key, reducer, ctx, out));
    }

    fn dispatch(&mut self, who: &str, key: &str, action: &Value) {
        self.run(who, |s, ctx, out| s.dispatch(key, action, ctx, out));
    }

    fn release(&mut self, who: &str, key: &str) {
        self.run(who, |s, _, out| s.release(|k| k == key, out));
    }

    /// Lets `ms` pass, delivering what's due in order.
    fn wait(&mut self, ms: f64) {
        let end = self.now + ms;
        loop {
            self.queue.sort_by(|a, b| a.0.total_cmp(&b.0));
            let Some(pos) = self.queue.iter().position(|q| q.0 <= end) else {
                break;
            };
            let (at, from, to, m) = self.queue.remove(pos);
            self.now = self.now.max(at);
            self.sent.push((from.clone(), to.clone(), m.clone()));
            if !self.apps.get(to.as_str()).is_some_and(|a| a.present) {
                continue;
            }
            self.run(to.as_str(), |s, ctx, out| s.message(&from, &m, ctx, out));
        }
        self.now = end;
    }

    fn state(&self, who: &str, key: &str) -> Value {
        self.apps[who]
            .stores
            .get(key)
            .map(|s| s.state().clone())
            .unwrap_or(Value::Null)
    }

    fn version(&self, who: &str, key: &str) -> u64 {
        self.apps[who]
            .stores
            .get(key)
            .map_or(0, rtc_core::shared::Store::version)
    }
}

#[test]
fn each_peer_only_ever_receives_its_own_secret() {
    let mut m = Mesh::new(&["h", "a", "b"], "h");
    for id in ["h", "a", "b"] {
        m.open(id, "act:g", Box::new(Secrets));
    }
    m.wait(5.0);
    m.dispatch("a", "act:g", &json!({"kind": "set", "n": 1}));
    m.dispatch("b", "act:g", &json!({"kind": "set", "n": 2}));
    m.dispatch("h", "act:g", &json!({"kind": "set", "n": 9}));
    m.wait(10.0);
    assert_eq!(
        m.state("h", "act:g")["secrets"],
        json!({"a": 1, "b": 2, "h": 9}),
        "the authority has it all"
    );
    assert_eq!(m.state("a", "act:g"), json!({"secrets": {"a": 1}, "open": 3}));
    assert_eq!(m.state("b", "act:g"), json!({"secrets": {"b": 2}, "open": 3}));
    for (_, to, msg) in &m.sent {
        if let PeerMessage::RoomState { state, .. } = msg
            && let Some(secrets) = state["secrets"].as_object()
        {
            for owner in secrets.keys() {
                assert_eq!(owner, to.as_str(), "leaked {owner}'s secret to {to}");
            }
        }
    }
}

#[test]
fn a_late_joiner_gets_a_copy_made_for_it() {
    let mut m = Mesh::new(&["h", "a"], "h");
    m.open("h", "act:g2", Box::new(Secrets));
    m.dispatch("h", "act:g2", &json!({"kind": "set", "n": 5}));
    m.wait(5.0);
    m.open("a", "act:g2", Box::new(Secrets));
    m.wait(10.0);
    assert_eq!(m.state("a", "act:g2"), json!({"secrets": {}, "open": 1}));
}

#[test]
fn anyones_action_goes_through_the_host_and_reaches_everyone() {
    let mut m = Mesh::new(&["h", "a", "b"], "h");
    for id in ["h", "a", "b"] {
        m.open(id, "act:board", Box::new(Board));
    }
    m.wait(5.0);
    m.dispatch("b", "act:board", &json!({"kind": "draw"}));
    m.dispatch("a", "act:board", &json!({"kind": "draw"}));
    m.dispatch("a", "act:board", &json!({"kind": "nonsense"}));
    m.wait(10.0);
    for id in ["h", "a", "b"] {
        assert_eq!(m.state(id, "act:board"), json!({"strokes": 2}), "{id}");
        assert_eq!(m.version(id, "act:board"), 2, "{id}");
    }
    // the host decides; the others know it
    let p = m.apps["b"]
        .stores
        .get("act:board")
        .map(|s| s.presence().clone())
        .unwrap_or_default();
    assert_eq!(p.authority, Some(pid("h")));
    assert_eq!(p.members, vec![pid("a"), pid("b"), pid("h")]);
}

#[test]
fn a_state_from_someone_who_doesnt_decide_is_ignored() {
    let mut m = Mesh::new(&["h", "a", "b"], "h");
    for id in ["h", "a", "b"] {
        m.open(id, "act:board", Box::new(Board));
    }
    m.wait(5.0);
    // b makes up a version 9 and sends it to a: a only takes states from the host
    let forged = PeerMessage::RoomState {
        key: "act:board".into(),
        v: 9,
        state: json!({"strokes": 99}),
    };
    m.queue.push((m.now, pid("b"), pid("a"), forged));
    m.wait(5.0);
    assert_eq!(m.state("a", "act:board"), json!({"strokes": 0}));
}

/// `sharedRejoin.test.ts`: 'h' is the host but has left the game (still in the room); 'p' is still
/// playing; the joiner comes back to the game. The host's "I don't have it" reaches the joiner
/// after p's state does.
fn rejoin(joiner: &str) {
    let mut m = Mesh::new(&["h", "p", joiner], "h");
    m.slow.insert("h".into(), 25.0);
    m.open("p", "act:board", Box::new(Board));
    m.wait(60.0); // p learns the host doesn't have the game: p decides now
    for _ in 0..3 {
        m.dispatch("p", "act:board", &json!({"kind": "draw"}));
    }
    m.wait(10.0);
    assert_eq!(m.state("p", "act:board"), json!({"strokes": 3}));

    m.open(joiner, "act:board", Box::new(Board));
    m.wait(120.0);
    assert_eq!(
        m.state(joiner, "act:board"),
        json!({"strokes": 3}),
        "the returning player sees the board as it is"
    );
    assert_eq!(m.version(joiner, "act:board"), m.version("p", "act:board"));

    // ...and stays in step afterwards
    m.dispatch(joiner, "act:board", &json!({"kind": "draw"}));
    m.wait(30.0);
    assert_eq!(m.state("p", "act:board"), json!({"strokes": 4}));
    assert_eq!(m.state(joiner, "act:board"), json!({"strokes": 4}));
}

#[test]
fn rejoining_a_game_the_host_left_the_rejoiner_is_not_the_new_authority() {
    rejoin("z");
}

#[test]
fn rejoining_a_game_the_host_left_the_rejoiner_becomes_the_authority() {
    rejoin("a");
}

#[test]
fn leaving_a_game_hands_the_decisions_on_and_coming_back_counts_again() {
    let mut m = Mesh::new(&["h", "a", "b"], "h");
    for id in ["h", "a", "b"] {
        m.open(id, "act:board", Box::new(Board));
    }
    m.wait(5.0);
    m.dispatch("a", "act:board", &json!({"kind": "draw"}));
    m.wait(5.0);
    // the host leaves the game (not the room): a decides now (smallest id)
    m.release("h", "act:board");
    m.wait(5.0);
    let p = m.apps["b"]
        .stores
        .get("act:board")
        .map(|s| s.presence().clone())
        .unwrap_or_default();
    assert_eq!(p.authority, Some(pid("a")));
    m.dispatch("b", "act:board", &json!({"kind": "draw"}));
    m.wait(5.0);
    assert_eq!(m.state("b", "act:board"), json!({"strokes": 2}));
    // the host comes back: it gets the board and decides again
    m.open("h", "act:board", Box::new(Board));
    m.wait(10.0);
    assert_eq!(m.state("h", "act:board"), json!({"strokes": 2}));
    m.dispatch("a", "act:board", &json!({"kind": "draw"}));
    m.wait(5.0);
    for id in ["h", "a", "b"] {
        assert_eq!(m.state(id, "act:board"), json!({"strokes": 3}), "{id}");
    }
}

#[test]
fn the_host_leaving_the_room_mid_game_and_returning() {
    let mut m = Mesh::new(&["h", "a", "b"], "h");
    for id in ["h", "a", "b"] {
        m.open(id, "act:board", Box::new(Board));
    }
    m.wait(5.0);
    m.dispatch("b", "act:board", &json!({"kind": "draw"}));
    m.wait(5.0);
    // the host's app goes away (its channels close): a decides
    if let Some(h) = m.apps.get_mut("h") {
        h.present = false;
    }
    m.run("a", Stores::refresh);
    m.run("b", Stores::refresh);
    m.dispatch("b", "act:board", &json!({"kind": "draw"}));
    m.wait(5.0);
    assert_eq!(m.state("a", "act:board"), json!({"strokes": 2}));
    // it comes back with a fresh app (nothing kept): everyone sends it the board
    if let Some(h) = m.apps.get_mut("h") {
        h.present = true;
        h.stores = Stores::default();
    }
    m.open("h", "act:board", Box::new(Board));
    for id in ["a", "b"] {
        m.run(id, |s, ctx, out| s.peer_open(&pid("h"), ctx, out));
    }
    m.wait(10.0);
    assert_eq!(
        m.state("h", "act:board"),
        json!({"strokes": 2}),
        "the host gets the game it left"
    );
    m.dispatch("a", "act:board", &json!({"kind": "draw"}));
    m.wait(5.0);
    for id in ["h", "a", "b"] {
        assert_eq!(m.state(id, "act:board"), json!({"strokes": 3}), "{id}");
    }
}

#[test]
fn messages_for_games_we_dont_have_are_answered_gone() {
    let mut m = Mesh::new(&["h", "a"], "h");
    m.open("h", "act:chess", Box::new(Board));
    m.wait(5.0);
    // a doesn't have chess: the host's request was answered "gone", so the host decides alone
    let p = m.apps["h"]
        .stores
        .get("act:chess")
        .map(|s| s.presence().clone())
        .unwrap_or_default();
    assert_eq!(p.members, vec![pid("h")]);
    assert!(m.sent.iter().any(|(f, t, msg)| f.as_str() == "a"
        && t.as_str() == "h"
        && matches!(msg, PeerMessage::RoomStateGone { key } if key == "act:chess")));
}
