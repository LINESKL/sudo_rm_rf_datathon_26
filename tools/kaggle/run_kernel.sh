#!/usr/bin/env bash
# usage: run_kernel.sh [ONLY] [AUGMENT]
set -euo pipefail
ONLY="${1:-}"
source "$(dirname "$0")/_user.sh"
bash tools/kaggle/push_code.sh
K=$(mktemp -d)
sed "s|^ONLY = .*|ONLY = os.environ.get(\"ONLY\", \"$ONLY\")|" tools/kaggle/kernel/run.py > "$K/run.py"
cat > "$K/kernel-metadata.json" <<JSON
{"id": "$KUSER/cashguard-eval", "title": "cashguard-eval", "code_file": "run.py",
 "language": "python", "kernel_type": "script", "is_private": true,
 "enable_gpu": true, "enable_internet": true,
 "dataset_sources": ["$KUSER/cashguard-code", "$KUSER/cashguard-videos"]}
JSON
sleep 30  # дать датасету кода обработаться
kaggle kernels push -p "$K" ${KAGGLE_ACCEL_FLAG:-}
while true; do
  S=$(kaggle kernels status "$KUSER/cashguard-eval" 2>&1 || true); echo "$S"
  case "$S" in *complete*|*COMPLETE*|*error*|*ERROR*|*cancel*|*CANCEL*) break;; esac
  sleep 60
done
OUT="runs/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$OUT"
kaggle kernels output "$KUSER/cashguard-eval" -p "$OUT" -q
cat "$OUT/out/report.md" 2>/dev/null || tail -50 "$OUT/vllm.log"
