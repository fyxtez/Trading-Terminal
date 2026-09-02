#!/usr/bin/env bash

set -Eeuo pipefail

# Vite gives process environment variables precedence over .env files. Define
# these as empty for desktop release builds so a developer's ignored frontend
# .env can never be compiled into the installed WebView. Tauri supplies the
# endpoint and per-launch capability over IPC at runtime.
export VITE_TRADING_API_TOKEN=""
export VITE_TRADING_API_URL=""
export VITE_TRADING_LOCAL_API_URL=""
export VITE_PUBLIC_TERMINAL_URL=""

exec npm run build
