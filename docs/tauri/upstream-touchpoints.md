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
| `src/vs/workbench/services/environment/electron-browser/environmentService.ts` | Added Tauri runtime-specific webview endpoint fallback to avoid sandboxed iframe custom-protocol load failures. |
| `src/vs/workbench/contrib/webview/browser/webviewElement.ts` | Added Tauri runtime sandbox attribute normalization for outer webview iframe creation to preserve `allow-scripts` under WebKit/Tauri. |
| `src/vs/workbench/contrib/webview/browser/pre/index.html` | Added Tauri path-endpoint handshake support that validates strict same-origin (`parentOrigin === location.origin`) when subdomain-hash hostname mode is not used. |
| `src/vs/workbench/contrib/webview/electron-browser/webviewElement.ts` | Routed Tauri runtime webview content endpoint through configured external endpoint instead of forcing `vscode-webview://` to keep sandboxed iframe loads working. |

## Update Rule

When a pull request changes files outside the allowed fork-only directories, update this file in the same pull request with exact paths and rationale.
