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
