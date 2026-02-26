@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0\.."

echo ### Tauri structural smoke
node build\tauri\smoke.mjs
if %errorlevel% neq 0 exit /b %errorlevel%
node build\tauri\startup-bundle-test.mjs
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo ### Tauri end-to-end smoke
if "%VSCODE_TAURI_RUN_E2E_SMOKE%"=="1" (
	if not exist test\smoke\out\main.js (
		cd test\smoke
		call npm run compile
		if !errorlevel! neq 0 exit /b !errorlevel!
		cd /d "%~dp0\.."
	)
	node test\smoke\out\main.js --tauri --headless %*
	if !errorlevel! neq 0 exit /b !errorlevel!
) else (
	echo SKIP tauri-e2e-smoke: TODO https://github.com/microsoft/vscode/issues/244147 ^(set VSCODE_TAURI_RUN_E2E_SMOKE=1 to execute^)
)
