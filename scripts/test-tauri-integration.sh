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

echo
echo "### API tests (folder/workspace) for Tauri"
if [[ "${VSCODE_TAURI_RUN_API_INTEGRATION:-0}" == "1" ]]; then
	VSCODE_TAURI_INTEGRATION=1 INTEGRATION_TEST_ELECTRON_PATH="./scripts/code-tauri.sh" ./scripts/test-integration.sh "$@"
else
	echo "SKIP api-tests-folder-workspace: TODO https://github.com/microsoft/vscode/issues/244145 (set VSCODE_TAURI_RUN_API_INTEGRATION=1 to execute)"
fi

echo
echo "### Built-in extension integration suites for Tauri"
echo "SKIP typescript/markdown/emmet/git/ipynb/configuration-editing: TODO https://github.com/microsoft/vscode/issues/244146"
