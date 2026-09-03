#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$PROJECT_DIR/frontend"
BACKEND_DIR="$PROJECT_DIR/backend"

# Process ids owned by browser mode must outlive run_browser's local scope:
# the EXIT trap runs after that function returns. Keeping them at script scope
# also prevents `set -u` from turning cleanup itself into an error.
BROWSER_BACKEND_PID=""
BROWSER_FRONTEND_PID=""

usage() {
  cat <<'EOF'
Usage:
  ./run.sh                 Start the Tauri desktop application (default)
  ./run.sh desktop         Start the Tauri desktop application
  ./run.sh browser         Start backend + Vite and open the browser UI
  ./run.sh android         Build, install, and launch the Android debug APK
  ./run.sh --help          Show this help

Aliases:
  tauri -> desktop
  web   -> browser
  apk   -> android
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[fyxtez] Missing required command: $1" >&2
    exit 1
  fi
}

require_frontend_dependencies() {
  if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    echo "[fyxtez] Frontend dependencies are not installed." >&2
    echo "          Run: cd frontend && npm install" >&2
    exit 1
  fi
}

require_browser_project_files() {
  if [[ ! -f "$BACKEND_DIR/.env" ]]; then
    echo "[fyxtez] Missing backend/.env" >&2
    echo "          Run: cp backend/.env.example backend/.env" >&2
    exit 1
  fi

  if [[ ! -f "$FRONTEND_DIR/.env" ]]; then
    echo "[fyxtez] Missing frontend/.env" >&2
    echo "          Run: cp frontend/.env.example frontend/.env" >&2
    exit 1
  fi

  require_frontend_dependencies
}

read_env_setting() {
  local file="$1"
  local key="$2"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      value = $0
      sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "", value)
      sub("[[:space:]\r]+$", "", value)
    }
    END { print value }
  ' "$file"
}

validate_local_auth() {
  local backend_token
  local frontend_token
  backend_token="$(read_env_setting "$BACKEND_DIR/.env" SERVICE_API_TOKEN)"
  frontend_token="$(read_env_setting "$FRONTEND_DIR/.env" VITE_TRADING_API_TOKEN)"

  if [[ -z "$backend_token" || -z "$frontend_token" ]]; then
    echo "[fyxtez] SERVICE_API_TOKEN and VITE_TRADING_API_TOKEN are required." >&2
    exit 1
  fi
  if [[ "$backend_token" == replace-with-* || "$frontend_token" == replace-with-* ]]; then
    echo "[fyxtez] Replace the example service token with a random value in both .env files." >&2
    exit 1
  fi
  if [[ "$backend_token" != "$frontend_token" ]]; then
    echo "[fyxtez] Backend and frontend service tokens do not match." >&2
    exit 1
  fi
}

ensure_backend_is_stopped() {
  local backend_url="$1"
  if curl --silent --fail --max-time 1 "$backend_url/health" >/dev/null 2>&1; then
    echo "[fyxtez] A backend is already running at $backend_url." >&2
    echo "          Stop it before starting a new stack." >&2
    exit 1
  fi
}

browser_frontend_is_running() {
  curl --silent --fail --max-time 1 "http://127.0.0.1:5173/" >/dev/null 2>&1
}

cleanup_browser() {
  local exit_code="${1:-$?}"
  trap - EXIT INT TERM

  if [[ -n "$BROWSER_FRONTEND_PID" ]] && kill -0 "$BROWSER_FRONTEND_PID" 2>/dev/null; then
    kill "$BROWSER_FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$BROWSER_BACKEND_PID" ]] && kill -0 "$BROWSER_BACKEND_PID" 2>/dev/null; then
    kill "$BROWSER_BACKEND_PID" 2>/dev/null || true
  fi

  [[ -z "$BROWSER_FRONTEND_PID" ]] || wait "$BROWSER_FRONTEND_PID" 2>/dev/null || true
  [[ -z "$BROWSER_BACKEND_PID" ]] || wait "$BROWSER_BACKEND_PID" 2>/dev/null || true
  exit "$exit_code"
}

run_desktop() {
  require_command cargo
  require_command npm
  require_command rustc
  require_frontend_dependencies

  echo "[fyxtez] Starting Tauri desktop application with its managed local backend..."
  cd "$FRONTEND_DIR"
  exec npm run desktop:dev
}

