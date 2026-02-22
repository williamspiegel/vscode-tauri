# Upstream Touchpoints Ledger

This ledger tracks edits outside the preferred fork-only directories.

## Allowed Fork-Only Directories

- `apps/tauri/`
- `build/tauri/`
- `docs/tauri/`

## Recorded Out-of-Bounds Edits

| Path | Reason |
| --- | --- |
| `package.json` | Added root `tauri:*` scripts for developer workflow and CI hooks. |
| `scripts/code-tauri.sh` | Added POSIX launcher for Tauri host runtime. |
| `scripts/code-tauri.bat` | Added Windows launcher for Tauri host runtime. |
| `.github/workflows/tauri-upstream-sync.yml` | Added daily upstream sync automation and report publishing. |
| `.github/workflows/tauri-touchpoint-gate.yml` | Added CI guard to enforce low conflict-surface policy. |
| `.gitignore` | Ignored Tauri runtime artifacts (`apps/tauri/logs/`, `apps/tauri/ui/out`, `apps/tauri/ui/.cache/`) and generated report markdown files. |

## Update Rule

When a pull request changes files outside the allowed fork-only directories, update this file in the same pull request with exact paths and rationale.
