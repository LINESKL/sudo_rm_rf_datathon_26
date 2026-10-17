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
