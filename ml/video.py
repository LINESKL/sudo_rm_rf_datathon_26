from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image


def probe(path: Path | str) -> tuple[float, float]:
    out = subprocess.run(
        [os.getenv("FFPROBE_BIN", "ffprobe"), "-v", "error", "-protocol_whitelist", "file,pipe",
         "-select_streams", "v:0", "-show_entries",
         "stream=r_frame_rate:format=duration", "-of", "json", str(path)],
        check=True, capture_output=True, text=True, timeout=15).stdout
    info = json.loads(out)
    num, den = info["streams"][0]["r_frame_rate"].split("/")
    return float(info["format"]["duration"]), float(num) / float(den)


def _grab(path: Path | str, t: float, width: int) -> Image.Image:
    raw = subprocess.run(
        [os.getenv("FFMPEG_BIN", "ffmpeg"), "-nostdin", "-v", "error", "-threads", "2",
         "-protocol_whitelist", "file,pipe", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
         "-vf", f"scale={width}:-2", "-f", "image2pipe", "-vcodec", "png", "-"],
        check=True, capture_output=True, timeout=30).stdout
    return Image.open(io.BytesIO(raw)).convert("RGB")


_PNG = b"\x89PNG\r\n\x1a\n"
_SELECT_CHUNK = 100


def _video_id(path: Path | str) -> str:
    """Cheap content identity (size + first MB) so cached VLM answers survive renames."""
    p = Path(path)
    with p.open("rb") as f:
        head = f.read(1 << 20)
    return hashlib.sha1(str(p.stat().st_size).encode() + head).hexdigest()[:16]


def sample_frames(path: Path | str, times: list[float], width: int = 464) -> list[tuple[float, Image.Image]]:
    """All requested frames in ONE ffmpeg pass (select by frame index) instead of a seek per frame."""
    duration, fps = probe(path)
    last = max(0.0, duration - 1.5 / fps)
    clipped = [min(max(0.0, t), last) for t in times]
    if not clipped:
        return []
    wanted = sorted({int(round(t * fps)) for t in clipped})
    images = []
    for start in range(0, len(wanted), _SELECT_CHUNK):  # long select expressions crash ffmpeg
        chunk = wanted[start:start + _SELECT_CHUNK]
        expr = "+".join(f"eq(n,{i})" for i in chunk)  # inside quotes commas need no escaping
        raw = subprocess.run(
            [os.getenv("FFMPEG_BIN", "ffmpeg"), "-nostdin", "-v", "error", "-threads", "2",
             "-protocol_whitelist", "file,pipe", "-i", str(path),
             "-vf", f"select='{expr}',scale={width}:-2", "-fps_mode", "passthrough",
             "-f", "image2pipe", "-vcodec", "png", "-"],
            check=True, capture_output=True, timeout=120).stdout
        images += [Image.open(io.BytesIO(_PNG + c)).convert("RGB") for c in raw.split(_PNG)[1:]]
    vid = _video_id(path)
    by_index = {}
    for i, img in zip(wanted, images):
        img.info["src"] = f"{vid}@{i}@{width}"
        by_index[i] = img
    fallback = images[-1] if images else _grab(path, last, width)
    return [(t, by_index.get(int(round(t * fps)), fallback)) for t in clipped]


def low_res_stream(path: Path | str, fps: float = 4.0, size: tuple[int, int] = (58, 106)) -> tuple[list[float], np.ndarray]:
    w, h = size
    raw = subprocess.run(
        [os.getenv("FFMPEG_BIN", "ffmpeg"), "-nostdin", "-v", "error", "-threads", "2",
         "-protocol_whitelist", "file,pipe", "-i", str(path), "-vf", f"fps={fps},scale={w}:{h},format=gray",
         "-f", "rawvideo", "-"], check=True, capture_output=True, timeout=60).stdout
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w)
    return [i / fps for i in range(len(arr))], arr


def to_jpeg_b64(img: Image.Image, quality: int = 85) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode()
