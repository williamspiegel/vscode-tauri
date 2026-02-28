#!/usr/bin/env bash
set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

MODE="dev"
if [[ "${1:-}" == "--build" ]]; then
	MODE="build"
	shift
fi

cd "$ROOT"

if [[ -z "${VSCODE_TAURI_NODE_BINARY:-}" ]]; then
	VSCODE_TAURI_NODE_BINARY="$(command -v node)"
	export VSCODE_TAURI_NODE_BINARY
fi

if [[ -z "${VSCODE_SKIP_PRELAUNCH:-}" ]]; then
	node build/lib/preLaunch.ts
fi

node build/tauri/run-tauri.mjs "$MODE" "$@"
