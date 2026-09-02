#!/usr/bin/env bash

set -Eeuo pipefail

FRONTEND_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$(cd -- "$FRONTEND_DIR/.." && pwd)"
BACKEND_PID=""
VITE_PID=""

cleanup() {
  trap - EXIT INT TERM
  [[ -z "$VITE_PID" ]] || kill "$VITE_PID" 2>/dev/null || true
  [[ -z "$BACKEND_PID" ]] || kill "$BACKEND_PID" 2>/dev/null || true
  [[ -z "$VITE_PID" ]] || wait "$VITE_PID" 2>/dev/null || true
  [[ -z "$BACKEND_PID" ]] || wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ ! -f "$PROJECT_DIR/backend/.env" ]]; then
  echo "[desktop] Missing backend/.env" >&2
  exit 1
fi

if [[ ! -f "$FRONTEND_DIR/.env" ]]; then
  echo "[desktop] Missing frontend/.env" >&2
  exit 1
fi

for command in cargo npm curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[desktop] Missing required command: $command" >&2
    exit 1
  fi
done

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

BACKEND_PORT="$(read_env_setting "$PROJECT_DIR/backend/.env" SERVER_PORT)"
BACKEND_PORT="${BACKEND_PORT:-8657}"
BACKEND_HOST="$(read_env_setting "$PROJECT_DIR/backend/.env" SERVER_HOST)"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
BACKEND_TOKEN="$(read_env_setting "$PROJECT_DIR/backend/.env" SERVICE_API_TOKEN)"
FRONTEND_TOKEN="$(read_env_setting "$FRONTEND_DIR/.env" VITE_TRADING_API_TOKEN)"

if [[ "$BACKEND_HOST" != "127.0.0.1" || "$BACKEND_PORT" != "8657" ]]; then
  echo "[desktop] Tauri development currently requires SERVER_HOST=127.0.0.1 and SERVER_PORT=8657." >&2
  exit 1
fi
if [[ -z "$BACKEND_TOKEN" || -z "$FRONTEND_TOKEN" || "$BACKEND_TOKEN" != "$FRONTEND_TOKEN" ]]; then
  echo "[desktop] Backend and frontend service tokens are required and must match." >&2
  exit 1
fi
if [[ "$BACKEND_TOKEN" == replace-with-* ]]; then
  echo "[desktop] Replace the example service token with a random value in both .env files." >&2
  exit 1
fi
if curl --silent --fail --max-time 1 "$BACKEND_URL/health" >/dev/null 2>&1; then
  echo "[desktop] A backend is already running at $BACKEND_URL. Stop it first." >&2
  exit 1
fi

(
  cd "$PROJECT_DIR/backend"
  exec cargo run
) &
BACKEND_PID=$!

backend_ready=false
for _ in {1..120}; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "[desktop] Backend exited before becoming ready." >&2
    exit 1
  fi
  if curl --silent --fail --max-time 1 "$BACKEND_URL/health" >/dev/null 2>&1; then
    backend_ready=true
    break
  fi
  sleep 0.5
done

if [[ "$backend_ready" != true ]]; then
  echo "[desktop] Backend did not become ready within 60 seconds." >&2
  exit 1
fi

(
  cd "$FRONTEND_DIR"
  exec npm run dev
) &
VITE_PID=$!

wait "$VITE_PID"
