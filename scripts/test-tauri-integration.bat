@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0\.."

echo ### Tauri integration preflight
node build\tauri\contract-test.mjs
if %errorlevel% neq 0 exit /b %errorlevel%
node build\tauri\smoke.mjs
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo ### API tests ^(folder/workspace^) for Tauri
if "%VSCODE_TAURI_RUN_API_INTEGRATION%"=="1" (
	set INTEGRATION_TEST_ELECTRON_PATH=.\scripts\code-tauri.bat
	set VSCODE_TAURI_INTEGRATION=1
	call .\scripts\test-integration.bat %*
	if !errorlevel! neq 0 exit /b !errorlevel!
) else (
	echo SKIP api-tests-folder-workspace: TODO https://github.com/microsoft/vscode/issues/244145 ^(set VSCODE_TAURI_RUN_API_INTEGRATION=1 to execute^)
)

echo.
echo ### Built-in extension integration suites for Tauri
echo SKIP typescript/markdown/emmet/git/ipynb/configuration-editing: TODO https://github.com/microsoft/vscode/issues/244146
