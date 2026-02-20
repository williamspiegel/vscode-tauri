@echo off
setlocal

set ELECTRON_RUN_AS_NODE=1
set ELECTROBUN_RUN_AS_NODE=1
set VSCODE_DESKTOP_RUNTIME=electrobun

pushd %~dp0\..

set "NAMESHORT="
for /f "tokens=2 delims=:," %%a in ('findstr /R /C:"\"nameShort\":.*" product.json') do if not defined NAMESHORT set "NAMESHORT=%%~a"
set NAMESHORT=%NAMESHORT: "=%
set NAMESHORT=%NAMESHORT:"=%.exe
set CODE=".build\electrobun\%NAMESHORT%"

%CODE% %*

popd

endlocal
exit /b %errorlevel%
