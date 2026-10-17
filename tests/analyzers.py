import os
import json
import subprocess
import sys
import time
from pathlib import Path

from backend.app.schemas import AnalysisResult


def clean(video_path, deadline_s, on_progress):
    on_progress("scene", .6)
    time.sleep(.5)
    return AnalysisResult(verdict="no_violation", rules_checked=13)


def hanging(video_path, deadline_s, on_progress):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    Path(video_path).with_suffix(".pids").write_text(f"{os.getpid()},{child.pid}")
    on_progress("scene", .5)
    time.sleep(120)


def broken(video_path, deadline_s, on_progress):
    raise RuntimeError("fixture failure")


def inconsistent(video_path, deadline_s, on_progress):
    class Result:
        def to_jury(self, job_id):
            return {"job_id": job_id, "status": "done", "verdict": "no_violation", "violations": []}

        def to_details(self, job_id, preview_url):
            return {"job_id": job_id, "status": "done", "verdict": "violation", "violations": [],
                    "preview_url": preview_url}
    return Result()


def ml_contract(video_path, *, deadline_s, on_progress):
    """Independent result type: the backend must use serializers, not its own model."""
    Path(video_path).with_suffix(".contract.json").write_text(json.dumps({
        "deadline_s": deadline_s, "base_url": os.environ["VLM_BASE_URL"], "model": os.environ["VLM_MODEL"],
    }))
    on_progress("scene", .6)

    class Result:
        def to_jury(self, job_id):
            self.job_id = job_id
            return {"job_id": job_id, "status": "done", "verdict": "no_violation", "violations": []}

        def to_details(self, job_id, preview_url):
            assert job_id == self.job_id
            return {"job_id": job_id, "status": "done", "verdict": "no_violation", "violations": [],
                    "progress": {"stage": "done", "value": 1}, "duration_sec": 1.0,
                    "processing_sec": .125, "rules_checked": 13, "preview_url": preview_url,
                    "degraded": False, "timeline": {"bag_on_desk": [[0, 1]]},
                    "timeline_labels": {"bag_on_desk": "Сумка инкассации на столе"}}

    return Result()
