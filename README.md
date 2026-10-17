# CashGuard — Datathon 2026

Бэкенд проверки видео кассовой зоны: FastAPI, очередь из трёх воркеров,
SQLite WAL, h264-превью и отдельный контракт ответа жюри.

**Текущий анализатор — заглушка.** Она ждёт 5 секунд, извлекает реальный первый
кадр и возвращает одно явно вымышленное нарушение. Это средство интеграции;
Код реального ML подключён и включается отдельно; VLM-сервер, публичный адрес
и результат проверки качества ещё требуют приёмки.

## Быстрый запуск

Нужны Python 3.12+ и `ffmpeg`/`ffprobe` в PATH. Команды выполняются из корня репозитория.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export API_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
python -m uvicorn backend.app.main:create_app --factory --host 127.0.0.1 --port 8000
```

PowerShell:

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
$env:API_KEY = .venv/Scripts/python.exe -c 'import secrets; print(secrets.token_urlsafe(32))'
.venv/Scripts/python.exe -m uvicorn backend.app.main:create_app --factory --host 127.0.0.1 --port 8000
```

Если `venv` не смог установить pip, используйте
`python -m pip --python .venv/Scripts/python.exe install -r requirements.txt`.
Для нестандартного расположения FFmpeg задайте `FFMPEG_BIN` и `FFPROBE_BIN` полными путями.
Список настроек — [.env.example](.env.example); файл `.env` автоматически не читается.
Запускайте **один** процесс uvicorn: внутри него уже есть три воркера анализа.

