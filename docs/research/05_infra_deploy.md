# 05. Инфраструктура и деплой (GPU-хостинг, serving, backend, Docker, фронт)

Дата исследования: 2026-10-17. Дедлайн: 2026-10-18 12:00 (Алматы). Команда: 3 человека.

Легенда достоверности: **[В]** - число/факт проверен по первичному источнику или явно подтверждён в нескольких; **[О]** - оценка автора (расчёт или опыт), требует замера; **[Н]** - не удалось проверить, нужно уточнить вручную.

---

## 0. TL;DR - рекомендуемый сетап

| Что | Решение |
|---|---|
| Хостинг | **RunPod Pod (не serverless), Secure Cloud, 1x RTX 4090 24 GB ($0.89/ч) или L40S 48 GB ($1.09/ч)**, + Network Volume 50 GB. Публичный HTTPS из коробки: `https://<pod_id>-8000.proxy.runpod.net` |
| Запасной | Lambda (A100, VM + Docker, ~$1.3-1.5/ч) или Vast.ai verified-хост + `cloudflared`. Третий вариант: домашний GPU + Cloudflare Tunnel |
| Serving VLM | **vLLM** (OpenAI-совместимый сервер, continuous batching), версия запинена, модель `Qwen/Qwen2.5-VL-7B-Instruct` из локальной папки |
| Детектор | В процессе бэкенда (тот же контейнер), YOLO на GPU, `~1-2 GB` VRAM; vLLM получает `--gpu-memory-utilization 0.85` |
| Backend | FastAPI + **in-process asyncio-воркеры (до 3 заданий параллельно)** + SQLite (WAL) для персистентности. Без Redis/Celery |
| Декод | `ffmpeg` CLI (subprocess, фильтр `fps=3`), не decord |
| Контейнер | **Один all-in-one образ** (vLLM + backend + веса + статика фронта), т.к. на RunPod/Vast нельзя запустить docker-compose внутри пода. Для банка - тот же образ, compose с одним сервисом |
| Фронт | Plain HTML + vanilla JS, 0 сборки, 0 CDN (оффлайн!). React/Vite только если фронтендер быстрее на нём, но тогда `dist/` кладётся в образ |
| Главный риск | **Пропускная способность**: каждое задание должно уложиться в 5 минут, включая время ожидания в очереди. Нужны параллельные задания + дедлайн-aware пайплайн с частичным результатом вместо `failed` |

Бюджет на 2 недели 24/7 [О, расчёт по ценам ниже]: 4090 Secure $0.89 x 336 ч = **~$299**; L40S Secure $1.09 x 336 ч = **~$366**; 4090 Community $0.34 x 336 = **~$114** (дёшево, но менее надёжно). Плюс volume ~$3.5/мес за 50 GB.

---

## 1. Где поднять GPU

### 1.1 Сводная таблица

Цены на 2026-10 по агрегаторам и официальным страницам; везде проверьте живую цену перед оплатой.

| Провайдер | GPU / цена | Публичный HTTPS | Персистентность | Надёжность | Вердикт |
|---|---|---|---|---|---|
| **RunPod Pods** | 4090: $0.34 Community / $0.89 Secure; L40S: $0.79 / $1.09; A100 PCIe 80GB: $1.19 / $1.79; A100 SXM: $1.39 / $1.79 [В: официальная страница] | Да, бесплатно: `https://<pod_id>-<port>.proxy.runpod.net`, но Cloudflare-таймаут **100 с** на первый байт ответа (ошибка 524) | Network Volume $0.07/ГБ/мес (<1 ТБ), $0.14 high-perf [В]. Диск пода живёт, пока под существует | Secure Cloud - дата-центры Tier 3/4; Community - хосты разного качества | **Основной выбор** |
| RunPod Serverless | Те же GPU, посекундно | Да | Через volume | Cold start: загрузка 15 ГБ весов + vLLM 1-3 мин [О] | Не брать: cold start бьёт по 5-минутному лимиту, оффлайн-образ 25+ ГБ |
| **Vast.ai** | 4090 от $0.14-0.50/ч в зависимости от тира (interruptible - самый дешёвый, может быть вытеснен) [В: расхождение между обзорами] | Нет "из коробки": общий IP, внешние порты случайные (`VAST_TCP_PORT_X`), нужен `cloudflared`/ngrok-туннель | Диск инстанса, привязан к хосту | Зависит от хоста; брать только verified/datacenter | Запасной вариант (дёшево) |
| **Lambda** | A100 ~$1.29-1.48/ч, H100 PCIe $2.86-3.29/ч (обзоры, не официальная страница) [В/О] | Нет: VM с публичным IP, HTTPS руками (Caddy + домен или cloudflared) | Persistent filesystem | Хорошая, но часто нет свободных инстансов | Запасной №2 |
| **Hetzner GPU** | GEX44 (RTX 4000 SFF Ada 20 GB) снят, замена GEX45 EUR 214/мес + setup EUR 209; GEX131 (RTX PRO 6000 96 GB) EUR 889-1197/мес + setup EUR 599 [В/О: источники расходятся] | Статический IP, HTTPS руками | Полная (свой сервер) | Высокая, но выдача/наличие и биллинг помесячно | Не подходит: 20 GB и 280 ГБ/с у RTX 4000 SFF Ada (по спецификации) = в ~3 раза медленнее 4090 на decode; GEX131 дорог для 2 недель |
| **TensorDock** | 4090 от $0.35/ч, A100 SXM от $1.80/ч [В: официальная страница] | VM, HTTPS руками | Диск VM | Маркетплейс хостов, разброс | Вариант, но смысла больше нет, чем у RunPod |
| **Paperspace** | A100 $1.15-3.18/ч (источники расходятся), A100 требует платной подписки Growth [В/Н] | Нет из коробки | Да | Средняя | Пропустить |
| **Modal** | L40S $1.95/ч, A100 80GB $2.50/ч (посекундно) [В: обзоры от июля 2026] | Да, `*.modal.run` | Volumes | Cold start; лимит времени веб-эндпоинта не подтверждён [Н] | Пропустить: serverless-модель не совпадает с оффлайн-поставкой |
| **Yandex Cloud / PS Cloud / QazCloud (КЗ)** | Не нашёл ни одной проверяемой цены на GPU в тенге/рублях [Н] | - | - | - | Для хакатона не рассматривать: договор/оплата/квоты на GPU обычно занимают дни. Если у команды уже есть аккаунт - узнайте квоту на A100/L4 |

