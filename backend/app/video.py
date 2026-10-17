import json
import math
import subprocess
from pathlib import Path

from fastapi import HTTPException, UploadFile


async def save_upload(upload: UploadFile, destination: Path, max_bytes: int):
    size = 0
    try:
        # UploadFile operations and writes use the thread pool, even for disk-spooled files.
        import anyio
        async with await anyio.open_file(destination, "wb") as output:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(400, f"Размер видео превышает {max_bytes // (1024 * 1024)} МБ")
                await output.write(chunk)
        if not size:
            raise HTTPException(400, "Загружен пустой файл")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def probe_video(path: Path, ffprobe: str = "ffprobe") -> float:
    try:
        result = subprocess.run([
            ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,duration:format=duration",
            "-of", "json", str(path),
        ], capture_output=True, timeout=15, check=True)
        data = json.loads(result.stdout)
        stream = data["streams"][0]
        duration = float(stream.get("duration") or data.get("format", {}).get("duration", 0))
        if not stream.get("codec_name") or stream.get("width", 0) <= 0 or stream.get("height", 0) <= 0:
            raise ValueError("Missing video stream")
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("Invalid duration")
        return duration
    except FileNotFoundError as exc:
        raise RuntimeError("ffprobe не установлен или недоступен") from exc
    except (subprocess.SubprocessError, ValueError, KeyError, IndexError) as exc:
        raise ValueError("Не удалось открыть видео: файл повреждён или не содержит видеопоток") from exc


def make_preview(source: Path, destination: Path, ffmpeg: str, timeout: float):
    temporary = destination.with_suffix(".partial.mp4")
    try:
        subprocess.run([
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-protocol_whitelist", "file,pipe", "-i", str(source), "-map", "0:v:0", "-an",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1", "-c:v", "libx264",
            "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-threads", "2",
            "-movflags", "+faststart", str(temporary),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=max(.01, timeout), check=True)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