run_browser() {
  require_command cargo
  require_command npm
  require_command curl
  require_browser_project_files
  validate_local_auth

  local backend_port
  local backend_url
  local reuse_frontend=false

  BROWSER_BACKEND_PID=""
  BROWSER_FRONTEND_PID=""
  trap 'cleanup_browser $?' EXIT INT TERM

  backend_port="$(sed -n 's/^[[:space:]]*SERVER_PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$BACKEND_DIR/.env" | tail -n 1)"
  backend_port="${backend_port:-8657}"
  backend_url="http://127.0.0.1:${backend_port}"
  ensure_backend_is_stopped "$backend_url"

  echo "[fyxtez] Starting backend at $backend_url..."
  (
    cd "$BACKEND_DIR"
    exec cargo run
  ) &
  BROWSER_BACKEND_PID=$!

  echo "[fyxtez] Waiting for backend readiness..."
  local backend_ready=false
  for _ in {1..120}; do
    if ! kill -0 "$BROWSER_BACKEND_PID" 2>/dev/null; then
      wait "$BROWSER_BACKEND_PID" || true
      echo "[fyxtez] Backend exited before it became ready." >&2
      exit 1
    fi

    if curl --silent --fail --max-time 1 "$backend_url/health" >/dev/null 2>&1; then
      backend_ready=true
      break
    fi
    sleep 0.5
  done

  if [[ "$backend_ready" != true ]]; then
    echo "[fyxtez] Backend did not become ready within 60 seconds." >&2
    exit 1
  fi

  if browser_frontend_is_running; then
    reuse_frontend=true
    echo "[fyxtez] Reusing the Vite UI already running at http://localhost:5173."
    echo "          Reload its browser tab to reconnect to the backend."
  else
    echo "[fyxtez] Starting chart-only browser UI..."
    (
      cd "$FRONTEND_DIR"
      exec npm run dev -- --host localhost --open
    ) &
    BROWSER_FRONTEND_PID=$!
  fi

  echo "[fyxtez] Browser development stack is running. Press Ctrl+C to stop it."

  set +e
  if [[ "$reuse_frontend" == true ]]; then
    wait "$BROWSER_BACKEND_PID"
  else
    wait -n "$BROWSER_BACKEND_PID" "$BROWSER_FRONTEND_PID"
  fi
  local process_status=$?
  set -e

  if [[ $process_status -ne 0 ]]; then
    echo "[fyxtez] A development process exited with status $process_status." >&2
  else
    echo "[fyxtez] A development process stopped; shutting down the stack."
  fi

  cleanup_browser "$process_status"
}

run_android() {
  require_command adb
  require_command cargo
  require_command npm
  require_command rustc
  require_frontend_dependencies

  local device_count
  local apk_path="$FRONTEND_DIR/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
  device_count="$(adb devices | awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }')"

  if [[ "$device_count" -eq 0 ]]; then
    echo "[fyxtez] No authorized Android device is connected." >&2
    echo "          Enable USB debugging, connect the phone, and accept its authorization prompt." >&2
    exit 1
  fi
  if [[ "$device_count" -gt 1 ]]; then
    echo "[fyxtez] More than one Android device is connected; leave only the target device attached." >&2
    exit 1
  fi

  echo "[fyxtez] Building the Android arm64 debug APK..."
  (
    cd "$FRONTEND_DIR"
    npm run android:build:device
  )

  if [[ ! -f "$apk_path" ]]; then
    echo "[fyxtez] Android build completed without the expected APK: $apk_path" >&2
    exit 1
  fi

  echo "[fyxtez] Installing the APK on the connected device..."
  adb install -r "$apk_path"

  echo "[fyxtez] Launching Fyxtez Terminal..."
  adb shell am start -n com.fyxtez.terminal/.MainActivity
}

mode="${1:-desktop}"
if [[ $# -gt 0 ]]; then
  shift
fi

if [[ $# -gt 0 ]]; then
  echo "[fyxtez] Unexpected arguments: $*" >&2
  usage >&2
  exit 2
fi

case "$mode" in
  desktop | tauri)
    run_desktop
    ;;
  browser | web)
    run_browser
    ;;
  android | apk)
    run_android
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    echo "[fyxtez] Unknown mode: $mode" >&2
    usage >&2
    exit 2
    ;;
esac
