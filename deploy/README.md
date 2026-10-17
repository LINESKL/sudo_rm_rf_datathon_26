# Развёртывание CashGuard

## Образы и версии

`Dockerfile` имеет цели `stub` (CPU) и `gpu` (по умолчанию).
GPU-основа: `vllm/vllm-openai:v0.31.0-cu129`, зафиксированная по
[официальному релизу vLLM](https://github.com/vllm-project/vllm/releases/tag/v0.31.0).
Это исходная конфигурация для проверки на GPU, а не результат замера совместимости.
Версию можно переопределить `--build-arg VLLM_IMAGE=...` после ML-спайка.
Драйвер хоста должен поддерживать CUDA выбранного образа.

Зависимости API устанавливаются в отдельное окружение `/opt/backend`,
чтобы не менять зависимости сервера vLLM. Оно видит системные torch/ML-пакеты;
Если после интеграции ветки `ml` есть `requirements-ml.txt`, Dockerfile устанавливает
его в backend-окружение с ограничениями версий API из `requirements.txt`.

```bash
docker build --target gpu -t YOUR_REGISTRY/cashguard:datathon .
docker push YOUR_REGISTRY/cashguard:datathon
docker run -d --name cashguard --restart unless-stopped --gpus all \
  --shm-size 8g -p 8000:8000 -e API_KEY \
  -e ANALYZER=ml:analyze -e VLLM_ENABLED=1 \
  -v /absolute/workspace:/workspace YOUR_REGISTRY/cashguard:datathon
```

Сначала интегрируйте ветку `ml` вместе с её `requirements-ml.txt`
и добавьте сборку `frontend/dist`.
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

По решению команды модель по умолчанию — `Qwen/Qwen3-VL-8B-Instruct` (Apache-2.0),
запасная — `Qwen/Qwen3-VL-4B-Instruct`; окончательный выбор после Kaggle-спайка.
Цель — 24 ГБ VRAM. `start.sh` выставляет `VLM_MODEL`, публикует локальные веса
под этим же именем через `--served-model-name`, задаёт `--max-model-len 8192`
и `--limit-mm-per-prompt '{"image": 6}'`. ML получает
`VLM_BASE_URL=http://localhost:8001/v1`. При переключении на 4B смените и имя,
и каталог весов; автоматического скачивания или переключения модели нет.
Параметры `GPU_MEMORY_UTILIZATION=0.80` и `MAX_NUM_SEQS=8` требуют замера на выбранном GPU.

Команда запуска для среды с уже подготовленным HF-кешем:

```bash
vllm serve Qwen/Qwen3-VL-8B-Instruct --host 127.0.0.1 --port 8001 \
  --max-model-len 8192 --limit-mm-per-prompt '{"image": 6}'
```

В контейнере вместо HF-id запускается `MODEL_PATH`, чтобы сохранить офлайн-режим.

Проверка CPU-заглушки без внешней сети:

```bash
export IMAGE=cashguard:stub
export VIDEO_DIR=/absolute/path/to/videos  # внутри должен быть sample.mp4
export WORKSPACE_DIR=/absolute/path/to/offline-workspace
export VLLM_ENABLED=0
bash deploy/offline-check.sh
```

Проверка реального образа: задать `IMAGE`, `VLLM_ENABLED=1`,
`ANALYZER=ml:analyze`, `REQUIRE_REAL=1`; подготовить веса в workspace.
Скрипт использует `--network none` и запускает HTTP-клиент внутри контейнера.
Результаты и журнал сохраняются в `WORKSPACE_DIR/offline-results`.
Успех со stub не является подтверждением работы реального ML без сети.
Изоляция блокирует внешний трафик; журнал надо проверить также на попытки сетевых обращений.

## RunPod и восстановление

Под пока не арендовать. До появления пода работа ведётся со своей заглушкой.
Целевой вариант по указанию команды — RunPod Community RTX 3090 / 4090 с 24 ГБ VRAM,
ориентир бюджета $0,30/ч (не подтверждённая котировка), оплата через капитана.
Цель доступности заглушки снаружи — к 18.10.2026 00:00 (Asia/Qyzylorda).
Инструкция ниже предназначена для согласованного запуска; публичный под ещё не развёрнут.

1. Заранее загрузить образ в доступный поду registry, веса и данные — на persistent volume.
2. После согласования оплаты создать Community Pod с RTX 3090 или RTX 4090 (24 ГБ), подключить persistent storage в `/workspace`,
   выбрать подготовленный образ. В команде контейнера использовать `/app/deploy/start.sh`,
   если шаблон RunPod переопределяет ENTRYPOINT.
3. Для первой внешней проверки заглушки использовать цель `stub`, `VLLM_ENABLED=0`,
   `ANALYZER=ml.stub:analyze`. Для реального ML — цель `gpu`, `VLLM_ENABLED=1`,
   `ANALYZER=ml:analyze`, `MODEL_PATH`, `VLM_MODEL`. В обоих случаях установить `API_KEY`.
   HTTP-порт: **8000**; 8001 наружу не открывать.
4. В Connect взять HTTPS-ссылку на 8000. Обычно она имеет вид
   `https://<pod-id>-8000.proxy.runpod.net`; фактический адрес берётся из панели.
   Задать `MEDIA_COOKIE_SECURE=1`: доступ к превью выдаётся cookie из `/details`.
   UI и API должны быть на одном origin; схема для разработки описана в
   [интеграционном контракте](../docs/frontend/backend-integration.md).
5. Проверить `/health`, затем запустить `deploy/loadtest.py --url <URL>` с внешней машины.
   После подключения ML повторить с `--require-real` и шестью разными роликами.
6. Перезапустить под и проверить сохранённый `done` и восстановление `processing`.

Для замены хоста повторить шаги 2–5 с тем же образом, volume и окружением.
На поде не требуется сборка или установка пакетов: entrypoint выполняет запуск сам.
Цель ≤15 минут зависит от размера образа, наличия GPU и загрузки весов; до замера
это не подтверждённое время восстановления. Для публичного URL после смены pod ID
нужно обновить данные сдачи.

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
