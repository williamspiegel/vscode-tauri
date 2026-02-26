# Tauri Test Port Manifest

This manifest tracks Electron test coverage ports into the Tauri runtime.

## Legend

- `Ported`: test behavior is now covered by Tauri unit/integration/smoke checks.
- `In Progress`: planned and partially scaffolded.
- `Skipped`: intentionally deferred with tracking issue.

## Unit Coverage Mapping

| Electron Source Test | Tauri Target | Status | Notes |
| --- | --- | --- | --- |
| `src/vs/base/parts/sandbox/test/electron-browser/globals.test.ts` | `test/unit/tauri/desktopSandbox.test.js` | Ported | Validates `window.vscode` bridge shape, process/webFrame/webUtils shims, process event helpers, platform/arch fallback normalization (`os.platform`/`os.type`), global alias wiring, and zoom-level sync behavior. |
| `src/vs/platform/storage/test/electron-main/storageMainService.test.ts` | `test/unit/tauri/desktopChannels.test.js` + `apps/tauri/src-tauri/src/router.rs::{storage_channel_is_stateful,storage_is_used_tracks_insert_delete_and_scope_updates}` | Ported | Channel-level normalization plus stateful insert/delete and `isUsed` scope behavior are covered. |
| `src/vs/platform/userDataProfile/test/electron-main/userDataProfileMainService.test.ts` | `test/unit/tauri/desktopChannels.test.js` + `apps/tauri/src-tauri/src/router.rs` tests | Ported | Event payload normalization plus workspace/profile lifecycle (`create/set/reset/remove/cleanup`), update semantics, and unknown-profile mapping guards are covered. |
| `src/vs/base/parts/ipc/test/electron-browser/ipc.mp.test.ts` | `apps/tauri/src-tauri/src/router.rs` + `apps/tauri/ui/src/desktopSandbox.ts` + `test/unit/tauri/desktopChannels.test.js` | In Progress | Added `extensionHostStarter` message-port/event normalization, watcher correlation/stop/verbose behavior, watcher invalid-request validation, webview event normalization, native-host pick/open navigation flows, broader nativeHost/userDataSync/mcp/extensions/debug/watcher event normalization, and listener-failure noop behavior; full transport parity still pending. |
| `src/vs/workbench/services/configurationResolver/test/electron-browser/configurationResolverService.test.ts` | `test/unit/tauri/desktopSandbox.test.js` | In Progress | Added URL workspace/folder/empty-window (`ew`) configuration derivation coverage plus shell env merge/caching behavior via sandbox configuration resolver path. |
| `src/vs/workbench/services/dialogs/test/electron-browser/fileDialogService.test.ts` | `apps/tauri/src-tauri/src/capabilities/dialogs.rs` tests | In Progress | Added method-shape coverage for `showMessage` defaults plus button-array/button-element validation; interactive picker semantics still expanding. |
| `src/vs/workbench/services/textfile/test/electron-browser/nativeTextFileService.io.test.ts` | `apps/tauri/src-tauri/src/capabilities/filesystem.rs` + `apps/tauri/src-tauri/src/router.rs` + `test/unit/tauri/desktopChannels.test.js` | In Progress | Added base64 read/write roundtrip, fd open/write/read/close + offset/length slicing, stat/realpath/readdir/mkdir/writeFile/rename/copy/clone/delete flows, overwrite semantics, expanded resource/path/data validation branches (including close/read/write positional arg errors), watch arg checks, filesystem error-name mapping, and stream decode/error normalization (including invalid payload guards). |
| `src/vs/workbench/services/textfile/test/electron-browser/nativeTextFileService.test.ts` | `apps/tauri/src-tauri/src/capabilities/filesystem.rs` + `apps/tauri/src-tauri/src/capabilities/process.rs` + `apps/tauri/src-tauri/src/capabilities/terminal.rs` | In Progress | Added contract validation for missing/invalid params, create-parent behavior, process env/args/pid/list handling, unknown-pid wait behavior, and terminal args/env/data/id guardrails; broader non-IO parity remains. |
| `src/vs/workbench/services/workingCopy/test/electron-browser/workingCopyBackupService.test.ts` | `apps/tauri/src-tauri/src/router.rs` tests | In Progress | Repo-backed workspace/user-data behavior validated in router tests. |
| `src/vs/workbench/services/workingCopy/test/electron-browser/workingCopyHistoryService.test.ts` | `apps/tauri/src-tauri/src/router.rs` tests | In Progress | History storage parity in progress via channel runtime state coverage. |
| `src/vs/platform/windows/test/electron-main/windowsFinder.test.ts` | `apps/tauri/src-tauri/src/capabilities/window.rs` tests | In Progress | Added no-app-handle behavior assertions for main/non-main open and state calls; full native window lookup parity remains. |
| `src/vs/platform/windows/test/electron-main/windowsStateHandler.test.ts` | `apps/tauri/src-tauri/src/router.rs` tests | In Progress | Tauri window/workspace state persistence parity. |
| `src/vs/platform/workspaces/test/electron-main/workspacesManagementMainService.test.ts` | `apps/tauri/src-tauri/src/router.rs::{workspaces_and_local_pty_use_repo_backed_state,workspaces_recently_opened_can_be_added_removed_and_cleared,workspaces_delete_untitled_workspace_removes_workspace_file}` | Ported | Covers untitled workspace/local-pty state, recent-workspace mutation semantics, and untitled workspace deletion behavior. |
| `src/vs/platform/backup/test/electron-main/backupMainService.test.ts` | `apps/tauri/src-tauri/src/router.rs` backup/state tests | In Progress | Data-path parity still expanding. |
| `src/vs/workbench/contrib/extensions/test/electron-browser/*.test.ts` | `apps/tauri/src-tauri/src/router.rs` extension channel tests | In Progress | Added broad argument-validation coverage (`getManifest/zip/install/installFromLocation/installFromGallery/installGalleryExtensions/download/uninstall/toggleApplicationScope/updateMetadata`), control-manifest default fallback behavior, cache cleanup stability, menubar-action payload mapping, and profile metadata/uninstall stateful flows; full gallery/network install parity remains. |

