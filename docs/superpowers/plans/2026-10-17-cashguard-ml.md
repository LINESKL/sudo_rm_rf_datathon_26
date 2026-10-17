# CashGuard ML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пакет `ml/` с функцией `analyze(video_path) -> AnalysisResult`, оценщик `eval/` на 42 роликах и обвязка для прогонов на Kaggle GPU.

**Architecture:** Видео → адаптивная выборка кадров (ffmpeg) → VLM-сенсор отдаёт JSON состояния сцены на каждый кадр (OpenAI-совместимый vLLM) → сглаживание в таймлайн → правила из каталога дают кандидатов → VLM-верификатор отсеивает ложные → кадры-доказательства и описание с нормативом → `AnalysisResult`. Шаблоны процедур и открытый проход — отдельные этапы поверх того же клиента VLM.

**Tech Stack:** Python 3.12, ffmpeg/ffprobe (CLI), Pillow, NumPy, requests, PyYAML, openpyxl, pytest; на GPU — vLLM с `Qwen/Qwen3-VL-8B-Instruct` (запасная `Qwen/Qwen3-VL-4B-Instruct`), kaggle CLI.

**Spec:** `docs/superpowers/specs/2026-10-17-cashguard-design.md`

## Global Constraints

- Всё локально: никаких облачных AI API; VLM только через наш vLLM по `VLM_BASE_URL` (по умолчанию `http://localhost:8001/v1`).
- Модели только с лицензией, разрешающей коммерческое использование (Apache-2.0/MIT). Не использовать Ultralytics, YOLO-World, Qwen2.5-VL-3B, Gemma 3.
- Ответ жюри — строго поля ТЗ: `job_id, status, verdict, violations[type, timecode_sec, description, evidence_frames[timestamp_sec, image_base64]]`. Норматив входит в текст `description`.
- `/details` — по эталону `docs/frontend/mock_details*.json`.
- 1–3 кадра-доказательства на нарушение, JPEG в base64.
- Лимит 5 мин на видео; пайплайн получает `deadline_s` (по умолчанию 240) и при нехватке времени пропускает необязательные этапы, а не падает.
- Нормативы выводятся только из `ml/catalog.yaml` и только с `verified: true`; иначе текст «Норматив не определён, требуется проверка».
- Лица не распознаём; никаких эмбеддингов лиц.
- Датасет не коммитим и не публикуем (`open/` в `.gitignore`).
- Все команды запускаются из корня репозитория `/Users/aliar/WorkSpace/datathon_26`, Python — `.venv/bin/python`.

**Отложено относительно спеки (добавляем, только если оценщик покажет нужду):** детектор D-FINE + трекер, калибровка раскладки по якорям, размытие лиц на кадрах. В v1 их роль выполняет VLM-сенсор по полному кадру.

## Review Focus

- Видео, где кассир отсутствует с первого кадра (Х-32, Х-33): начало ролика — не «уход», правило ухода не должно срабатывать на t=0.
- Видео короче 3 с или с одним кадром: пайплайн отдаёт `no_violation` без исключений.
- VLM вернула невалидный JSON или упала по таймауту на части кадров: кадр пропускается, пайплайн продолжает, `degraded=True`.
- Таймкод у конца видео: кадры-доказательства не запрашиваются за пределами длительности.
- Имена файлов с латинской X и кириллической Х и дубликаты по md5 (Х-4=Х-47, Х-5=Х-48): оценщик сопоставляет и не считает дубли дважды.

Тесты для каждого пункта добавлены в задачи-владельцы (Task 2, 4, 5, 8, 10).

---

## File Structure

```
ml/
  __init__.py          экспорт analyze
  types.py             Evidence, Violation, AnalysisResult, STAGES, TIMELINE_LABELS; to_jury / to_details
  catalog.yaml         типы нарушений: тексты, вопрос верификатора, норматив
  catalog.py           load_catalog(), norm_for(), fmt_t()
  video.py             probe(), sample_frames(), frames_at(), to_jpeg_b64()
  sampling.py          choose_times(): адаптивная выборка по движению
  vlm.py               VLMClient.ask_json() + map_parallel()
  sensor.py            STATE_SCHEMA, sense(): кадр → состояние
  timeline.py          Scene: сглаживание сигналов в интервалы
  rules.py             Candidate, RULES, run_rules()
  verify.py            verify(): фильтр кандидатов VLM
  procedures.py        шаги процедур по окнам + шаблоны пропусков
  open_pass.py         открытый проход для неизвестных типов
  pipeline.py          analyze(): оркестрация, дедлайн, прогресс
eval/
  __init__.py
  labels.py            load_labels(): xlsx → эталон, дубли по md5
  metrics.py           score(): метрики как у жюри
  run_eval.py          CLI: прогон + отчёт report.md
tools/kaggle/
  push_code.sh         код → приватный Kaggle-датасет cashguard-code
  push_videos.sh       видео → приватный Kaggle-датасет cashguard-videos
  kernel/run.py        скрипт ноутбука: vLLM + оценщик
  run_kernel.sh        push ноутбука, ожидание, скачивание результатов
tests/
  conftest.py          фикстуры: синтетическое видео, FakeVLM
  test_*.py            по модулю
requirements-ml.txt
```

---

### Task 1: Каркас пакета, типы результата и каталог

Первым пушится в `main`, чтобы бэк (MAIN-1) импортировал `ml.types`.

**Files:**
- Create: `requirements-ml.txt`, `ml/__init__.py`, `ml/types.py`, `ml/catalog.yaml`, `ml/catalog.py`, `tests/__init__.py`, `tests/test_types.py`, `tests/test_catalog.py`

**Interfaces:**
- Produces:
  - `Evidence(timestamp_sec: float, image_base64: str)`
  - `Violation(type_id, title, timecode_sec, timecode_end_sec, confidence, observed, why, rule: dict | None, evidence: list[Evidence])`, свойство `confidence_level -> "low"|"medium"|"high"`, метод `description() -> str`
  - `AnalysisResult(duration_sec, violations, timeline: dict[str, list[list[float]]], rules_checked: int, processing_sec=0.0, degraded=False)`, свойство `verdict`, методы `to_jury(job_id) -> dict`, `to_details(job_id, preview_url) -> dict`
  - `STAGES: list[dict]`, `TIMELINE_LABELS: dict[str, str]`
  - `load_catalog() -> dict[str, dict]`, `norm_for(entry) -> dict | None`, `fmt_t(t: float) -> str` (`8.6 → "8,6"`)

- [ ] **Step 1: Окружение**

```bash
cat > requirements-ml.txt <<'EOF'
numpy>=1.26
pillow>=10.0
requests>=2.31
pyyaml>=6.0
openpyxl>=3.1
pytest>=8.0
EOF
uv pip install --python .venv/bin/python -r requirements-ml.txt
mkdir -p ml tests eval tools/kaggle/kernel
touch tests/__init__.py eval/__init__.py
```

- [ ] **Step 2: Тест типов**

```python
# tests/test_types.py
from ml.types import AnalysisResult, Evidence, Violation, TIMELINE_LABELS

def _v(rule=None):
    return Violation(
        type_id="cash_unattended", title="Наличные или ценности оставлены без присмотра",
        timecode_sec=8.6, timecode_end_sec=14.0, confidence=0.8,
        observed="В 8,6 с кассир вышла, пачка денег на столе.",
        why="Деньги должны храниться в закрывающихся устройствах.",
        rule=rule, evidence=[Evidence(8.6, "AAA")])

def test_jury_dict_has_only_spec_keys():
    r = AnalysisResult(duration_sec=20.0, violations=[_v()], timeline={}, rules_checked=9)
    j = r.to_jury("abc")
    assert set(j) == {"job_id", "status", "verdict", "violations"}
    assert j["verdict"] == "violation"
    v = j["violations"][0]
    assert set(v) == {"type", "timecode_sec", "description", "evidence_frames"}
    assert set(v["evidence_frames"][0]) == {"timestamp_sec", "image_base64"}

def test_description_contains_norm_or_disclaimer():
    rule = {"document": "Постановление НБРК № 231", "point": "п. 20", "quote": "q", "url": "u"}
    assert "Постановление НБРК № 231, п. 20" in _v(rule).description()
    assert "Норматив не определён" in _v(None).description()

def test_no_violation_and_details_shape():
    r = AnalysisResult(duration_sec=5.0, violations=[], timeline={"cashier_present": [[0, 5]]}, rules_checked=9)
    assert r.to_jury("x")["verdict"] == "no_violation"
    d = r.to_details("x", "/previews/x.mp4")
    for key in ("status", "verdict", "progress", "stages", "duration_sec", "processing_sec",
                "rules_checked", "preview_url", "timeline", "timeline_labels", "violations"):
        assert key in d
    assert d["timeline_labels"] == TIMELINE_LABELS

def test_confidence_level():
    v = _v(); v.confidence = 0.4
    assert v.confidence_level == "low"
```

- [ ] **Step 3: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_types.py -q`
Expected: FAIL `ModuleNotFoundError: No module named 'ml.types'`

- [ ] **Step 4: Реализация типов**

```python
# ml/types.py
from __future__ import annotations

from dataclasses import dataclass, field

STAGES = [
    {"id": "decode", "title": "Подготовка видео"},
    {"id": "detect", "title": "Люди и предметы"},
    {"id": "scene", "title": "Анализ сцены"},
    {"id": "verify", "title": "Проверка находок"},
]

TIMELINE_LABELS = {
    "cashier_present": "Кассир на месте",
    "cash_on_desk": "Деньги на столе",
    "bag_on_desk": "Сумка инкассации на столе",
    "safe_open": "Сейф открыт",
    "screen_unlocked": "Экран разблокирован",
    "outsider_in_cashier_zone": "Посторонний в зоне кассира",
}


@dataclass
class Evidence:
    timestamp_sec: float
    image_base64: str


@dataclass
class Violation:
    type_id: str
    title: str
    timecode_sec: float
    timecode_end_sec: float
    confidence: float
    observed: str
    why: str
    rule: dict | None
    evidence: list[Evidence] = field(default_factory=list)

    @property
    def confidence_level(self) -> str:
        if self.confidence >= 0.75:
            return "high"
        return "medium" if self.confidence >= 0.5 else "low"

    def description(self) -> str:
        if self.rule:
            norm = f"Норматив: {self.rule['document']}, {self.rule['point']}."
        else:
            norm = "Норматив не определён, требуется проверка."
        return f"{self.observed} {self.why} {norm}"

    def _frames(self) -> list[dict]:
        return [{"timestamp_sec": round(e.timestamp_sec, 2), "image_base64": e.image_base64}
                for e in self.evidence]


@dataclass
class AnalysisResult:
    duration_sec: float
    violations: list[Violation]
    timeline: dict[str, list[list[float]]]
    rules_checked: int
    processing_sec: float = 0.0
    degraded: bool = False

    @property
    def verdict(self) -> str:
        return "violation" if self.violations else "no_violation"

    def to_jury(self, job_id: str) -> dict:
        return {
            "job_id": job_id, "status": "done", "verdict": self.verdict,
            "violations": [{
                "type": v.title,
                "timecode_sec": round(v.timecode_sec, 2),
                "description": v.description(),
                "evidence_frames": v._frames(),
            } for v in self.violations],
        }

    def to_details(self, job_id: str, preview_url: str) -> dict:
        return {
            "job_id": job_id, "status": "done", "verdict": self.verdict,
            "progress": {"stage": "done", "value": 1.0}, "stages": STAGES,
            "duration_sec": round(self.duration_sec, 2),
            "processing_sec": round(self.processing_sec, 1),
            "rules_checked": self.rules_checked, "preview_url": preview_url,
            "degraded": self.degraded,
            "timeline": self.timeline, "timeline_labels": TIMELINE_LABELS,
            "violations": [{
                "type": v.title, "type_id": v.type_id,
                "timecode_sec": round(v.timecode_sec, 2),
                "timecode_end_sec": round(v.timecode_end_sec, 2),
                "confidence": round(v.confidence, 2), "confidence_level": v.confidence_level,
                "observed": v.observed, "why": v.why, "rule": v.rule,
                "description": v.description(), "evidence_frames": v._frames(),
            } for v in self.violations],
        }
