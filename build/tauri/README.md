# Tauri Build Helpers

This directory contains helper scripts for the Tauri migration workflow.

## Scripts

- `run-tauri.mjs`: entrypoint for `tauri:dev` and `tauri:build` root scripts.
- `smoke.mjs`: fast structural smoke checks for required Tauri files.
- `contract-test.mjs`: protocol contract checks for `apps/tauri/protocol/host-v1.json`.
- `generate-capability-inventory.mjs`: extracts baseline inventory from upstream touchpoints and emits protocol vs Rust-handler coverage snapshot.
- `fallback-telemetry-report.mjs`: generates markdown report from persisted Node fallback counters and event history.
- `touchpoint-gate.mjs`: CI gate for low-conflict-surface touchpoint policy.
- `upstream-sync-report.mjs`: emits markdown summary for daily upstream sync workflow.
