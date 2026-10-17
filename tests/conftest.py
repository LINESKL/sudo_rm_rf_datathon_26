import os
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.app.config import Settings


@pytest.fixture(scope="session")
def binaries():
    def find(name):
        override = os.getenv(f"{name.upper()}_BIN")
        matches = list(Path(".tools").glob(f"ffmpeg/**/{name}.exe"))
        found = override or shutil.which(name) or (str(matches[0].resolve()) if matches else None)
        if not found:
            pytest.fail(f"Install {name} or set {name.upper()}_BIN to run integration tests")
        return found
    return find("ffmpeg"), find("ffprobe")


@pytest.fixture(scope="session")
def video(tmp_path_factory, binaries):
    path = tmp_path_factory.mktemp("media") / "sample.mp4"
    subprocess.run([binaries[0], "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                    "-i", "testsrc=size=160x120:rate=10", "-t", "1", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", str(path)], check=True, timeout=20)
    return path


@pytest.fixture
def settings(tmp_path, binaries):
    return Settings(api_key="test-secret", data_dir=tmp_path / "data",
                    frontend_dir=tmp_path / "frontend", ffmpeg=binaries[0], ffprobe=binaries[1],
                    analyzer="tests.analyzers:clean", job_timeout_s=20)


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
