# syntax=docker/dockerfile:1
ARG VLLM_IMAGE=vllm/vllm-openai:v0.31.0-cu129

FROM python:3.12-slim AS stub
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN sed -i 's/\r$//' deploy/*.sh && chmod +x deploy/*.sh
ENV PYTHONUNBUFFERED=1 DATA_DIR=/workspace/data FRONTEND_DIR=/app/frontend/dist \
    ANALYZER=ml.stub:analyze VLLM_ENABLED=0 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    VLM_BASE_URL=http://localhost:8001/v1 VLM_MODEL=Qwen/Qwen3-VL-8B-Instruct ML_DEADLINE_S=240 \
    HF_HUB_DISABLE_TELEMETRY=1 VLLM_NO_USAGE_STATS=1 DO_NOT_TRACK=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD curl -fsS http://127.0.0.1:8000/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/start.sh"]

FROM ${VLLM_IMAGE} AS gpu
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl tini python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
# Isolate API dependency pins from vLLM's own server dependencies.
RUN python3 -m venv --system-site-packages /opt/backend \
    && /opt/backend/bin/pip install --no-cache-dir -r requirements.txt
COPY . .
RUN /opt/backend/bin/pip install --no-cache-dir -r requirements-ml.txt -c requirements.txt
RUN sed -i 's/\r$//' deploy/*.sh && chmod +x deploy/*.sh
ENV PYTHONUNBUFFERED=1 BACKEND_PYTHON=/opt/backend/bin/python \
    DATA_DIR=/workspace/data FRONTEND_DIR=/app/frontend/dist \
    MODEL_PATH=/workspace/models/qwen VLLM_ENABLED=1 ANALYZER=ml.stub:analyze \
    VLM_BASE_URL=http://localhost:8001/v1 VLM_MODEL=Qwen/Qwen3-VL-8B-Instruct ML_DEADLINE_S=240 \
    HF_HOME=/workspace/cache/huggingface HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 VLLM_NO_USAGE_STATS=1 DO_NOT_TRACK=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s \
    CMD curl -fsS http://127.0.0.1:8000/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/start.sh"]
