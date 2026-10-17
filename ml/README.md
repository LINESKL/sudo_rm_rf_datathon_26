# ml — как подключить

```python
from ml import analyze
result = analyze(video_path, deadline_s=240, on_progress=lambda stage, value: ...)
jury = result.to_jury(job_id)                 # ответ GET /api/v1/jobs/{id}
details = result.to_details(job_id, preview)  # ответ GET /api/v1/jobs/{id}/details
```

Зависимости: `python -m pip install -r requirements-ml.txt -c requirements.txt`.
Для разработки и eval: `python -m pip install -r requirements-dev.txt`.
API с заглушкой требует только `requirements.txt`.

Окружение: `VLM_BASE_URL` (по умолчанию `http://localhost:8001/v1`), `VLM_MODEL` (на стенде `QuantTrio/Qwen3-VL-30B-A3B-Instruct-AWQ`),
`FFMPEG_BIN` / `FFPROBE_BIN` (по умолчанию команды из PATH).
В бэкенде реальный конвейер выбирается через `ANALYZER=ml:analyze`.

vLLM: `vllm serve <local-model-path> --served-model-name <VLM_MODEL> --host 127.0.0.1 --port 8001 --max-model-len 8192 --limit-mm-per-prompt '{"image": 6}'`.
Веса должны быть заранее подготовлены. Порт 8001 наружу не публиковать.

`analyze` синхронная и тяжёлая — вызывать в потоке/процессе. Исключения ловить снаружи → `failed`.
Если часть запросов VLM не выполнена, JSON не соответствует схеме, пропущен этап
или исчерпан бюджет, библиотека помечает результат `degraded=True`.
Такой результат нельзя интерпретировать как полный анализ. Бэкенд отдаёт его со статусом `done`
и флагом `degraded`, интерфейс помечает его «требует ручной проверки»; `failed` — только если
VLM не ответил ни на один кадр.
Общий жёсткий таймаут и уничтожение дерева процессов обеспечивает бэкенд.
Сам `deadline_s` пока не прерывает выполняющийся запрос VLM: это бюджет этапов.

Тесты: `python -m pytest -q` после установки `requirements-dev.txt` и FFmpeg.
`tests/test_ml_integration.py` проверяет реальный конвейер через API с локальным
тестовым VLM-сервером; это не замер качества Qwen. Состояние приёмки:
[`docs/ml-integration.md`](../docs/ml-integration.md).
