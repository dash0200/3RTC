#!/usr/bin/env bash
# Linux/macOS twin of dev.ps1: local signaling server + the desktop app.
#   ./dev.sh          app + local server        ./dev.sh --prod    use the real server
#   ./dev.sh --check  fmt, clippy, tests (what CI runs)
set -euo pipefail
cd "$(dirname "$0")"
repo="$(cd .. && pwd)"
if [[ "${1:-}" == "--check" ]]; then
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets -- -D warnings
  [[ -d "$repo/server/node_modules" ]] || (cd "$repo/server" && npm ci)
  exec cargo test --workspace
fi
if [[ "${1:-}" != "--prod" ]]; then
  [[ -d "$repo/server/node_modules" ]] || (cd "$repo/server" && npm ci)
  if ! (exec 3<>/dev/tcp/127.0.0.1/8080) 2>/dev/null; then
    (cd "$repo/server" && PORT=8080 node server.js) &
    server=$!
    trap 'kill "$server" 2>/dev/null || true' EXIT
    sleep 1
  fi
  export RTC_SIGNAL_URL=ws://localhost:8080
fi
RUST_LOG="${RUST_LOG:-warn,rtc=debug}" cargo run -p rtc-app
