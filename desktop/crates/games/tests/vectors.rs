//! The golden vectors (BUILD_SPEC 6.11): every step the web app's own reducers took in scripted
//! and random games (`client-ts/tests/vectors/`), replayed through the Rust rules. Each result
//! must be the same JSON, and each rejection a rejection.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests: failing loudly is the point

use std::path::Path;

use rtc_games::{Meta, reducer_for};
use serde_json::Value;

fn run(file: &Path) -> usize {
    let text = std::fs::read_to_string(file).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let key = v["key"].as_str().unwrap();
    let reducer = reducer_for(key).unwrap_or_else(|| panic!("no rules for {key}"));
    let mut steps = 0;
    for case in v["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap_or("?");
        let mut state = case["initial"].clone();
        if case.get("custom").and_then(Value::as_bool) != Some(true) {
            assert_eq!(state, reducer.initial(), "{name}: initial state");
        }
        for (n, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let meta = &step["meta"];
            let present: Vec<String> = meta["present"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap().to_owned())
                .collect();
            let clients = meta["clients"].clone();
            let client_of = move |p: &str| clients.get(p).and_then(Value::as_str).map(str::to_owned);
            let randoms: Vec<f64> = meta["randoms"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r.as_f64().unwrap())
                .collect();
            let mut used = 0;
            let mut random = || {
                let r = randoms
                    .get(used)
                    .copied()
                    .unwrap_or_else(|| panic!("{name} step {n}: more random numbers than the web app used"));
                used += 1;
                r
            };
            let mut m = Meta {
                by: meta["by"].as_str().unwrap(),
                is_host: meta["isHost"].as_bool().unwrap(),
                self_id: meta["selfId"].as_str().unwrap(),
                host_id: meta["hostId"].as_str(),
                present: &present,
                client_of: &client_of,
                playback_lock: meta["playbackLock"].as_bool().unwrap_or(false),
                now_ms: meta["now"].as_f64().unwrap(),
                random: &mut random,
            };
            let got = reducer.reduce(&state, &step["action"], &mut m);
            let want = &step["next"];
            match (got, want.is_null()) {
                (None, true) => {}
                (Some(g), false) => {
                    assert_eq!(&g, want, "{name} step {n}: action {}", step["action"]);
                    if let Some(views) = step.get("views").and_then(Value::as_object) {
                        for (peer, seen) in views {
                            let mine = reducer.redact(&g, peer).unwrap_or_else(|| g.clone());
                            assert_eq!(&mine, seen, "{name} step {n}: what {peer} sees");
                        }
                    }
                    state = g;
                }
                (None, false) => panic!(
                    "{name} step {n}: rejected {} (the web app took it: {want})",
                    step["action"]
                ),
                (Some(g), true) => panic!(
                    "{name} step {n}: took {} (the web app rejected it) -> {g}",
                    step["action"]
                ),
            }
            assert_eq!(
                used,
                randoms.len(),
                "{name} step {n}: used fewer random numbers than the web app"
            );
            steps += 1;
        }
    }
    steps
}

#[test]
fn every_game_plays_exactly_as_the_web_app() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no vectors in {}", dir.display());
    for f in files
        .iter()
        .filter(|f| f.extension().is_some_and(|e| e == "json"))
    {
        let steps = run(f);
        assert!(steps > 0, "{}: no steps", f.display());
    }
}
