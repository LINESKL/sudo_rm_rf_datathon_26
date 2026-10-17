import base64
import binascii
from io import BytesIO
from typing import Annotated, Literal
from urllib.parse import urlsplit

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, AfterValidator, field_validator, model_validator

Seconds = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Verdict = Literal["violation", "no_violation"]
Status = Literal["processing", "done", "failed"]


def nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("Text must not be empty")
    return value


Text = Annotated[str, AfterValidator(nonblank)]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvidenceFrame(Model):
    timestamp_sec: Seconds
    image_base64: str = Field(max_length=14_000_000)

    @field_validator("image_base64")
    @classmethod
    def valid_jpeg(cls, value):
        try:
            data = base64.b64decode(value, validate=True)
            if not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
                raise ValueError("Evidence must contain a complete JPEG")
            with Image.open(BytesIO(data)) as image:
                if image.format != "JPEG" or image.width * image.height > 20_000_000:
                    raise ValueError("Evidence must be a JPEG up to 20 megapixels")
                image.load()
        except (binascii.Error, OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
            raise ValueError("Evidence is not a decodable JPEG") from exc
        return value


class Violation(Model):
    type: Text
    timecode_sec: Seconds
    description: Text
    evidence_frames: list[EvidenceFrame] = Field(min_length=1, max_length=3)


class Rule(Model):
    document: Text
    point: Text | None = None
    quote: Text | None = None
    url: str

    @field_validator("url")
    @classmethod
    def safe_source_url(cls, value):
        parsed = urlsplit(value)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Source URL must be an absolute HTTP(S) URL without credentials")
        return value


class DetailedViolation(Violation):
    type_id: Text
    timecode_end_sec: Seconds
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    confidence_level: Literal["low", "medium", "high"]
    observed: Text
    why: Text
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
        if any(end < start for intervals in (details.timeline or {}).values() for start, end in intervals):
            raise ValueError("Timeline end precedes start")
        if details.duration_sec is not None:
            # Serializers round times to hundredths; tolerate only that rounding.
            limit = details.duration_sec + .01
            for violation in details.violations:
                if violation.timecode_end_sec > limit or any(f.timestamp_sec > limit for f in violation.evidence_frames):
                    raise ValueError("Evidence or event timestamp exceeds video duration")
            for intervals in (details.timeline or {}).values():
                if any(end < start or end > limit for start, end in intervals):
                    raise ValueError("Timeline interval is outside the video")
        return self
