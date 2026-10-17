"""Deliberately fake result for API integration; never use for judging."""
import base64
import os
import subprocess
import time
from pathlib import Path
from collections.abc import Callable

from backend.app.schemas import AnalysisResult, DetailedViolation, EvidenceFrame


def analyze(video_path: str | Path, deadline_s: float = 240, on_progress: Callable | None = None) -> AnalysisResult:
    deadline = time.monotonic() + deadline_s
    on_progress = on_progress or (lambda stage, value: None)
    for stage, value in (("decode", .1), ("detect", .3), ("scene", .6), ("verify", .9)):
        on_progress(stage, value)
        if time.monotonic() + 1.25 >= deadline:
            raise TimeoutError("Недостаточно времени для демонстрационного анализа")
        time.sleep(1.25)
    frame = subprocess.run([
        os.getenv("FFMPEG_BIN", "ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error",
        "-protocol_whitelist", "file,pipe", "-i", str(video_path), "-map", "0:v:0",
        "-frames:v", "1", "-vf", "scale=640:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ], capture_output=True, check=True, timeout=max(.01, deadline - time.monotonic())).stdout
    if not frame.startswith(b"\xff\xd8"):
        raise ValueError("Не удалось извлечь JPEG-кадр")
    return AnalysisResult(verdict="violation", violations=[DetailedViolation(
        type="Демонстрационное нарушение (заглушка)", type_id="stub_demo",
        timecode_sec=0, timecode_end_sec=0, confidence=0, confidence_level="low",
        observed="Первый кадр загруженного видео. Анализ содержимого не выполнялся.",
        why="Тест интеграции интерфейса и API; нарушение вымышлено.",
        description="Демонстрационная заглушка: вымышленное нарушение, не результат ML-анализа.",
        evidence_frames=[EvidenceFrame(timestamp_sec=0, image_base64=base64.b64encode(frame).decode())],
        rule=None,
    )])
