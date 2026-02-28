@echo off
setlocal

set ROOT=%~dp0\..
pushd %ROOT%

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
