#!/usr/bin/env bash
set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

cd "$ROOT"

echo "### Tauri integration preflight"
node build/tauri/contract-test.mjs
node build/tauri/smoke.mjs

echo "### Tauri API extension build"
./node_modules/.bin/tsc -p "$ROOT/extensions/vscode-api-tests/tsconfig.json"

VSCODEUSERDATADIR=$(mktemp -d 2>/dev/null)
VSCODEAPITESTDIR=$(mktemp -d 2>/dev/null)
VSCODECONFEDITDIR=$(mktemp -d 2>/dev/null)
VSCODEMARKDOWNDIR=$(mktemp -d 2>/dev/null)
VSCODEIPYNBDIR=$(mktemp -d 2>/dev/null)
VSCODEEMMETDIR=$(mktemp -d 2>/dev/null)
VSCODEGITDIR=$(mktemp -d 2>/dev/null)
VSCODETYPESCRIPTDIR=$(mktemp -d 2>/dev/null)
VSCODECRASHDIR=$ROOT/.build/crashes
VSCODELOGSDIR=$ROOT/.build/logs/integration-tests
INTEGRATION_TEST_ELECTRON_PATH=${INTEGRATION_TEST_ELECTRON_PATH:-"./scripts/code-tauri.sh"}
COMMON_TESTS_EXTRA_ARGS="--disable-telemetry --disable-experiments --skip-welcome --skip-release-notes --crash-reporter-directory=$VSCODECRASHDIR --logsPath=$VSCODELOGSDIR --no-cached-data --disable-updates --use-inmemory-secretstorage --disable-workspace-trust --user-data-dir=$VSCODEUSERDATADIR"
API_TESTS_EXTRA_ARGS="--disable-extensions $COMMON_TESTS_EXTRA_ARGS"
BUILTIN_EXTENSION_TESTS_EXTRA_ARGS="$COMMON_TESTS_EXTRA_ARGS"
API_TEST_WORKSPACE_FOLDER="$VSCODEAPITESTDIR/testWorkspace"
API_TEST_WORKSPACE_FOLDER_2="$VSCODEAPITESTDIR/testWorkspace2"
API_TEST_WORKSPACE_FILE="$VSCODEAPITESTDIR/testworkspace.code-workspace"

mkdir -p "$VSCODECRASHDIR" "$VSCODELOGSDIR"
cp -R "$ROOT/extensions/vscode-api-tests/testWorkspace" "$API_TEST_WORKSPACE_FOLDER"
cp -R "$ROOT/extensions/vscode-api-tests/testWorkspace2" "$API_TEST_WORKSPACE_FOLDER_2"
cp "$ROOT/extensions/vscode-api-tests/testworkspace.code-workspace" "$API_TEST_WORKSPACE_FILE"
cp -R "$ROOT/extensions/markdown-language-features/test-workspace/." "$VSCODEMARKDOWNDIR"
cp -R "$ROOT/extensions/emmet/test-workspace/." "$VSCODEEMMETDIR"
cp -R "$ROOT/extensions/typescript-language-features/test-workspace/." "$VSCODETYPESCRIPTDIR"

cleanup() {
	rm -rf "$VSCODEUSERDATADIR"
	rm -rf "$VSCODEAPITESTDIR"
	rm -rf "$VSCODECONFEDITDIR"
	rm -rf "$VSCODEMARKDOWNDIR"
	rm -rf "$VSCODEIPYNBDIR"
	rm -rf "$VSCODEEMMETDIR"
	rm -rf "$VSCODEGITDIR"
	rm -rf "$VSCODETYPESCRIPTDIR"
}

trap cleanup EXIT

if [[ -n "${INTEGRATION_TEST_APP_NAME:-}" ]]; then
	kill_app() { killall "$INTEGRATION_TEST_APP_NAME" || true; }
else
	kill_app() { true; }
fi

export VSCODE_CLI=1
export VSCODE_SKIP_PRELAUNCH=1
export VSCODE_TAURI_NO_DEV_SERVER=1
export VSCODE_TAURI_NO_WATCH=1
export VSCODE_TAURI_DISABLE_DEFAULT_EXTENSIONS_GALLERY=1

echo "Running Tauri API integration tests with '$INTEGRATION_TEST_ELECTRON_PATH' as build."
echo "Storing crash reports into '$VSCODECRASHDIR'."
echo "Storing log files into '$VSCODELOGSDIR'."

echo
echo "### API tests (folder/workspace) for Tauri"
echo
echo "### API tests (folder)"
VSCODE_TAURI_INTEGRATION=1 \
VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT="$API_TEST_WORKSPACE_FOLDER" \
VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT_2= \
VSCODE_TAURI_EXPECTED_WORKSPACE_FILE= \
"$INTEGRATION_TEST_ELECTRON_PATH" \
	"$API_TEST_WORKSPACE_FOLDER" \
	--enable-proposed-api=vscode.vscode-api-tests \
	--extensionDevelopmentPath="$ROOT/extensions/vscode-api-tests" \
	--extensionTestsPath="$ROOT/extensions/vscode-api-tests/out/singlefolder-tests" \
	$API_TESTS_EXTRA_ARGS \
	"$@"
kill_app

