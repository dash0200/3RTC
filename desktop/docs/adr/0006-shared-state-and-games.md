# 6. Shared state and games: one store in the core, rules in `crates/games` (M6)

Date: 2026-11-13 · Status: accepted (owner, 13 Nov: "start with M6"); being built in M6

## Context

Every game, and which activity the room has open, is shared room state
(`core/sharedState.ts`): one app (the host, else the smallest peer id among those who have the
store) applies everyone's actions with the game's reducer and sends the result. The desktop
app must take part in the same rooms as the web app, as a player and as the one who decides,
and its rules must give exactly the web app's results, or two apps would disagree about a game.

## Decision

- **The store is ported to `rtc_core::shared`**, pure like the rest of the core: authority,
  versions, catch-up for a new store (3 s), late joiners, `room-state-gone` (who has a store),
  per-peer redaction. The room feeds it messages and channel events
  (`core/src/room/activity.rs`) and sends what it returns. States and actions are JSON
  (`serde_json::Value`) at this boundary, as on the wire.
- **Rules live in a new crate, `rtc-games`**: a `Reducer` trait (initial, reduce, redact) and one
  module per game, plus the open-activity reducer and the development example (Sample counter).
  No I/O, no clock, no randomness of its own: `Meta` brings `now_ms` and `random`, so the crate
  can be built for the web app (WASM) later, as the spec plans. `core` depends on `games` (the
  store runs its reducers and reads the open activity); `games` still depends on nothing of
  ours. The spec's crate table said `core` depends on `protocol` only: changed with this ADR.
- **Golden vectors prove the port.** `client-ts/tests/vectors/export.ts` plays scripted and random
  games through the web reducers, recording each action, what the reducer was told (who, host,
  present, clock, the random numbers it drew) and the resulting state, or a rejection.
  `crates/games/tests/vectors.rs` replays them; any difference fails. A reducer rejects by
  returning `None` (the web store compares by reference, so a new equal state is a change, and
  the Rust store follows that).
- **Activities in the app** (`app/src/activity.rs`): the dock's "Play together" menu, the game
  full size over the stage with its bar (Minimise / ▶ Video, Leave, End with a second tap
  "End for all?"), the bubble (minimised, or "Join <game>" when not loaded here), and the card
  for a game this version doesn't have ("Update app"). A video's window would cover a GPUI game,
  so the video hides while the game is open full size and returns when it's minimised.
- The development example is listed in debug builds (as in the web app's dev builds) or with
  `RTC_DEV_ACTIVITIES=1`; the interop tests use it against the web app's dev server.

## Consequences

- Each game is a rules port checked step by step, then a native board.
- Not yet (later in M6 or after): the sidebar and small-window views of a game (the web app docks
  a game beside a playing video); the game staying loaded across an app restart; the
  protocol-version check before starting (every desktop build has shared state).
