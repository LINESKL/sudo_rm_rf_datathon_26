#!/usr/bin/env bash
# Запускать один раз, после «да» капитана. Датасет приватный по умолчанию.
set -euo pipefail
source "$(dirname "$0")/_user.sh"
B=$(mktemp -d)
mkdir "$B/videos" && cp open/videos/*.mov "$B/videos/" && cp open/open_labels.xlsx "$B/"
cat > "$B/dataset-metadata.json" <<JSON
{"title": "cashguard-videos", "id": "$KUSER/cashguard-videos", "licenses": [{"name": "other"}]}
JSON
kaggle datasets create -p "$B" -r zip -q
echo "videos uploaded as private dataset $KUSER/cashguard-videos"
