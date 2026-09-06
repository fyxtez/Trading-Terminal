#!/usr/bin/env bash

set -Eeuo pipefail

FRONTEND_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

for command in cargo npm rustc; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[desktop] Missing required command: $command" >&2
    exit 1
  fi
done

# Keep a production snapshot beside the Vite development server. The local
# backend serves this snapshot to normal browsers while the native window keeps
# using Vite and hot reload.
"$FRONTEND_DIR/scripts/build-desktop-frontend.sh"
"$FRONTEND_DIR/scripts/prepare-sidecar.sh" debug
cd "$FRONTEND_DIR"
exec npm run dev
