@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0\.."

echo ### Tauri integration preflight
node build\tauri\contract-test.mjs
if %errorlevel% neq 0 exit /b %errorlevel%
node build\tauri\smoke.mjs
if %errorlevel% neq 0 exit /b %errorlevel%

set VSCODEUSERDATADIR=%TEMP%\vscodeuserfolder-%RANDOM%-%TIME:~6,2%
set VSCODECRASHDIR=%CD%\.build\crashes
set VSCODELOGSDIR=%CD%\.build\logs\integration-tests
if "%INTEGRATION_TEST_ELECTRON_PATH%"=="" set INTEGRATION_TEST_ELECTRON_PATH=.\scripts\code-tauri.bat
set API_TESTS_EXTRA_ARGS=--disable-telemetry --disable-experiments --skip-welcome --skip-release-notes --crash-reporter-directory=%VSCODECRASHDIR% --logsPath=%VSCODELOGSDIR% --no-cached-data --disable-updates --use-inmemory-secretstorage --disable-extensions --disable-workspace-trust --user-data-dir=%VSCODEUSERDATADIR%

mkdir "%VSCODECRASHDIR%" >nul 2>nul
mkdir "%VSCODELOGSDIR%" >nul 2>nul

set VSCODE_CLI=1
set VSCODE_SKIP_PRELAUNCH=1
set VSCODE_TAURI_NO_DEV_SERVER=1
set VSCODE_TAURI_NO_WATCH=1
set VSCODE_TAURI_DISABLE_DEFAULT_EXTENSIONS_GALLERY=1

echo Running Tauri API integration tests with '%INTEGRATION_TEST_ELECTRON_PATH%' as build.
echo Storing crash reports into '%VSCODECRASHDIR%'.
echo Storing log files into '%VSCODELOGSDIR%'.

echo.
echo ### API tests ^(folder/workspace^) for Tauri
if "%VSCODE_TAURI_RUN_API_INTEGRATION%"=="1" (
	set VSCODE_TAURI_INTEGRATION=1

	echo.
	echo ### API tests ^(folder^)
	call "%INTEGRATION_TEST_ELECTRON_PATH%" %CD%\extensions\vscode-api-tests\testWorkspace --enable-proposed-api=vscode.vscode-api-tests --extensionDevelopmentPath=%CD%\extensions\vscode-api-tests --extensionTestsPath=%CD%\extensions\vscode-api-tests\out\singlefolder-tests %API_TESTS_EXTRA_ARGS% %*
	if !errorlevel! neq 0 exit /b !errorlevel!

	if not "%INTEGRATION_TEST_APP_NAME%"=="" (
		killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
	)

	echo.
	echo ### API tests ^(workspace^)
	call "%INTEGRATION_TEST_ELECTRON_PATH%" %CD%\extensions\vscode-api-tests\testworkspace.code-workspace --enable-proposed-api=vscode.vscode-api-tests --extensionDevelopmentPath=%CD%\extensions\vscode-api-tests --extensionTestsPath=%CD%\extensions\vscode-api-tests\out\workspace-tests %API_TESTS_EXTRA_ARGS% %*
	if !errorlevel! neq 0 exit /b !errorlevel!

	if not "%INTEGRATION_TEST_APP_NAME%"=="" (
		killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
	)
) else (
	echo SKIP api-tests-folder-workspace: TODO https://github.com/microsoft/vscode/issues/244145 ^(set VSCODE_TAURI_RUN_API_INTEGRATION=1 to execute^)
)

echo.
echo ### Built-in extension integration suites for Tauri
echo SKIP typescript/markdown/emmet/git/ipynb/configuration-editing: TODO https://github.com/microsoft/vscode/issues/244146

rmdir /s /q %VSCODEUSERDATADIR% >nul 2>nul
