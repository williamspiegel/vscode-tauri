#!/usr/bin/env bash
set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

cd "$ROOT"

echo "### Tauri contract checks"
node build/tauri/contract-test.mjs

echo "### Tauri structural smoke"
node build/tauri/smoke.mjs

echo "### Tauri startup bundle parity"
node build/tauri/startup-bundle-test.mjs

echo "### Tauri Rust unit tests"
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml

echo "### Tauri JS unit harness"
node test/unit/tauri/index.js "$@"
