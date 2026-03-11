#!/usr/bin/env bash
set -euo pipefail

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
fi

DO_BUILD=0
WORKSPACE_PATH=""
OPEN_FILE_UI=""
UI_ACTIONS=()
CAPTURE_SECONDS="${VSCODE_TAURI_CAPTURE_SECONDS:-0}"
UI_DELAY_SECONDS="${VSCODE_TAURI_UI_DELAY_SECONDS:-4}"
SCREENSHOT_NAME=""
SCREENSHOT_DELAY_SECONDS="${VSCODE_TAURI_SCREENSHOT_DELAY_SECONDS:-0}"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--build)
			DO_BUILD=1
			shift
			;;
		--workspace)
			WORKSPACE_PATH="${2:-}"
			shift 2
			;;
		--open-file-ui)
			OPEN_FILE_UI="${2:-}"
			shift 2
			;;
		--ui-action)
			UI_ACTIONS+=("${2:-}")
			shift 2
			;;
		--screenshot-name)
			SCREENSHOT_NAME="${2:-}"
			shift 2
			;;
		--screenshot-delay)
			SCREENSHOT_DELAY_SECONDS="${2:-0}"
			shift 2
			;;
		--capture-seconds)
			CAPTURE_SECONDS="${2:-0}"
			shift 2
			;;
		--)
			shift
			break
			;;
		*)
			break
			;;
	esac
done

APP_ARGS=("$@")

if [[ -n "$WORKSPACE_PATH" ]]; then
	if [[ ${#APP_ARGS[@]} -gt 0 ]]; then
		APP_ARGS=("$WORKSPACE_PATH" "${APP_ARGS[@]}")
	else
		APP_ARGS=("$WORKSPACE_PATH")
	fi
fi

cd "$ROOT"

if [[ $DO_BUILD -eq 1 ]]; then
	npm run tauri:build
fi

APP_BUNDLE="$ROOT/apps/tauri/src-tauri/target/release/bundle/macos/Code Tauri.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/vscode-tauri-host"

if [[ ! -x "$APP_BINARY" ]]; then
	echo "Missing packaged Tauri binary: $APP_BINARY" >&2
	echo "Run: npm run tauri:build" >&2
	exit 1
fi

RUN_ROOT="$ROOT/.build/tauri-prod-debug"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$-$RANDOM"
RUN_DIR="$RUN_ROOT/$RUN_ID"
USER_DATA_DIR="$RUN_DIR/user-data"
LOGS_DIR="$RUN_DIR/logs"
STDIO_LOG="$RUN_DIR/host-stdio.log"
SCREENSHOTS_DIR="$RUN_DIR/screenshots"

mkdir -p "$USER_DATA_DIR" "$LOGS_DIR" "$SCREENSHOTS_DIR"

if [[ "${VSCODE_TAURI_KILL_EXISTING:-1}" == "1" ]]; then
	pkill -f 'Code Tauri.app/Contents/MacOS/vscode-tauri-host' >/dev/null 2>&1 || true
	sleep 1
fi

echo "Tauri prod debug run:"
echo "  app:  $APP_BINARY"
echo "  run:  $RUN_DIR"
echo "  logs: $STDIO_LOG"
echo "  host: $LOGS_DIR/tauri-host.log"
echo "  screenshots: $SCREENSHOTS_DIR"
echo "  args: ${APP_ARGS[*]:-<none>}"

open_file_via_ui() {
	local file_path="$1"
	local escaped_path="${file_path//\\/\\\\}"
	escaped_path="${escaped_path//\"/\\\"}"
	/usr/bin/osascript <<EOF
tell application "Code Tauri" to activate
delay 1
tell application "System Events"
	keystroke "p" using command down
	delay 1
	keystroke "$escaped_path"
	delay 1
	key code 36
end tell
EOF
}

command_palette_action() {
	local command_label="$1"
	local escaped_label="${command_label//\\/\\\\}"
	escaped_label="${escaped_label//\"/\\\"}"
	/usr/bin/osascript <<EOF
tell application "Code Tauri" to activate
delay 1
tell application "System Events"
	keystroke "p" using {command down, shift down}
	delay 1
	keystroke "$escaped_label"
	delay 1
	key code 36
end tell
EOF
}

open_extensions_via_ui() {
	/usr/bin/osascript <<EOF
tell application "Code Tauri" to activate
delay 1
tell application "System Events"
	keystroke "x" using {command down, shift down}
end tell
EOF
}

run_ui_action() {
	local action="$1"
	case "$action" in
		open-file:*)
			open_file_via_ui "${action#open-file:}"
			;;
		terminal)
			command_palette_action "Terminal: Create New Terminal"
			;;
		settings)
			command_palette_action "Preferences: Open Settings (UI)"
			;;
		extensions)
			open_extensions_via_ui
			;;
		command:*)
			command_palette_action "${action#command:}"
			;;
		*)
			echo "Unknown --ui-action: $action" >&2
			return 1
			;;
	esac
}

capture_screenshot() {
	local screenshot_name="$1"
	local screenshot_path="$SCREENSHOTS_DIR/$screenshot_name"
	screencapture -x "$screenshot_path"
	echo "  screenshot: $screenshot_path"
}

"$APP_BINARY" \
	--logsPath "$LOGS_DIR" \
	--user-data-dir "$USER_DATA_DIR" \
	"${APP_ARGS[@]}" > >(tee "$STDIO_LOG") 2>&1 &
APP_PID=$!

if [[ -n "$OPEN_FILE_UI" || ${#UI_ACTIONS[@]} -gt 0 ]]; then
	if [[ "$OSTYPE" != "darwin"* ]]; then
		echo "UI actions are only supported on macOS" >&2
		kill "$APP_PID" >/dev/null 2>&1 || true
		exit 1
	fi

	sleep "$UI_DELAY_SECONDS"

	if [[ -n "$OPEN_FILE_UI" ]]; then
		run_ui_action "open-file:$OPEN_FILE_UI"
	fi

	if (( ${#UI_ACTIONS[@]} > 0 )); then
		for action in "${UI_ACTIONS[@]}"; do
			sleep 1
			run_ui_action "$action"
		done
	fi
fi

if [[ "$CAPTURE_SECONDS" != "0" ]]; then
	if [[ -n "$SCREENSHOT_NAME" && "$SCREENSHOT_DELAY_SECONDS" != "0" ]]; then
		(
			sleep "$SCREENSHOT_DELAY_SECONDS"
			capture_screenshot "$SCREENSHOT_NAME"
		) &
	fi

	sleep "$CAPTURE_SECONDS"
	kill "$APP_PID" >/dev/null 2>&1 || true
fi

wait "$APP_PID" || true