echo
echo "### API tests (workspace)"
VSCODE_TAURI_INTEGRATION=1 \
VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT="$API_TEST_WORKSPACE_FOLDER" \
VSCODE_TAURI_EXPECTED_WORKSPACE_ROOT_2="$API_TEST_WORKSPACE_FOLDER_2" \
VSCODE_TAURI_EXPECTED_WORKSPACE_FILE="$API_TEST_WORKSPACE_FILE" \
"$INTEGRATION_TEST_ELECTRON_PATH" \
	"$API_TEST_WORKSPACE_FILE" \
	--enable-proposed-api=vscode.vscode-api-tests \
	--extensionDevelopmentPath="$ROOT/extensions/vscode-api-tests" \
	--extensionTestsPath="$ROOT/extensions/vscode-api-tests/out/workspace-tests" \
	$API_TESTS_EXTRA_ARGS \
	"$@"
kill_app

echo
echo "### Built-in extension integration suites for Tauri"
echo
echo "### TypeScript tests"
./node_modules/.bin/tsc -p "$ROOT/extensions/typescript-language-features/tsconfig.json"
VSCODE_TAURI_INTEGRATION=1 "$INTEGRATION_TEST_ELECTRON_PATH" \
	"$VSCODETYPESCRIPTDIR" \
	--extensionDevelopmentPath="$ROOT/extensions/typescript-language-features" \
	--extensionTestsPath="$ROOT/extensions/typescript-language-features/out/test/unit" \
	$BUILTIN_EXTENSION_TESTS_EXTRA_ARGS \
	"$@"
kill_app

echo
echo "### Markdown tests"
./node_modules/.bin/tsc -p "$ROOT/extensions/markdown-language-features/tsconfig.json"
VSCODE_TAURI_INTEGRATION=1 "$INTEGRATION_TEST_ELECTRON_PATH" \
	"$VSCODEMARKDOWNDIR" \
	--extensionDevelopmentPath="$ROOT/extensions/markdown-language-features" \
	--extensionTestsPath="$ROOT/extensions/markdown-language-features/out/test" \
	$BUILTIN_EXTENSION_TESTS_EXTRA_ARGS \
	"$@"
kill_app

echo
echo "### Ipynb tests"
./node_modules/.bin/tsc -p "$ROOT/extensions/ipynb/tsconfig.json"
VSCODE_TAURI_INTEGRATION=1 "$INTEGRATION_TEST_ELECTRON_PATH" \
	"$VSCODEIPYNBDIR" \
	--extensionDevelopmentPath="$ROOT/extensions/ipynb" \
	--extensionTestsPath="$ROOT/extensions/ipynb/out/test" \
	$BUILTIN_EXTENSION_TESTS_EXTRA_ARGS \
	"$@"
kill_app

echo
echo "### Emmet tests"
./node_modules/.bin/tsc -p "$ROOT/extensions/emmet/tsconfig.json"
VSCODE_TAURI_INTEGRATION=1 "$INTEGRATION_TEST_ELECTRON_PATH" \
	"$VSCODEEMMETDIR" \
	--extensionDevelopmentPath="$ROOT/extensions/emmet" \
	--extensionTestsPath="$ROOT/extensions/emmet/out/test" \
	$BUILTIN_EXTENSION_TESTS_EXTRA_ARGS \
	"$@"
kill_app

echo
echo "### Git tests"
./node_modules/.bin/tsc -p "$ROOT/extensions/git/tsconfig.json"
VSCODE_TAURI_INTEGRATION=1 "$INTEGRATION_TEST_ELECTRON_PATH" \
	"$VSCODEGITDIR" \
	--extensionDevelopmentPath="$ROOT/extensions/git" \
	--extensionTestsPath="$ROOT/extensions/git/out/test" \
	$BUILTIN_EXTENSION_TESTS_EXTRA_ARGS \
	"$@"
kill_app

echo
echo "### Configuration editing tests"
./node_modules/.bin/tsc -p "$ROOT/extensions/configuration-editing/tsconfig.json"
VSCODE_TAURI_INTEGRATION=1 "$INTEGRATION_TEST_ELECTRON_PATH" \
	"$VSCODECONFEDITDIR" \
	--extensionDevelopmentPath="$ROOT/extensions/configuration-editing" \
	--extensionTestsPath="$ROOT/extensions/configuration-editing/out/test" \
	$BUILTIN_EXTENSION_TESTS_EXTRA_ARGS \
	"$@"
kill_app

echo
echo "### CSS tests"
(
	cd "$ROOT/extensions/css-language-features/server"
	"$ROOT/scripts/node-electron.sh" test/index.js
)

echo
echo "### HTML tests"
(
	cd "$ROOT/extensions/html-language-features/server"
	"$ROOT/scripts/node-electron.sh" test/index.js
)

echo
echo "### Git base tests"
node "$ROOT/scripts/run-tauri-standalone-extension-tests.mjs" \
	--label git-base \
	--compile-tsconfig "$ROOT/extensions/git-base/tsconfig.json" \
	--test-cli-label git-base \
	--

echo
echo "### Colorize tests"
node "$ROOT/scripts/run-tauri-standalone-extension-tests.mjs" \
	--label vscode-colorize-tests \
	--compile-tsconfig "$ROOT/extensions/vscode-colorize-tests/tsconfig.json" \
	--test-cli-label vscode-colorize-tests \
	--
