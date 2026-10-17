"""Regressions from the 17.10 backend review: jury must get a result, not `failed`."""
import json
import os
import subprocess
import sys
import time
from dataclasses import replace

import psutil
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.queue import kill_process_tree
from tests.test_api import HEADERS, submit, wait_done


def test_degraded_result_is_delivered_not_failed(settings, video):
    with TestClient(create_app(replace(settings, analyzer="tests.analyzers:degraded"))) as client:
        details, _ = wait_done(client, submit(client, video))
        assert details["status"] == "done", details
        assert details["degraded"] is True


def test_upload_returns_200(settings, video):
    with TestClient(create_app(settings)) as client, video.open("rb") as content:
        r = client.post("/api/v1/analyze", headers=HEADERS, files={"file": (video.name, content)})
        assert r.status_code == 200, r.text


def test_extra_form_field_is_ignored(settings, video):
    with TestClient(create_app(settings)) as client, video.open("rb") as content:
        r = client.post("/api/v1/analyze", headers=HEADERS, data={"note": "jury"},
                        files={"file": (video.name, content)})
        assert r.status_code == 200, r.text


def test_filename_without_extension_is_probed(settings, video):
    with TestClient(create_app(settings)) as client, video.open("rb") as content:
        r = client.post("/api/v1/analyze", headers=HEADERS, files={"file": ("blob", content)})
        assert r.status_code == 200, r.text
        details, _ = wait_done(client, r.json()["job_id"])
        assert details["status"] == "done", details


def test_non_json_stdout_does_not_fail_job(settings, video):
    with TestClient(create_app(replace(settings, analyzer="tests.analyzers:noisy"))) as client:
        details, _ = wait_done(client, submit(client, video))
        assert details["status"] == "done", details


def test_preview_failure_does_not_block_result(settings, video, tmp_path):
    fake = tmp_path / "ffmpeg"
    fake.write_text("#!/bin/sh\nexit 1\n")
    fake.chmod(0o755)
    with TestClient(create_app(replace(settings, ffmpeg=str(fake)))) as client:
        details, _ = wait_done(client, submit(client, video))
        assert details["status"] == "done", details
        assert details.get("preview_url") is None


def test_budget_counts_time_waiting_in_queue(settings, video):
    configured = replace(settings, workers=1, analyzer="tests.analyzers:slow")
    with TestClient(create_app(configured)) as client:
        first = submit(client, video)
        client.app.state.settings  # same app; switch analyzer for the queued job via env-free path
        second = submit(client, video)
        wait_done(client, first)
        wait_done(client, second)
    # second job waited ~3 s in queue: its ML budget must shrink accordingly
    log = (settings.data_dir / "logs" / f"{second}.log").read_text()
    budget = float(log.split("ML budget ")[1].split()[0])
    assert budget < settings.job_timeout_s - 2.5, budget


def test_kill_process_tree_kills_non_group_leader():
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    kill_process_tree(process.pid)
    process.wait(timeout=5)
    assert not psutil.pid_exists(process.pid) or psutil.Process(process.pid).status() == psutil.STATUS_ZOMBIE
