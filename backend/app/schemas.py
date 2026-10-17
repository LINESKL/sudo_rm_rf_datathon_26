from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Seconds = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Verdict = Literal["violation", "no_violation"]
Status = Literal["processing", "done", "failed"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvidenceFrame(Model):
    timestamp_sec: Seconds
    image_base64: str


class Violation(Model):
    type: str
    timecode_sec: Seconds
    description: str
    evidence_frames: list[EvidenceFrame] = Field(min_length=1, max_length=3)


class Rule(Model):
    document: str
    point: str
    quote: str
    url: str


class DetailedViolation(Violation):
    type_id: str
    timecode_end_sec: Seconds
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    confidence_level: Literal["low", "medium", "high"]
    observed: str
    why: str
    rule: Rule | None = None

    @model_validator(mode="after")
    def valid_interval(self):
        if self.timecode_end_sec < self.timecode_sec:
            raise ValueError("Violation end precedes start")
        return self


class AnalysisResult(Model):
    """Local stub result implementing the same serialization methods as ml.types."""
    verdict: Verdict
    violations: list[DetailedViolation] = Field(default_factory=list)
    timeline: dict[str, list[tuple[Seconds, Seconds]]] = Field(default_factory=dict)
    timeline_labels: dict[str, str] = Field(default_factory=dict)
    rules_checked: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def consistent_result(self):
        if (self.verdict == "violation") != bool(self.violations):
            raise ValueError("Verdict must agree with violations")
        if any(end < start for intervals in self.timeline.values() for start, end in intervals):
            raise ValueError("Timeline end precedes start")
        return self

    def to_jury(self, job_id: str) -> dict:
        return JobResult(
            job_id=job_id, status="done", verdict=self.verdict,
            violations=[Violation.model_validate(v.model_dump(include=set(Violation.model_fields)))
                        for v in self.violations],
        ).model_dump()

    def to_details(self, job_id: str, preview_url: str) -> dict:
        return JobDetails(job_id=job_id, status="done", progress=Progress(stage="done", value=1),
                          preview_url=preview_url, **self.model_dump()).model_dump(exclude_unset=True)


class JobCreated(Model):
    job_id: str


class JobResult(Model):
    job_id: str
    status: Status
    verdict: Verdict | None = None
    violations: list[Violation] | None = None


class Progress(Model):
    stage: str
    value: float = Field(ge=0, le=1, allow_inf_nan=False)


class Stage(Model):
    id: str
    title: str


def stages() -> list[Stage]:
    return [Stage(id=key, title=title) for key, title in (
        ("decode", "Подготовка видео"), ("detect", "Люди и предметы"),
        ("scene", "Анализ сцены"), ("verify", "Проверка находок"),
    )]


class JobDetails(Model):
    job_id: str
    status: Status = "processing"
    progress: Progress = Field(default_factory=lambda: Progress(stage="queued", value=0))
    stages: list[Stage] = Field(default_factory=stages)
    verdict: Verdict | None = None
    duration_sec: Seconds | None = None
    processing_sec: Seconds | None = None
    rules_checked: int | None = None
    preview_url: str | None = None
    violations: list[DetailedViolation] | None = None
    timeline: dict[str, list[tuple[Seconds, Seconds]]] | None = None
    timeline_labels: dict[str, str] | None = None
    error: str | None = None
    degraded: bool | None = None


class JobOutput(Model):
    jury: JobResult
    details: JobDetails

    @model_validator(mode="after")
    def consistent_output(self):
        jury, details = self.jury, self.details
        if jury.status != "done" or details.status != "done" or jury.job_id != details.job_id:
            raise ValueError("Analyzer serializers must return the same completed job")
        if jury.verdict is None or jury.violations is None or details.violations is None:
            raise ValueError("Completed results require verdict and violations")
        if jury.verdict != details.verdict or (jury.verdict == "violation") != bool(jury.violations):
            raise ValueError("Analyzer serializers disagree on verdict")
        projected = [Violation.model_validate(v.model_dump(include=set(Violation.model_fields)))
                     for v in details.violations]
        if projected != jury.violations:
            raise ValueError("Analyzer serializers disagree on violations")
        return self
