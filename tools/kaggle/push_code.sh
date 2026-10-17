#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_user.sh"
B=$(mktemp -d)
cp -r ml eval requirements-ml.txt "$B/"
find "$B" -name __pycache__ -prune -exec rm -rf {} +
cat > "$B/dataset-metadata.json" <<JSON
{"title": "cashguard-code", "id": "$KUSER/cashguard-code", "licenses": [{"name": "other"}]}
JSON
if kaggle datasets status "$KUSER/cashguard-code" >/dev/null 2>&1; then
  kaggle datasets version -p "$B" -m "code $(git rev-parse --short HEAD)" -r zip -q
else
  kaggle datasets create -p "$B" -r zip -q
fi
echo "pushed code $(git rev-parse --short HEAD)"
