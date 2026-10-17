#!/usr/bin/env bash
# Bring the whole service up on the RunPod pod: vLLM (offline) + Observer API.
# Idempotent: rebuilds what a pod stop wiped from the container disk, skips what is running.
# usage: bash /workspace/start_all.sh        (also called from /pre_start.sh on pod start)
set -u
export HF_HOME=/workspace/hf HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
APP=/workspace/app
MODEL=${VLM_MODEL:-QuantTrio/Qwen3-VL-30B-A3B-Instruct-AWQ}

command -v ffmpeg >/dev/null && command -v tmux >/dev/null || {
  apt-get -qq update && apt-get -qq install -y ffmpeg tmux rsync >/dev/null; }
command -v uv >/dev/null || pip install -q --break-system-packages uv
[ -x /root/vv/bin/vllm ] || { uv venv -q --python 3.12 /root/vv &&
  uv pip install -q --python /root/vv/bin/python "vllm==0.11.0" "transformers>=4.57,<5"; }
[ -x /root/api/bin/python ] || { uv venv -q --python 3.12 /root/api &&
  uv pip install -q --python /root/api/bin/python -r $APP/requirements.txt -r $APP/requirements-ml.txt; }

if ! curl -sf 127.0.0.1:8011/v1/models >/dev/null; then
  tmux kill-session -t vllm 2>/dev/null
  tmux new -d -s vllm "/root/vv/bin/vllm serve $MODEL --host 127.0.0.1 --port 8011 --max-model-len ${MAX_LEN:-32768} --max-num-seqs ${MAX_SEQS:-48} --limit-mm-per-prompt '{\"image\": 8, \"video\": 1}' --gpu-memory-utilization 0.90 --mm-processor-kwargs '{\"max_pixels\": 401408}' 2>&1 | tee /workspace/vllm.log"
  for i in $(seq 1 90); do
    curl -sf 127.0.0.1:8011/v1/models >/dev/null && break
    tmux has -t vllm 2>/dev/null || { echo "vLLM DIED"; tail -5 /workspace/vllm.log; exit 1; }
    sleep 10
  done
fi
curl -sf 127.0.0.1:8011/v1/models >/dev/null || { echo "vLLM TIMEOUT"; exit 1; }

if ! curl -sf -o /dev/null 127.0.0.1:8000/; then
  tmux kill-session -t api 2>/dev/null
  tmux new -d -s api "cd $APP && set -a && . /workspace/api.env && set +a && /root/api/bin/python -m uvicorn backend.app.main:create_app --factory --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' 2>&1 | tee -a /workspace/api.log"
  sleep 5
fi
curl -sf -o /dev/null 127.0.0.1:8000/ && echo "Observer READY" || { echo "API FAILED"; tail -5 /workspace/api.log; exit 1; }
