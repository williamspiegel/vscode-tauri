# Tauri Capability Inventory Baseline

Generated from these upstream touchpoints:
- `src/vs/platform/native/common/native.ts`
- `src/vs/code/electron-main/app.ts`
- `src/vs/workbench/workbench.desktop.main.ts`

Generated from these Tauri touchpoints:
- `apps/tauri/protocol/host-v1.json`
- `apps/tauri/src-tauri/src/main.rs`
- `apps/tauri/src-tauri/src/capabilities/*.rs`

Generated at: 2026-02-22T03:29:07.283Z

## Protocol Coverage Snapshot

- Protocol methods: 37
- Rust primary methods with handler entrypoints: 34
- Methods missing Rust entrypoints (Node fallback required): 0
- Host/protocol core methods: 3
- Note: methods counted as Rust primary can still route to Node fallback at runtime based on platform or partial implementation.

### By Domain

| Domain | Total | Rust Primary Entry | Missing Rust Entry | Host Core |
| --- | ---: | ---: | ---: | ---: |
| clipboard | 2 | 2 | 0 | 0 |
| dialogs | 4 | 4 | 0 | 0 |
| filesystem | 5 | 5 | 0 | 0 |
| host | 2 | 0 | 0 | 2 |
| os | 3 | 3 | 0 | 0 |
| power | 3 | 3 | 0 | 0 |
| process | 5 | 5 | 0 | 0 |
| protocol | 1 | 0 | 0 | 1 |
| terminal | 4 | 4 | 0 | 0 |
| update | 3 | 3 | 0 | 0 |
| window | 5 | 5 | 0 | 0 |

### Methods Missing Rust Entry


## Native Host Methods
Count: 97

- clearToast
- clearToasts
- closeWindow
- createZipFile
- exit
- findFreePort
- focusWindow
- getActiveWindowId
- getActiveWindowPosition
- getCurrentThermalState
- getCursorScreenPoint
- getNativeWindowHandle
- getOSColorScheme
- getOSProperties
- getOSStatistics
- getOSVirtualMachineHint
- getProcessId
- getScreenshot
- getSystemIdleState
- getSystemIdleTime
- getWindowCount
- getWindows
- hasClipboard
- hasWSLFeatureInstalled
- installShellCommand
- isAdmin
- isFullScreen
- isMaximized
- isOnBatteryPower
- isPortFree
- isPowerSaveBlockerStarted
- isRunningUnderARM64Translation
- isWindowAlwaysOnTop
- killProcess
- loadCertificates
- lookupAuthorization
- lookupKerberosAuthorization
- maximizeWindow
- mergeAllWindowTabs
- minimizeWindow
- moveItemToTrash
- moveWindowTabToNewWindow
- moveWindowTop
- newWindowTab
- notifyReady
- openContentTracingWindow
- openDevTools
- openDevToolsWindow
- openExternal
- openGPUInfoWindow
- openSessionsWindow
- openWindow
- pickFileAndOpen
- pickFileFolderAndOpen
- pickFolderAndOpen
- pickWorkspaceAndOpen
- positionWindow
- profileRenderer
- quit
- readClipboardBuffer
- readClipboardFindText
- readClipboardText
- readImage
- relaunch
- reload
- resolveProxy
- saveWindowSplash
- setBackgroundThrottling
- setDocumentEdited
- setMinimumSize
- setRepresentedFilename
- setWindowAlwaysOnTop
- showItemInFolder
- showMessageBox
- showNextWindowTab
- showOpenDialog
- showPreviousWindowTab
- showSaveDialog
- showToast
- startPowerSaveBlocker
- stopPowerSaveBlocker
- stopTracing
- toggleDevTools
- toggleFullScreen
- toggleWindowAlwaysOnTop
- toggleWindowTabsBar
- triggerPaste
- uninstallShellCommand
- unmaximizeWindow
- updateTouchBar
- updateWindowAccentColor
- updateWindowControls
- windowsGetStringRegKey
- writeClipboardBuffer
- writeClipboardFindText
- writeClipboardText
- writeElevated

## Electron Main IPC Channels
Count: 21

- browserElements
- diagnostics
- encryption
- extensionhostdebugservice
- externalTerminal
- keyboardLayout
- launch
- logger
- menubar
- nativeHost
- policy
- process
- profileStorageListener
- sign
- storage
- update
- url
- userDataProfiles
- webContentExtractor
- webview
- workspaces

## Desktop Service Imports
Count: 51

- accessibility/electron-browser/accessibilityService.js
- auxiliaryWindow/electron-browser/auxiliaryWindowService.js
- browserElements/electron-browser/browserElementsService.js
- browserView/electron-browser/playwrightWorkbenchService.js
- checksum/electron-browser/checksumService.js
- clipboard/electron-browser/clipboardService.js
- configurationResolver/electron-browser/configurationResolverService.js
- contextmenu/electron-browser/contextmenuService.js
- dialogs/electron-browser/fileDialogService.js
- encryption/electron-browser/encryptionService.js
- environment/electron-browser/shellEnvironmentService.js
- extensionManagement/electron-browser/extensionGalleryManifestService.js
- extensionManagement/electron-browser/extensionManagementServerService.js
- extensionManagement/electron-browser/extensionManagementService.js
- extensionManagement/electron-browser/extensionTipsService.js
- extensions/electron-browser/extensionHostStarter.js
- extensions/electron-browser/extensionsScannerService.js
- extensions/electron-browser/nativeExtensionService.js
- files/electron-browser/elevatedFileService.js
- host/electron-browser/nativeHostService.js
- imageResize/electron-browser/imageResizeService.js
- integrity/electron-browser/integrityService.js
- keybinding/electron-browser/nativeKeyboardLayout.js
- lifecycle/electron-browser/lifecycleService.js
- localization/electron-browser/languagePackService.js
- localization/electron-browser/localeService.js
- mcp/electron-browser/mcpGalleryManifestService.js
- mcp/electron-browser/mcpWorkbenchManagementService.js
- menubar/electron-browser/menubarService.js
- path/electron-browser/pathService.js
- power/electron-browser/powerService.js
- process/electron-browser/processService.js
- request/electron-browser/requestService.js
- search/electron-browser/searchService.js
- secrets/electron-browser/secretStorageService.js
- telemetry/electron-browser/telemetryService.js
- textfile/electron-browser/nativeTextFileService.js
- themes/electron-browser/nativeHostColorSchemeService.js
- themes/electron-browser/themes.contribution.js
- timer/electron-browser/timerService.js
- title/electron-browser/titleService.js
- tunnel/electron-browser/tunnelService.js
- update/electron-browser/updateService.js
- url/electron-browser/urlService.js
- userDataSync/browser/userDataSyncEnablementService.js
- userDataSync/electron-browser/userDataAutoSyncService.js
- userDataSync/electron-browser/userDataSyncService.js
- workingCopy/electron-browser/workingCopyBackupService.js
- workingCopy/electron-browser/workingCopyHistoryService.js
- workspaces/electron-browser/workspaceEditingService.js
- workspaces/electron-browser/workspacesService.js