Источники:
- RunPod, цены: https://www.runpod.io/gpu-cloud/pricing (официальная; Community/Secure из structured data страницы)
- RunPod proxy и порты, лимит 100 с: https://docs.runpod.io/pods/configuration/expose-ports , https://www.runpod.io/blog/runpod-proxy-guide
- Обзор RunPod vs Vast.ai: https://www.spheron.network/blog/runpod-vs-vastai-2026/ ; Vast цены: https://costbench.com/software/ai-gpu-cloud/vast-ai/ , https://www.hostinger.com/tutorials/?p=158956
- Vast.ai сеть и порты: https://docs.vast.ai/documentation/instances/connect/networking
- Lambda: https://deploybase.ai/articles/lambda-labs-gpu-pricing , https://www.spheron.network/blog/lambda-cloud-h100-pricing-2026/
- Hetzner: https://wz-it.com/en/blog/hetzner-gpu-server-comparison/ , https://pasqualepillitteri.it/en/news/17339/contabo-launches-gpu-vps-999-euros-hetzner-gex131
- TensorDock: https://tensordock.com/cloud-gpus.html
- Paperspace: https://www.spheron.network/blog/paperspace-pricing-2026/
- Modal: https://www.spheron.network/blog/modal-gpu-pricing-2026-per-second-billing/

### 1.2 Почему RunPod Pod