```

- [ ] **Step 5: Тест каталога**

```python
# tests/test_catalog.py
from ml.catalog import fmt_t, load_catalog, norm_for

def test_catalog_entries_complete():
    cat = load_catalog()
    for type_id in ("workstation_unlocked", "cash_unattended", "safe_unsecured", "personal_items",
                    "eating_drinking", "phone_use", "outsider_cashier_zone",
                    "banknote_check_skipped", "id_check_skipped", "bag_acceptance_violation"):
        e = cat[type_id]
        assert e["title"] and e["observed"] and e["why"] and e["verify_question"]
        assert "{t}" in e["observed"]

def test_unverified_norm_is_hidden():
    assert norm_for({"norm": {"document": "d", "point": "p", "quote": "q", "url": "u", "verified": False}}) is None
    n = norm_for({"norm": {"document": "d", "point": "p", "quote": "q", "url": "u", "verified": True}})
    assert n == {"document": "d", "point": "p", "quote": "q", "url": "u"}
    assert norm_for({"norm": None}) is None

def test_fmt_t():
    assert fmt_t(8.6) == "8,6"
    assert fmt_t(68.04) == "68,0"
```

- [ ] **Step 6: Каталог и загрузчик**

```yaml
# ml/catalog.yaml
# Нормативы — из docs/research/01_normative_base.md (VERIFIED). Перед сдачей сверить каждый url на adilet вручную.
_docs:
  npa231: &npa231 "Постановление Правления Национального Банка РК от 29.11.2019 № 231 (Правила ведения кассовых операций)"
  npa14: &npa14 "Постановление Правления Национального Банка РК от 24.02.2020 № 14"
  ib53: &ib53 "Постановление Правления АРРФР от 03.04.2026 № 53 (требования к информационной безопасности)"

workstation_unlocked:
  title: Рабочая станция оставлена разблокированной
  observed: "В {t} с кассир покинула рабочее место, на экране ноутбука остаётся открытое приложение без блокировки."
  why: "Рабочая станция кассира без блокировки доступна посторонним в его отсутствие."
  verify_question: "The cashier has left. Does the laptop screen show an open application or spreadsheet (NOT a lock screen, NOT a dark screen, NOT a closed lid)?"
  confidence: 0.7
  norm: {document: *ib53, point: "п. 71 пп. 9)", quote: "…информационная система автоматически завершает сеанс … либо блокирует рабочую станцию или ноутбук", url: "https://adilet.zan.kz/rus/docs/V2600038336", verified: true}

workstation_left_open:
  title: Рабочая станция оставлена открытой при уходе
  observed: "В {t} с кассир покинула рабочее место, ноутбук остаётся открытым."
  why: "Рабочее место кассира не должно оставаться доступным в его отсутствие."
  verify_question: "The cashier has left. Is the laptop left open (lid open) rather than closed?"
  confidence: 0.5
  norm: {document: *ib53, point: "п. 71 пп. 9)", quote: "…информационная система автоматически завершает сеанс … либо блокирует рабочую станцию или ноутбук", url: "https://adilet.zan.kz/rus/docs/V2600038336", verified: true}

cash_unattended:
  title: Наличные или ценности оставлены без присмотра
  observed: "В {t} с наличные или сумка инкассации остаются на столе без присмотра кассира."
  why: "Принятые наличные деньги хранятся в устройствах, закрывающихся на ключ, а не на открытом рабочем месте."
  verify_question: "Is there cash (banknotes) or a cash collection bag lying on the desk while the cashier is away from the desk or another person approaches it?"
  confidence: 0.7
  norm: {document: *npa231, point: "п. 20 ч. 2", quote: "Все ранее принятые наличные деньги хранятся в специальных устройствах … закрывающихся на ключ", url: "https://adilet.zan.kz/rus/docs/V1900019680", verified: true}

safe_unsecured:
  title: Сейф не заперт или ключ оставлен в замке
  observed: "В {t} с сейф остаётся открытым или с ключом в замке без присмотра кассира."
  why: "Хранилище наличных должно быть заперто, а ключи защищены от несанкционированного использования."
  verify_question: "Is the safe door open, or is a key left inserted in the safe lock, while the cashier is not at the safe?"
  confidence: 0.6
  norm: {document: *npa231, point: "п. 20 ч. 2, п. 80", quote: "Порядок хранения … ключей … обеспечивающими исключение их несанкционированного использования", url: "https://adilet.zan.kz/rus/docs/V1900019680", verified: true}

personal_items:
  title: Личные вещи на рабочем месте кассира
  observed: "С {t} с на рабочем столе кассира находятся личные вещи (сумка, верхняя одежда)."
  why: "Личные вещи работников хранятся вне кассового узла."
  verify_question: "Is there a personal handbag, backpack or outerwear (coat, jacket) placed on the cashier's desk?"
  confidence: 0.75
  norm: {document: *npa231, point: "п. 12 ч. 1", quote: "Хранение личных вещей, наличных денег и ценностей работников банка осуществляется вне кассового узла", url: "https://adilet.zan.kz/rus/docs/V1900019680", verified: true}

eating_drinking:
  title: Приём пищи или напитков на рабочем месте
  observed: "В {t} с кассир ест или пьёт на рабочем месте."
  why: "Посторонние предметы и приём пищи на рабочем месте кассира создают риск для наличных и документов; порядок определяется внутренними документами банка."
  verify_question: "Is the cashier eating or drinking (cup or food raised to the mouth) at the desk?"
  confidence: 0.7
  norm: {document: *npa231, point: "п. 12 (отсылка к внутренним документам банка)", quote: "Хранение личных вещей … осуществляется вне кассового узла", url: "https://adilet.zan.kz/rus/docs/V1900019680", verified: false}

phone_use:
  title: Мобильный телефон на рабочем месте кассира
  observed: "В {t} с кассир держит в руках мобильный телефон на рабочем месте."
  why: "В кассовый узел допускаются только средства связи без функций фото- и видеофиксации."
  verify_question: "Is the CASHIER (not a client) holding or using a smartphone?"
  confidence: 0.7
  norm: {document: *npa231, point: "п. 12 ч. 2", quote: "Допускается внос … средств связи, не имеющих функции фото и видео фиксации", url: "https://adilet.zan.kz/rus/docs/V1900019680", verified: true}

outsider_cashier_zone:
  title: Посторонний в зоне кассира
  observed: "В {t} с посторонний человек находится на стороне кассира, в зоне рабочего места."
  why: "Кассовый узел изолируется от посторонних; рабочее место кассира отделяется."
  verify_question: "Is a person other than the cashier standing on the cashier's side of the desk (behind or next to the cashier), not on the client side?"
  confidence: 0.6
  norm: {document: *npa14, point: "п. 8", quote: "Кассовый узел подлежит изолированию … одним закрывающимся служебным входом", url: "https://adilet.zan.kz/rus/docs/V2000020075", verified: true}

banknote_check_skipped:
  title: Наличные не проверены на подлинность
  observed: "В {t} с кассир принимает и пересчитывает наличные без проверки на оборудовании для определения подлинности."
  why: "Пересчёт наличных выполняется на оборудовании с проверкой машиночитаемых защитных признаков."
  verify_question: "During this cash handling, does the cashier put the banknotes through a counting/checking machine or a banknote detector?"
  confidence: 0.5
  norm: {document: *npa231, point: "п. 41, п. 9", quote: "…на оборудовании, имеющем функцию проверки не менее двух машиночитаемых защитных признаков", url: "https://adilet.zan.kz/rus/docs/V1900019680", verified: true}

id_check_skipped:
  title: Операция без проверки документа клиента
  observed: "В {t} с кассир принимает наличные от клиента без проверки документа, удостоверяющего личность."
  why: "Перед проведением операции личность клиента идентифицируется по документу."
  verify_question: "Before accepting cash, does the cashier take and look at the client's ID card or document?"
  confidence: 0.5
  norm: null

bag_acceptance_violation:
  title: Нарушен порядок приёма сумки у инкассатора
  observed: "В {t} с сумка инкассации принята, инкассатор уходит до завершения приёма, сумка вскрывается без него."
  why: "При приёме сумки кассир проверяет её целостность и пломбирование, вскрытие при нарушении целостности — в присутствии инкассатора."
  verify_question: "After handing over the green collection bag, does the courier leave the room before the cashier finishes checking/opening the bag?"
  confidence: 0.5
  norm: {document: *npa231, point: "пп. 24–25", quote: "проверяет целостность сумки; проверяет правильность пломбирования сумки", url: "https://adilet.zan.kz/rus/docs/V1900019680", verified: true}

other_security_risk:
  title: Иной возможный риск кассовой дисциплины
  observed: "В {t} с: {note}"
  why: "Наблюдаемое действие может противоречить порядку работы кассы; требуется проверка человеком."
  verify_question: "{note} Is this clearly visible in these frames?"
  confidence: 0.4
  norm: null
```

```python
# ml/catalog.py
from __future__ import annotations

from functools import cache
from pathlib import Path

import yaml

_PATH = Path(__file__).with_name("catalog.yaml")


@cache
def load_catalog() -> dict[str, dict]:
    data = yaml.safe_load(_PATH.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def norm_for(entry: dict) -> dict | None:
    norm = entry.get("norm")
    if not norm or not norm.get("verified"):
        return None
    return {k: norm[k] for k in ("document", "point", "quote", "url")}


def fmt_t(t: float) -> str:
    return f"{t:.1f}".replace(".", ",")
```

```python
# ml/__init__.py
"""CashGuard ML: analyze(video_path) -> AnalysisResult."""
```

- [ ] **Step 7: Тесты зелёные**

Run: `.venv/bin/python -m pytest tests/test_types.py tests/test_catalog.py -q`
Expected: `7 passed`

- [ ] **Step 8: Commit и push (бэку нужен `ml.types`)**

```bash
git add requirements-ml.txt ml tests eval/__init__.py
git commit -m "ml: result types and violation catalog"
git push
```

---

### Task 2: Видео — проба, выборка кадров, JPEG

**Files:**
- Create: `ml/video.py`, `tests/conftest.py`, `tests/test_video.py`

**Interfaces:**
- Produces:
  - `probe(path) -> tuple[float, float]` — (длительность, fps)
  - `sample_frames(path, times: list[float], width: int = 464) -> list[tuple[float, PIL.Image.Image]]` — кадры в заданные моменты (по PTS, ближайший кадр)
  - `low_res_stream(path, fps: float = 4.0, size=(58, 106)) -> tuple[list[float], np.ndarray]` — времена и серые миниатюры `uint8[N, H, W]` для оценки движения
  - `to_jpeg_b64(img, quality=85) -> str`
- Фикстура `tiny_video(tmp_path) -> Path`: 8 с, 464×848, 30 fps, движущийся testsrc.

- [ ] **Step 1: Фикстура и тесты**

```python
# tests/conftest.py
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def tiny_video(tmp_path) -> Path:
    out = tmp_path / "tiny.mov"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc=size=464x848:rate=30:duration=8", "-pix_fmt", "yuv420p",
                    str(out)], check=True)
    return out
```

```python
# tests/test_video.py
import base64

from ml.video import low_res_stream, probe, sample_frames, to_jpeg_b64

def test_probe(tiny_video):
    dur, fps = probe(tiny_video)
    assert abs(dur - 8.0) < 0.1 and abs(fps - 30) < 0.5

def test_sample_frames_times_and_size(tiny_video):
    frames = sample_frames(tiny_video, [0.0, 1.5, 3.9])
    assert [round(t, 1) for t, _ in frames] == [0.0, 1.5, 3.9]
    assert frames[0][1].size == (464, 848)

def test_sample_frames_clips_beyond_duration(tiny_video):
    frames = sample_frames(tiny_video, [10.0])
    assert len(frames) == 1 and frames[0][0] <= 8.0

