# Tauri Migration Architecture

## Goals

- Port desktop runtime from Electron host to a Tauri host.
- Keep merge conflicts with upstream `microsoft/vscode` minimal.
- Preserve behavior parity while Rust handlers replace temporary Node fallback adapters.

## Runtime Model (Desktop Hard Switch)

- UI Runtime: VS Code desktop workbench bootstrap loaded from `/out/vs/code/electron-browser/workbench/workbench.js`.
- Sandbox Globals: `window.vscode` shim is installed from `apps/tauri/ui/src/desktopSandbox.ts` before desktop bootstrap import.
- Renderer IPC Bridge: Electron-style channel calls are proxied through renderer-side channel adapters in `apps/tauri/ui/src/desktopChannels.ts`.
- Host Control Plane: Rust/Tauri app controls lifecycle and protocol routing.
- Data Plane: Rust capability handlers execute first, then Node fallback handles missing capability/channel methods.

## Protocol Shape

- JSON-RPC protocol version: `1.0.0`
- Desktop methods:
  - `desktop.resolveWindowConfig`
  - `desktop.channelCall`
  - `desktop.channelListen`
  - `desktop.channelUnlisten`
- Desktop event envelope:
  - `desktop.channelEvent`

## Desktop Config Source

`desktop.resolveWindowConfig` returns an `INativeWindowConfiguration`-compatible payload sourced from:

- `product.json`
- `out/nls.messages.json`
- repo-local user data paths under `.vscode-tauri/user-data`
- explicit defaults for `windowId`, `profiles`, `os`, `logLevel`, and `colorScheme`

## Fallback Telemetry

- Counters persist in `apps/tauri/logs/fallback-metrics.json`.
- Event history persists in `apps/tauri/logs/fallback-metrics.events.jsonl`.
- Fallback keys are classed as:
  - `capability:<domain>:<method>`
  - `channel:<channel>:<method>`

## Merge-Surface Rules

- Fork-specific code should stay in:
  - `apps/tauri/`
  - `build/tauri/`
  - `docs/tauri/`
- Any other modified path must be recorded in `docs/tauri/upstream-touchpoints.md`.
