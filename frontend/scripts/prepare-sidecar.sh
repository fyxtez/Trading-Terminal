#!/usr/bin/env bash

set -Eeuo pipefail

FRONTEND_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$(cd -- "$FRONTEND_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
MODE="${1:-debug}"

case "$MODE" in
  debug | release) ;;
  *)
    echo "Usage: $0 [debug|release]" >&2
    exit 2
    ;;
esac

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
TARGET_TRIPLE="${TAURI_ENV_TARGET_TRIPLE:-$HOST_TRIPLE}"
CARGO_ARGS=(build --locked --manifest-path "$BACKEND_DIR/Cargo.toml")
PROFILE_DIR="debug"

if [[ "$MODE" == "release" ]]; then
  CARGO_ARGS+=(--release)
  PROFILE_DIR="release"
fi

if [[ "$TARGET_TRIPLE" != "$HOST_TRIPLE" ]]; then
  CARGO_ARGS+=(--target "$TARGET_TRIPLE")
  SOURCE_BINARY="$BACKEND_DIR/target/$TARGET_TRIPLE/$PROFILE_DIR/fyxtez-backend"
else
  SOURCE_BINARY="$BACKEND_DIR/target/$PROFILE_DIR/fyxtez-backend"
fi

echo "[fyxtez] Building Axum sidecar ($MODE, $TARGET_TRIPLE)..."
cargo "${CARGO_ARGS[@]}"

mkdir -p "$FRONTEND_DIR/src-tauri/binaries"
install -m 755 "$SOURCE_BINARY" \
  "$FRONTEND_DIR/src-tauri/binaries/fyxtez-backend-$TARGET_TRIPLE"

echo "[fyxtez] Sidecar ready for Tauri."