def test_low_res_stream_shape(tiny_video):
    ts, arr = low_res_stream(tiny_video, fps=4.0)
    assert arr.ndim == 3 and arr.shape[0] == len(ts) and 30 <= len(ts) <= 33

def test_jpeg_b64(tiny_video):
    _, img = sample_frames(tiny_video, [1.0])[0]
    raw = base64.b64decode(to_jpeg_b64(img))
    assert raw[:2] == b"\xff\xd8"
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_video.py -q`
Expected: FAIL `No module named 'ml.video'`

- [ ] **Step 3: Реализация**

```python
# ml/video.py
from __future__ import annotations

import base64
import io
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image


def probe(path: Path | str) -> tuple[float, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=r_frame_rate:format=duration", "-of", "json", str(path)],
        check=True, capture_output=True, text=True).stdout
    info = json.loads(out)
    num, den = info["streams"][0]["r_frame_rate"].split("/")
    return float(info["format"]["duration"]), float(num) / float(den)


def _grab(path: Path | str, t: float, width: int) -> Image.Image:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
         "-vf", f"scale={width}:-2", "-f", "image2pipe", "-vcodec", "png", "-"],
        check=True, capture_output=True).stdout
    return Image.open(io.BytesIO(raw)).convert("RGB")


def sample_frames(path: Path | str, times: list[float], width: int = 464) -> list[tuple[float, Image.Image]]:
    duration, fps = probe(path)
    last = max(0.0, duration - 1.5 / fps)
    result = []
    for t in times:
        t = min(max(0.0, t), last)
        result.append((t, _grab(path, t, width)))
    return result


def low_res_stream(path: Path | str, fps: float = 4.0, size: tuple[int, int] = (58, 106)) -> tuple[list[float], np.ndarray]:
    w, h = size
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"fps={fps},scale={w}:{h},format=gray",
         "-f", "rawvideo", "-"], check=True, capture_output=True).stdout
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w)
    return [i / fps for i in range(len(arr))], arr


def to_jpeg_b64(img: Image.Image, quality: int = 85) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode()
```

- [ ] **Step 4: Тесты зелёные**

Run: `.venv/bin/python -m pytest tests/test_video.py -q`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add ml/video.py tests/conftest.py tests/test_video.py
git commit -m "ml: video probe, frame sampling, jpeg"
```

---

### Task 3: Адаптивная выборка кадров

**Files:**
- Create: `ml/sampling.py`, `tests/test_sampling.py`

**Interfaces:**
- Consumes: `low_res_stream` (Task 2)
- Produces: `choose_times(duration: float, motion_ts: list[float], motion: np.ndarray, budget: int = 160) -> list[float]` — отсортированные уникальные моменты: база 2 fps (1 fps при `duration > 90`), плюс 4 fps в окнах ±2 с вокруг всплесков движения, не больше `budget`.
- Produces: `motion_score(frames: np.ndarray) -> np.ndarray` — средняя абсолютная разность соседних миниатюр, длина `len(frames)`, первый элемент 0.

- [ ] **Step 1: Тест**

```python
# tests/test_sampling.py
import numpy as np

from ml.sampling import choose_times, motion_score

def test_motion_score():
    f = np.zeros((4, 2, 2), np.uint8); f[2] = 100
    s = motion_score(f)
    assert s[0] == 0 and s[2] == 100 and s[3] == 100

def test_base_rate_short_video():
    ts = [i / 4 for i in range(40)]
    times = choose_times(10.0, ts, np.zeros(40))
    assert times[0] == 0.0 and len(times) == 20
    assert times == sorted(set(times))

def test_densify_around_spike():
    ts = [i / 4 for i in range(80)]
    m = np.zeros(80); m[40] = 50.0  # всплеск на 10 с
    times = choose_times(20.0, ts, m)
    near = [t for t in times if 8.0 <= t <= 12.0]
    assert len(near) >= 15

def test_budget_and_long_video():
    ts = [i / 4 for i in range(600)]
    times = choose_times(150.0, ts, np.random.default_rng(0).random(600) * 50, budget=160)
    assert len(times) <= 160 and times[-1] <= 150.0

def test_tiny_video():
    assert choose_times(0.3, [0.0], np.zeros(1)) == [0.0]
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_sampling.py -q`
Expected: FAIL `No module named 'ml.sampling'`

- [ ] **Step 3: Реализация**

```python
# ml/sampling.py
from __future__ import annotations

import numpy as np


def motion_score(frames: np.ndarray) -> np.ndarray:
    if len(frames) == 0:
        return np.zeros(0)
    diff = np.abs(np.diff(frames.astype(np.int16), axis=0)).mean(axis=(1, 2))
    return np.concatenate([[0.0], diff])


def choose_times(duration: float, motion_ts: list[float], motion: np.ndarray, budget: int = 160) -> list[float]:
    base_step = 1.0 if duration > 90 else 0.5
    times = set(np.round(np.arange(0.0, duration, base_step), 2).tolist()) or {0.0}
    if len(motion):
        thr = max(float(np.percentile(motion, 90)), float(np.mean(motion)) * 2, 1.0)
        for t, m in zip(motion_ts, motion):
            if m >= thr:
                times.update(np.round(np.arange(max(0.0, t - 2), min(duration, t + 2), 0.25), 2).tolist())
    ordered = sorted(t for t in times if t < max(duration, 0.01))
    if len(ordered) > budget:
        idx = np.linspace(0, len(ordered) - 1, budget).round().astype(int)
        ordered = sorted({ordered[i] for i in idx})
    return ordered
```

- [ ] **Step 4: Тесты зелёные**

Run: `.venv/bin/python -m pytest tests/test_sampling.py -q`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add ml/sampling.py tests/test_sampling.py
git commit -m "ml: adaptive frame sampling by motion"
```

---

### Task 4: Клиент VLM

**Files:**
- Create: `ml/vlm.py`, `tests/test_vlm.py`; Modify: `tests/conftest.py` (добавить `FakeVLM`)

**Interfaces:**
- Produces:
  - `VLMClient(base_url: str | None = None, model: str | None = None, timeout: float = 60)` — по умолчанию из env `VLM_BASE_URL` (`http://localhost:8001/v1`) и `VLM_MODEL` (`Qwen/Qwen3-VL-8B-Instruct`)
  - `VLMClient.ask_json(images: list[Image], prompt: str, schema: dict, max_tokens: int = 400) -> dict | None` — `None` при сетевой ошибке, таймауте или невалидном JSON (никогда не бросает)
  - `map_parallel(fn, items, workers: int = 8) -> list` — сохраняет порядок
  - В тестах: `FakeVLM(responder: Callable[[list[Image], str], dict | None])` с тем же `ask_json`.

- [ ] **Step 1: FakeVLM и тесты**

```python
# tests/conftest.py — добавить в конец
class FakeVLM:
    def __init__(self, responder):
        self.responder = responder
        self.calls = 0

    def ask_json(self, images, prompt, schema, max_tokens=400):
        self.calls += 1
        return self.responder(images, prompt)


@pytest.fixture
def fake_vlm_cls():
    return FakeVLM
```

```python
# tests/test_vlm.py
import json

import requests
from PIL import Image

from ml.vlm import VLMClient, map_parallel

class _Resp:
    def __init__(self, content): self._c = content
    def raise_for_status(self): pass
    def json(self): return {"choices": [{"message": {"content": self._c}}]}

def test_ask_json_parses(monkeypatch):
    sent = {}
    def fake_post(url, json=None, timeout=None):
        sent.update(json); return _Resp('{"ok": true}')
    monkeypatch.setattr(requests, "post", fake_post)
    r = VLMClient("http://x/v1", "m").ask_json([Image.new("RGB", (8, 8))], "q", {"type": "object"})
    assert r == {"ok": True}
    content = sent["messages"][0]["content"]
    assert content[0]["type"] == "image_url" and content[-1] == {"type": "text", "text": "q"}
    assert sent["response_format"]["type"] == "json_schema"

def test_ask_json_bad_json_returns_none(monkeypatch):
    monkeypatch.setattr(requests, "post", lambda *a, **k: _Resp("not json"))
    assert VLMClient("http://x/v1", "m").ask_json([], "q", {}) is None

def test_ask_json_network_error_returns_none(monkeypatch):
    def boom(*a, **k): raise requests.ConnectionError("down")
    monkeypatch.setattr(requests, "post", boom)
    assert VLMClient("http://x/v1", "m").ask_json([], "q", {}) is None

def test_map_parallel_keeps_order():
    assert map_parallel(lambda x: x * 2, [3, 1, 2], workers=3) == [6, 2, 4]
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_vlm.py -q`
Expected: FAIL `No module named 'ml.vlm'`

- [ ] **Step 3: Реализация**

```python
# ml/vlm.py
from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor

import requests

from ml.video import to_jpeg_b64


class VLMClient:
    def __init__(self, base_url: str | None = None, model: str | None = None, timeout: float = 60):
        self.base_url = (base_url or os.getenv("VLM_BASE_URL", "http://localhost:8001/v1")).rstrip("/")
        self.model = model or os.getenv("VLM_MODEL", "Qwen/Qwen3-VL-8B-Instruct")
        self.timeout = timeout

    def ask_json(self, images, prompt: str, schema: dict, max_tokens: int = 400) -> dict | None:
        content = [{"type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{to_jpeg_b64(im)}"}} for im in images]
        content.append({"type": "text", "text": prompt})
        body = {
            "model": self.model, "temperature": 0, "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": content}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}},
            "chat_template_kwargs": {"enable_thinking": False},
        }
        try:
            r = requests.post(f"{self.base_url}/chat/completions", json=body, timeout=self.timeout)
            r.raise_for_status()
            return json.loads(r.json()["choices"][0]["message"]["content"])
        except (requests.RequestException, ValueError, KeyError, IndexError):
            return None


def map_parallel(fn, items, workers: int = 8) -> list:
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(fn, items))
```

- [ ] **Step 4: Тесты зелёные**

Run: `.venv/bin/python -m pytest tests/test_vlm.py -q`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add ml/vlm.py tests/test_vlm.py tests/conftest.py
git commit -m "ml: OpenAI-compatible VLM client with JSON schema"
```

---

### Task 5: VLM-сенсор состояния сцены

**Files:**
- Create: `ml/sensor.py`, `tests/test_sensor.py`

**Interfaces:**
- Consumes: `VLMClient.ask_json`, `map_parallel` (Task 4)
- Produces:
  - `STATE_SCHEMA: dict` (JSON Schema), `STATE_PROMPT: str`
  - `sense(client, frames: list[tuple[float, Image]], workers: int = 8) -> list[tuple[float, dict]]` — только кадры с валидным ответом, по возрастанию t
  - Ключи состояния: `cashier_present: bool`, `cashier_holding_phone: bool`, `cashier_eating_or_drinking: bool`, `laptop_screen: "app_visible"|"lock_screen"|"dark_or_off"|"closed"|"not_visible"`, `safe_door_open: "yes"|"no"|"unknown"`, `key_in_safe_lock: "yes"|"no"|"unknown"`, `cash_on_desk: bool`, `collection_bag_on_desk: bool`, `personal_items_on_desk: bool`, `other_person_on_cashier_side: bool`, `people_count: int`

- [ ] **Step 1: Тест**

```python
# tests/test_sensor.py
from PIL import Image

from ml.sensor import STATE_SCHEMA, sense

STATE = {"cashier_present": True, "cashier_holding_phone": False, "cashier_eating_or_drinking": False,
         "laptop_screen": "app_visible", "safe_door_open": "no", "key_in_safe_lock": "no",
         "cash_on_desk": False, "collection_bag_on_desk": False, "personal_items_on_desk": False,
         "other_person_on_cashier_side": False, "people_count": 1}

def test_schema_requires_all_keys():
    assert set(STATE_SCHEMA["required"]) == set(STATE)