- UI: [localhost:8000](http://localhost:8000). Готовую сборку фронтенда поместить в `frontend/dist`.
  Пока сборки нет, корень показывает страницу состояния API.
- API: [localhost:8000/docs](http://localhost:8000/docs).
- Состояние: [localhost:8000/health](http://localhost:8000/health).
- Ключ: значение вашей переменной `API_KEY`; общего встроенного ключа нет.

## Проверка видео

```bash
curl -X POST http://localhost:8000/api/v1/analyze \
  -H "X-API-Key: $API_KEY" -F "file=@sample.mov"
# Подставьте job_id из ответа:
curl http://localhost:8000/api/v1/jobs/JOB_ID -H "X-API-Key: $API_KEY"
curl http://localhost:8000/api/v1/jobs/JOB_ID/details -H "X-API-Key: $API_KEY"
```

В PowerShell используйте `curl.exe` и `$env:API_KEY`.
Приём возвращает `202 {"job_id":"..."}`. Разрешены MOV/MP4 до 200 МиБ;
битое видео, пустой файл и неподдерживаемое расширение возвращают `400`.
Отсутствующий/неверный ключ — `401`, неизвестная задача — `404`.

`/jobs/{id}` во время обработки или ошибки содержит только `job_id`, `status`.
В `done` добавляются `verdict` и `violations`, каждое нарушение содержит только
`type`, `timecode_sec`, `description`, `evidence_frames`.
Причина ошибки доступна в `/details.error`, поля UI — только в `/details`.
Эталон UI: [моки](docs/frontend/), [спецификация](docs/superpowers/specs/2026-10-17-cashguard-design.md).

Превью `/previews/<32-символьный-id>.mp4` защищены. Успешный `/details`
выдаёт HttpOnly cookie на одно видео на 15 минут; обычный `<video src>` на том же
origin отправляет её автоматически. Один URL без cookie не даёт доступа (`401`).
Для curl допустим `X-API-Key`; основной ключ не передаётся в URL.
Поддерживаются GET, HEAD и Range; ответы не кешируются. При истечении cookie
нужно повторить `/details` с ключом. За HTTPS-прокси задайте `MEDIA_COOKIE_SECURE=1`.
Интеграция фронтенда: [контракт media и неполных нормативов](docs/frontend/backend-integration.md).

## Docker

CPU-образ для проверки заглушки:

```bash
docker build --target stub -t cashguard:stub .
docker run --rm -p 8000:8000 -e API_KEY -v cashguard-data:/workspace cashguard:stub
```

GPU-образ, запуск vLLM, RunPod, восстановление и проверка без сети:
[deploy/README.md](deploy/README.md).
Соберите фронт **до** `docker build`, чтобы `frontend/dist` попал в образ.

CPU-образ проверен 17.10.2026: запуск с `--network none`, обработка исходного MOV
28,72 МБ, шесть одновременных загрузок и сохранение результатов после рестарта.
Повторяемая проверка — `deploy/offline-check.sh`; параметры Linux/PowerShell и
результаты описаны в [инструкции](deploy/README.md) и [протоколе](docs/backend-acceptance.md).
Это проверка заглушки; GPU-образ с реальными моделями ещё требует приёмки.

## Подключение ML

Код из ветки `ml` подключён; подробности и границы проверки —
[в протоколе интеграции](docs/ml-integration.md). Для реального анализа установите
`requirements-ml.txt` с ограничениями `-c requirements.txt`, запустите собственный
VLM-сервер и выставьте `ANALYZER=ml:analyze`. Значение по умолчанию —
`ANALYZER=ml.stub:analyze`. Функция синхронная и вызывается
в отдельном процессе:

```python
from ml import analyze
result = analyze(video_path, deadline_s=240, on_progress=lambda stage, value: ...)
jury = result.to_jury(job_id)
details = result.to_details(job_id, preview_url)
```

`deadline_s` — бюджет в секундах от начала вызова ML. По умолчанию он равен 240
(`ML_DEADLINE_S`); если после превью осталось меньше, передаётся оставшийся бюджет.
Общий жёсткий лимит задачи с превью — 280 секунд (`JOB_TIMEOUT_S`).
Результат обязан предоставлять `to_jury` и `to_details`; бэкенд валидирует их ответы,
сохраняет время анализа, измеренное ML. `degraded=True` означает неполный анализ:
бэкенд завершает такую задачу как `failed`, поскольку ответ жюри не содержит поля
для этой оговорки. Это касается обоих вердиктов; причина остаётся в журнале задачи.
`on_progress(stage, value)`: decode / detect / scene / verify / done, value от 0 до 1.
Тексты, нормативы и ссылки поставляет ML; бэкенд не генерирует юридические утверждения.
При превышении общего лимита завершается
всё дерево процесса; задача становится `failed`. При рестарте `processing`
ставится в очередь повторно. `done` и `failed` сохраняются.

`DATA_DIR` содержит БД, оригиналы, превью и журналы. Автоудаления пока нет:
для очистки архивируйте данные при остановленном сервисе. Храните volume на
локальной файловой системе с поддержкой SQLite WAL и блокировок файлов.

Архитектура реального анализа из спецификации: декодирование → детектор/трекер →
VLM-состояния и процедуры → правила → проверка кандидатов → результат.
Пока реализована инфраструктура, а не эти ML-этапы.
По текущему решению команды модель по умолчанию — `Qwen/Qwen3-VL-8B-Instruct`
(Apache-2.0), запасная — `Qwen/Qwen3-VL-4B-Instruct`. Целевой GPU — 24 ГБ VRAM;
финальный выбор ожидается после спайка на Kaggle. Веса в репозиторий не включены.
ML использует `VLM_BASE_URL=http://localhost:8001/v1` и `VLM_MODEL=<модель>`.
Для 4B нужно одновременно сменить `VLM_MODEL` и локальные веса в `MODEL_PATH`.

## Проверки

```bash
pip install -r requirements-dev.txt
python -m pytest -q
python -m deploy.acceptance --url http://localhost:8000 --source dataset sample.mov
python deploy/loadtest.py --url http://localhost:8000 sample.mov
# При приёмке реального пайплайна:
python deploy/loadtest.py --url https://YOUR_HOST --require-real a.mov b.mov c.mov d.mov e.mov f.mov
```

`deploy.acceptance` проверяет загрузку одного ролика через HTTP, согласованность
обоих ответов, JPEG, закрытый доступ к media, HEAD/Range, H.264/yuv420p и faststart.
Нужны `API_KEY` и `ffprobe` в PATH (или `FFPROBE_BIN`).
Отчёт — `test-results/acceptance-http.json`; в нём нет ключей, cookie или кадров.
Для сгенерированного видео укажите `--source synthetic`; для настоящего ML добавьте
`--require-real` (заглушка и `degraded` не проходят). Проверка качества ML и
воспроизведения браузером проводится отдельно: HTTP-скрипт их не подтверждает.

Нагрузочный скрипт отправляет шесть запросов одновременно, считает время от
начала загрузки, сохраняет ответы и `summary.json` в `test-results/loadtest`.
Код выхода ненулевой при ошибке, превышении 300 секунд или заглушке с `--require-real`.
280 секунд на обработку не гарантируют 300 секунд с ожиданием в очереди:
производительность реального пайплайна нужно замерить на целевом GPU.

Материалы сдачи и незаполненные внешние данные: [docs/submission.md](docs/submission.md).
