<div align="center">

# Observer — Datathon 2026

Проверка видеозаписей кассовых операций с объяснением находок.

**React · TypeScript · Vite · shadcn/ui · Tailwind CSS**

</div>

Observer — локальный AI-сервис: по записи потолочной камеры кассы находит признаки возможных
нарушений кассовой дисциплины и показывает тип, таймкод, 1–3 кадра-доказательства и норму РК
со ссылкой на adilet. Облачные AI-сервисы не используются, после загрузки весов интернет не нужен.

- **Сервис:** https://13y5afllndxi2q-8000.proxy.runpod.net/ (интерфейс без ключа, API жюри `/api/v1` с `X-API-Key`).
- **Материалы сдачи:** [docs/submission.md](docs/submission.md) — архитектура, нормы, типы нарушений, метрики, ограничения.
- **Модель:** Qwen3-VL-30B-A3B-Instruct (AWQ, Apache-2.0) в vLLM 0.11, одна видеокарта 24–48 ГБ.

**Как работает** (`ml/`): выборка до 160 кадров → покадровое состояние сцены от VLM → интервалы
и правила → крупный план экрана и стола на уходах кассира → анкета действий по окнам из 4 кадров
(дверь, пересчёт руками без счётной машины) → посторонний по окнам → кадры, таймкод и норма.

**Качество** на 40 размеченных видео кейса: точность вердикта 72,5 %, найдено 76 % нарушений,
тревога на 32 % чистых видео, таймкод в пределах 5 с у 45 % событий (`eval/run_eval.py`).

Анализатор по умолчанию в локальном запуске — заглушка (`ANALYZER=ml.stub:analyze`): она ждёт
5 секунд и возвращает одно явно вымышленное нарушение. Реальный ML включается через
`ANALYZER=ml:analyze` и требует vLLM с моделью; запуск на RunPod — `deploy/pod/start_all.sh`.

## Быстрый запуск

Нужны Python 3.12+, `ffmpeg`/`ffprobe` в PATH и Node.js согласно `frontend/package.json`
(проверено с Node 24.19.0). Команды выполняются из корня репозитория.

Сначала соберите production-интерфейс, который FastAPI раздаёт с того же origin:

```bash
npm --prefix frontend ci
npm --prefix frontend run build
```

В Windows при ограничении PowerShell ExecutionPolicy используйте `npm.cmd`.
Интерфейс работает без ключа; API-ключ нужен только для `/api/v1`, в сборку его не добавляйте.

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

- UI: [localhost:8000](http://localhost:8000). Сборка создаёт `frontend/dist`;
  если она отсутствует, корень показывает страницу состояния API.
- API: [localhost:8000/docs](http://localhost:8000/docs).
- Состояние: [localhost:8000/health](http://localhost:8000/health).
- Ключ: значение вашей переменной `API_KEY`; общего встроенного ключа нет.

## Интерфейс и разработка

Frontend принадлежит snownumb: React, Vite, TypeScript, Tailwind и локальные shadcn/ui.
Одна рабочая колонка: видео, API-ключ, прогресс отправки, этапы обработки, результат.
F2 показывает каждое событие с точным таймкодом, 1–3 JPEG, увеличением и нормативом;
неполный или тестовый анализ обозначается явно. F5 добавляет переходы фокуса,
подписи ошибок и проверенный адаптив 375/1440 px. Плеер F3 и дорожки F4 отложены;
отсутствие preview не мешает обязательным карточкам.
Все 155 frontend-тестов, lint/build/format проходят. Безопасные скриншоты и открытые
критерии реального ML — в [отчёте приёмки](docs/frontend/acceptance.md).

```bash
npm --prefix frontend run dev
# FastAPI должен работать на 127.0.0.1:8000.
# Vite проксирует /api и /previews на один backend.
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run format:check
```

Отдельный демонстрационный режим: `npm --prefix frontend run demo` и ключ
`demo-key`. Он не анализирует видео. Production не переключается на демо
при ошибках API; серверная заглушка явно обозначена в результате.
Все шрифты и ресурсы UI локальные. После `build:demo` обязательно выполните
обычный `build` перед передачей локальному сервису. Docker собирает production UI самостоятельно.

Бриф: [docs/frontend/BRIEF.md](docs/frontend/BRIEF.md).
Результаты и границы проверки: [приёмка frontend](docs/frontend/acceptance.md),
согласованный формат полей и cookie — [контракт](docs/frontend/backend-integration.md).

## Проверка видео

```bash
curl -X POST http://localhost:8000/api/v1/analyze \
  -H "X-API-Key: $API_KEY" -F "file=@sample.mov"
# Подставьте job_id из ответа:
curl http://localhost:8000/api/v1/jobs/JOB_ID -H "X-API-Key: $API_KEY"
curl http://localhost:8000/api/v1/jobs/JOB_ID/details -H "X-API-Key: $API_KEY"
```

В PowerShell используйте `curl.exe` и `$env:API_KEY`.
Приём возвращает `200 {"job_id":"..."}`. Разрешены MOV/MP4 до 200 МиБ;
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
docker build --target stub -t observer:stub .
docker run --rm -p 8000:8000 -e API_KEY -v observer-data:/workspace observer:stub
```

GPU-образ, запуск vLLM, RunPod, восстановление и проверка без сети:
[deploy/README.md](deploy/README.md).
Docker собирает production UI из исходников отдельным этапом Node 24.19.0
(`npm ci` и `npm run build`). Локальный `frontend/dist` исключён из контекста,
поэтому устаревшая или demo-сборка не попадёт в образ. Node нужен только при сборке.

Офлайн-проверки образа со стороны backend используют заглушку и контейнер с
`--network none`. Скрипт `deploy/offline-browser.py` проверяет UI/ресурсы и внешние
HTTP-запросы. Плеер/seek относятся к альтернативному интерфейсу backend-ветки;
в текущем основном UI F3 отложен. Границы локальной и реальной приёмки —
[протокол frontend](docs/frontend/acceptance.md).

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
актуальный runner доставляет его как `done`; `/details` содержит оговорку, а UI
показывает предупреждение и нейтральный баннер. Схема ответа жюри остаётся прежней.
`on_progress(stage, value)`: decode / detect / scene / verify / done, value от 0 до 1.
Тексты, нормативы и ссылки поставляет ML; бэкенд не генерирует юридические утверждения.
При превышении общего лимита завершается
всё дерево процесса; задача становится `failed`. При рестарте `processing`
ставится в очередь повторно. `done` и `failed` сохраняются.

`DATA_DIR` содержит БД, оригиналы, превью и журналы. Автоудаления пока нет:
для очистки архивируйте данные при остановленном сервисе. Храните volume на
локальной файловой системе с поддержкой SQLite WAL и блокировок файлов.

Код ML из `main`: декодирование → VLM-состояния и процедуры → правила → проверка
кандидатов → результат. Детектор/трекер и размытие лиц отложены; наличие кода
не подтверждает качество на датасете. При частичном сбое VLM библиотека помечает
анализ `degraded: true`; UI показывает предупреждение, такой результат не подтверждает
полный анализ. Исключение анализатора или невалидный ответ дают `failed`.
В конфигурации репозитория модель по умолчанию — `QuantTrio/Qwen3-VL-30B-A3B-Instruct-AWQ`
(Apache-2.0), запасная — `Qwen/Qwen3-VL-4B-Instruct`. Целевой GPU — 24 ГБ VRAM;
для публичного пода команда сообщает Qwen3-VL-30B на RTX 4090. Это ещё нужно
подтвердить живой приёмкой; веса в репозиторий не включены.
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

