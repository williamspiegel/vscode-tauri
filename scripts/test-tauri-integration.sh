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

VSCODEUSERDATADIR=$(mktemp -d 2>/dev/null)
VSCODEAPITESTDIR=$(mktemp -d 2>/dev/null)
VSCODECRASHDIR=$ROOT/.build/crashes
VSCODELOGSDIR=$ROOT/.build/logs/integration-tests
INTEGRATION_TEST_ELECTRON_PATH=${INTEGRATION_TEST_ELECTRON_PATH:-"./scripts/code-tauri.sh"}
API_TESTS_EXTRA_ARGS="--disable-telemetry --disable-experiments --skip-welcome --skip-release-notes --crash-reporter-directory=$VSCODECRASHDIR --logsPath=$VSCODELOGSDIR --no-cached-data --disable-updates --use-inmemory-secretstorage --disable-extensions --disable-workspace-trust --user-data-dir=$VSCODEUSERDATADIR"
API_TEST_WORKSPACE_FOLDER="$VSCODEAPITESTDIR/testWorkspace"
API_TEST_WORKSPACE_FILE="$VSCODEAPITESTDIR/testworkspace.code-workspace"

mkdir -p "$VSCODECRASHDIR" "$VSCODELOGSDIR"
cp -R "$ROOT/extensions/vscode-api-tests/testWorkspace" "$API_TEST_WORKSPACE_FOLDER"
cp "$ROOT/extensions/vscode-api-tests/testworkspace.code-workspace" "$API_TEST_WORKSPACE_FILE"

cleanup() {
	rm -rf "$VSCODEUSERDATADIR"
	rm -rf "$VSCODEAPITESTDIR"
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
if [[ "${VSCODE_TAURI_RUN_API_INTEGRATION:-0}" == "1" ]]; then
	echo
	echo "### API tests (folder)"
	VSCODE_TAURI_INTEGRATION=1 "$INTEGRATION_TEST_ELECTRON_PATH" \
		"$API_TEST_WORKSPACE_FOLDER" \
		--enable-proposed-api=vscode.vscode-api-tests \
		--extensionDevelopmentPath="$ROOT/extensions/vscode-api-tests" \
		--extensionTestsPath="$ROOT/extensions/vscode-api-tests/out/singlefolder-tests" \
		$API_TESTS_EXTRA_ARGS \
		"$@"
	kill_app

	echo
	echo "### API tests (workspace)"
	VSCODE_TAURI_INTEGRATION=1 "$INTEGRATION_TEST_ELECTRON_PATH" \
		"$API_TEST_WORKSPACE_FILE" \
		--enable-proposed-api=vscode.vscode-api-tests \
		--extensionDevelopmentPath="$ROOT/extensions/vscode-api-tests" \
		--extensionTestsPath="$ROOT/extensions/vscode-api-tests/out/workspace-tests" \
		$API_TESTS_EXTRA_ARGS \
		"$@"
	kill_app
else
	echo "SKIP api-tests-folder-workspace: TODO https://github.com/microsoft/vscode/issues/244145 (set VSCODE_TAURI_RUN_API_INTEGRATION=1 to execute)"
fi

echo
echo "### Built-in extension integration suites for Tauri"
echo "SKIP typescript/markdown/emmet/git/ipynb/configuration-editing: TODO https://github.com/microsoft/vscode/issues/244146"
