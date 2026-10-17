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