1. **Публичный HTTPS без домена и без настройки.** Порт 8000 пода отдаётся по `https://<pod_id>-8000.proxy.runpod.net`. Судьям отдаётся один URL. URL стабилен, пока под не пересоздан (при stop/resume pod id сохраняется - проверьте на своём поде, если планируете останавливать). Прокси не имеет своей аутентификации, поэтому X-API-Key обязателен (и он у нас есть).
2. **100-секундный лимит прокси не мешает**, потому что API асинхронный: `POST` возвращает `job_id` за < 1 с (29 МБ грузятся за секунды), результат берётся поллингом. Нельзя делать синхронный `/analyze` на 2 минуты.
3. **Лимит тела запроса:** Cloudflare Free - 100 МБ (источник: https://developers.cloudflare.com/workers/about/limits , для Tunnel подтверждение только из стороннего блога, https://localtonet.com/blog/cloudflare-tunnel-alternative). 29 МБ укладывается с большим запасом.
4. **Секьюр vs Community.** Для судейского окна берите **Secure Cloud** (вдвое-втрое дороже, но реже "пропадает" хост). Community хорош для разработки сегодня ночью. Разница на 2 недели ~$185 - это страховка.
5. **GPU:** RTX 4090 (24 GB, 1008 ГБ/с) быстрее A100 по decode на 7B за меньшие деньги, но 24 GB - в притык (см. §5). **L40S 48 GB (864 ГБ/с)** даёт запас по VRAM и можно держать BF16 + 2 детектора без нервов; по скорости decode чуть медленнее 4090. Если ML-часть хочет Qwen2.5-VL с большим числом кадров на запрос или bf16 + 32k контекст - L40S. По умолчанию: **4090 Secure**, при нехватке VRAM - L40S.

### 1.3 Ограничения RunPod, которые надо знать заранее

- **Внутри пода нет Docker daemon** -> `docker compose` внутри пода не запустить. Отсюда all-in-one образ (§4).
- Образ тянется с Docker Hub/GHCR: образ ~25-30 ГБ тянется на свежий хост 5-15 мин [О]. Не останавливайте и не пересоздавайте под в окне судейства без необходимости. Если под остановлен, GPU при resume может быть занят (тогда под застрянет без GPU) [О, известная особенность RunPod].
- Пушьте образ в **публичный** репозиторий (веса открытые) либо в приватный с registry credentials. Push 25+ ГБ с домашней сети может занять часы: **собирайте образ на самом GPU-поде/сервере** или в GitHub Actions (на раннере 14 ГБ диска образ не соберётся - нужен `jlumbroso/free-disk-space` либо сборка на подe). Быстрее всего: слой с весами отдельно, а на RunPod - Network Volume с весами (см. §4.3).

### 1.4 Дешёвый запасной вариант: CPU VPS + домашний GPU

Схема: на домашней машине (RTX 3090/4090) контейнер + `cloudflared tunnel` -> публичный HTTPS. **CPU VPS не нужен**: туннель сам даёт публичный URL, VPS только добавит хоп.

| Плюсы | Минусы |
|---|---|
| $0 за GPU, веса уже на диске | Домашний канал: upload-скорость маленькая (ответ с base64-кадрами 1-3 МБ x несколько судей), нестабильный провайдер |
| Именованный туннель Cloudflare бесплатен, URL стабильный, но нужен домен в Cloudflare. Quick Tunnel (`trycloudflare.com`) меняет URL при перезапуске и без гарантий | Электричество, сон, обновления ОС, кот на кабеле. Нет дежурного 24/7 в окне судейства неделями |
| Полный контроль, быстро отладить | Лимит 100 МБ на тело (хватает) |
| Хорошая "демо-репетиция" оффлайн-режима | Риск репутационный: "сервис лежит", когда судья зашёл |

Рекомендация: домашний GPU - только как hot spare и для разработки, в окне судейства основной - облако.

Дополнительно: у ngrok на free-плане есть интерстициальная страница и лимиты - для API-судей не годится без платного плана [О]; Cloudflare Tunnel предпочтительнее.

---

## 2. Serving stack для Qwen2.5-VL-7B

### 2.1 vLLM vs SGLang vs transformers

| | vLLM | SGLang | transformers (`generate`) |
|---|---|---|---|
| Qwen2.5-VL | Поддержка есть, рецепт: https://recipes.vllm.ai/Qwen/Qwen2.5-VL-7B-Instruct | Есть, https://cookbook.sglang.io/docs/autoregressive/Qwen/Qwen2.5-VL | Нативно, самый предсказуемый |
| Continuous batching | Да | Да (RadixAttention, быстрее на общих префиксах) | Нет (нужно batching руками) |
| Multi-image | `--limit-mm-per-prompt '{"image":N,"video":0}'` (новый JSON-формат) | Да | Да |
| OpenAI API | Да | Да | Нет (свой FastAPI) |
| Старт | 1.5-3 мин (загрузка + torch.compile + CUDA graphs) [О]; `--enforce-eager` ускоряет старт, но замедляет decode | Сопоставимо [О] | 30-60 с, самый быстрый |
| Риск | Версионные дрейфы CLI-флагов (старые доки: `limit_mm_per_prompt={"image":4}` как dict; в рецептах - JSON) - **пиньте версию** | Меньше примеров под VL, меньше готовых ответов на форумах | Медленный decode при 40 вызовах подряд (~160-200 с только VLM [О]) |

Мой выбор: **vLLM** - больше всего документации и готовых решений, ровно то, что нужно на хакатоне. По скорости SGLang может выиграть на текстовых нагрузках (Bench360 на Qwen2.5-7B), но **прямого сравнения для Qwen2.5-VL по мультимодальной нагрузке я не нашёл** (https://arxiv.org/pdf/2511.16682) - не тратьте ночь на A/B. Если vLLM упрётся в баг с VL, SGLang - план Б; transformers - план В (проще всего, но нужна очередь на один вызов за раз).

Интересный нюанс из рецепта vLLM: для моделей такого размера на одном узле рекомендуют **data parallel вместо tensor parallel**; у нас одна карта, так что TP=1.

### 2.2 Рекомендуемые флаги (4090 24 GB)

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct \
  --served-model-name qwen-vl \
  --host 127.0.0.1 --port 8001 \
  --dtype bfloat16 \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.85 \
  --max-num-seqs 16 \
  --limit-mm-per-prompt '{"image":6,"video":0}' \
  --mm-processor-kwargs '{"min_pixels":200704,"max_pixels":602112}' \
  --no-enable-prefix-caching   # убрать, если системный промпт длинный и одинаковый: prefix caching тогда выгоден
```

- `max_pixels=602112` = 768 visual-токенов на изображение максимум (токен = 28x28 px) [О, формула Qwen2.5-VL]. Для 4 кадров на запрос ~3k токенов контекста - `max-model-len 8192` хватает.
- Кадры лучше **заранее ресайзить** до ~640x360-896x504 в бэкенде и подавать как JPEG data-URL (`data:image/jpeg;base64,...`) - это дешевле по трафику и токенам, чем отдавать FullHD.
- Веса BF16 ~15.5 ГБ, при `0.85` vLLM берёт ~20.4 ГБ -> остаётся ~3.6 ГБ на детектор и CUDA-контексты. Если детектор тяжёлый - `0.80`. Нужно ещё меньше? **AWQ/GPTQ-int4** (`Qwen/Qwen2.5-VL-7B-Instruct-AWQ`, ~5-6 ГБ) освобождает память и ускоряет decode [О], но может просесть по качеству - ML-часть решает по метрике.
- Структурированный вывод: просите JSON через `response_format`/guided decoding (xgrammar) - в рецепте указан `--guided-decoding-backend xgrammar`; названия флагов меняются между версиями, сверьтесь с `vllm serve --help` вашей версии.

### 2.3 Детектор: в том же процессе или отдельно?

**В процессе бэкенда (тот же контейнер, отдельный от vLLM процесс).** Причины: ~1-2 ГБ VRAM, нет сетевого хопа, не нужен второй образ; vLLM - отдельный процесс на 127.0.0.1:8001, потому что он сам крутит event loop и жрёт всю память под себя.
- Если детектор Ultralytics: лицензия AGPL-3.0 (для хакатона/внутреннего пилота ок, для передачи банку проговорите с юристами; альтернативы - RT-DETR/YOLOX/Apache-лицензированные).
- **Ловушка с зависимостями:** `pip install ultralytics` в образе vLLM может обновить/сломать `torch`. Ставьте с констрейнтами: `pip freeze | grep -E '^(torch|torchvision|numpy)==' > /tmp/c.txt && pip install -c /tmp/c.txt ultralytics`.
- Оффлайн-ловушка: Ultralytics пытается скачать шрифт (Arial.ttf) и делает проверки сети - положите веса `.pt` в образ, не рисуйте через их `plot()`, в настройках отключите sync (`yolo settings sync=False`).
- Загрузка модели - один раз при старте приложения; `half=True`; батчи по 16-32 кадра.

---

## 3. Дизайн бэкенда

### 3.1 Очередь: что выбрать

| | In-process asyncio + SQLite | arq + Redis | RQ/Celery + Redis |
|---|---|---|---|
| Доп. сервисы | 0 | Redis | Redis + воркер-процесс |
| Персистентность | SQLite (сами) | Redis AOF | Redis |
| Хватит на 3-10 заданий/день | Да | Да | Избыточно |
| Деплой на RunPod (1 контейнер) | Тривиально | Redis в том же контейнере - лишний процесс | То же |
| Риск | Рестарт приложения убивает текущую работу -> решается requeue при старте | - | - |

**Выбор: in-process asyncio-воркеры + SQLite.** Redis добавляет второй процесс в единственный контейнер ради нагрузки, которой нет. GPU-bound работа идёт в `asyncio.to_thread`/процесс-пуле, HTTP-обработчики остаются отзывчивыми.

Параметры:
- `MAX_PARALLEL_JOBS = 3` (семафор). Почему не 1: VLM-вызовы memory-bound, vLLM батчит их почти бесплатно; декодирование ffmpeg на CPU и ожидание ответов VLM перекрываются. Три параллельных задания **не втрое медленнее** одного. Замерьте и подберите 2-4.
- Глобальный семафор VLM-запросов (напр. 12 в полёте) - чтобы очередь vLLM не росла бесконечно.
- Очередь FIFO; порядок = время `created_at`.

### 3.2 Бюджет 5 минут и поведение при перегрузке (ключевое)

Лимит 5 минут идёт, скорее всего, от `POST` (включая ожидание в очереди). Значит:
1. Время одного задания должно быть **<= ~90-120 с** при пустой очереди (§5), иначе 3-й задание в пачке из трёх уже не успеет.
2. Пайплайн **знает свой дедлайн**: `deadline = created_at + 270 с`. В конце каждой стадии проверяет остаток времени; на стадии VLM при нехватке времени сокращает число вызовов (берёт самые подозрительные кандидаты первыми по score детектора), а при истечении - **возвращает `done` с частичным результатом и пометкой `"degraded": true`**, а не `failed`. `failed` - только при фатальной ошибке (битый файл).
3. Жёсткий `asyncio.wait_for(..., timeout=285)` на задание как предохранитель.
4. Для судейской пачки: если в очереди уже > N заданий, не отвергайте, а принимайте и уменьшайте качество (меньше кадров на запрос) - лучше деградировать, чем провалить.

### 3.3 Персистентность, идемпотентность, лимиты

- **SQLite (WAL)** в `/data/app.db`; таблица `jobs(id, status, stage, progress, created_at, updated_at, file_path, sha256, result_json, error)`. Загруженные видео - `/data/uploads/<job_id>.mov`. `/data` - Docker volume / Network Volume RunPod.
- При старте: `UPDATE jobs SET status='processing', stage='queued' WHERE status='processing'` и положить в очередь заново (файл на диске). Так рестарт приложения не теряет задания.
- **Идемпотентность:** опциональный заголовок `Idempotency-Key`; если нет - дедуп по `sha256(file)+api_key` в окне 10 минут возвращает тот же `job_id`. Судья, ретраящий POST после таймаута, не создаёт дубликат и не занимает GPU дважды.
- **Лимит размера:** 200 МБ на файл (с запасом над 29 МБ); читать multipart потоком на диск (`shutil.copyfileobj` в тред), не в память; 413 при превышении. Проверка расширения/ffprobe: если ffprobe не видит видеопоток - 422.
- **Длина:** принимайте до ~300 с, дольше -> 422 (иначе блокируете весь бюджет).
- **Аутентификация:** `X-API-Key` в `Depends`, `secrets.compare_digest`, ключи из env `API_KEYS=key1,key2` (судейский + командный). `/healthz`, статика и `/docs` - без ключа или с ограничением. Фронт использует тот же ключ: поле ввода + `localStorage` (ключ в публичном JS всё равно не секрет).
- **CORS:** фронт отдаётся с того же origin (FastAPI `StaticFiles`) -> CORS не нужен. Для автоматизированных клиентов из браузера: `CORSMiddleware(allow_origins=["*"], allow_headers=["X-API-Key","Content-Type"])` (ключ в заголовке, куки нет, `*` безопасен).
- **Health:** `GET /healthz` -> `{"status":"ok","vllm":true,"gpu":true,"queue_depth":n}`; внутри проверка `GET http://127.0.0.1:8001/health`. Нужен для Docker `HEALTHCHECK`, для судей ("прогрев") и мониторинга (UptimeRobot на `/healthz`).
- Таймауты: ffmpeg subprocess 60 с; один вызов VLM 40 с с 1 ретраем (при ошибке - пропуск кандидата); весь пайплайн 285 с.
- Прогрев при старте: прогнать 1 синтетический запрос к VLM и 1 кадр через детектор до выставления `ready`, чтобы первый судья не платил за ленивую инициализацию. `/healthz` отдаёт 503 до прогрева.

### 3.4 Декодирование .mov

Рекомендация: **`ffmpeg` CLI как subprocess**.

```bash
ffmpeg -v error -i in.mov -vf "fps=3,scale=1280:-2" -q:v 3 /tmp/job/f_%05d.jpg
# или rawvideo в pipe, если кадры нужны в numpy сразу
```

- Плюсы: автоматически применяет поворот из display matrix (iPhone .mov!), справляется с HEVC/H.264/ProRes, пакетный `fps=` фильтр, никаких питон-зависимостей кроме `apt install ffmpeg`.
- Время кадров: `timestamp = (i + 0.5) / fps` либо `-vf "fps=3,showinfo"`/`-frame_pts`; проще хранить `t = idx / fps`. Для VFR-видео (iPhone пишет переменную частоту) аккуратнее: `-fps_mode cfr` и считать от `fps`.
- **PyAV** - ок, если нужен покадровый контроль в одном процессе (ставит свой ffmpeg в wheel); нужно самому обрабатывать rotation. **decord** - пропустить (слабо поддерживается, сборка с CUDA - боль).
- Аппаратный NVDEC не нужен: на 145 с 1080p хватает CPU (см. бюджет). Убедитесь, что у пода >= 8 vCPU.
- 4K HEVC iPhone: перед детекцией `scale=-2:720..1080`.

### 3.5 Возврат base64 JPEG

- Кадры-свидетельства: ресайз до ширины 640-960, `quality=80` -> 40-90 КБ; base64 +33%. 10 нарушений x 3 кадра = 30 кадров ~ 2-4 МБ ответа - приемлемо, но **добавьте `?include_frames=false`** (по умолчанию `true`) для фронта-поллера, чтобы статус-запросы были лёгкими; финальный запрос за результатом - с кадрами.
- Рисуйте bbox на кадре, если это часть "доказательства" - решает ML-часть, но в `image_base64` кладите чистый JPEG без `data:` префикса (спека говорит "image_base64 JPEG"; префикс фронт добавляет сам).
- Храните результат в БД как JSON-строку, кадры - внутри (простота важнее нормализации).

### 3.6 Раздача фронта

`app.mount("/", StaticFiles(directory="/app/static", html=True), name="ui")` - **после** подключения роутеров `/api/*` и `/healthz`. Один порт 8000 наружу, один URL для судей и для UI.

### 3.7 Контракт API (pydantic v2)

```python
# app/schemas.py
from enum import Enum
from typing import Literal
from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    processing = "processing"   # включает очередь; детали - в stage
    done = "done"
    failed = "failed"


class Stage(str, Enum):
    queued = "queued"
    decoding = "decoding"
    detecting = "detecting"
    vlm = "vlm"
    finalizing = "finalizing"


class EvidenceFrame(BaseModel):
    timestamp_sec: float = Field(ge=0)
    image_base64: str = Field(description="JPEG, base64 без префикса data:")


class Violation(BaseModel):
    type: str                                   # код нарушения из справочника ML-части
    timecode_sec: float = Field(ge=0)
    description: str                            # человекочитаемо
    evidence_frames: list[EvidenceFrame] = []
    # расширения (необязательные, судьи их могут игнорировать):
    normative_reference: str | None = None      # напр. "СНиП ..., п. ..."
    confidence: float | None = Field(default=None, ge=0, le=1)


class AnalysisResult(BaseModel):
    verdict: str                                # значения согласовать с ТЗ хакатона
    violations: list[Violation] = []
    degraded: bool = False                      # True = не хватило времени, результат частичный
    processing_time_sec: float | None = None


class AnalyzeResponse(BaseModel):
    job_id: str


class JobResponse(BaseModel):
    job_id: str
    status: JobStatus
    stage: Stage | None = None                  # только пока processing
    progress: float | None = Field(default=None, ge=0, le=1)
    queue_position: int | None = None
    result: AnalysisResult | None = None        # только при done
    error: str | None = None                    # только при failed


class Health(BaseModel):
    status: Literal["ok", "starting", "degraded"]
    vllm: bool
    gpu: bool
    queue_depth: int
```

Эндпоинты:
- `POST /api/v1/analyze` (multipart, поле `file`, заголовок `X-API-Key`, опц. `Idempotency-Key`) -> `202 AnalyzeResponse`.
- `GET /api/v1/jobs/{job_id}?include_frames=true` -> `JobResponse`; `404` для неизвестного id, `401` без ключа.
- `GET /healthz` -> `Health`.

Сверьте имена полей и допустимые значения `verdict`/`type` с официальным ТЗ хакатона: они должны совпасть буквально.

### 3.8 Скелет воркеров (минимум кода)

```python
# app/main.py (эскиз)
import asyncio, hashlib, secrets, sqlite3, uuid, time, shutil
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, Header, HTTPException, Depends
from fastapi.staticfiles import StaticFiles

JOB_SEM = asyncio.Semaphore(3)          # ponytail: константа; поднять/опустить после замера
queue: asyncio.Queue[str] = asyncio.Queue()

def require_key(x_api_key: str = Header(...)):
    if not any(secrets.compare_digest(x_api_key, k) for k in API_KEYS):
        raise HTTPException(401)

async def worker():
    while True:
        job_id = await queue.get()
        async with JOB_SEM:
            await run_job(job_id)        # внутри: deadline-aware pipeline, пишет stage/progress в SQLite
        queue.task_done()

@asynccontextmanager
async def lifespan(app):
    init_db()
    for job_id in db_pending_ids():      # requeue после рестарта
        queue.put_nowait(job_id)
    tasks = [asyncio.create_task(worker()) for _ in range(3)]
    await warmup()
    yield
    for t in tasks: t.cancel()

app = FastAPI(lifespan=lifespan)

@app.post("/api/v1/analyze", status_code=202, dependencies=[Depends(require_key)])
async def analyze(file: UploadFile = File(...), idempotency_key: str | None = Header(None)):
    ...  # поток на диск, sha256, ffprobe-проверка, дедуп, INSERT, queue.put_nowait
    return {"job_id": job_id}

# роутеры /api/v1/jobs/{id}, /healthz - выше; статика - в самом конце:
app.mount("/", StaticFiles(directory="/app/static", html=True))
```

Почему 3 воркера + семафор, а не 1: если один воркер упал на исключении, остальные продолжают; семафор - ограничитель при расширении числа воркеров.

---

## 4. Docker и оффлайн-режим

### 4.1 Принципы

- Веса запекаются в образ на этапе `build` (интернет нужен только тогда). В рантайме: `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`, `VLLM_NO_USAGE_STATS=1`, `DO_NOT_TRACK=1`, и **vLLM запускается по локальному пути** `/models/Qwen2.5-VL-7B-Instruct`, а не по HF-id - исключает любые обращения к хабу.
- Проверка оффлайна обязательна (и это отличная демонстрация для банка): `docker run --network none ...` или `docker network create --internal`. Любой скрытый `requests.get` (шрифты Ultralytics, tiktoken, nltk...) выстрелит именно тут. Сделайте это **до** деплоя.
- Размер: базовый образ `vllm/vllm-openai` ~10-15 ГБ [О] + веса 7B BF16 ~16 ГБ + детектор ~0.1 ГБ + python-пакеты -> **~28-32 ГБ несжато** [О]. Docker Hub принимает такие слои, но push/pull долгие. Слой с весами пишите отдельным `COPY`, чтобы пересборка кода не перезаливала 16 ГБ.
- Мультистейдж: стадия `weights` (`python:3.11-slim` + `huggingface_hub`, скачивает и всё) -> `COPY --from=weights /models /models`. Кэш HF в образ не попадает.

### 4.2 Dockerfile (эскиз)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.11-slim AS weights
RUN pip install --no-cache-dir "huggingface_hub[cli]"
ARG HF_TOKEN=""
RUN huggingface-cli download Qwen/Qwen2.5-VL-7B-Instruct \
      --local-dir /models/Qwen2.5-VL-7B-Instruct \
 && rm -rf /models/Qwen2.5-VL-7B-Instruct/.cache
COPY detector/best.pt /models/detector/best.pt     # веса детектора команды

FROM vllm/vllm-openai:vX.Y.Z AS app                 # ПИН: взять ту версию, на которой ML-часть всё проверила
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 VLLM_NO_USAGE_STATS=1 DO_NOT_TRACK=1 \
    PYTHONUNBUFFERED=1 YOLO_CONFIG_DIR=/tmp/yolo
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN pip freeze | grep -E '^(torch|torchvision|numpy)==' > /tmp/c.txt \
 && pip install --no-cache-dir -c /tmp/c.txt -r /tmp/requirements.txt     # fastapi, uvicorn, python-multipart, httpx, ultralytics, pillow, opencv-python-headless

COPY --from=weights /models /models
COPY app /app/app
COPY static /app/static
COPY docker/start.sh /start.sh
EXPOSE 8000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=240s --retries=3 \
  CMD curl -fs http://127.0.0.1:8000/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["/start.sh"]
```

`docker/start.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
vllm serve /models/Qwen2.5-VL-7B-Instruct --served-model-name qwen-vl \
  --host 127.0.0.1 --port 8001 --dtype bfloat16 --max-model-len 8192 \
  --gpu-memory-utilization "${VLLM_GPU_UTIL:-0.85}" --max-num-seqs 16 \
  --limit-mm-per-prompt '{"image":6,"video":0}' \
  --mm-processor-kwargs '{"min_pixels":200704,"max_pixels":602112}' &
VLLM_PID=$!
cd /app
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 &   # ровно 1 воркер: очередь в памяти процесса
APP_PID=$!
wait -n $VLLM_PID $APP_PID      # любой упал -> контейнер падает -> restart policy поднимет
exit $?
```

Бэкенд сам ждёт `GET :8001/health` в `warmup()`, до этого `/healthz` = 503.
`--workers 1` обязателен: несколько uvicorn-воркеров = несколько очередей и гонки по SQLite.

### 4.3 RunPod-специфика

- Создайте Network Volume (50 GB, тот же дата-центр, что и GPU) для `/data` (SQLite + загрузки). Монтируется в `/workspace` по умолчанию - либо смонтируйте в `/data` в настройках пода.
- Template: свой образ, `Expose HTTP Ports: 8000`, Container disk >= образ + 20 ГБ (~60 ГБ), env `API_KEYS=...`.
- **Альтернатива тяжёлому пушу образа:** лёгкий образ без весов (код + vLLM) + веса на Network Volume (`/workspace/models`), скачанные один раз внутри пода с интернетом; запуск `vllm serve /workspace/models/...`. Быстрее для сегодняшней ночи, но для банка нужен полноценный образ с весами - соберите его отдельно после дедлайна/параллельно.
- Не используйте Jupyter/SSH-шаблон как прод: нужен ваш `CMD`.

### 4.4 docker-compose (для банка / Lambda / любого Docker-хоста)

```yaml
# docker-compose.yml
services:
  app:
    image: ghcr.io/<team>/video-audit:1.0     # all-in-one: vLLM + backend + веса + фронт
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      API_KEYS: "${API_KEYS:?set API_KEYS}"
      MAX_PARALLEL_JOBS: "3"
      MAX_UPLOAD_MB: "200"
      VLLM_GPU_UTIL: "0.85"
      HF_HUB_OFFLINE: "1"
      TRANSFORMERS_OFFLINE: "1"
    volumes:
      - appdata:/data
    ipc: host                  # vLLM рекомендует, иначе --shm-size
    # shm_size: "8gb"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "curl", "-fs", "http://127.0.0.1:8000/healthz"]
      interval: 30s
      timeout: 5s
      start_period: 240s
      retries: 3
volumes:
  appdata:
```

Если позже понадобится разделить: сервис `vllm` (образ `vllm/vllm-openai` + тот же `/models`) и сервис `api` (без GPU-стека); но на старте дублирование весов в двух образах не нужно - **ponytail: один образ, добавим второй сервис, когда реально потребуется масштабирование**.

Запуск на новом сервере (для Lambda/банка):
1. NVIDIA драйвер + `nvidia-container-toolkit`: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html , `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.
2. Проверка: `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`.
3. Перенос в закрытый контур: `docker save video-audit:1.0 | zstd -T0 > image.tar.zst` -> `zstd -d | docker load` (~15-20 ГБ после сжатия [О]).
4. Для HTTPS на голом сервере: `caddy` в compose перед `app` (нужен домен), либо `cloudflared`. В закрытой сети банка - их внутренний reverse proxy.

---

## 5. Бюджет времени (145 с, 4090) - оценка, требует замера

Допущения: FullHD H.264, ~30 fps (4350 кадров), детектор на 3 fps = 435 кадров (на 4 fps = 580), YOLO-m/l 640 px на 4090, 40 VLM-вызовов по ~4 кадра (~1000-1500 токенов prompt) с ответом ~150 токенов JSON, BF16, 1-batch decode ~45 ток/с (теоретический максимум по пропускной способности 1008 ГБ/с / 15.5 ГБ ~ 65 ток/с).

| Этап | Один job в одиночку | Комментарий |
|---|---|---|
| Приём файла + ffprobe | 1-2 с | |
| Декод + `fps=3` + ресайз | 8-15 с | CPU-bound; 4K HEVC - до 30 с. Можно перекрыть с детектором, подавая кадры по мере готовности |
| Детектор (435 кадров, батч 16-32) | 5-12 с | ~5-10 мс/кадр на GPU + препроцесс; при 4 fps +30% |
| Отбор кандидатов + постобработка | 1-3 с | |
| VLM 40 вызовов, **последовательно** | ~160 с | 40 x (prefill ~0.3 с + decode 150 ток / 45 = 3.3 с) - **слишком медленно** |
| VLM 40 вызовов, **8-10 параллельно** | **25-45 с** | prefill ~0.4 с x 40 = 16 с (compute-bound) + decode 6000 токенов при агрегированных ~250 ток/с = 24 с |
| Сборка JPEG-свидетельств + запись | 1-3 с | |
| **Итого (job один)** | **~45-80 с** | |
| 3 job одновременно | ~100-150 с каждый | VLM-prefill суммируется (compute-bound), decode амортизируется батчем |
| Холодный старт сервиса | 2-4 мин (+ pull образа 5-15 мин) | поэтому pod держим включённым |

Выводы:
- **Параллельные VLM-вызовы внутри задания - обязательны** (последовательно: ~200 с на задание, 2-е задание в очереди уже провал).
- 3 одновременно пришедших видео должны укладываться в ~2.5 мин [О]; 6 одновременных - уже на грани (очередь). Фоллбек: уменьшать число VLM-вызовов по дедлайну (§3.2).
- Короткие ответы VLM (`max_tokens=200`, строгий JSON) - главный рычаг скорости. Укорочение ответа вдвое ускоряет VLM-этап почти вдвое.
- Если ML-часть решит подавать целые отрезки вместо кадров (video-вход) - токены вырастут кратно; это запрещает `video:0` в флагах - обсудить заранее.
- Контрольный замер сегодня ночью: 3 одновременных `curl` с одним и тем же .mov, снять `/usr/bin/time`, `nvidia-smi dmon`, `vllm` метрики (`/metrics`).

---

## 6. Фронтенд

### 6.1 Что выбрать

| | Plain HTML + vanilla JS | React + Vite |
|---|---|---|
| Время до рабочего UI | 1-2 ч | 2-4 ч (если стек знаком - сравнимо) |
| Сборка в образ | Копируем 2-3 файла | Нужен `npm run build` локально/в CI, `dist/` в образ (Node в рантайм-образ не нужен) |
| Оффлайн | Нативно: нет зависимостей | Всё бандлится, CDN не используем |
| Риск | Спагетти при росте | Больше "движущихся частей" в ночь перед дедлайном |

**Рекомендация: plain HTML + vanilla JS, один `index.html` + `app.js` + `style.css`.** Критично: **никаких CDN** (Tailwind CDN, unpkg, Google Fonts) - сервис обязан работать без интернета. Системные шрифты. Если фронтендер сильнее в React - Vite ок, но только со статической сборкой.

### 6.2 UX-спецификация (минимум)

1. Экран загрузки: drag&drop зона + поле API-ключа (`localStorage`) + кнопка "Анализировать".
2. Прогресс: поллинг `GET /api/v1/jobs/{id}?include_frames=false` каждые 1.5 с; показываем `stage` (русские подписи: очередь / декодирование / детекция / анализ VLM / сборка) и прогресс-бар; "место в очереди N".
3. Видео-плеер: `<video controls src="blob:...">` из `URL.createObjectURL(file)` - **видео с сервера возвращать не нужно**; после перезагрузки страницы плеер недоступен (опционально - кнопка "загрузить файл повторно", либо сервер отдаёт `/api/v1/jobs/{id}/video` с Range).
4. Вердикт: крупный бейдж (OK / нарушения), счётчик нарушений, время обработки, значок "частичный результат", если `degraded`.
5. Карточка нарушения: тип, **кликабельный таймкод** `mm:ss` -> `video.currentTime = t; video.play()`; описание; нормативная ссылка (`normative_reference`); лента кадров-свидетельств (`<img src="data:image/jpeg;base64,...">`), клик увеличивает; у каждого кадра подпись `timestamp_sec` + клик -> seek.
6. Состояния: `failed` с текстом ошибки, 401 (неверный ключ), 413/422 (файл), потеря связи (ретрай поллинга с backoff), повторная отправка.
7. Дополнительно (если успеем): список последних заданий из `localStorage` (`job_id`), чтобы не потерять результат после обновления страницы; ссылка `#job=<id>` для шаринга судьям.

Скелет seek: `video.currentTime = violation.timecode_sec;` и `video.play()`; `loadedmetadata` перед использованием. Для .mov (HEVC/ProRes) браузер Chrome/Firefox может **не проиграть** видео - для превью, возможно, придётся делать серверный H.264-прокси (`ffmpeg -c:v libx264 -preset veryfast`) - проверьте на реальном файле сегодня. Safari играет .mov нативно. Это скрытый риск R9.

---

## 7. Рекомендуемый план на ночь (до 12:00)

| Когда | Кто | Что |
|---|---|---|
| Сейчас (T+0..1 ч) | Backend/deploy | Поднять RunPod Community 4090 для разработки; vLLM + Qwen2.5-VL по `/workspace/models`; проверить публичный URL и 100-с лимит |
| T+0..3 ч | Backend | Скелет FastAPI: schemas, `/analyze`, `/jobs`, SQLite, очередь, заглушечный пайплайн (возвращает фейковые нарушения и 1 кадр) - **чтобы фронт и судейский контракт работали с первой минуты** |
| T+0..3 ч | Фронт | Vanilla UI против заглушки |
| T+1..6 ч | ML | Реальный пайплайн за интерфейсом `analyze(video_path, deadline) -> AnalysisResult` |
| T+6..9 ч | Backend | Dockerfile, сборка образа, тест `--network none`, замер 3 параллельных заданий |
| T+9..11 ч | Все | Перенос на Secure 4090/L40S (или оставить Community до утра и сменить после), смоук-тест с судейского ключа, мониторинг `/healthz` |
| До 12:00 | Все | Заморозка: версия образа не меняется, URL + ключ отправлены организаторам. Hot spare описан в README |

Правило: интерфейс `analyze(...)` фиксируется первым; ML-часть может его менять изнутри сколько угодно.

---

## 8. Список рисков

| # | Риск | Вероятность / влияние | Митигация |
|---|---|---|---|
| R1 | Задание не укладывается в 5 мин из-за очереди при пачке судейских видео | Высокая / Критично | Параллельные задания (3), параллельные VLM-вызовы, дедлайн-aware пайплайн с `degraded`, ограничение `max_tokens`, замер сегодня |
| R2 | VRAM 24 GB не хватает (OOM при 3 параллельных заданиях + детектор) | Средняя / Высокое | `gpu-memory-utilization 0.80-0.85`, `max_pixels` ниже, `max-num-seqs 8`, либо L40S 48 GB / AWQ-модель |
| R3 | Под RunPod пропал / хост Community выключился / нет GPU при resume | Средняя / Критично | Secure Cloud на время судейства, не останавливать под, hot spare (Lambda/Vast с тем же образом), uptime-монитор на `/healthz` с алертом в Telegram |
| R4 | Образ 30 ГБ не пушится/не тянется к утру | Средняя / Высокое | Собирать на GPU-хосте или в CI с free-disk; запасной путь через Network Volume с весами; начать push с вечера |
| R5 | Скрытое сетевое обращение ломает оффлайн-режим (Ultralytics, tokenizers, vLLM usage stats) | Средняя / Высокое (для банка) | Тест `--network none`; env-флаги §4.1; локальные пути моделей |
| R6 | `pip install ultralytics` ломает torch в образе vLLM | Средняя / Среднее | Констрейнты на torch/torchvision/numpy; либо ONNX Runtime/другой детектор |
| R7 | Дрейф версий vLLM: флаги CLI/формат `limit-mm-per-prompt` меняются | Средняя / Среднее | Запинить версию образа и проверить `--help`; SGLang или transformers как План Б |
| R8 | Прокси RunPod 100 с / 524 на долгих запросах | Низкая (у нас async) / Высокое | Никаких синхронных долгих ответов; POST быстрый; поллинг короткими запросами; `include_frames=false` для статуса |
| R9 | Браузер не проигрывает загруженный .mov (HEVC) -> seek не работает у пользователя | Средняя / Среднее | Проверить на реальном файле; серверный H.264-прокси для превью; Safari/Chrome инструкция |
| R10 | Переменный fps (VFR) смещает таймкоды | Средняя / Среднее | `-fps_mode cfr`, тайминги из ffprobe/PTS, проверка на файле организаторов |
| R11 | Рестарт контейнера теряет задания | Средняя / Среднее | SQLite + requeue на старте; volume вне контейнера |
| R12 | Утечка/подбор API-ключа через публичный URL | Низкая / Среднее | Длинный случайный ключ, `compare_digest`, rate-limit по IP (простой счётчик), лимит размера, разные ключи судьям/нам |
| R13 | Лицензии (Ultralytics AGPL-3.0, Qwen2.5-VL Apache-2.0 для 7B - проверить карточку модели) при передаче банку | Низкая / Среднее | Зафиксировать в README; при необходимости заменить детектор |
| R14 | Цены/доступность GPU отличаются от этой таблицы (источники расходятся) | Средняя / Низкое | Сверить на живых страницах до оплаты; взять пул из 2 провайдеров заранее с пополненным балансом |
| R15 | Судьи шлют пачку + повторы POST (ретраи) -> дубли занимают GPU | Средняя / Среднее | Идемпотентность по `Idempotency-Key`/sha256, лимит очереди, быстрый 202 |
| R16 | Нет достоверных данных по КЗ-провайдерам (PS Cloud, QazCloud, Yandex Cloud) | - | Не закладываться; при наличии связей - запросить КП (A100/L40S, срок выдачи, оплата в тенге) как альтернативный хост на следующую неделю |

---

## 9. Что осталось непроверенным

- Точная версия vLLM/SGLang, актуальная на 2026-10, и стабильность Qwen2.5-VL на ней: ML-часть выбирает по факту запуска.
- Цены КЗ-провайдеров (PS Cloud, QazCloud, Yandex Cloud): подтверждённых данных не найдено.
- Лимит тела запроса Cloudflare Tunnel (100 МБ на Free) подтверждён только сторонним источником; для 29 МБ несущественно.
- Все тайминги §5 - расчёты, не замеры; бенчмарк на целевом поде - первый пункт после поднятия окружения.
- Сохранность pod ID при stop/resume на RunPod - проверить на практике.
