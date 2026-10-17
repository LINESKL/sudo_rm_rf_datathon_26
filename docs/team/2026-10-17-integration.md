# Команде: наводим порядок в репо (17.10, ~18:00)

**С этого момента `main` — единственная точка сборки.** Сейчас в нём (`fc628ac`):
- бэк, деплой, Docker, очередь, офлайн-проверки — из `dunan/backend-video-processing` (Bekzat);
- фронт целиком — из `AIrevision/F2-result-evidence` (snownumb): `ResultView`, `useAnalysis`, клиент API;
- ML — из ветки `ml` (Aliar), включая ваши правки в `ml/` (полярность верификатора, таймауты ffmpeg, ленивый импорт, URL норматива в описании) — они приняты.

Дубль экрана результата (`AnalysisResults.tsx`, `timecode.ts` из ветки бэка) удалён — фронт ведёт snownumb.
Python-тесты: 105 зелёных; `test_server.py::test_hard_restart_and_loadtest` падает по таймауту и на исходной ветке бэка (не регрессия слияния) — **Bekzat, глянь**.

## Как работаем дальше

1. Старые ветки `dunan/backend-video-processing`, `AIrevision/F2-result-evidence`, `feat/F1-upload-status` уже в `main` — **не продолжайте в них**. Новая задача = новая ветка от свежего `main`:
   ```bash
   git fetch && git checkout -b feat/<MAIN-N>-<кратко> origin/main
   ```
2. В `main` — только через PR (или merge после зелёных тестов), маленькими порциями. Перед PR: `git merge origin/main`, тесты.
3. **Зоны ответственности — правим только своё:**

   | Зона | Владелец |
   |---|---|
   | `frontend/`, `docs/frontend/` | snownumb |
   | `backend/`, `deploy/`, `Dockerfile`, `requirements*.txt`, `tests/test_api*`, `tests/test_server*` | Bekzat |
   | `ml/`, `eval/`, `tools/kaggle/`, `ml/catalog.yaml`, `tests/test_*` для ML | Aliar |

   Нужна правка в чужой зоне — комментарий в задаче Linear владельцу или короткий PR с его ревью. Не копируйте чужой код к себе в ветку.
4. Контракт `/details` — по `docs/frontend/mock_details*.json`; меняет его только бэк по согласованию с фронтом.

## Открытый вопрос к бэку (Bekzat)

Сейчас любой `degraded=True` от ML превращается в `failed`. Для жюри `failed` = видео не обработано = ноль баллов.
ML ставит `degraded`, если хоть один кадр не распознан VLM — это будет случаться.
**Предлагаю:** `failed` только при исключении или пустом результате; при `degraded=True` отдавать результат как есть (в `/details` флаг для UI). На стороне ML я сделаю `degraded` только при потере >20% кадров. Ок?

## Статус модели

Первый реальный прогон на Kaggle (2×T4, Qwen3-VL-8B) идёт сейчас; до этого чинили окружение vLLM. Метрики пришлю, как будут.
