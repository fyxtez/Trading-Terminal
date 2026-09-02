#!/usr/bin/env bash

set -euo pipefail

CURRENT_DIR="$(pwd)"
FOLDER_NAME="$(basename "$CURRENT_DIR")"
ZIP_NAME="${FOLDER_NAME}.zip"
ZIP_PATH="${CURRENT_DIR}/${ZIP_NAME}"

# Remove existing archive so we always create a fresh one.
rm -f "$ZIP_PATH"

echo "Creating: $ZIP_PATH"

cd "$(dirname "$CURRENT_DIR")"

zip -r "$ZIP_PATH" "$FOLDER_NAME" \
    -x \
    "$FOLDER_NAME/node_modules/*" \
    "$FOLDER_NAME/target/*" \
    "$FOLDER_NAME/dist/*" \
    "$FOLDER_NAME/build/*" \
    "$FOLDER_NAME/.git/*" \
    "$FOLDER_NAME/.idea/*" \
    "$FOLDER_NAME/.vscode/*" \
    "$FOLDER_NAME/.next/*" \
    "$FOLDER_NAME/.cache/*" \
    "$FOLDER_NAME/coverage/*" \
    "$FOLDER_NAME/tmp/*" \
    "$FOLDER_NAME/temp/*" \
    "$FOLDER_NAME/.env" \
    "$FOLDER_NAME/.env.*" \
    "$FOLDER_NAME/*.zip" \
    "$FOLDER_NAME/*.log" \
    "$FOLDER_NAME/.DS_Store"

echo "Archive created successfully:"
echo "$ZIP_PATH"

# Open the current folder in the system's default file manager.
if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$CURRENT_DIR" >/dev/null 2>&1 &
elif command -v gio >/dev/null 2>&1; then
    gio open "$CURRENT_DIR" >/dev/null 2>&1 &
else
    echo "Could not find xdg-open or gio to open the file manager."
fi