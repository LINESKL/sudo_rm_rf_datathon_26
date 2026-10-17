# eval — как быстро гонять варианты

```bash
# 1) один раз прогнать с моделью и сохранить ответы VLM в кэш (на поде, GPU):
/workspace/run_eval.sh dev1          # или вручную:
python -m eval.run_eval --videos V --labels L --out runs/dev1 --set dev --jobs 3 --cache /workspace/vlmcache

# 2) правки правил/порогов/длительностей — перепроверка за секунды, без GPU:
python -m eval.run_eval --videos V --labels L --out runs/dev1b --set dev --cache /workspace/vlmcache --offline
```

- `--set dev` — 12 роликов из `eval/sets/dev.txt` (пары «нарушение / чистый двойник»). Все 40 — без `--set`.
- `--jobs N` — N роликов параллельно.
- `--cache DIR` — ответы VLM на диске (ключ: модель + промпт + схема + кадры). Новый промпт или модель → новые ключи, старые не мешают.
- `--offline` — только кэш: промах = «VLM недоступна». Для правил, которые не меняют запросы к модели.
