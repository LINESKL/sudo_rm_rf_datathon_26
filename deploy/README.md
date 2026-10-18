# Развёртывание Observer

## Образы и версии

`Dockerfile` имеет цели `stub` (CPU) и `gpu` (по умолчанию).
GPU-основа: `vllm/vllm-openai:v0.11.0` — та же версия vLLM, что на стенде.
GPU-образ с реальной моделью целиком не собирался: боевой стенд запущен скриптом `deploy/pod/start_all.sh` (ниже).
Версию можно переопределить `--build-arg VLLM_IMAGE=...`.
Драйвер хоста должен поддерживать CUDA выбранного образа.

Зависимости API устанавливаются в отдельное окружение `/opt/backend`,
чтобы не менять зависимости сервера vLLM. Оно видит системные torch/ML-пакеты;
`requirements-ml.txt` устанавливается в backend-окружение GPU-образа
с ограничениями версий API из `requirements.txt`. CPU-цель `stub` устанавливает
только зависимости API; импорт заглушки не загружает зависимости реального ML.

```bash
docker build --target gpu -t YOUR_REGISTRY/observer:datathon .
docker push YOUR_REGISTRY/observer:datathon
docker run -d --name observer --restart unless-stopped --gpus all \
  --shm-size 8g -p 8000:8000 -e API_KEY \
  -e ANALYZER=ml:analyze -e VLLM_ENABLED=1 \
  -v /absolute/workspace:/workspace YOUR_REGISTRY/observer:datathon
```

Код `ml` уже подключён. UI собирается из исходников этапом `frontend-build`
на `node:24.19.0-bookworm-slim`: `npm ci` по lock-файлу и production `npm run build`.
Результат копируется в обе цели (`stub` и `gpu`), Node в runtime не требуется.
Локальные `frontend/dist`, `node_modules` и кеш TypeScript исключены из контекста.
Перед запуском GPU-образа подготовьте веса (раздел ниже).
Для проверки инфраструктуры используйте `ANALYZER=ml.stub:analyze`.
`start.sh` требует `API_KEY`, запускает vLLM на `127.0.0.1:8001`, ждёт `/health`,
затем запускает один uvicorn на 8000. Порт 8001 не публикуется.
При выходе API или vLLM завершается контейнер; Docker restart policy поднимает его снова.
Журналы отдельных задач: `/workspace/data/logs/<job_id>.log`.

## Подготовка весов и офлайн-запуск

На машине с сетью загрузите выбранные ML-командой веса в `/workspace/models/qwen`.
Сохраните точную ревизию и LICENSE вместе с весами. Запуск использует локальный
`MODEL_PATH`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, телеметрия отключена.
На старте скачивания нет; отсутствующий `config.json` приводит к явной ошибке.

Модель — `QuantTrio/Qwen3-VL-30B-A3B-Instruct-AWQ` (Apache-2.0), ревизия
`a5ea10732e2c9330957864ece3ec66d806a4b00d`, GPU 48 ГБ (стенд — NVIDIA L40).
`start.sh` выставляет `VLM_MODEL`, публикует локальные веса под этим же именем через
`--served-model-name` и задаёт флаги стенда: `--max-model-len 32768`, `--max-num-seqs 48`,
`--limit-mm-per-prompt '{"image": 8, "video": 1}'`, `--gpu-memory-utilization 0.90`.
ML получает `VLM_BASE_URL=http://localhost:8001/v1`. Автоматического скачивания или переключения модели нет.

Команда запуска для среды с уже подготовленным HF-кешем:

```bash
vllm serve QuantTrio/Qwen3-VL-30B-A3B-Instruct-AWQ --host 127.0.0.1 --port 8001 \
  --max-model-len 32768 --max-num-seqs 48 --limit-mm-per-prompt '{"image": 8, "video": 1}'
```

В контейнере вместо HF-id запускается `MODEL_PATH`, чтобы сохранить офлайн-режим.

Проверка CPU-заглушки без внешней сети:

