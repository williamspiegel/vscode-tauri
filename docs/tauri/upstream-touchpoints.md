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
| `test/automation/src/code.ts` | Added `LaunchOptions.tauri` and Tauri launch routing for smoke/integration automation. |
| `test/automation/src/playwrightTauri.ts` | Added Playwright launcher for Tauri-hosted smoke/integration automation path. |
| `test/smoke/src/main.ts` | Added `--tauri` smoke-runner mode and wiring into automation launch options. |
| `test/unit/tauri/index.js` | Added Node/Mocha Tauri unit harness with UI-module transpile pre-step. |
| `test/unit/tauri/hostProtocol.test.js` | Added protocol contract behavior tests for Tauri UI host protocol helpers. |
| `test/unit/tauri/desktopSandbox.test.js` | Added Tauri sandbox global bridge tests for `window.vscode` shims. |
| `test/unit/tauri/desktopChannels.test.js` | Added Tauri desktop channel adapter normalization tests (filesystem payload/stream handling, watcher + extension-host events, sync/store and external-terminal fallback shapes). |
| `test/unit/tauri/renderer.html` | Added browser harness scaffold for Tauri renderer-side unit tests. |
| `test/unit/tauri/renderer.js` | Added browser harness scaffold test bootstrap for Tauri renderer tests. |
| `scripts/test-tauri-unit.sh` | Added POSIX Tauri unit suite runner (`tauri:test-unit`). |
| `scripts/test-tauri-integration.sh` | Added POSIX Tauri integration suite runner (`tauri:test-integration`). |
| `scripts/test-tauri-smoke.sh` | Added POSIX Tauri smoke suite runner (`tauri:test-smoke`). |
| `scripts/test-tauri-unit.bat` | Added Windows Tauri unit suite runner parity with POSIX scripts. |
| `scripts/test-tauri-integration.bat` | Added Windows Tauri integration suite runner parity with POSIX scripts. |
| `scripts/test-tauri-smoke.bat` | Added Windows Tauri smoke suite runner parity with POSIX scripts. |
| `.github/workflows/tauri-parity-macos.yml` | Added macOS CI workflow to run `npm run tauri:test-all`. |

## Update Rule

When a pull request changes files outside the allowed fork-only directories, update this file in the same pull request with exact paths and rationale.
