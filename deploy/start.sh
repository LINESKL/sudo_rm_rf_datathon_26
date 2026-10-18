#!/usr/bin/env bash
set -Eeuo pipefail
cd /app
: "${API_KEY:?Set API_KEY before starting the service}"
if [[ "$API_KEY" == "replace-with-a-random-secret" ]]; then
    echo 'Replace the example API_KEY.' >&2
    exit 1
fi
export DATA_DIR="${DATA_DIR:-/workspace/data}"
mkdir -p "$DATA_DIR"
backend_python="${BACKEND_PYTHON:-python3}"
export VLM_MODEL="${VLM_MODEL:-QuantTrio/Qwen3-VL-30B-A3B-Instruct-AWQ}"
export VLM_BASE_URL="${VLM_BASE_URL:-http://localhost:8001/v1}"
vllm_pid=''
api_pid=''
cleanup() {
    trap - EXIT TERM INT
    [[ -z "$api_pid" ]] || kill -TERM "$api_pid" 2>/dev/null || true
    [[ -z "$vllm_pid" ]] || kill -TERM "$vllm_pid" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

if [[ "${VLLM_ENABLED:-0}" == '1' ]]; then
    : "${MODEL_PATH:?Set MODEL_PATH to a local model directory}"
    [[ -f "$MODEL_PATH/config.json" ]] || { echo 'Local model config.json is missing' >&2; exit 1; }
    export VLM_BASE_URL=http://localhost:8001/v1
    vllm serve "$MODEL_PATH" --host 127.0.0.1 --port 8001 \
        --served-model-name "$VLM_MODEL" \
        --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION:-0.90}" \
        --max-model-len "${MAX_MODEL_LEN:-32768}" --limit-mm-per-prompt '{"image": 8, "video": 1}' \
        --mm-processor-kwargs '{"max_pixels": 401408}' \
        --max-num-seqs "${MAX_NUM_SEQS:-48}" &
    vllm_pid=$!
    ready=0
    for ((attempt=0; attempt<${VLLM_STARTUP_TIMEOUT_S:-600}; attempt+=2)); do
        kill -0 "$vllm_pid" 2>/dev/null || { echo 'vLLM exited during startup' >&2; exit 1; }
        if curl -fsS --max-time 2 http://127.0.0.1:8001/health >/dev/null; then ready=1; break; fi
        sleep 2
    done
    [[ "$ready" == '1' ]] || { echo 'vLLM readiness timeout' >&2; exit 1; }
fi

# One API process owns SQLite recovery and the three internal analysis workers.
"$backend_python" -m uvicorn backend.app.main:create_app --factory \
    --host 0.0.0.0 --port "${PORT:-8000}" --workers 1 &
api_pid=$!
set +e
if [[ -n "$vllm_pid" ]]; then
    wait -n "$api_pid" "$vllm_pid"
else
    wait "$api_pid"
fi
code=$?
set -e
# An unexpected clean exit must also trigger the container restart policy.
if [[ "$code" == '0' ]]; then code=1; fi
exit "$code"
