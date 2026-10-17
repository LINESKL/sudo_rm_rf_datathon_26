# Ответы команде

## Фронту (snownumb)

Да, текущий экран на моках принимается. Работай на моках, пока бэк (MAIN-1) не готов; на реальный API переключимся к 00:00.

Формат результата для следующего экрана — ответ `GET /api/v1/jobs/{id}/details`. Эталоны в репо:
- `docs/frontend/mock_details.json` — есть нарушения
- `docs/frontend/mock_details_clean.json` — нарушений нет
- `docs/frontend/mock_details_processing.json` — идёт обработка

Поля карточки нарушения:
- `observed` → «Что видно»
- `why` → «Почему это может быть нарушением»
- `rule` → «Норматив» (может быть `null` — тогда «Норматив не определён, требуется проверка»)
- `confidence_level` (low / medium / high) → уверенность
- `evidence_frames` → кадры

Дорожки состояний: `timeline` + `timeline_labels`. Плеер: `preview_url`.
Ответ для жюри (`/jobs/{id}`) фронту не нужен.

## Бэку (Bekzat)

Пода пока нет, модель финально не выбрана — спайк идёт на Kaggle, решение будет вечером.

- Модель по умолчанию: `Qwen/Qwen3-VL-8B-Instruct` (Apache-2.0), запасная `Qwen/Qwen3-VL-4B-Instruct`. Закладывай 24 ГБ VRAM.
- Под пока не арендуй. Когда заглушка будет готова снаружи (к ~00:00), бери RunPod **Community** RTX 3090 / 4090 (~$0,3/ч), не Secure. Оплата — через капитана.
- vLLM: `vllm serve Qwen/Qwen3-VL-8B-Instruct --port 8001 --max-model-len 8192 --limit-mm-per-prompt '{"image": 6}'`. Порт 8001 наружу не открывать.
- Подключение ML: ветка `ml`.

  ```python
  from ml import analyze
  result = analyze(video_path, deadline_s=240, on_progress=lambda stage, value: ...)
  result.to_jury(job_id)                  # ответ GET /api/v1/jobs/{id}
  result.to_details(job_id, preview_url)  # ответ GET /api/v1/jobs/{id}/details
  ```

  Переменные окружения: `VLM_BASE_URL=http://localhost:8001/v1`, `VLM_MODEL=<модель>`.
- `analyze` синхронная и тяжёлая — вызывай в потоке или процессе, исключения ловить снаружи → `failed`.
- До появления пода работай со своей заглушкой.
