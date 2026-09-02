#!/usr/bin/env bash

# Recursively collects contents of all .rs files from the project root
# (where this script lives) and copies them to the clipboard.
# Skips: target, untracked, .github, .git directories.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECTED=""
FILE_COUNT=0

while IFS= read -r -d '' file; do
    COLLECTED+="// ===== ${file#"$SCRIPT_DIR"/} =====
"
    COLLECTED+="$(cat "$file")"
    COLLECTED+=$'\n\n'
    ((FILE_COUNT++))
done < <(find "$SCRIPT_DIR" \
    -type d \( -name target -o -name untracked -o -name .github -o -name .git \) -prune \
    -o -type f -name "*.rs" -print0 | sort -z)

if [[ $FILE_COUNT -eq 0 ]]; then
    echo "No .rs files found."
    exit 0
fi

# Copy to clipboard (works on Linux/macOS)
if command -v xclip &>/dev/null; then
    printf '%s' "$COLLECTED" | xclip -selection clipboard
elif command -v xsel &>/dev/null; then
    printf '%s' "$COLLECTED" | xsel --clipboard --input
elif command -v pbcopy &>/dev/null; then
    printf '%s' "$COLLECTED" | pbcopy
elif command -v wl-copy &>/dev/null; then
    printf '%s' "$COLLECTED" | wl-copy
else
    echo "ERROR: No clipboard tool found (need xclip, xsel, pbcopy, or wl-copy)."
    exit 1
fi

echo "Copied $FILE_COUNT .rs file(s) to clipboard."