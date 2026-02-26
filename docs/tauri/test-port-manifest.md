# Tauri Test Port Manifest

This manifest tracks Electron test coverage ports into the Tauri runtime.

## Legend

- `Ported`: test behavior is now covered by Tauri unit/integration/smoke checks.
- `In Progress`: planned and partially scaffolded.
- `Skipped`: intentionally deferred with tracking issue.

## Unit Coverage Mapping

| Electron Source Test | Tauri Target | Status | Notes |
| --- | --- | --- | --- |
| `src/vs/base/parts/sandbox/test/electron-browser/globals.test.ts` | `test/unit/tauri/desktopSandbox.test.js` | Ported | Validates `window.vscode` bridge shape and process shim behavior. |
| `src/vs/base/parts/ipc/test/electron-browser/ipc.mp.test.ts` | `apps/tauri/src-tauri/src/router.rs` + `apps/tauri/ui/src/desktopSandbox.ts` | In Progress | Message-port transport parity currently validated by router + startup checks. |
| `src/vs/workbench/services/dialogs/test/electron-browser/fileDialogService.test.ts` | `apps/tauri/src-tauri/src/capabilities/dialogs.rs` tests | In Progress | Rust-primary dialog behavior under active parity work. |
| `src/vs/workbench/services/textfile/test/electron-browser/nativeTextFileService.io.test.ts` | `apps/tauri/src-tauri/src/capabilities/filesystem.rs` tests | In Progress | File read/write/stat parity mapped to filesystem capability tests. |
| `src/vs/workbench/services/textfile/test/electron-browser/nativeTextFileService.test.ts` | `apps/tauri/src-tauri/src/capabilities/filesystem.rs` tests | In Progress | Covers non-IO capability semantics. |
| `src/vs/workbench/services/workingCopy/test/electron-browser/workingCopyBackupService.test.ts` | `apps/tauri/src-tauri/src/router.rs` tests | In Progress | Repo-backed workspace/user-data behavior validated in router tests. |
| `src/vs/workbench/services/workingCopy/test/electron-browser/workingCopyHistoryService.test.ts` | `apps/tauri/src-tauri/src/router.rs` tests | In Progress | History storage parity in progress via channel runtime state coverage. |
| `src/vs/platform/windows/test/electron-main/windowsFinder.test.ts` | `apps/tauri/src-tauri/src/capabilities/window.rs` tests | In Progress | Window route parity and state query semantics. |
| `src/vs/platform/windows/test/electron-main/windowsStateHandler.test.ts` | `apps/tauri/src-tauri/src/router.rs` tests | In Progress | Tauri window/workspace state persistence parity. |
| `src/vs/platform/storage/test/electron-main/storageMainService.test.ts` | `apps/tauri/src-tauri/src/router.rs::storage_channel_is_stateful` | Ported | Stateful storage channel test exists in Rust. |
| `src/vs/platform/workspaces/test/electron-main/workspacesManagementMainService.test.ts` | `apps/tauri/src-tauri/src/router.rs::workspaces_and_local_pty_use_repo_backed_state` | Ported | Workspace + local PTY state test exists in Rust. |
| `src/vs/platform/backup/test/electron-main/backupMainService.test.ts` | `apps/tauri/src-tauri/src/router.rs` backup/state tests | In Progress | Data-path parity still expanding. |
| `src/vs/workbench/contrib/extensions/test/electron-browser/*.test.ts` | `apps/tauri/src-tauri/src/router.rs` extension channel tests | In Progress | Archive/install/metadata tests partially covered in Rust. |

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
