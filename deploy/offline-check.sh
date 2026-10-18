#!/usr/bin/env bash
# Run from a Docker host; no published ports, test traffic stays inside the container.
set -Eeuo pipefail
: "${API_KEY:?Set API_KEY}"
: "${IMAGE:?Set IMAGE to the already-built image}"
: "${VIDEO_DIR:?Set VIDEO_DIR to an absolute directory containing the input video}"
: "${WORKSPACE_DIR:?Set WORKSPACE_DIR to an absolute persistent data/model directory}"
video_file="${VIDEO_FILE:-sample.mp4}"
source_kind="${VIDEO_SOURCE:-synthetic}"
[[ "$video_file" != */* && "$video_file" != *\\* && -f "$VIDEO_DIR/$video_file" ]] || {
    echo 'VIDEO_FILE must name an existing file directly inside VIDEO_DIR' >&2; exit 1;
}
[[ "$source_kind" == 'synthetic' || "$source_kind" == 'dataset' ]] || {
    echo 'VIDEO_SOURCE must be synthetic or dataset' >&2; exit 1;
}
name="observer-offline-$$"
container_created=0
output="$WORKSPACE_DIR/offline-results"
mkdir -p "$output"
cleanup() {
    [[ "$container_created" == '1' ]] || return 0
    docker logs "$name" > "$output/container.log" 2>&1 || true
    docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
gpu_args=()
real_args=()
if [[ "${VLLM_ENABLED:-0}" == '1' ]]; then gpu_args=(--gpus all); fi
if [[ "${REQUIRE_REAL:-0}" == '1' ]]; then real_args=(--require-real); fi
# Never pull an image during the offline check; it must already exist locally.
docker image inspect "$IMAGE" --format '{{.Id}}' > "$output/image-id.txt"
docker run --pull never -d --name "$name" --network none "${gpu_args[@]}" \
    -e API_KEY -e VLLM_ENABLED="${VLLM_ENABLED:-0}" \
    -e ANALYZER="${ANALYZER:-ml.stub:analyze}" \
    -e VLM_MODEL="${VLM_MODEL:-QuantTrio/Qwen3-VL-30B-A3B-Instruct-AWQ}" \
    -e MODEL_PATH="${MODEL_PATH:-/workspace/models/qwen}" \
    -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
    -v "$WORKSPACE_DIR:/workspace" -v "$VIDEO_DIR:/videos:ro" "$IMAGE" >/dev/null
container_created=1
wait_ready() {
    for ((attempt=0; attempt<360; attempt++)); do
        [[ "$(docker inspect "$name" --format '{{.State.Running}}')" == 'true' ]] || {
            echo 'Container exited before readiness; see offline-results/container.log' >&2; return 1;
        }
        if docker exec "$name" curl -fsS --max-time 2 http://127.0.0.1:8000/health >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    echo 'Readiness timeout; see offline-results/container.log' >&2
    return 1
}
wait_ready
docker inspect "$name" --format '{{.HostConfig.NetworkMode}}' > "$output/network-mode.txt"
[[ "$(cat "$output/network-mode.txt")" == 'none' ]]

# Check the actual network namespace, not just the requested Docker option.
docker exec -i "$name" bash -c 'exec "${BACKEND_PYTHON:-python3}" -' > "$output/network.json" <<'PY'
import json
import socket
interfaces = [name for _, name in socket.if_nameindex()]
error = None
connected = False
try:
    with socket.create_connection(('192.0.2.1', 443), timeout=2):
        connected = True
except OSError as exc:
    error = str(exc)
isolated = interfaces == ['lo'] and not connected
print(json.dumps({'interfaces': interfaces, 'external_tcp_connected': connected,
                  'external_tcp_error': error, 'isolated': isolated}, indent=2))
if not isolated:
    raise SystemExit('Network isolation check failed')
PY
docker exec "$name" bash -c 'exec "${BACKEND_PYTHON:-python3}" -m pip check' > "$output/pip-check.txt"
docker exec "$name" bash -c \
    'exec "${BACKEND_PYTHON:-python3}" -m deploy.frontend_check --output /workspace/offline-results/frontend.json'
docker exec "$name" bash -c \
    'exec "${BACKEND_PYTHON:-python3}" -m deploy.acceptance --output /workspace/offline-results/acceptance.json "$@"' \
    bash --source "$source_kind" "${real_args[@]}" "/videos/$video_file"
docker exec "$name" bash -c \
    'exec "${BACKEND_PYTHON:-python3}" deploy/loadtest.py --output /workspace/offline-results "$@"' \
    bash "${real_args[@]}" "/videos/$video_file"

docker restart "$name" >/dev/null
wait_ready
docker exec -i "$name" bash -c 'exec "${BACKEND_PYTHON:-python3}" -' > "$output/restart.json" <<'PY'
import json
import os
from pathlib import Path
import httpx
summary = json.loads(Path('/workspace/offline-results/summary.json').read_text())
results = []
with httpx.Client(base_url='http://127.0.0.1:8000', headers={'X-API-Key': os.environ['API_KEY']},
                  timeout=10, trust_env=False) as client:
    for job in summary['results']:
        response = client.get('/api/v1/jobs/' + job['job_id'])
        response.raise_for_status()
        results.append({'job_id': job['job_id'], 'status': response.json()['status']})
passed = len(results) == 6 and all(row['status'] == 'done' for row in results)
print(json.dumps({'passed': passed, 'jobs': results}, indent=2))
if not passed:
    raise SystemExit('Completed results did not survive restart')
PY
echo "Offline acceptance, six uploads and restart passed. Reports: $output"
