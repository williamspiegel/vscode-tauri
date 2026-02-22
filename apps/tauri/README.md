# VS Code Tauri Host

This folder contains the Tauri host runtime for this fork.

## Layout

- `protocol/host-v1.json`: JSON-RPC protocol contract between UI and host.
- `src-tauri/`: Rust Tauri host process and capability router.
- `ui/`: Host web shell that boots the VS Code web workbench.
- `node/`: Node fallback adapters used when Rust capability handlers are incomplete.

## Design Constraints

- Keep upstream merge surface low by avoiding edits in `src/vs/**` where possible.
- Treat Rust handlers as primary implementations.
- Keep Node fallback available and observable during parity migration.
- Preserve existing gallery/product policy from root `product.json`.