## Integration Coverage Mapping

| Electron Integration Suite (from `scripts/test-integration.sh`) | Tauri Target | Status | Notes |
| --- | --- | --- | --- |
| API tests (folder/workspace) | `scripts/test-tauri-integration.sh` | In Progress | Executable path wired; opt-in execution via `VSCODE_TAURI_RUN_API_INTEGRATION=1`. |
| TypeScript tests | `scripts/test-tauri-integration.sh` | Skipped | Tracking: [#244146](https://github.com/microsoft/vscode/issues/244146) |
| Markdown tests | `scripts/test-tauri-integration.sh` | Skipped | Tracking: [#244146](https://github.com/microsoft/vscode/issues/244146) |
| Emmet tests | `scripts/test-tauri-integration.sh` | Skipped | Tracking: [#244146](https://github.com/microsoft/vscode/issues/244146) |
| Git tests | `scripts/test-tauri-integration.sh` | Skipped | Tracking: [#244146](https://github.com/microsoft/vscode/issues/244146) |
| Ipynb tests | `scripts/test-tauri-integration.sh` | Skipped | Tracking: [#244146](https://github.com/microsoft/vscode/issues/244146) |
| Configuration editing tests | `scripts/test-tauri-integration.sh` | Skipped | Tracking: [#244146](https://github.com/microsoft/vscode/issues/244146) |

## Smoke / E2E Coverage Mapping

| Electron Smoke Area | Tauri Target | Status | Notes |
| --- | --- | --- | --- |
| Desktop smoke launcher | `test/smoke/src/main.ts --tauri` | In Progress | `--tauri` path added to smoke launcher + automation options. |
| Structural desktop bootstrap smoke | `build/tauri/smoke.mjs` + `build/tauri/startup-bundle-test.mjs` | Ported | Included in `tauri:test-smoke`. |
| Full end-to-end smoke suites | `scripts/test-tauri-smoke.sh` | Skipped | Tracking: [#244147](https://github.com/microsoft/vscode/issues/244147); opt-in with `VSCODE_TAURI_RUN_E2E_SMOKE=1`. |
