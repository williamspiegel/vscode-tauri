@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0\.."

echo ### Tauri integration preflight
node build\tauri\contract-test.mjs
if %errorlevel% neq 0 exit /b %errorlevel%
node build\tauri\smoke.mjs
if %errorlevel% neq 0 exit /b %errorlevel%
echo ### Tauri API extension build
call .\node_modules\.bin\tsc.cmd -p "%CD%\extensions\vscode-api-tests\tsconfig.json"
if %errorlevel% neq 0 exit /b %errorlevel%

set VSCODEUSERDATADIR=%TEMP%\vscodeuserfolder-%RANDOM%-%TIME:~6,2%
set VSCODEAPITESTDIR=%TEMP%\vscode-api-tests-%RANDOM%-%TIME:~6,2%
set VSCODECONFEDITDIR=%TEMP%\vscode-confedit-%RANDOM%-%TIME:~6,2%
set VSCODEMARKDOWNDIR=%TEMP%\vscode-markdown-%RANDOM%-%TIME:~6,2%
set VSCODEIPYNBDIR=%TEMP%\vscode-ipynb-%RANDOM%-%TIME:~6,2%
set VSCODEEMMETDIR=%TEMP%\vscode-emmet-%RANDOM%-%TIME:~6,2%
set VSCODEGITDIR=%TEMP%\vscode-git-%RANDOM%-%TIME:~6,2%
set VSCODETYPESCRIPTDIR=%TEMP%\vscode-typescript-%RANDOM%-%TIME:~6,2%
set VSCODECRASHDIR=%CD%\.build\crashes
set VSCODELOGSDIR=%CD%\.build\logs\integration-tests
if "%INTEGRATION_TEST_ELECTRON_PATH%"=="" set INTEGRATION_TEST_ELECTRON_PATH=.\scripts\code-tauri.bat
set COMMON_TESTS_EXTRA_ARGS=--disable-telemetry --disable-experiments --skip-welcome --skip-release-notes --crash-reporter-directory=%VSCODECRASHDIR% --logsPath=%VSCODELOGSDIR% --no-cached-data --disable-updates --use-inmemory-secretstorage --disable-workspace-trust --user-data-dir=%VSCODEUSERDATADIR%
set API_TESTS_EXTRA_ARGS=--disable-extensions %COMMON_TESTS_EXTRA_ARGS%
set BUILTIN_EXTENSION_TESTS_EXTRA_ARGS=%COMMON_TESTS_EXTRA_ARGS%
set API_TEST_WORKSPACE_FOLDER=%VSCODEAPITESTDIR%\testWorkspace
set API_TEST_WORKSPACE_FOLDER_2=%VSCODEAPITESTDIR%\testWorkspace2
set API_TEST_WORKSPACE_FILE=%VSCODEAPITESTDIR%\testworkspace.code-workspace

mkdir "%VSCODECRASHDIR%" >nul 2>nul
mkdir "%VSCODELOGSDIR%" >nul 2>nul
mkdir "%VSCODEAPITESTDIR%" >nul 2>nul
mkdir "%VSCODEMARKDOWNDIR%" >nul 2>nul
mkdir "%VSCODEIPYNBDIR%" >nul 2>nul
mkdir "%VSCODEEMMETDIR%" >nul 2>nul
mkdir "%VSCODEGITDIR%" >nul 2>nul
mkdir "%VSCODETYPESCRIPTDIR%" >nul 2>nul
xcopy /E /I /Q /Y "%CD%\extensions\vscode-api-tests\testWorkspace" "%API_TEST_WORKSPACE_FOLDER%" >nul
xcopy /E /I /Q /Y "%CD%\extensions\vscode-api-tests\testWorkspace2" "%API_TEST_WORKSPACE_FOLDER_2%" >nul
copy /Y "%CD%\extensions\vscode-api-tests\testworkspace.code-workspace" "%API_TEST_WORKSPACE_FILE%" >nul
xcopy /E /I /Q /Y "%CD%\extensions\markdown-language-features\test-workspace" "%VSCODEMARKDOWNDIR%" >nul
xcopy /E /I /Q /Y "%CD%\extensions\emmet\test-workspace" "%VSCODEEMMETDIR%" >nul
xcopy /E /I /Q /Y "%CD%\extensions\typescript-language-features\test-workspace" "%VSCODETYPESCRIPTDIR%" >nul

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
set VSCODE_TAURI_INTEGRATION=1

echo.
echo ### API tests ^(folder^)
set VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT=%API_TEST_WORKSPACE_FOLDER%
set VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT_2=
set VSCODE_TAURI_EXPECTED_WORKSPACE_FILE=
call "%INTEGRATION_TEST_ELECTRON_PATH%" "%API_TEST_WORKSPACE_FOLDER%" --enable-proposed-api=vscode.vscode-api-tests --extensionDevelopmentPath=%CD%\extensions\vscode-api-tests --extensionTestsPath=%CD%\extensions\vscode-api-tests\out\singlefolder-tests %API_TESTS_EXTRA_ARGS% %*
if !errorlevel! neq 0 exit /b !errorlevel!

if not "%INTEGRATION_TEST_APP_NAME%"=="" (
	killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
)

