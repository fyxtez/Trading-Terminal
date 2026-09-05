#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$script_dir/.."

# Vite gives process environment variables precedence over .env files. Native
# releases obtain the endpoint and per-launch capability from Tauri IPC, so no
# browser-development URL, token or alert link may be compiled into the WebView.
export VITE_TRADING_API_TOKEN=""
export VITE_TRADING_API_URL=""
export VITE_TRADING_LOCAL_API_URL=""
export VITE_PUBLIC_TERMINAL_URL=""
export VITE_NTFY_URL=""

npm run build

# Absolute root paths work in Vite's HTTP development server but can leave a
# packaged WebView without styles or other assets. Enforce relative assets for
# every native target.
if grep -E -q '(src|href)="/' dist/index.html; then
  echo "Native index contains an absolute asset URL" >&2
  exit 1
fi
