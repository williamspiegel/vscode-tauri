#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$OSTYPE" == "darwin"* ]]; then
	NAME="$(node -p "require('./product.json').nameLong")"
	EXE_NAME="$(node -p "require('./product.json').nameShort")"
	CODE="./.build/electrobun/$NAME.app/Contents/MacOS/$EXE_NAME"
else
	NAME="$(node -p "require('./product.json').applicationName")"
	CODE="./.build/electrobun/$NAME"
fi

if [[ -z "${VSCODE_SKIP_PRELAUNCH:-}" ]]; then
	node --experimental-strip-types build/lib/electrobun.ts
fi

export NODE_ENV=development
export VSCODE_DEV=1
export VSCODE_CLI=1
export VSCODE_DESKTOP_RUNTIME=electrobun
export ELECTRON_ENABLE_STACK_DUMPING=1
export ELECTRON_ENABLE_LOGGING=1

if command -v node >/dev/null 2>&1; then
	export VSCODE_NODE_EXEC_PATH="$(command -v node)"
fi

"$CODE" "$@"
