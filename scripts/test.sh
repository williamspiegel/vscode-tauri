#!/usr/bin/env bash
set -e

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname $(dirname $(realpath "$0")))
else
	ROOT=$(dirname $(dirname $(readlink -f $0)))
fi

cd $ROOT

if [[ "$OSTYPE" == "darwin"* ]]; then
	NAME=`node -p "require('./product.json').nameLong"`
	EXE_NAME=`node -p "require('./product.json').nameShort"`
	CODE="./.build/electrobun/$NAME.app/Contents/MacOS/$EXE_NAME"
else
	NAME=`node -p "require('./product.json').applicationName"`
	CODE=".build/electrobun/$NAME"
fi

VSCODECRASHDIR=$ROOT/.build/crashes

# Node modules
test -d node_modules || npm i

# Get electrobun runtime
if [[ -z "${VSCODE_SKIP_PRELAUNCH}" ]]; then
	npm run electrobun
fi

# Unit Tests
if [[ "$OSTYPE" == "darwin"* ]]; then
	cd $ROOT ; ulimit -n 4096 ; \
		VSCODE_DESKTOP_RUNTIME=electrobun \
		ELECTRON_ENABLE_LOGGING=1 \
		"$CODE" \
		test/unit/electron/index.js --crash-reporter-directory=$VSCODECRASHDIR "$@"
else
	cd $ROOT ; \
		VSCODE_DESKTOP_RUNTIME=electrobun \
		ELECTRON_ENABLE_LOGGING=1 \
		"$CODE" \
		test/unit/electron/index.js --crash-reporter-directory=$VSCODECRASHDIR "$@"
fi
