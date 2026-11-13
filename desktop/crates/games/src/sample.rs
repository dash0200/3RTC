//! The development example (`features/activities/sample/`): a shared counter. Listed only in
//! development builds, as in the web app; the activity tests drive it.

use serde_json::{Value, json};

use crate::{ActivityDef, Meta, Reducer, js_slice, js_string};

/// Its menu entry.
pub const DEF: ActivityDef = ActivityDef {
    id: "sample-counter",
    name: "Sample counter",
    icon: "🧪",
    description: "Dev example of a shared activity",
    min_people: 1,
};

/// `{ count, last: { by, name, step } | null }`.
pub struct Counter;

impl Reducer for Counter {
    fn initial(&self) -> Value {
        json!({ "count": 0, "last": null })
    }

    fn reduce(&self, state: &Value, action: &Value, meta: &mut Meta<'_>) -> Option<Value> {
        match action.get("kind").and_then(Value::as_str) {
            Some("add") => {
                // Number(step): integers within ±10 only
                let step = action.get("step").and_then(Value::as_f64)?;
                if step.fract() != 0.0 || step.abs() > 10.0 {
                    return None;
                }
                #[allow(clippy::cast_possible_truncation)]
                let step = step as i64;
                let count = state.get("count").and_then(Value::as_i64).unwrap_or(0) + step;
                let name = match action.get("name") {
                    None | Some(Value::Null) => String::new(),
                    Some(Value::String(s)) => s.clone(),
                    Some(v) => js_string(v),
                };
                Some(json!({
                    "count": count,
                    "last": { "by": meta.by, "name": js_slice(&name, 40), "step": step },
                }))
            }
            Some("reset") => meta.is_host.then(|| self.initial()),
            _ => None,
        }
    }
}

/// What the counter shows: the count and the line under it.
#[must_use]
pub fn view(state: &Value) -> (i64, String) {
    let count = state.get("count").and_then(Value::as_i64).unwrap_or(0);
    let line = state.get("last").filter(|l| !l.is_null()).map_or_else(
        || "Nobody has pressed anything yet".to_owned(),
        |l| {
            let name = l
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .unwrap_or("Someone");
            let step = l.get("step").and_then(Value::as_i64).unwrap_or(0);
            format!(
                "{name} {} {}",
                if step > 0 { "added" } else { "took" },
                step.abs()
            )
        },
    );
    (count, line)
}

/// An action: add `step` (−1 or +1 from the buttons).
#[must_use]
pub fn add(step: i64, name: &str) -> Value {
    json!({ "kind": "add", "step": step, "name": name })
}

/// An action: back to 0 (the host only).
#[must_use]
pub fn reset() -> Value {
    json!({ "kind": "reset" })
}
