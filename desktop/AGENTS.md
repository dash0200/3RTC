# Working on the desktop app

Read [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md) first and follow it: it has the rules, the
architecture, the UI spec (the app must look like 3rtc.me; references in `docs/ui-reference/`),
every feature with its web sources, the milestones and their exit checklists.

Before every push, from `desktop/`:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Work on the `CLAUDE` branch, one milestone at a time, and stop and ask in the cases the spec lists.
