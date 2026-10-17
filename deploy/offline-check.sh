#!/usr/bin/env bash
# Run from a Docker host; no published ports, test traffic stays inside the container.
set -Eeuo pipefail
: "${API_KEY:?Set API_KEY}"
: "${IMAGE:?Set IMAGE to the already-built image}"
: "${VIDEO_DIR:?Set VIDEO_DIR to an absolute directory containing sample.mp4}"
: "${WORKSPACE_DIR:?Set WORKSPACE_DIR to an absolute persistent data/model directory}"
name="cashguard-offline-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
gpu_args=()
real_args=()
if [[ "${VLLM_ENABLED:-0}" == '1' ]]; then gpu_args=(--gpus all); fi
if [[ "${REQUIRE_REAL:-0}" == '1' ]]; then real_args=(--require-real); fi
docker run -d --name "$name" --network none "${gpu_args[@]}" \
    -e API_KEY -e VLLM_ENABLED="${VLLM_ENABLED:-0}" \
    -e ANALYZER="${ANALYZER:-ml.stub:analyze}" \
    -e VLM_MODEL="${VLM_MODEL:-Qwen/Qwen3-VL-8B-Instruct}" \
    -e MODEL_PATH="${MODEL_PATH:-/workspace/models/qwen}" \
    -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
    -v "$WORKSPACE_DIR:/workspace" -v "$VIDEO_DIR:/videos:ro" "$IMAGE" >/dev/null
ready=0
for ((attempt=0; attempt<360; attempt++)); do
    if docker exec "$name" curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
done
[[ "$ready" == '1' ]] || { docker logs "$name"; exit 1; }
docker exec "$name" bash -c \
    'exec "${BACKEND_PYTHON:-python3}" deploy/loadtest.py --output /workspace/offline-results "$@" /videos/sample.mp4' \
    bash "${real_args[@]}"
docker logs "$name" > "$WORKSPACE_DIR/offline-results/container.log" 2>&1