def test_sense_skips_failed_frames(fake_vlm_cls):
    answers = iter([STATE, None, STATE])
    vlm = fake_vlm_cls(lambda imgs, p: next(answers))
    frames = [(t, Image.new("RGB", (8, 8))) for t in (0.0, 0.5, 1.0)]
    out = sense(vlm, frames, workers=1)
    assert [t for t, _ in out] == [0.0, 1.0]

def test_sense_drops_answers_missing_keys(fake_vlm_cls):
    vlm = fake_vlm_cls(lambda imgs, p: {"cashier_present": True})
    assert sense(vlm, [(0.0, Image.new("RGB", (8, 8)))], workers=1) == []
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_sensor.py -q`
Expected: FAIL `No module named 'ml.sensor'`

- [ ] **Step 3: Реализация**

```python
# ml/sensor.py
from __future__ import annotations

from ml.vlm import map_parallel

_YNU = {"type": "string", "enum": ["yes", "no", "unknown"]}

STATE_SCHEMA = {
    "type": "object",
    "properties": {
        "cashier_present": {"type": "boolean"},
        "cashier_holding_phone": {"type": "boolean"},
        "cashier_eating_or_drinking": {"type": "boolean"},
        "laptop_screen": {"type": "string",
                          "enum": ["app_visible", "lock_screen", "dark_or_off", "closed", "not_visible"]},
        "safe_door_open": _YNU,
        "key_in_safe_lock": _YNU,
        "cash_on_desk": {"type": "boolean"},
        "collection_bag_on_desk": {"type": "boolean"},
        "personal_items_on_desk": {"type": "boolean"},
        "other_person_on_cashier_side": {"type": "boolean"},
        "people_count": {"type": "integer", "minimum": 0},
    },
}
STATE_SCHEMA["required"] = list(STATE_SCHEMA["properties"])

STATE_PROMPT = """Overhead CCTV frame of a bank cashier room. The CASHIER is the bank employee who works at the desk with the laptop and the cash counting machine. Clients and cash couriers sit or stand on the opposite (client) side of the desk.
Answer strictly about what is visible in THIS frame:
- cashier_present: the cashier is in the room at or near the cashier's workplace.
- cashier_holding_phone: the cashier (not a client) holds a smartphone.
- cashier_eating_or_drinking: the cashier is eating or holding a cup/drink to the mouth.
- laptop_screen: app_visible = an application, document or spreadsheet is open; lock_screen = wallpaper/lock screen; dark_or_off = black screen with lid open; closed = lid closed.
- safe_door_open / key_in_safe_lock: the small metal safe near the desk.
- cash_on_desk: banknotes or cash bundles lying on the desk.
- collection_bag_on_desk: a (green) cash collection bag lying on the desk.
- personal_items_on_desk: handbag, backpack, coat or jacket on the desk.
- other_person_on_cashier_side: someone other than the cashier is on the cashier's side of the desk.
- people_count: number of people visible.
Return JSON only."""


def sense(client, frames, workers: int = 8) -> list[tuple[float, dict]]:
    required = set(STATE_SCHEMA["required"])

    def one(item):
        t, img = item
        ans = client.ask_json([img], STATE_PROMPT, STATE_SCHEMA, max_tokens=300)
        return (t, ans) if isinstance(ans, dict) and required <= set(ans) else None

    return [r for r in map_parallel(one, frames, workers) if r is not None]
```

- [ ] **Step 4: Тесты зелёные**

Run: `.venv/bin/python -m pytest tests/test_sensor.py -q`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add ml/sensor.py tests/test_sensor.py
git commit -m "ml: VLM scene state sensor"
```

---

### Task 6: Таймлайн — сглаживание сигналов в интервалы

**Files:**
- Create: `ml/timeline.py`, `tests/test_timeline.py`

**Interfaces:**
- Consumes: список `(t, state)` из `sense` (Task 5)
- Produces:
  - `SIGNALS: dict[str, Callable[[dict], bool]]` — ключи: `cashier_present`, `cashier_absent`, `screen_unlocked`, `screen_open_dark`, `laptop_open`, `cash_on_desk`, `bag_on_desk`, `valuables_on_desk`, `safe_open`, `key_in_lock`, `personal_items`, `phone`, `eating`, `outsider_in_cashier_zone`
  - `Scene(samples: list[tuple[float, dict]], duration: float)` с полями `.samples`, `.duration`, `.intervals: dict[str, list[tuple[float, float]]]`
  - `Scene.frac(signal, a, b) -> float` — доля сэмплов в `[a, b]`, где сигнал истинен (0.0, если сэмплов нет)
  - `Scene.timeline_json() -> dict[str, list[list[float]]]` — только ключи `TIMELINE_LABELS`
  - `smooth(points: list[tuple[float, bool]], duration: float, window: int = 3, min_dur: float = 1.0, gap: float = 1.0) -> list[tuple[float, float]]`

- [ ] **Step 1: Тест**

```python
# tests/test_timeline.py
from ml.timeline import Scene, smooth
from ml.types import TIMELINE_LABELS

def _st(**kw):
    base = {"cashier_present": True, "cashier_holding_phone": False, "cashier_eating_or_drinking": False,
            "laptop_screen": "app_visible", "safe_door_open": "no", "key_in_safe_lock": "no",
            "cash_on_desk": False, "collection_bag_on_desk": False, "personal_items_on_desk": False,
            "other_person_on_cashier_side": False, "people_count": 1}
    return base | kw

def test_smooth_removes_single_flicker():
    pts = [(i * 0.5, v) for i, v in enumerate([0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1])]
    assert smooth(pts, 6.0) == [(3.0, 6.0)]

def test_smooth_merges_small_gaps_and_drops_short():
    pts = [(i * 0.5, v) for i, v in enumerate([1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0])]
    assert smooth(pts, 6.0, min_dur=1.0) == [(0.0, 4.5)]

def test_scene_absent_interval_and_frac():
    samples = [(i * 0.5, _st(cashier_present=i < 10)) for i in range(20)]
    sc = Scene(samples, 10.0)
    assert sc.intervals["cashier_absent"] == [(5.0, 10.0)]
    assert sc.frac("screen_unlocked", 5.0, 10.0) == 1.0
    assert sc.frac("phone", 50.0, 60.0) == 0.0

def test_timeline_json_keys():
    sc = Scene([(0.0, _st()), (0.5, _st())], 1.0)
    assert set(sc.timeline_json()) == set(TIMELINE_LABELS)

def test_empty_scene():
    sc = Scene([], 2.0)
    assert sc.intervals["cashier_absent"] == []
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_timeline.py -q`
Expected: FAIL `No module named 'ml.timeline'`

- [ ] **Step 3: Реализация**

```python
# ml/timeline.py
from __future__ import annotations

from ml.types import TIMELINE_LABELS

SIGNALS = {
    "cashier_present": lambda s: s["cashier_present"],
    "cashier_absent": lambda s: not s["cashier_present"],
    "screen_unlocked": lambda s: s["laptop_screen"] == "app_visible",
    "screen_open_dark": lambda s: s["laptop_screen"] == "dark_or_off",
    "laptop_open": lambda s: s["laptop_screen"] in ("app_visible", "dark_or_off"),
    "cash_on_desk": lambda s: s["cash_on_desk"],
    "bag_on_desk": lambda s: s["collection_bag_on_desk"],
    "valuables_on_desk": lambda s: s["cash_on_desk"] or s["collection_bag_on_desk"],
    "safe_open": lambda s: s["safe_door_open"] == "yes",
    "key_in_lock": lambda s: s["key_in_safe_lock"] == "yes",
    "personal_items": lambda s: s["personal_items_on_desk"],
    "phone": lambda s: s["cashier_holding_phone"],
    "eating": lambda s: s["cashier_eating_or_drinking"],
    "outsider_in_cashier_zone": lambda s: s["other_person_on_cashier_side"],
}


def smooth(points, duration: float, window: int = 3, min_dur: float = 1.0, gap: float = 1.0):
    if not points:
        return []
    ts = [t for t, _ in points]
    vals = [bool(v) for _, v in points]
    half = window // 2
    sm = [sum(vals[max(0, i - half): i + half + 1]) * 2 > len(vals[max(0, i - half): i + half + 1])
          for i in range(len(vals))]
    ends = ts[1:] + [duration]
    raw = []
    for t, end, v in zip(ts, ends, sm):
        if not v:
            continue
        if raw and t - raw[-1][1] <= gap:
            raw[-1] = (raw[-1][0], end)
        else:
            raw.append((t, end))
    return [(round(a, 2), round(b, 2)) for a, b in raw if b - a >= min_dur]


class Scene:
    def __init__(self, samples, duration: float):
        self.samples = sorted(samples, key=lambda x: x[0])
        self.duration = duration
        self.intervals = {name: smooth([(t, fn(s)) for t, s in self.samples], duration)
                          for name, fn in SIGNALS.items()}

    def frac(self, signal: str, a: float, b: float) -> float:
        fn = SIGNALS[signal]
        vals = [fn(s) for t, s in self.samples if a <= t <= b]
        return sum(vals) / len(vals) if vals else 0.0

    def timeline_json(self) -> dict[str, list[list[float]]]:
        return {k: [list(iv) for iv in self.intervals.get(k, [])] for k in TIMELINE_LABELS}
```

- [ ] **Step 4: Тесты зелёные**

Run: `.venv/bin/python -m pytest tests/test_timeline.py -q`
Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add ml/timeline.py tests/test_timeline.py
git commit -m "ml: scene timeline smoothing"
```

---

### Task 7: Правила по состояниям

**Files:**
- Create: `ml/rules.py`, `tests/test_rules.py`

**Interfaces:**
- Consumes: `Scene` (Task 6), `load_catalog` (Task 1)
- Produces:
  - `Candidate(type_id: str, t: float, t_end: float, confidence: float, note: str = "")`
  - `RULES: dict[str, Callable[[Scene], list[Candidate]]]` для: `workstation_unlocked`, `workstation_left_open`, `cash_unattended`, `safe_unsecured`, `personal_items`, `eating_drinking`, `phone_use`, `outsider_cashier_zone`
  - `run_rules(scene) -> list[Candidate]` — все кандидаты, по t; на один `type_id` не больше 2 кандидатов с разницей ≥ 5 с
  - Константа `LEAVE_MIN = 3.0` (с)

- [ ] **Step 1: Тест**

```python
# tests/test_rules.py
from ml.rules import run_rules
from ml.timeline import Scene
from tests.test_timeline import _st

def _scene(states, step=0.5):
    return Scene([(i * step, s) for i, s in enumerate(states)], len(states) * step)

def _types(cands): return {c.type_id for c in cands}

def test_unlocked_on_leave():
    st = [_st()] * 10 + [_st(cashier_present=False)] * 10
    c = [x for x in run_rules(_scene(st)) if x.type_id == "workstation_unlocked"]
    assert len(c) == 1 and c[0].t == 5.0

def test_locked_screen_on_leave_is_clean():
    st = [_st()] * 10 + [_st(cashier_present=False, laptop_screen="lock_screen")] * 10
    assert not _types(run_rules(_scene(st))) & {"workstation_unlocked", "workstation_left_open"}

def test_absent_from_start_is_not_leave():
    st = [_st(cashier_present=False)] * 10 + [_st()] * 10
    assert "workstation_unlocked" not in _types(run_rules(_scene(st)))

def test_cash_unattended():
    st = [_st(cash_on_desk=True, laptop_screen="closed")] * 10 + \
         [_st(cashier_present=False, cash_on_desk=True, laptop_screen="closed")] * 10
    c = [x for x in run_rules(_scene(st)) if x.type_id == "cash_unattended"]
    assert c and c[0].t == 5.0

def test_client_phone_does_not_trigger_and_cashier_phone_does():
    assert "phone_use" not in _types(run_rules(_scene([_st(people_count=2)] * 10)))
    assert "phone_use" in _types(run_rules(_scene([_st()] * 4 + [_st(cashier_holding_phone=True)] * 8)))