```bash
export IMAGE=observer:stub
export VIDEO_DIR=/absolute/path/to/videos
export VIDEO_FILE=sample.mov
export VIDEO_SOURCE=dataset  # synthetic для сгенерированного видео
export WORKSPACE_DIR=/absolute/path/to/offline-workspace
export VLLM_ENABLED=0
bash deploy/offline-check.sh
```

Образ нужно предварительно собрать с сетью (`docker build --target stub -t observer:stub .`).
Офлайн-проверка использует только уже имеющийся образ (`--pull never`). `API_KEY`
должен быть задан в окружении; его значение не передаётся аргументом командной строки.
Для каждого прогона лучше использовать отдельный пустой WORKSPACE_DIR.

Из PowerShell с установленным Git Bash:

```powershell
$env:API_KEY = python -c 'import secrets; print(secrets.token_urlsafe(32))'
$env:IMAGE = 'observer:stub'
$env:VIDEO_DIR = 'C:/absolute/path/to/videos'
$env:VIDEO_FILE = 'sample.mov'
$env:VIDEO_SOURCE = 'dataset'
$env:WORKSPACE_DIR = "$($PWD.Path.Replace('\', '/'))/test-results/docker-offline"
$env:VLLM_ENABLED = '0'
$env:MSYS_NO_PATHCONV = '1'
& 'C:/Program Files/Git/bin/bash.exe' deploy/offline-check.sh
```

MSYS_NO_PATHCONV предотвращает подмену путей `/workspace` и `/videos` Git Bash.
В репозитории окончания строк `*.sh` зафиксированы как LF.

Проверка реального образа: задать `IMAGE`, `VLLM_ENABLED=1`,
`ANALYZER=ml:analyze`, `REQUIRE_REAL=1`; подготовить веса в workspace.
Скрипт использует `--network none`, не публикует порты и запускает HTTP-клиент
внутри контейнера. Проверяются отсутствие внешнего сетевого интерфейса и отказ
внешнего TCP-соединения, зависимости, точное соответствие всех упакованных файлов UI
их HTTP-ответам (включая JS/CSS/шрифты), полная HTTP-приёмка одного видео, шесть
одновременных загрузок того же видео и сохранение результатов после рестарта.
Шесть повторов одного файла проверяют очередь; это не оценка качества на шести разных видео.
Результаты, image ID и журнал сохраняются в `WORKSPACE_DIR/offline-results`:
`network.json`, `acceptance.json`, `summary.json`, `restart.json`, `image-id.txt`,
`pip-check.txt`, `frontend.json`, `container.log`. Журнал сохраняется и при ошибке проверки.
Проверка статики требует собранного React UI; служебная страница API её не проходит.
Она не заменяет браузерную проверку загрузки, карточек и воспроизведения видео.
Нагрузочный скрипт также сохраняет JSON с кадрами: эти локальные файлы не публиковать.
Тестовый контейнер удаляется после завершения; образ и workspace с результатами сохраняются.
Успех со stub не является подтверждением работы реального ML без сети.
Изоляция блокирует внешний трафик; журнал надо проверить также на попытки сетевых обращений.

17.10.2026 проверен локальный образ `observer:stub-offline-check` на Docker Desktop
4.43.1 / Engine 28.3.0, Linux amd64: Python 3.12.15, FFmpeg 7.1.5, `pip check` без
конфликтов. Сетевая изоляция, HTTP-приёмка, шесть загрузок и рестарт прошли.
Локальный image ID: `sha256:06cd2c1bd2764078eeb904c9fa999657a913b0d50dada5226edea8c1f0d3199f`.
Образ не публиковался в registry.

Для переноса готового образа на хост без интернета можно выполнить `docker save`
на машине сборки и `docker load` на целевой машине. Сборка зависимостей требует
сети либо заранее подготовленного локального кеша; подтверждён именно офлайн-запуск
готового образа. Для GPU-варианта отдельно переносятся все выбранные веса.

## Локальная браузерная проверка без сети

Для UI используйте тот же готовый CPU-образ и отдельный контейнер без портов:

```bash
# API_KEY должен быть задан в окружении; значение в команду не подставлять.
docker run --pull never -d --name observer-offline-ui --network none \
  -e API_KEY -v observer-offline-ui:/workspace observer:stub
python deploy/offline-browser.py --container observer-offline-ui --port 8087
```

