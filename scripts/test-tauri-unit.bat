@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0\.."

echo ### Tauri contract checks
node build\tauri\contract-test.mjs
if %errorlevel% neq 0 exit /b %errorlevel%

echo ### Tauri structural smoke
node build\tauri\smoke.mjs
if %errorlevel% neq 0 exit /b %errorlevel%

echo ### Tauri startup bundle parity
node build\tauri\startup-bundle-test.mjs
if %errorlevel% neq 0 exit /b %errorlevel%

echo ### Tauri Rust unit tests
cargo test --manifest-path apps\tauri\src-tauri\Cargo.toml
if %errorlevel% neq 0 exit /b %errorlevel%

echo ### Tauri JS unit harness
node test\unit\tauri\index.js %*
if %errorlevel% neq 0 exit /b %errorlevel%
