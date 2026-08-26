#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-/Users/bytedance/Downloads/nunito}"
TARGET_DIR="${HOME}/Library/Fonts/Nunito"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Font source directory not found: $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

find "$SOURCE_DIR" -type f \( \
  -iname "*.ttf" -o \
  -iname "*.otf" -o \
  -iname "*.ttc" -o \
  -iname "*.woff" -o \
  -iname "*.woff2" \
\) -print0 | while IFS= read -r -d '' font; do
  cp -f "$font" "$TARGET_DIR/"
done

if command -v atsutil >/dev/null 2>&1; then
  atsutil databases -removeUser >/dev/null 2>&1 || true
  atsutil server -shutdown >/dev/null 2>&1 || true
  atsutil server -ping >/dev/null 2>&1 || true
fi

echo "Installed Nunito fonts to: $TARGET_DIR"
echo "Restart apps that render SVGs so they can see the new fonts."