def test_personal_items_eating_outsider():
    t = _types(run_rules(_scene([_st(personal_items_on_desk=True, cashier_eating_or_drinking=True,
                                     other_person_on_cashier_side=True)] * 10)))
    assert {"personal_items", "eating_drinking", "outsider_cashier_zone"} <= t

def test_clean_video_no_candidates():
    assert run_rules(_scene([_st()] * 20)) == []
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_rules.py -q`
Expected: FAIL `No module named 'ml.rules'`

- [ ] **Step 3: Реализация**

```python
# ml/rules.py
from __future__ import annotations

from dataclasses import dataclass

from ml.catalog import load_catalog

LEAVE_MIN = 3.0


@dataclass
class Candidate:
    type_id: str
    t: float
    t_end: float
    confidence: float
    note: str = ""


def _conf(type_id: str) -> float:
    return float(load_catalog()[type_id]["confidence"])


def _leaves(scene):
    first = scene.samples[0][0] if scene.samples else 0.0
    return [(a, b) for a, b in scene.intervals["cashier_absent"] if a > first + 0.01 and b - a >= LEAVE_MIN]


def _on_leave(type_id, signal, min_frac=0.6):
    def rule(scene):
        return [Candidate(type_id, a, b, _conf(type_id))
                for a, b in _leaves(scene) if scene.frac(signal, a, b) >= min_frac]
    return rule


def _presence(type_id, signal, min_dur):
    def rule(scene):
        return [Candidate(type_id, a, b, _conf(type_id))
                for a, b in scene.intervals[signal] if b - a >= min_dur]
    return rule


def _cash_unattended(scene):
    out = []
    for a, b in scene.intervals["valuables_on_desk"]:
        for la, lb in scene.intervals["cashier_absent"]:
            s, e = max(a, la), min(b, lb)
            if e - s >= LEAVE_MIN:
                out.append(Candidate("cash_unattended", s, e, _conf("cash_unattended")))
    return out


def _safe_unsecured(scene):
    out = []
    for la, lb in _leaves(scene):
        if scene.frac("safe_open", la, lb) >= 0.5 or scene.frac("key_in_lock", la, lb) >= 0.5:
            out.append(Candidate("safe_unsecured", la, lb, _conf("safe_unsecured")))
    return out


RULES = {
    "workstation_unlocked": _on_leave("workstation_unlocked", "screen_unlocked"),
    "workstation_left_open": _on_leave("workstation_left_open", "screen_open_dark"),
    "cash_unattended": _cash_unattended,
    "safe_unsecured": _safe_unsecured,
    "personal_items": _presence("personal_items", "personal_items", 3.0),
    "eating_drinking": _presence("eating_drinking", "eating", 1.0),
    "phone_use": _presence("phone_use", "phone", 2.0),
    "outsider_cashier_zone": _presence("outsider_cashier_zone", "outsider_in_cashier_zone", 1.5),
}


def run_rules(scene) -> list[Candidate]:
    out = []
    for rule in RULES.values():
        kept = []
        for c in sorted(rule(scene), key=lambda c: c.t):
            if len(kept) < 2 and all(abs(c.t - k.t) >= 5.0 for k in kept):
                kept.append(c)
        out += kept
    return sorted(out, key=lambda c: c.t)
```

- [ ] **Step 4: Тесты зелёные**

Run: `.venv/bin/python -m pytest tests/test_rules.py -q`
Expected: `7 passed`

- [ ] **Step 5: Commit**

```bash
git add ml/rules.py tests/test_rules.py
git commit -m "ml: state rules producing violation candidates"
```

---

### Task 8: Пайплайн v1 — сборка результата с кадрами-доказательствами

**Files:**
- Create: `ml/pipeline.py`, `tests/test_pipeline.py`; Modify: `ml/__init__.py`

**Interfaces:**
- Consumes: `probe, sample_frames, low_res_stream, to_jpeg_b64` (Task 2), `choose_times, motion_score` (Task 3), `VLMClient` (Task 4), `sense` (Task 5), `Scene` (Task 6), `run_rules, Candidate, RULES` (Task 7), `load_catalog, norm_for, fmt_t` (Task 1)
- Produces:
  - `analyze(video_path, deadline_s: float = 240.0, on_progress=None, client=None) -> AnalysisResult`
  - `to_violation(c: Candidate, video_path, duration: float) -> Violation` — кадры в `c.t`, середине и `min(c.t_end, duration)`; без дублей ближе 0,5 с; максимум 3
  - Этапы `on_progress(stage_id, value)`: `decode`, `detect`, `scene`, `verify`, затем `done`
  - Хук `STAGE_HOOKS: list[Callable[[list[Candidate], Scene, client, video_path, float], list[Candidate]]]` — пустой в v1; Task 9–11 добавляют верификатор, процедуры и открытый проход

- [ ] **Step 1: Тест**

```python
# tests/test_pipeline.py
from ml.pipeline import analyze
from tests.test_timeline import _st

def test_analyze_detects_unlocked_leave(tiny_video, fake_vlm_cls):
    def responder(imgs, prompt):
        return _st()  # кассир на месте; ниже подменим по счётчику
    calls = {"n": 0}
    def by_order(imgs, prompt):
        calls["n"] += 1
        return _st() if calls["n"] <= 4 else _st(cashier_present=False)
    vlm = fake_vlm_cls(by_order)
    stages = []
    r = analyze(tiny_video, client=vlm, on_progress=lambda s, v: stages.append(s), workers=1)
    assert r.verdict == "violation"
    v = [x for x in r.violations if x.type_id == "workstation_unlocked"][0]
    assert 1 <= len(v.evidence) <= 3
    assert all(0 <= e.timestamp_sec <= r.duration_sec for e in v.evidence)
    assert "Норматив:" in v.description()
    assert stages[0] == "decode" and stages[-1] == "done"

def test_analyze_clean(tiny_video, fake_vlm_cls):
    r = analyze(tiny_video, client=fake_vlm_cls(lambda i, p: _st()), workers=1)
    assert r.verdict == "no_violation" and r.rules_checked > 0
    assert set(r.to_jury("j")) == {"job_id", "status", "verdict", "violations"}

def test_analyze_vlm_down_is_degraded(tiny_video, fake_vlm_cls):
    r = analyze(tiny_video, client=fake_vlm_cls(lambda i, p: None), workers=1)
    assert r.verdict == "no_violation" and r.degraded
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_pipeline.py -q`
Expected: FAIL `No module named 'ml.pipeline'`

- [ ] **Step 3: Реализация**

```python
# ml/pipeline.py
from __future__ import annotations

import time

from ml.catalog import fmt_t, load_catalog, norm_for
from ml.rules import RULES, Candidate, run_rules
from ml.sampling import choose_times, motion_score
from ml.sensor import sense
from ml.timeline import Scene
from ml.types import AnalysisResult, Evidence, Violation
from ml.video import low_res_stream, probe, sample_frames, to_jpeg_b64
from ml.vlm import VLMClient

STAGE_HOOKS: list = []  # (cands, scene, client, video_path, time_left) -> cands


def _evidence_times(c: Candidate, duration: float) -> list[float]:
    raw = [c.t, (c.t + min(c.t_end, duration)) / 2, min(c.t_end, duration) - 0.3]
    out = []
    for t in raw:
        t = min(max(0.0, t), duration)
        if all(abs(t - o) >= 0.5 for o in out):
            out.append(t)
    return out[:3]


def to_violation(c: Candidate, video_path, duration: float) -> Violation:
    entry = load_catalog()[c.type_id]
    frames = sample_frames(video_path, _evidence_times(c, duration))
    return Violation(
        type_id=c.type_id, title=entry["title"],
        timecode_sec=c.t, timecode_end_sec=min(c.t_end, duration), confidence=c.confidence,
        observed=entry["observed"].format(t=fmt_t(c.t), note=c.note), why=entry["why"],
        rule=norm_for(entry),
        evidence=[Evidence(t, to_jpeg_b64(img)) for t, img in frames])


