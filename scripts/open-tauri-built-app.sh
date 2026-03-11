#!/usr/bin/env bash
set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

APP_BUNDLE="$ROOT/apps/tauri/src-tauri/target/release/bundle/macos/Code Tauri.app"

if [[ ! -d "$APP_BUNDLE" ]]; then
	echo "Missing packaged app bundle: $APP_BUNDLE" >&2
	echo "Run: npm run tauri:build" >&2
	exit 1
fi

if [[ "$OSTYPE" == "darwin"* ]]; then
	while mount | grep -q '/Volumes/Code Tauri '; do
		hdiutil detach "/Volumes/Code Tauri" >/dev/null 2>&1 || break
		sleep 1
	done
fi

open "$APP_BUNDLE"
