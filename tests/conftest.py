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