Команды работают и из PowerShell (команду docker run записать одной строкой).
Откройте `http://127.0.0.1:8087` (ключ в UI не нужен), загрузите MOV,
проверьте карточки/JPEG, play/pause, перемотку и обновление доступа к видео.
Мост требует Docker CLI на хосте, проверяет `NetworkMode=none` и передаёт HTTP
через `docker exec` на loopback контейнера. Файлы и ответы не подменяются.
Мост добавляет CSP: скрипты, стили, шрифты, media и API разрешены только с того же
origin, JPEG разрешены также через data URL. Кеширование отключено. Это тестовый
инструмент, не production-прокси; его накладные расходы не использовать для SLA.
Он слушает только 127.0.0.1 и не сохраняет ключи/cookie/тела запросов в журналы.

После проверки остановите мост Ctrl+C и удалите тестовый контейнер:
`docker rm -f observer-offline-ui`. Данные остаются в одноимённом volume.
Отдельно проверяйте публичный HTTPS и Safari: локальный мост их не подтверждает.

## RunPod (боевой стенд)

Стенд: RunPod, 1× NVIDIA L40 48 ГБ, persistent volume в `/workspace`. Docker-образ там не используется:
`deploy/pod/start_all.sh` ставит vLLM 0.11.0 и зависимости API в отдельные venv и запускает оба процесса в tmux.

1. Скопировать репозиторий в `/workspace/app`, собрать фронт (`npm --prefix frontend ci && npm --prefix frontend run build`).
2. Загрузить веса `QuantTrio/Qwen3-VL-30B-A3B-Instruct-AWQ` (ревизия `a5ea10732e2c9330957864ece3ec66d806a4b00d`)
   в HF-кэш `/workspace/hf` на машине с сетью.
3. Создать `/workspace/api.env` по образцу [pod/api.env.example](pod/api.env.example) и задать свой `API_KEY`.
4. `cp deploy/pod/start_all.sh /workspace/ && bash /workspace/start_all.sh`. Скрипт идемпотентен:
   после остановки пода он восстанавливает окружение и пропускает то, что уже запущено.
   Чтобы сервис поднимался при старте пода, добавьте этот вызов в `/pre_start.sh`.
5. Наружу открыть только HTTP-порт **8000** (`https://<pod-id>-8000.proxy.runpod.net`); vLLM слушает `127.0.0.1:8011`.
6. Проверить `/health`, затем `python -m deploy.acceptance --url <URL> --require-real sample.mov`
   и `deploy/loadtest.py --url <URL>` с внешней машины.

Протокол async POST + короткий polling избегает долгого ответа анализатора через
прокси. При этом лимит/скорость самой загрузки 200 МиБ нужно проверить на выбранном
HTTP-прокси отдельно; локальная поддержка этого размера не гарантирует настройки провайдера.

## Контроль перед сдачей

- `/health`: `mode=pipeline`, доступен GPU, `vllm.ready=true`, достаточно места.
- Реальный фронт включён в образ, UI работает без CDN.
- Шесть разных видео завершаются менее чем за 300 секунд с учётом загрузки и очереди.
- Проверка offline проведена на том же образе и весах, что будут сданы.
- Версия модели, ревизия весов, лицензии и нормативы подтверждены ML-командой.
- URL и секретный ключ переданы жюри; ключ не помещён в публичный Git.

Перед нагрузкой проверить один исходный MOV:

```bash
python -m deploy.acceptance --url https://YOUR_HOST --source dataset --require-real sample.mov
```

Сохранить отчёт, commit SHA, digest образа, ревизию весов и версии браузеров в
протоколе приёмки. Для запуска заглушки убрать только `--require-real`.
HTTP-успех не заменяет проверку Safari, F2/F3 и качества детектора.

Справка: [Docker в vLLM](https://docs.vllm.ai/en/stable/deployment/docker/),
[RunPod HTTP proxy](https://docs.runpod.io/pods/configuration/expose-ports).
