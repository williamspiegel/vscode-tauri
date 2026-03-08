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

export VSCODE_TAURI_NO_DEV_SERVER="${VSCODE_TAURI_NO_DEV_SERVER:-1}"
export VSCODE_TAURI_NO_WATCH="${VSCODE_TAURI_NO_WATCH:-1}"
export VSCODE_TAURI_DISABLE_DEFAULT_EXTENSIONS_GALLERY="${VSCODE_TAURI_DISABLE_DEFAULT_EXTENSIONS_GALLERY:-1}"

if [[ -z "${VSCODE_SKIP_PRELAUNCH:-}" ]]; then
	node build/lib/preLaunch.ts
fi

node build/tauri/run-tauri.mjs "$MODE" "$@"
