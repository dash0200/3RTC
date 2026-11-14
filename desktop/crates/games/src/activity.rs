//! Which activity the room has open (`features/activities/activityState.ts`), shared state key
//! `activity`.

use serde_json::{Value, json};

use crate::{Meta, Reducer, js_slice, js_string};

/// The shared state key.
pub const KEY: &str = "activity";

/// `{ current: { id, startedBy, startedByName, startedAt } | null }`.
pub struct Activity;

fn well_formed(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl Reducer for Activity {
    fn initial(&self) -> Value {
        json!({ "current": null })
    }

    fn reduce(&self, state: &Value, action: &Value, meta: &mut Meta<'_>) -> Option<Value> {
        if meta.playback_lock && !meta.is_host {
            return None; // host controls lock
        }
        let current = state.get("current").filter(|c| !c.is_null());
        match action.get("kind").and_then(Value::as_str) {
            Some("start") => {
                let id = action.get("id").and_then(Value::as_str)?;
                if !well_formed(id) || current.and_then(|c| c.get("id")).and_then(Value::as_str) == Some(id) {
                    return None;
                }
                let name = match action.get("byName") {
                    None | Some(Value::Null) => String::new(),
                    Some(Value::String(s)) if s.is_empty() => String::new(),
                    Some(Value::Bool(false)) => String::new(),
                    Some(v) if v.as_f64() == Some(0.0) => String::new(),
                    Some(v) => js_string(v),
                };
                Some(json!({
                    "current": {
                        "id": id,
                        "startedBy": meta.by,
                        "startedByName": js_slice(&name, 40),
                        "startedAt": meta.now(),
                    }
                }))
            }
            Some("stop") => current.map(|_| json!({ "current": null })),
            _ => None,
        }
    }
}

/// The open activity in a state (`None`: none, or a malformed state).
#[must_use]
pub fn current(state: &Value) -> Option<Current> {
    let c = state.get("current")?;
    Some(Current {
        id: c.get("id")?.as_str()?.to_owned(),
        started_by: c
            .get("startedBy")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        started_by_name: c
            .get("startedByName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        started_at: c.get("startedAt").and_then(Value::as_f64).unwrap_or_default(),
    })
}

/// The activity the room has open.
#[derive(Debug, Clone, PartialEq)]
pub struct Current {
    /// Which (`chess`, …).
    pub id: String,
    /// Peer id of who opened it.
    pub started_by: String,
    /// Their name then.
    pub started_by_name: String,
    /// When (ms since 1970).
    pub started_at: f64,
}

impl Current {
    /// What tells one opening from another (`useActivityLoad`: `<id>:<startedAt>`).
    #[must_use]
    pub fn load_key(&self) -> String {
        format!("{}:{}", self.id, crate::js_number(self.started_at))
    }
}

/// An action to open an activity.
#[must_use]
pub fn start(id: &str, by_name: &str) -> Value {
    json!({ "kind": "start", "id": id, "byName": by_name })
}

/// An action to close the open activity.
#[must_use]
pub fn stop() -> Value {
    json!({ "kind": "stop" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(state: &Value, action: &Value, by: &str, is_host: bool, lock: bool) -> Option<Value> {
        let present = vec![by.to_owned()];
        let mut rnd = || 0.5;
        let mut meta = Meta {
            by,
            is_host,
            self_id: "h",
            host_id: Some("h"),
            present: &present,
            client_of: &|_| None,
            playback_lock: lock,
            now_ms: 1_700_000_000_123.0,
            random: &mut rnd,
        };
        Activity.reduce(state, action, &mut meta)
    }

    #[test]
    fn start_and_stop() {
        let s0 = Activity.initial();
        let s1 = run(&s0, &start("chess", "Riya"), "p1", false, false).unwrap_or_default();
        assert_eq!(
            s1,
            json!({"current": {"id": "chess", "startedBy": "p1", "startedByName": "Riya", "startedAt": 1_700_000_000_123_i64}})
        );
        assert_eq!(
            current(&s1).map(|c| c.load_key()),
            Some("chess:1700000000123".to_owned())
        );
        // the same one again: rejected; another: replaces it
        assert!(run(&s1, &start("chess", "Riya"), "p2", false, false).is_none());
        assert!(run(&s1, &start("ludo", ""), "p2", false, false).is_some());
        // ids from newer apps are fine; malformed ones aren't
        assert!(run(&s0, &start("new-game-2", ""), "p1", false, false).is_some());
        assert!(run(&s0, &start("Bad Id", ""), "p1", false, false).is_none());
        assert!(run(&s0, &start(&"x".repeat(41), ""), "p1", false, false).is_none());
        assert_eq!(
            run(&s1, &stop(), "p2", false, false),
            Some(json!({"current": null}))
        );
        assert!(run(&s0, &stop(), "p2", false, false).is_none());
    }

    #[test]
    fn the_lock_leaves_it_to_the_host() {
        let s0 = Activity.initial();
        assert!(run(&s0, &start("chess", "Riya"), "p1", false, true).is_none());
        assert!(run(&s0, &start("chess", "Darshan"), "h", true, true).is_some());
    }

    #[test]
    fn names_are_cut_to_forty() {
        let s = run(
            &Activity.initial(),
            &start("chess", &"n".repeat(60)),
            "p1",
            false,
            false,
        )
        .unwrap_or_default();
        assert_eq!(s["current"]["startedByName"].as_str().map(str::len), Some(40));
    }
}
