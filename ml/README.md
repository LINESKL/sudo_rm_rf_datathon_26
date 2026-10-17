# ml — как подключить

```python
from ml import analyze
result = analyze(video_path, deadline_s=240, on_progress=lambda stage, value: ...)
jury = result.to_jury(job_id)                 # ответ GET /api/v1/jobs/{id}
details = result.to_details(job_id, preview)  # ответ GET /api/v1/jobs/{id}/details
```

Окружение: `VLM_BASE_URL` (по умолчанию `http://localhost:8001/v1`), `VLM_MODEL` (по умолчанию `Qwen/Qwen3-VL-8B-Instruct`).

vLLM: `vllm serve <model> --port 8001 --max-model-len 8192 --limit-mm-per-prompt '{"image": 6}'`.

`analyze` синхронная и тяжёлая — вызывать в потоке/процессе. Исключения ловить снаружи → `failed`.
Если VLM недоступна, `analyze` не падает: вернёт `no_violation` с `degraded=True` в `/details`.

Тесты: `uv pip install --python .venv/bin/python -r requirements-ml.txt && .venv/bin/python -m pytest -q`.