echo.
echo ### API tests ^(workspace^)
set VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT=%API_TEST_WORKSPACE_FOLDER%
set VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT_2=%API_TEST_WORKSPACE_FOLDER_2%
set VSCODE_TAURI_EXPECTED_WORKSPACE_FILE=%API_TEST_WORKSPACE_FILE%
call "%INTEGRATION_TEST_ELECTRON_PATH%" "%API_TEST_WORKSPACE_FILE%" --enable-proposed-api=vscode.vscode-api-tests --extensionDevelopmentPath=%CD%\extensions\vscode-api-tests --extensionTestsPath=%CD%\extensions\vscode-api-tests\out\workspace-tests %API_TESTS_EXTRA_ARGS% %*
if !errorlevel! neq 0 exit /b !errorlevel!

if not "%INTEGRATION_TEST_APP_NAME%"=="" (
	killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
)

echo.
echo ### Built-in extension integration suites for Tauri
echo.
echo ### TypeScript tests
call .\node_modules\.bin\tsc.cmd -p "%CD%\extensions\typescript-language-features\tsconfig.json"
if !errorlevel! neq 0 exit /b !errorlevel!

call "%INTEGRATION_TEST_ELECTRON_PATH%" "%VSCODETYPESCRIPTDIR%" --extensionDevelopmentPath=%CD%\extensions\typescript-language-features --extensionTestsPath=%CD%\extensions\typescript-language-features\out\test\unit %BUILTIN_EXTENSION_TESTS_EXTRA_ARGS% %*
if !errorlevel! neq 0 exit /b !errorlevel!

if not "%INTEGRATION_TEST_APP_NAME%"=="" (
	killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
)

echo.
echo ### Markdown tests
call .\node_modules\.bin\tsc.cmd -p "%CD%\extensions\markdown-language-features\tsconfig.json"
if !errorlevel! neq 0 exit /b !errorlevel!

call "%INTEGRATION_TEST_ELECTRON_PATH%" "%VSCODEMARKDOWNDIR%" --extensionDevelopmentPath=%CD%\extensions\markdown-language-features --extensionTestsPath=%CD%\extensions\markdown-language-features\out\test %BUILTIN_EXTENSION_TESTS_EXTRA_ARGS% %*
if !errorlevel! neq 0 exit /b !errorlevel!

if not "%INTEGRATION_TEST_APP_NAME%"=="" (
	killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
)

echo.
echo ### Ipynb tests
call .\node_modules\.bin\tsc.cmd -p "%CD%\extensions\ipynb\tsconfig.json"
if !errorlevel! neq 0 exit /b !errorlevel!

call "%INTEGRATION_TEST_ELECTRON_PATH%" "%VSCODEIPYNBDIR%" --extensionDevelopmentPath=%CD%\extensions\ipynb --extensionTestsPath=%CD%\extensions\ipynb\out\test %BUILTIN_EXTENSION_TESTS_EXTRA_ARGS% %*
if !errorlevel! neq 0 exit /b !errorlevel!

if not "%INTEGRATION_TEST_APP_NAME%"=="" (
	killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
)

echo.
echo ### Emmet tests
call .\node_modules\.bin\tsc.cmd -p "%CD%\extensions\emmet\tsconfig.json"
if !errorlevel! neq 0 exit /b !errorlevel!

call "%INTEGRATION_TEST_ELECTRON_PATH%" "%VSCODEEMMETDIR%" --extensionDevelopmentPath=%CD%\extensions\emmet --extensionTestsPath=%CD%\extensions\emmet\out\test %BUILTIN_EXTENSION_TESTS_EXTRA_ARGS% %*
if !errorlevel! neq 0 exit /b !errorlevel!

if not "%INTEGRATION_TEST_APP_NAME%"=="" (
	killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
)

echo.
echo ### Git tests
call .\node_modules\.bin\tsc.cmd -p "%CD%\extensions\git\tsconfig.json"
if !errorlevel! neq 0 exit /b !errorlevel!

call "%INTEGRATION_TEST_ELECTRON_PATH%" "%VSCODEGITDIR%" --extensionDevelopmentPath=%CD%\extensions\git --extensionTestsPath=%CD%\extensions\git\out\test %BUILTIN_EXTENSION_TESTS_EXTRA_ARGS% %*
if !errorlevel! neq 0 exit /b !errorlevel!

if not "%INTEGRATION_TEST_APP_NAME%"=="" (
	killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
)

echo.
echo ### Configuration editing tests
call .\node_modules\.bin\tsc.cmd -p "%CD%\extensions\configuration-editing\tsconfig.json"
if !errorlevel! neq 0 exit /b !errorlevel!

mkdir "%VSCODECONFEDITDIR%" >nul 2>nul
call "%INTEGRATION_TEST_ELECTRON_PATH%" "%VSCODECONFEDITDIR%" --extensionDevelopmentPath=%CD%\extensions\configuration-editing --extensionTestsPath=%CD%\extensions\configuration-editing\out\test %BUILTIN_EXTENSION_TESTS_EXTRA_ARGS% %*
if !errorlevel! neq 0 exit /b !errorlevel!

if not "%INTEGRATION_TEST_APP_NAME%"=="" (
	killall "%INTEGRATION_TEST_APP_NAME%" >nul 2>nul
)

rmdir /s /q %VSCODEUSERDATADIR% >nul 2>nul
rmdir /s /q %VSCODEAPITESTDIR% >nul 2>nul
rmdir /s /q %VSCODECONFEDITDIR% >nul 2>nul
rmdir /s /q %VSCODEMARKDOWNDIR% >nul 2>nul
rmdir /s /q %VSCODEIPYNBDIR% >nul 2>nul
rmdir /s /q %VSCODEEMMETDIR% >nul 2>nul
rmdir /s /q %VSCODEGITDIR% >nul 2>nul
rmdir /s /q %VSCODETYPESCRIPTDIR% >nul 2>nul
