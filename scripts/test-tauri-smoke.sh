#!/usr/bin/env bash
set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

cd "$ROOT"

echo "### Tauri structural smoke"
node build/tauri/smoke.mjs
node build/tauri/startup-bundle-test.mjs

echo
echo "### Tauri end-to-end smoke"
if [[ "${VSCODE_TAURI_RUN_E2E_SMOKE:-0}" == "1" ]]; then
	if [[ ! -f "test/smoke/out/main.js" ]]; then
		( cd test/smoke && npm run compile )
	fi
	node test/smoke/out/main.js --tauri --headless "$@"
else
	echo "SKIP tauri-e2e-smoke: TODO https://github.com/microsoft/vscode/issues/244147 (set VSCODE_TAURI_RUN_E2E_SMOKE=1 to execute)"
fi
