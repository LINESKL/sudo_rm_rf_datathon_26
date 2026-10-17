import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    api_key: str
    data_dir: Path = ROOT / "backend/data"
    frontend_dir: Path = ROOT / "frontend/dist"
    analyzer: str = "ml.stub:analyze"
    workers: int = 3
    job_timeout_s: float = 280
    ml_deadline_s: float = 240
    max_upload_bytes: int = 200 * 1024 * 1024
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"
    cors_origins: tuple[str, ...] = field(default_factory=lambda: (
        "http://localhost:5173", "http://127.0.0.1:5173",
    ))
    vllm_enabled: bool = False
    vlm_base_url: str = "http://localhost:8001/v1"
    vlm_model: str = "Qwen/Qwen3-VL-8B-Instruct"
    media_cookie_ttl_s: int = 900
    media_cookie_secure: bool = False

    def __post_init__(self):
        if not self.api_key or self.api_key == "replace-with-a-random-secret":
            raise ValueError("Set API_KEY to a non-empty secret before starting CashGuard")
        if self.workers < 1 or self.job_timeout_s <= 0 or self.ml_deadline_s <= 0 or self.max_upload_bytes < 1:
            raise ValueError("WORKERS, JOB_TIMEOUT_S, ML_DEADLINE_S and MAX_UPLOAD_BYTES must be positive")
        if self.media_cookie_ttl_s < 1:
            raise ValueError("MEDIA_COOKIE_TTL_S must be positive")

    @classmethod
    def from_env(cls):
        return cls(
            api_key=os.getenv("API_KEY", ""),
            data_dir=Path(os.getenv("DATA_DIR", str(ROOT / "backend/data"))).resolve(),
            frontend_dir=Path(os.getenv("FRONTEND_DIR", str(ROOT / "frontend/dist"))).resolve(),
            analyzer=os.getenv("ANALYZER", "ml.stub:analyze"),
            workers=int(os.getenv("WORKERS", "3")),
            job_timeout_s=float(os.getenv("JOB_TIMEOUT_S", "280")),
            ml_deadline_s=float(os.getenv("ML_DEADLINE_S", "240")),
            max_upload_bytes=int(os.getenv("MAX_UPLOAD_BYTES", str(200 * 1024 * 1024))),
            ffmpeg=os.getenv("FFMPEG_BIN", "ffmpeg"),
            ffprobe=os.getenv("FFPROBE_BIN", "ffprobe"),
            cors_origins=tuple(x.strip() for x in os.getenv(
                "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
            ).split(",") if x.strip()),
            vllm_enabled=os.getenv("VLLM_ENABLED", "0") == "1",
            vlm_base_url=os.getenv("VLM_BASE_URL", "http://localhost:8001/v1").rstrip("/"),
            vlm_model=os.getenv("VLM_MODEL", "Qwen/Qwen3-VL-8B-Instruct"),
            media_cookie_ttl_s=int(os.getenv("MEDIA_COOKIE_TTL_S", "900")),
            media_cookie_secure=os.getenv("MEDIA_COOKIE_SECURE", "0") == "1",
        )