def analyze(video_path, deadline_s: float = 240.0, on_progress=None, client=None, workers: int = 8) -> AnalysisResult:
    started = time.monotonic()
    progress = on_progress or (lambda stage, value: None)
    client = client or VLMClient()
    left = lambda: deadline_s - (time.monotonic() - started)

    progress("decode", 0.0)
    duration, _ = probe(video_path)
    ts, small = low_res_stream(video_path)
    times = choose_times(duration, ts, motion_score(small))
    frames = sample_frames(video_path, times)

    progress("detect", 0.2)
    progress("scene", 0.3)
    samples = sense(client, frames, workers=workers)
    degraded = len(samples) < max(1, len(frames) // 2)
    scene = Scene(samples, duration)
    cands = run_rules(scene)

    progress("verify", 0.7)
    for hook in STAGE_HOOKS:
        if left() < 40:
            degraded = True
            break
        cands = hook(cands, scene, client, video_path, left())

    violations = [to_violation(c, video_path, duration) for c in sorted(cands, key=lambda c: c.t)]
    progress("done", 1.0)
    return AnalysisResult(duration_sec=duration, violations=violations, timeline=scene.timeline_json(),
                          rules_checked=len(RULES), processing_sec=time.monotonic() - started,
                          degraded=degraded)
```

```python
# ml/__init__.py
"""CashGuard ML: analyze(video_path) -> AnalysisResult."""
from ml.pipeline import analyze  # noqa: F401
```

- [ ] **Step 4: Тесты зелёные (все)**

Run: `.venv/bin/python -m pytest -q`
Expected: все тесты `passed`

- [ ] **Step 5: Commit и push**

```bash
git add ml/pipeline.py ml/__init__.py tests/test_pipeline.py
git commit -m "ml: end-to-end pipeline v1 (sensor, rules, evidence)"
git push
```

---

### Task 9: Верификатор кандидатов

**Files:**
- Create: `ml/verify.py`, `tests/test_verify.py`; Modify: `ml/pipeline.py` (регистрация хука)

**Interfaces:**
- Consumes: `Candidate` (Task 7), `sample_frames` (Task 2), `load_catalog` (Task 1), `STAGE_HOOKS` (Task 8)
- Produces: `verify(cands, scene, client, video_path, time_left) -> list[Candidate]` — `no` выкидывает кандидата, `yes` повышает уверенность на 0.15 (макс 0.95), `unclear` — 2 повторных вопроса, решает большинство; `None` от VLM — кандидат остаётся без изменений.
- `VERIFY_SCHEMA = {"type":"object","properties":{"answer":{"enum":["yes","no","unclear"]},"what_is_visible":{"type":"string"}},"required":["answer","what_is_visible"]}`

- [ ] **Step 1: Тест**

```python
# tests/test_verify.py
from ml.rules import Candidate
from ml.verify import verify

def test_verify_filters(tiny_video, fake_vlm_cls):
    answers = {"phone_use": "no", "personal_items": "yes", "eating_drinking": "unclear"}
    def responder(imgs, prompt):
        for k, q in (("phone_use", "smartphone"), ("personal_items", "handbag"), ("eating_drinking", "eating")):
            if q in prompt:
                return {"answer": answers[k], "what_is_visible": "x"}
    cands = [Candidate("phone_use", 1.0, 2.0, 0.7), Candidate("personal_items", 1.0, 3.0, 0.75),
             Candidate("eating_drinking", 1.0, 2.0, 0.7)]
    out = {c.type_id: c for c in verify(cands, None, fake_vlm_cls(responder), tiny_video, 100.0)}
    assert "phone_use" not in out
    assert abs(out["personal_items"].confidence - 0.9) < 1e-9
    assert "eating_drinking" in out and out["eating_drinking"].confidence <= 0.7

def test_verify_vlm_none_keeps(tiny_video, fake_vlm_cls):
    c = [Candidate("phone_use", 1.0, 2.0, 0.7)]
    assert verify(c, None, fake_vlm_cls(lambda i, p: None), tiny_video, 100.0) == c
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_verify.py -q`
Expected: FAIL `No module named 'ml.verify'`

- [ ] **Step 3: Реализация и регистрация**

```python
# ml/verify.py
from __future__ import annotations

from dataclasses import replace

from ml.catalog import load_catalog
from ml.video import sample_frames
from ml.vlm import map_parallel

VERIFY_SCHEMA = {
    "type": "object",
    "properties": {"answer": {"type": "string", "enum": ["yes", "no", "unclear"]},
                   "what_is_visible": {"type": "string"}},
    "required": ["answer", "what_is_visible"],
}

_PROMPT = ("Frames from overhead CCTV of a bank cashier room, in time order ({times}).\n"
           "Question: {q}\nAnswer yes, no or unclear and briefly describe what is visible.")


def _ask(client, frames, question):
    times = ", ".join(f"t={t:.1f}s" for t, _ in frames)
    ans = client.ask_json([im for _, im in frames], _PROMPT.format(times=times, q=question), VERIFY_SCHEMA)
    return ans.get("answer") if isinstance(ans, dict) else None


def verify(cands, scene, client, video_path, time_left, workers: int = 4):
    cat = load_catalog()

    def one(c):
        q = cat[c.type_id]["verify_question"].format(note=c.note)
        frames = sample_frames(video_path, [c.t - 1.0, c.t + 0.5, c.t + 2.0, min(c.t_end, c.t + 4.0)])
        ans = _ask(client, frames, q)
        if ans == "unclear":
            votes = [ans, _ask(client, frames, q), _ask(client, frames, q)]
            ans = "yes" if votes.count("yes") >= 2 else "no" if votes.count("no") >= 2 else "unclear"
        if ans == "no":
            return None
        if ans == "yes":
            return replace(c, confidence=min(0.95, c.confidence + 0.15))
        return c

    return [c for c in map_parallel(one, cands, workers) if c is not None]
```

```python
# ml/pipeline.py — после определения STAGE_HOOKS
from ml.verify import verify  # noqa: E402

STAGE_HOOKS.append(verify)
```

- [ ] **Step 4: Тесты зелёные (все)**

Run: `.venv/bin/python -m pytest -q`
Expected: все `passed` (FakeVLM в `test_pipeline` на вопрос верификатора вернёт состояние без `answer` → `_ask` даст `None` → кандидат сохраняется)

- [ ] **Step 5: Commit**

```bash
git add ml/verify.py ml/pipeline.py tests/test_verify.py
git commit -m "ml: VLM verifier for rule candidates"
```

---

### Task 10: Оценщик на 42 роликах

**Files:**
- Create: `eval/labels.py`, `eval/metrics.py`, `eval/run_eval.py`, `tests/test_eval.py`

**Interfaces:**
- Consumes: `analyze` (Task 8)
- Produces:
  - `parse_ts(text: str) -> float | None` («22 секунда» → 22.0, «1минута 8 секунда» → 68.0, пусто → None)
  - `norm_name(name: str) -> str` — латинская X → кириллическая Х, без расширения
  - `load_labels(xlsx, videos_dir) -> list[dict]` — по одному на уникальный по md5 файл: `{"name", "path", "violation": bool, "times": list[float]}`; дубли сливают времена
  - `score(rows: list[dict], tol: float = 2.0) -> dict` — `rows`: `{"name","violation","times","pred_verdict","pred_times","sec"}`; ключи результата: `n, accuracy, recall, fp_clean, timecode_hit, mean_sec, max_sec`
  - CLI: `python -m eval.run_eval --videos DIR --labels XLSX --out DIR [--only Х-11,Х-28]` → `OUT/<name>.json` (`to_details`) и `OUT/report.md`

- [ ] **Step 1: Тест**

```python
# tests/test_eval.py
import openpyxl

from eval.labels import load_labels, norm_name, parse_ts
from eval.metrics import score

def test_parse_ts():
    assert parse_ts("22 секунда") == 22.0
    assert parse_ts("1минута 8 секунда") == 68.0
    assert parse_ts(None) is None and parse_ts("") is None

def test_norm_name():
    assert norm_name("X-1.mov") == "Х-1" and norm_name("Х-12") == "Х-12"

def test_load_labels_merges_duplicates(tmp_path, tiny_video):
    vids = tmp_path / "videos"; vids.mkdir()
    for n in ("Х-4.mov", "Х-47.mov", "X-1.mov"):
        (vids / n).write_bytes(tiny_video.read_bytes() if n != "X-1.mov" else b"other")
    wb = openpyxl.Workbook(); ws = wb.active
    ws.append(["наименование файла", "таймстемп", "нарушение / без нарушения"])
    ws.append(["Х-4", "57 секунда", "нарушение"]); ws.append(["Х-47", "1минута 8 секунда", "нарушение"])
    ws.append(["X-1", "22 секунда", "нарушение"])
    xlsx = tmp_path / "l.xlsx"; wb.save(xlsx)
    rows = {r["name"]: r for r in load_labels(xlsx, vids)}
    assert set(rows) == {"Х-4", "Х-1"} and rows["Х-4"]["times"] == [57.0, 68.0]

def test_score():
    rows = [
        {"name": "a", "violation": True, "times": [10.0], "pred_verdict": "violation", "pred_times": [11.5], "sec": 50},
        {"name": "b", "violation": True, "times": [5.0], "pred_verdict": "no_violation", "pred_times": [], "sec": 40},
        {"name": "c", "violation": False, "times": [], "pred_verdict": "violation", "pred_times": [3.0], "sec": 30},
        {"name": "d", "violation": False, "times": [], "pred_verdict": "no_violation", "pred_times": [], "sec": 20},
    ]
    s = score(rows)
    assert s["accuracy"] == 0.5 and s["recall"] == 0.5 and s["fp_clean"] == 0.5
    assert s["timecode_hit"] == 0.5 and s["max_sec"] == 50
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_eval.py -q`
Expected: FAIL `No module named 'eval.labels'`

- [ ] **Step 3: Реализация**

```python
# eval/labels.py
from __future__ import annotations

import hashlib
import re
from pathlib import Path

import openpyxl


def parse_ts(text) -> float | None:
    if not text:
        return None
    m = re.search(r"(?:(\d+)\s*минут\w*)?\s*(\d+)\s*секунд", str(text))
    return float(int(m.group(1) or 0) * 60 + int(m.group(2))) if m else None


def norm_name(name: str) -> str:
    return Path(str(name).strip()).stem.replace("X", "Х")


def load_labels(xlsx, videos_dir) -> list[dict]:
    files = {norm_name(p.name): p for p in Path(videos_dir).glob("*.mov")}
    ws = openpyxl.load_workbook(xlsx).active
    by_hash: dict[str, dict] = {}
    for name, ts, label in ws.iter_rows(min_row=2, values_only=True):
        if not name:
            continue
        name = norm_name(name)
        path = files.get(name)
        if path is None:
            continue
        h = hashlib.md5(path.read_bytes()).hexdigest()
        row = by_hash.setdefault(h, {"name": name, "path": str(path), "violation": False, "times": []})
        if str(label).strip().startswith("нарушение"):
            row["violation"] = True
            t = parse_ts(ts)
            if t is not None and t not in row["times"]:
                row["times"].append(t)
    return sorted(by_hash.values(), key=lambda r: r["name"])
```

```python
# eval/metrics.py
from __future__ import annotations


def score(rows: list[dict], tol: float = 2.0) -> dict:
    pos = [r for r in rows if r["violation"]]
    neg = [r for r in rows if not r["violation"]]
    pred = lambda r: r["pred_verdict"] == "violation"
    labels = [(t, r) for r in pos for t in r["times"]]
    hits = sum(any(abs(t - p) <= tol for p in r["pred_times"]) for t, r in labels)
    secs = [r["sec"] for r in rows] or [0]
    return {
        "n": len(rows),
        "accuracy": sum(pred(r) == r["violation"] for r in rows) / max(1, len(rows)),
        "recall": sum(pred(r) for r in pos) / max(1, len(pos)),
        "fp_clean": sum(pred(r) for r in neg) / max(1, len(neg)),
        "timecode_hit": hits / max(1, len(labels)),
        "mean_sec": sum(secs) / len(secs),
        "max_sec": max(secs),
    }
```

```python
# eval/run_eval.py
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from eval.labels import load_labels
from eval.metrics import score
from ml import analyze


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    only = {s.strip().replace("X", "Х") for s in a.only.split(",") if s.strip()}
    rows = []
    for lab in load_labels(a.labels, a.videos):
        if only and lab["name"] not in only:
            continue
        t0 = time.monotonic()
        try:
            res = analyze(lab["path"])
            details = res.to_details(lab["name"], "")
            verdict, times = res.verdict, [v.timecode_sec for v in res.violations]
        except Exception as e:  # прогон не должен падать из-за одного видео
            details, verdict, times = {"error": repr(e)}, "error", []
        sec = time.monotonic() - t0
        (out / f"{lab['name']}.json").write_text(json.dumps(details, ensure_ascii=False, indent=1))
        rows.append(lab | {"pred_verdict": verdict, "pred_times": times, "sec": sec,
                           "pred_types": [v["type_id"] for v in details.get("violations", [])]})
        print(f"{lab['name']}: label={lab['violation']} {lab['times']} -> {verdict} {times} ({sec:.0f}s)", flush=True)
    s = score(rows)
    lines = ["# Eval report", "", *(f"- **{k}**: {v:.3f}" if isinstance(v, float) else f"- **{k}**: {v}"
                                     for k, v in s.items()), "",
             "| video | label | t | pred | t_pred | types | sec |", "|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['name']} | {'V' if r['violation'] else '-'} | {r['times']} | {r['pred_verdict']} "
                     f"| {[round(t, 1) for t in r['pred_times']]} | {', '.join(r['pred_types'])} | {r['sec']:.0f} |")
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    (out / "rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    print(json.dumps(s, indent=1))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Тесты зелёные**

Run: `.venv/bin/python -m pytest tests/test_eval.py -q`
Expected: `4 passed`

- [ ] **Step 5: Проверка парсинга на реальной разметке (без GPU)**

Run: `.venv/bin/python -c "from eval.labels import load_labels; r=load_labels('open/open_labels.xlsx','open/videos'); print(len(r), sum(x['violation'] for x in r)); print([x for x in r if x['name']=='Х-4'])"`
Expected: `40 21` и для Х-4 `times: [57.0, 68.0]`

- [ ] **Step 6: Commit**

```bash
git add eval tests/test_eval.py
git commit -m "eval: labels with dedupe, jury-like metrics, run_eval CLI"
```

---

### Task 11: Обвязка Kaggle (код, видео, ноутбук с vLLM)

Требует: токен `~/.kaggle/kaggle.json` (кладёт капитан), подтверждённый телефон в Kaggle, **явное «да» капитана** на загрузку видео в приватный датасет.

**Files:**
- Create: `tools/kaggle/push_code.sh`, `tools/kaggle/push_videos.sh`, `tools/kaggle/kernel/run.py`, `tools/kaggle/run_kernel.sh`

**Interfaces:**
- Consumes: `eval.run_eval` (Task 10)
- Produces: `bash tools/kaggle/run_kernel.sh [ONLY]` → результаты в `runs/<timestamp>/` (`report.md`, `rows.json`, JSON по видео, `vllm.log`). `runs/` в `.gitignore`.

- [ ] **Step 1: Проверить доступ**

Run: `kaggle datasets list --mine | head -3 && kaggle kernels push --help | grep -iE "accelerator|gpu"`
Expected: список (возможно пустой) без ошибки авторизации; в справке видно, есть ли флаг выбора ускорителя — записать его в `run_kernel.sh` ниже вместо `ACCEL_FLAG`, если есть.

- [ ] **Step 2: Скрипты загрузки**

```bash
# tools/kaggle/push_code.sh
#!/usr/bin/env bash
set -euo pipefail
USER=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.kaggle/kaggle.json')))['username'])")
B=$(mktemp -d)
cp -r ml eval requirements-ml.txt "$B/"
find "$B" -name __pycache__ -prune -exec rm -rf {} +
cat > "$B/dataset-metadata.json" <<EOF
{"title": "cashguard-code", "id": "$USER/cashguard-code", "licenses": [{"name": "other"}]}
EOF
if kaggle datasets status "$USER/cashguard-code" >/dev/null 2>&1; then
  kaggle datasets version -p "$B" -m "code $(git rev-parse --short HEAD)" -r zip -q
else
  kaggle datasets create -p "$B" -r zip -q
fi
echo "pushed code $(git rev-parse --short HEAD)"
```

```bash
# tools/kaggle/push_videos.sh  (запускать один раз, после «да» капитана; датасет приватный по умолчанию)
#!/usr/bin/env bash
set -euo pipefail
USER=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.kaggle/kaggle.json')))['username'])")
B=$(mktemp -d)
mkdir "$B/videos" && cp open/videos/*.mov "$B/videos/" && cp open/open_labels.xlsx "$B/"
cat > "$B/dataset-metadata.json" <<EOF
{"title": "cashguard-videos", "id": "$USER/cashguard-videos", "licenses": [{"name": "other"}]}
EOF
kaggle datasets create -p "$B" -r zip -q
echo "videos uploaded as private dataset $USER/cashguard-videos"
```

- [ ] **Step 3: Скрипт ноутбука**

```python
# tools/kaggle/kernel/run.py
import glob, os, shutil, subprocess, sys, time, urllib.request, zipfile

INP = "/kaggle/input"
WORK = "/kaggle/working"
ONLY = os.environ.get("ONLY", "")  # подставляется run_kernel.sh

def find(name):
    hits = glob.glob(f"{INP}/**/{name}", recursive=True)
    return hits[0] if hits else None

for z in glob.glob(f"{INP}/cashguard-*/*.zip"):
    zipfile.ZipFile(z).extractall(os.path.join(WORK, "unz", os.path.basename(z)[:-4]))

code_root = os.path.dirname(find("ml/__init__.py") or glob.glob(f"{WORK}/unz/**/ml/__init__.py", recursive=True)[0])
code_root = os.path.dirname(code_root)
videos = os.path.dirname(find("Х-3.mov") or glob.glob(f"{WORK}/unz/**/Х-3.mov", recursive=True)[0])
labels = find("open_labels.xlsx") or glob.glob(f"{WORK}/unz/**/open_labels.xlsx", recursive=True)[0]

gpus = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                      capture_output=True, text=True).stdout.strip().splitlines()
print("GPUs:", gpus, flush=True)
if not gpus or not all("T4" in g or "L4" in g or "A100" in g for g in gpus):
    sys.exit("Unsupported GPU for vLLM (need compute capability >= 7.0, e.g. T4)")

model = "Qwen/Qwen3-VL-8B-Instruct" if len(gpus) >= 2 else "Qwen/Qwen3-VL-4B-Instruct"
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "vllm>=0.11", "-r",
                os.path.join(code_root, "requirements-ml.txt")], check=True)
log = open(f"{WORK}/vllm.log", "w")
srv = subprocess.Popen([sys.executable, "-m", "vllm.entrypoints.openai.api_server", "--model", model,
                        "--port", "8001", "--dtype", "half", "--tensor-parallel-size", str(len(gpus)),
                        "--max-model-len", "8192", "--limit-mm-per-prompt", '{"image": 6}',
                        "--gpu-memory-utilization", "0.9"], stdout=log, stderr=subprocess.STDOUT)
for _ in range(180):
    try:
        urllib.request.urlopen("http://localhost:8001/v1/models", timeout=2); break
    except Exception:
        if srv.poll() is not None:
            sys.exit("vLLM exited, see vllm.log")
        time.sleep(10)
else:
    sys.exit("vLLM did not start in 30 min")

env = os.environ | {"VLM_BASE_URL": "http://localhost:8001/v1", "VLM_MODEL": model, "PYTHONPATH": code_root}
cmd = [sys.executable, "-m", "eval.run_eval", "--videos", videos, "--labels", labels, "--out", f"{WORK}/out"]
if ONLY:
    cmd += ["--only", ONLY]
subprocess.run(cmd, check=False, env=env, cwd=code_root)
srv.terminate()
shutil.rmtree(f"{WORK}/unz", ignore_errors=True)
```

- [ ] **Step 4: Запуск ноутбука и сбор результатов**

```bash
# tools/kaggle/run_kernel.sh
#!/usr/bin/env bash
set -euo pipefail
ONLY="${1:-}"
USER=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.kaggle/kaggle.json')))['username'])")
bash tools/kaggle/push_code.sh
K=$(mktemp -d)
sed "s|^ONLY = .*|ONLY = os.environ.get(\"ONLY\", \"$ONLY\")|" tools/kaggle/kernel/run.py > "$K/run.py"
cat > "$K/kernel-metadata.json" <<EOF
{"id": "$USER/cashguard-eval", "title": "cashguard-eval", "code_file": "run.py",
 "language": "python", "kernel_type": "script", "is_private": true,
 "enable_gpu": true, "enable_internet": true,
 "dataset_sources": ["$USER/cashguard-code", "$USER/cashguard-videos"]}
EOF
sleep 30  # дать датасету кода обработаться
kaggle kernels push -p "$K"   # + ACCEL_FLAG из Step 1, если есть (например --accelerator NvidiaTeslaT4)
while true; do
  S=$(kaggle kernels status "$USER/cashguard-eval" 2>&1 || true); echo "$S"
  case "$S" in *complete*|*error*|*cancel*) break;; esac
  sleep 60
done
OUT="runs/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$OUT"
kaggle kernels output "$USER/cashguard-eval" -p "$OUT" -q
cat "$OUT/out/report.md" 2>/dev/null || tail -50 "$OUT/vllm.log"
```

```bash
chmod +x tools/kaggle/*.sh
grep -q '^runs/' .gitignore || echo 'runs/' >> .gitignore
```

- [ ] **Step 5: Первый прогон на 4 роликах**

Run: `bash tools/kaggle/run_kernel.sh "Х-28,Х-29,Х-40,Х-27"`
Expected: в выводе `GPUs: [... T4 ...]`, затем `report.md`. Если GPU не T4 — найти флаг ускорителя (Step 1) и повторить; если vLLM не стартует — смотреть `vllm.log`, при нехватке памяти сменить модель на `Qwen/Qwen3-VL-4B-Instruct`.

- [ ] **Step 6: Commit**

```bash
git add tools/kaggle .gitignore
git commit -m "tools: kaggle code/video datasets and vLLM eval kernel"
git push
```

---

### Task 12: Первый полный прогон и разбор ошибок (контрольная точка с капитаном)

**Files:**
- Modify: `ml/sensor.py` (промпт), `ml/catalog.yaml` (пороги `confidence`), `ml/rules.py` (длительности) — по результатам

- [ ] **Step 1: Полный прогон**

Run: `bash tools/kaggle/run_kernel.sh`
Expected: `report.md` по 40 уникальным роликам с метриками `accuracy, recall, fp_clean, timecode_hit, max_sec`.

- [ ] **Step 2: Разбор пар-двойников**

Для каждого промаха открыть `runs/<ts>/out/<name>.json`, посмотреть `timeline` и сравнить с `docs/research/06_dataset_events.json`. Записать в `docs/eval_log.md` таблицу: видео → что ожидали → что получили → какой сигнал сенсора неверен.

- [ ] **Step 3: Показать капитану отчёт и таблицу промахов; решить вместе, что правим первым (промпт сенсора, правило, порог)**

- [ ] **Step 4: Commit**

```bash
git add docs/eval_log.md ml
git commit -m "ml: tuning after first full eval"
git push
```

---

### Task 13: Шаблоны процедур (пропущенные шаги)

**Files:**
- Create: `ml/procedures.py`, `tests/test_procedures.py`; Modify: `ml/pipeline.py`

**Interfaces:**
- Consumes: `Candidate` (Task 7), `sample_frames` (Task 2), `map_parallel` (Task 4), `STAGE_HOOKS` (Task 8)
- Produces:
  - `STEP_SCHEMA` — `{"steps": list[enum]}` из `client_hands_over_cash, id_document_check, counting_by_hand, counting_machine, banknote_detector_check, cash_to_safe, cash_to_client, bag_handover, bag_opened, courier_leaves, none`
  - `label_windows(client, video_path, duration, win=4.0) -> list[tuple[float, set[str]]]` — окна по 4 с, по 4 кадра
  - `check_procedures(windows) -> list[Candidate]` — правила:
    - `client_hands_over_cash` есть, а `id_document_check` нет ни в одном окне в [t−8, t+8] → `id_check_skipped` в момент передачи
    - есть `counting_by_hand` или `counting_machine`, но нигде нет `banknote_detector_check` или `counting_machine` → `banknote_check_skipped` в момент первого пересчёта
    - `bag_handover` в t, `courier_leaves` в ≤ 6 с после, а `bag_opened` позже ухода → `bag_acceptance_violation` в момент ухода
  - `procedures_hook(cands, scene, client, video_path, time_left) -> list[Candidate]` = `cands + check_procedures(label_windows(...))`

- [ ] **Step 1: Тест (чистая логика без видео)**

```python
# tests/test_procedures.py
from ml.procedures import check_procedures

def _types(c): return {x.type_id: x.t for x in c}

def test_id_check_skipped():
    w = [(0.0, {"client_hands_over_cash"}), (4.0, {"counting_machine"})]
    assert _types(check_procedures(w)) == {"id_check_skipped": 0.0}

def test_id_checked_ok():
    w = [(0.0, {"id_document_check"}), (4.0, {"client_hands_over_cash", "counting_machine"})]
    assert check_procedures(w) == []

def test_banknote_check_skipped():
    w = [(0.0, {"id_document_check", "client_hands_over_cash"}), (4.0, {"counting_by_hand"})]
    assert "banknote_check_skipped" in _types(check_procedures(w))

def test_bag_acceptance():
    w = [(0.0, {"bag_handover"}), (4.0, {"courier_leaves"}), (8.0, {"bag_opened"})]
    assert _types(check_procedures(w)) == {"bag_acceptance_violation": 4.0}

def test_bag_ok_courier_stays():
    w = [(0.0, {"bag_handover"}), (4.0, {"bag_opened"}), (12.0, {"courier_leaves"})]
    assert check_procedures(w) == []
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_procedures.py -q`
Expected: FAIL `No module named 'ml.procedures'`

- [ ] **Step 3: Реализация и регистрация**

```python
# ml/procedures.py
from __future__ import annotations

import numpy as np

from ml.catalog import load_catalog
from ml.rules import Candidate
from ml.video import sample_frames
from ml.vlm import map_parallel

STEPS = ["client_hands_over_cash", "id_document_check", "counting_by_hand", "counting_machine",
         "banknote_detector_check", "cash_to_safe", "cash_to_client", "bag_handover", "bag_opened",
         "courier_leaves", "none"]
STEP_SCHEMA = {"type": "object",
               "properties": {"steps": {"type": "array", "items": {"type": "string", "enum": STEPS}}},
               "required": ["steps"]}
_PROMPT = ("Four frames in time order from overhead CCTV of a bank cashier room. Which of these actions happen "
           "in this short window? client_hands_over_cash: client gives banknotes to the cashier; "
           "id_document_check: cashier takes or inspects an ID card/document; counting_by_hand; "
           "counting_machine: banknotes are put into the counting machine; banknote_detector_check: banknotes "
           "are checked on a small detector device; cash_to_safe; cash_to_client; bag_handover: a courier hands "
           "a green collection bag; bag_opened: cashier opens/cuts the bag; courier_leaves: the courier walks out. "
           "Return all that apply, or [\"none\"].")


def _conf(t): return float(load_catalog()[t]["confidence"])


def label_windows(client, video_path, duration, win: float = 4.0, workers: int = 8):
    starts = list(np.arange(0.0, max(duration - 1.0, 0.01), win))

    def one(s):
        frames = sample_frames(video_path, [s + win * k / 4 for k in range(4)])
        ans = client.ask_json([im for _, im in frames], _PROMPT, STEP_SCHEMA, max_tokens=80)
        return float(s), set(ans.get("steps", [])) - {"none"} if isinstance(ans, dict) else set()

    return map_parallel(one, starts, workers)


def _first(windows, step, a=-1e9, b=1e9):
    return next((t for t, s in windows if step in s and a <= t <= b), None)


def check_procedures(windows) -> list[Candidate]:
    out = []
    t_cash = _first(windows, "client_hands_over_cash")
    if t_cash is not None and _first(windows, "id_document_check", t_cash - 8, t_cash + 8) is None:
        out.append(Candidate("id_check_skipped", t_cash, t_cash + 4, _conf("id_check_skipped")))
    t_count = min([t for t in (_first(windows, "counting_by_hand"), _first(windows, "counting_machine")) if t is not None],
                  default=None)
    if t_count is not None and _first(windows, "banknote_detector_check") is None \
            and _first(windows, "counting_machine") is None:
        out.append(Candidate("banknote_check_skipped", t_count, t_count + 4, _conf("banknote_check_skipped")))
    t_bag = _first(windows, "bag_handover")
    if t_bag is not None:
        t_leave = _first(windows, "courier_leaves", t_bag, t_bag + 6)
        t_open = _first(windows, "bag_opened", t_bag)
        if t_leave is not None and t_open is not None and t_open > t_leave:
            out.append(Candidate("bag_acceptance_violation", t_leave, t_open + 4, _conf("bag_acceptance_violation")))
    return out


def procedures_hook(cands, scene, client, video_path, time_left):
    return cands + check_procedures(label_windows(client, video_path, scene.duration))
```

```python
# ml/pipeline.py — регистрация ПЕРЕД верификатором, чтобы процедуры тоже проверялись
from ml.procedures import procedures_hook  # noqa: E402

STAGE_HOOKS.insert(0, procedures_hook)
```

- [ ] **Step 4: Тесты зелёные (все)**

Run: `.venv/bin/python -m pytest -q`
Expected: все `passed`

- [ ] **Step 5: Commit**

```bash
git add ml/procedures.py ml/pipeline.py tests/test_procedures.py
git commit -m "ml: procedure templates for omitted steps"
```

Примечание для капитана: на Х-43 (чистый) пересчёт идёт руками, затем детектор; правило `banknote_check_skipped` требует, чтобы в ролике не было ни машины, ни детектора. Проверить на прогоне Х-43/Х-44 и Х-10.

---

### Task 14: Открытый проход для неизвестных типов

**Files:**
- Create: `ml/open_pass.py`, `tests/test_open_pass.py`; Modify: `ml/pipeline.py`

**Interfaces:**
- Consumes: `Candidate`, `load_catalog`, `sample_frames`, `map_parallel`, `STAGE_HOOKS`
- Produces:
  - `OPEN_SCHEMA = {"type":"object","properties":{"violation":{"enum":[*catalog_ids,"other","none"]},"note":{"type":"string"}},"required":["violation","note"]}`
  - `open_pass(cands, scene, client, video_path, time_left) -> list[Candidate]` — окна 8 с по 4 кадра; находка типа из каталога добавляется, только если такого типа нет среди кандидатов ближе 5 с; `other` → `other_security_risk` с `note`; не запускается, если `time_left < 90`

- [ ] **Step 1: Тест**

```python
# tests/test_open_pass.py
from ml.open_pass import open_pass
from ml.rules import Candidate
from ml.timeline import Scene

def test_open_pass_adds_other_and_dedupes(tiny_video, fake_vlm_cls):
    vlm = fake_vlm_cls(lambda i, p: {"violation": "other", "note": "Кассир передаёт ключ клиенту."})
    out = open_pass([], Scene([], 4.0), vlm, tiny_video, 200.0)
    assert len(out) == 1 and out[0].type_id == "other_security_risk" and "ключ" in out[0].note

def test_open_pass_skips_known_nearby(tiny_video, fake_vlm_cls):
    vlm = fake_vlm_cls(lambda i, p: {"violation": "phone_use", "note": "x"})
    existing = [Candidate("phone_use", 1.0, 2.0, 0.7)]
    assert open_pass(existing, Scene([], 4.0), vlm, tiny_video, 200.0) == existing

def test_open_pass_ignores_malformed(tiny_video, fake_vlm_cls):
    vlm = fake_vlm_cls(lambda i, p: {"cashier_present": True})
    assert open_pass([], Scene([], 4.0), vlm, tiny_video, 200.0) == []

def test_open_pass_skipped_when_late(tiny_video, fake_vlm_cls):
    vlm = fake_vlm_cls(lambda i, p: {"violation": "other", "note": "x"})
    assert open_pass([], Scene([], 4.0), vlm, tiny_video, 30.0) == []
```

- [ ] **Step 2: Запустить — падает**

Run: `.venv/bin/python -m pytest tests/test_open_pass.py -q`
Expected: FAIL `No module named 'ml.open_pass'`

- [ ] **Step 3: Реализация и регистрация**

```python
# ml/open_pass.py
from __future__ import annotations

import numpy as np

from ml.catalog import load_catalog
from ml.rules import Candidate
from ml.video import sample_frames
from ml.vlm import map_parallel

_PROMPT = ("Four frames in time order from overhead CCTV of a bank cashier room. Does the bank cashier clearly "
           "violate cash-handling or security discipline here? Known types: {types}. If a known type is clearly "
           "visible, return its id. If a different clear violation is visible, return \"other\" and describe it "
           "in one Russian sentence in note. If nothing clearly violates the rules, return \"none\". "
           "Do not guess about things not visible.")


def open_pass(cands, scene, client, video_path, time_left, win: float = 8.0, workers: int = 8):
    if time_left < 90:
        return cands
    cat = load_catalog()
    ids = [k for k in cat if k != "other_security_risk"]
    schema = {"type": "object", "properties": {"violation": {"type": "string", "enum": ids + ["other", "none"]},
                                               "note": {"type": "string"}}, "required": ["violation", "note"]}
    prompt = _PROMPT.format(types=", ".join(f"{k} ({cat[k]['title']})" for k in ids))

    def one(s):
        frames = sample_frames(video_path, [s + win * k / 4 for k in range(4)])
        ans = client.ask_json([im for _, im in frames], prompt, schema, max_tokens=120)
        return float(s), ans if isinstance(ans, dict) else None

    out = list(cands)
    for s, ans in map_parallel(one, list(np.arange(0.0, max(scene.duration - 1.0, 0.01), win)), workers):
        if not ans or ans.get("violation") in (None, "none"):
            continue
        type_id = "other_security_risk" if ans["violation"] == "other" else ans["violation"]
        if type_id not in cat or any(c.type_id == type_id and abs(c.t - s) < 5 for c in out):
            continue
        out.append(Candidate(type_id, s, s + win, float(cat[type_id]["confidence"]) - 0.1, note=ans["note"]))
    return out
```

```python
# ml/pipeline.py — после procedures_hook, перед verify
from ml.open_pass import open_pass  # noqa: E402

STAGE_HOOKS.insert(1, open_pass)
```

- [ ] **Step 4: Тесты зелёные (все)**

Run: `.venv/bin/python -m pytest -q`
Expected: все `passed`

- [ ] **Step 5: Commit**

```bash
git add ml/open_pass.py ml/pipeline.py tests/test_open_pass.py
git commit -m "ml: open pass for unseen violation types"
git push
```

---

### Task 15: Калибровка и проверка нового ракурса (контрольная точка с капитаном)

**Files:**
- Create: `eval/augment.py`; Modify: `ml/catalog.yaml` (confidence), `ml/rules.py` (длительности), `ml/pipeline.py` (порог)

**Interfaces:**
- Produces: `augment(src, dst, kind: "flip"|"perspective"|"crop")` — ffmpeg-копия ролика; `run_eval --augment KIND` прогоняет на аугментированных копиях.

- [ ] **Step 1: Аугментации**

```python
# eval/augment.py
from __future__ import annotations

import subprocess

FILTERS = {
    "flip": "hflip",
    "perspective": "perspective=x0=40:y0=30:x1=W-10:y1=0:x2=0:y2=H:x3=W-40:y3=H-30",
    "crop": "crop=iw*0.85:ih*0.85:iw*0.1:ih*0.05,scale=464:848",
}


def augment(src, dst, kind: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", FILTERS[kind], "-an", str(dst)],
                   check=True)
```

```python
# eval/run_eval.py — добавить аргумент и подмену пути перед analyze
ap.add_argument("--augment", default="", choices=["", "flip", "perspective", "crop"])
# ... внутри цикла, до analyze:
path = lab["path"]
if a.augment:
    from eval.augment import augment
    path = str(out / f"{lab['name']}.{a.augment}.mov"); augment(lab["path"], path, a.augment)
res = analyze(path)
```

В `tools/kaggle/kernel/run.py` прокинуть `AUGMENT` из env в `--augment`, в `run_kernel.sh` — вторым аргументом (по аналогии с `ONLY`).

- [ ] **Step 2: Прогоны**

Run: `bash tools/kaggle/run_kernel.sh` и вариант с `--augment perspective`
Expected: два `report.md`.

- [ ] **Step 3: Порог вердикта**

Подобрать минимальную `confidence` для вывода нарушения: перебрать пороги 0.3…0.8 по `rows.json` (у каждого нарушения в JSON есть `confidence`), выбрать наибольший порог с `recall = 1.0` на обучающих роликах; записать его в `ml/pipeline.py` как `MIN_CONFIDENCE` и фильтровать кандидатов перед `to_violation`. Тест:

```python
# tests/test_pipeline.py — добавить
def test_min_confidence_filters(tiny_video, fake_vlm_cls, monkeypatch):
    import ml.pipeline as p
    monkeypatch.setattr(p, "MIN_CONFIDENCE", 0.99)
    calls = {"n": 0}
    def by_order(imgs, prompt):
        calls["n"] += 1
        return _st() if calls["n"] <= 4 else _st(cashier_present=False)
    assert p.analyze(tiny_video, client=fake_vlm_cls(by_order), workers=1).verdict == "no_violation"
```

```python
# ml/pipeline.py
MIN_CONFIDENCE = 0.45  # перезаписывается по итогам калибровки
# в analyze перед сборкой violations:
cands = [c for c in cands if c.confidence >= MIN_CONFIDENCE]
```

- [ ] **Step 4: Показать капитану таблицу «порог → recall / fp_clean» и результаты аугментаций; зафиксировать порог вместе**

- [ ] **Step 5: Commit**

```bash
git add eval ml tests
git commit -m "ml: calibrated threshold, augmentation eval"
git push
```

---

### Task 16: Передача бэку и фриз

**Files:**
- Create: `ml/README.md`

- [ ] **Step 1: README для бэка**

```markdown
# ml — как подключить

    from ml import analyze
    result = analyze(video_path, deadline_s=240, on_progress=lambda stage, value: ...)
    jury = result.to_jury(job_id)                 # ответ GET /api/v1/jobs/{id}
    details = result.to_details(job_id, preview)  # ответ GET /api/v1/jobs/{id}/details

Окружение: `VLM_BASE_URL` (по умолчанию http://localhost:8001/v1), `VLM_MODEL`.
vLLM: `vllm serve <model> --port 8001 --max-model-len 8192 --limit-mm-per-prompt '{"image": 6}'`.
`analyze` синхронная и тяжёлая — вызывать в потоке/процессе. Исключения ловить снаружи → `failed`.
```

- [ ] **Step 2: Финальный прогон всех тестов**

Run: `.venv/bin/python -m pytest -q`
Expected: все `passed`

- [ ] **Step 3: Сверка нормативов** — капитан открывает каждый `url` из `ml/catalog.yaml` на adilet и подтверждает пункт; при расхождении `verified: false`.

- [ ] **Step 4: Commit и push**

```bash
git add ml/README.md ml/catalog.yaml
git commit -m "ml: handoff README, verified norms"
git push
```
