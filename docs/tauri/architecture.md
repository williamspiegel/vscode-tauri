# Tauri Migration Architecture

## Goals

- Port desktop runtime from Electron host to a Tauri host.
- Keep merge conflicts with upstream `microsoft/vscode` minimal.
- Preserve behavior parity while Rust handlers replace temporary Node fallback adapters.

## Runtime Model

- UI Runtime: VS Code web workbench loaded in Tauri WebView.
- Host Control Plane: Rust/Tauri app controls lifecycle and capability routing.
- Data Plane: Capability dispatch prefers Rust handlers and transparently falls back to Node adapters when needed.

## Capability Flow

1. UI sends JSON-RPC request to Rust host via `host_invoke`.
2. Router maps method prefix (`window.*`, `filesystem.*`, etc.) to a capability domain.
3. Rust primary handler runs first.
4. If Rust returns `None`, Node fallback adapter executes.
5. Fallback metrics are incremented and persisted for migration burn-down tracking.

## Fallback Telemetry

- Counters persist across runs in `apps/tauri/logs/fallback-metrics.json` during repo-based development.
- Event history is appended in `apps/tauri/logs/fallback-metrics.events.jsonl`.
- Override paths with:
  - `VSCODE_TAURI_FALLBACK_METRICS_PATH`
  - `VSCODE_TAURI_FALLBACK_EVENTS_PATH`

## Merge-Surface Rules

- Fork-specific code should stay in:
  - `apps/tauri/`
  - `build/tauri/`
  - `docs/tauri/`
- Any other modified path must be recorded in `docs/tauri/upstream-touchpoints.md`.
