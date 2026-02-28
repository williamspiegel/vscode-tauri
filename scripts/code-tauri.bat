@echo off
setlocal

set ROOT=%~dp0\..
pushd %ROOT%

if "%VSCODE_TAURI_NODE_BINARY%"=="" (
  for /f "usebackq delims=" %%i in (`where node 2^>nul`) do if not defined VSCODE_TAURI_NODE_BINARY set "VSCODE_TAURI_NODE_BINARY=%%i"
)

set MODE=dev
if "%1"=="--build" (
  set MODE=build
  shift
)

if "%VSCODE_SKIP_PRELAUNCH%"=="" (
  node build/lib/preLaunch.ts
)

node build/tauri/run-tauri.mjs %MODE% %*

popd
endlocal
