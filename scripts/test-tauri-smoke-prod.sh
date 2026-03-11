#!/usr/bin/env bash
set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

cd "$ROOT"

if [[ "$OSTYPE" != "darwin"* ]]; then
	echo "tauri:test-smoke-prod currently supports macOS only" >&2
	exit 1
fi

WORKSPACE_PATH="${VSCODE_TAURI_SMOKE_WORKSPACE:-$ROOT}"

echo "### Tauri packaged smoke"
echo "workspace: $WORKSPACE_PATH"

declare -a RUNS=()

last_run_dir() {
	local index=$((${#RUNS[@]} - 1))
	echo "${RUNS[$index]}"
}

run_prod_flow() {
	local label="$1"
	local screenshot_name="$2"
	shift 2

	echo
	echo "### $label"

	local output
	if ! output="$("$ROOT/scripts/run-tauri-prod-debug.sh" "$@" 2>&1)"; then
		echo "$output"
		echo "Flow failed before log analysis: $label" >&2
		exit 1
	fi

	echo "$output"
	local run_dir
	run_dir=$(printf '%s\n' "$output" | sed -n 's/^  run:  //p' | tail -n1)
	if [[ -z "$run_dir" || ! -d "$run_dir" ]]; then
		echo "Could not determine run directory for $label" >&2
		exit 1
	fi

	RUNS+=("$run_dir")
}

assert_no_prod_errors() {
	local label="$1"
	local run_dir="$2"
	local combined_log="$run_dir/.combined.log"

	cat "$run_dir/host-stdio.log" "$run_dir/logs/tauri-host.log" 2>/dev/null > "$combined_log"

	if grep -E "startup failed|ui\.runtime\.unhandledRejection|Unexpected token '<'|did not provide loadWASM|module doesn't start with '\\\\0asm'|level=error" "$combined_log" \
		| grep -Ev "ResizeObserver loop completed with undelivered notifications\." >/tmp/tauri-prod-smoke-errors.$$; then
		echo "Detected packaged prod errors during $label:" >&2
		cat /tmp/tauri-prod-smoke-errors.$$ >&2
		rm -f /tmp/tauri-prod-smoke-errors.$$
		exit 1
	fi

	rm -f /tmp/tauri-prod-smoke-errors.$$ "$combined_log"
}

run_prod_flow \
	"Launch" \
	"launch.png" \
	--build \
	--workspace "$WORKSPACE_PATH" \
	--capture-seconds 12 \
	--screenshot-name launch.png \
	--screenshot-delay 6
assert_no_prod_errors "Launch" "$(last_run_dir)"

run_prod_flow \
	"File Open" \
	"file-open.png" \
	--workspace "$WORKSPACE_PATH" \
	--open-file-ui "$ROOT/package.json" \
	--capture-seconds 18 \
	--screenshot-name file-open.png \
	--screenshot-delay 10
assert_no_prod_errors "File Open" "$(last_run_dir)"

run_prod_flow \
	"Terminal" \
	"terminal.png" \
	--workspace "$WORKSPACE_PATH" \
	--ui-action terminal \
	--capture-seconds 16 \
	--screenshot-name terminal.png \
	--screenshot-delay 10
assert_no_prod_errors "Terminal" "$(last_run_dir)"

run_prod_flow \
	"Settings" \
	"settings.png" \
	--workspace "$WORKSPACE_PATH" \
	--ui-action settings \
	--capture-seconds 16 \
	--screenshot-name settings.png \
	--screenshot-delay 10
assert_no_prod_errors "Settings" "$(last_run_dir)"

run_prod_flow \
	"Extensions" \
	"extensions.png" \
	--workspace "$WORKSPACE_PATH" \
	--ui-action extensions \
	--capture-seconds 16 \
	--screenshot-name extensions.png \
	--screenshot-delay 10
assert_no_prod_errors "Extensions" "$(last_run_dir)"

echo
echo "Packaged Tauri smoke passed."
printf 'Artifacts:\n'
for run_dir in "${RUNS[@]}"; do
	echo "  $run_dir"
done
