import asyncio
import base64
import json
import subprocess
import time
from dataclasses import replace

import httpx
import psutil
import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.schemas import JobDetails

HEADERS = {"X-API-Key": "test-secret"}


def wait_done(client, job_id, timeout=25):
    until = time.monotonic() + timeout
    seen = set()
    while time.monotonic() < until:
        response = client.get(f"/api/v1/jobs/{job_id}/details", headers=HEADERS)
        assert response.status_code == 200
        details = response.json()
        seen.add(details["progress"]["stage"])
        if details["status"] != "processing":
            return details, seen
        time.sleep(.1)
    pytest.fail("Job did not finish")


def submit(client, video):
    with video.open("rb") as content:
        response = client.post("/api/v1/analyze", headers=HEADERS, files={"file": (video.name, content)})
    assert response.status_code == 202, response.text
    assert set(response.json()) == {"job_id"}
    return response.json()["job_id"]


def test_auth_validation_cors_and_spa(settings, video):
    settings.frontend_dir.mkdir()
    (settings.frontend_dir / "index.html").write_text("<h1>Frontend fixture</h1>")
    with TestClient(create_app(replace(settings, max_upload_bytes=20000))) as client:
        for method, path in (("post", "/api/v1/analyze"), ("get", "/api/v1/jobs/missing"),
                             ("get", "/api/v1/jobs/missing/details"), ("get", "/api/unknown")):
            assert getattr(client, method)(path).status_code == 401
            assert getattr(client, method)(path, headers={"X-API-Key": "wrong"}).status_code == 401
        assert client.get("/api/v1/jobs/missing", headers=HEADERS).status_code == 404
        assert client.get("/api/unknown", headers=HEADERS).status_code == 404
        for filename, content in (("bad.avi", b"abc"), ("bad.mp4", b"broken"),
                                  ("empty.mov", b""), ("large.mov", b"a" * 20001)):
            response = client.post("/api/v1/analyze", headers=HEADERS, files={"file": (filename, content)})
            assert response.status_code == 400, response.text
        assert not list((settings.data_dir / "uploads").iterdir())
        assert client.post("/api/v1/analyze", headers=HEADERS).status_code == 400
        response = client.options("/api/v1/analyze", headers={"Origin": "http://localhost:5173",
                                  "Access-Control-Request-Method": "POST",
                                  "Access-Control-Request-Headers": "X-API-Key"})
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
        assert response.headers["access-control-allow-credentials"] == "true"
        assert "Frontend fixture" in client.get("/").text
        assert "Frontend fixture" in client.get("/results/example").text
        assert client.get("/missing.js").status_code == 404
        assert client.get("/health").json()["disk"]["free_bytes"] > 0


def test_stub_judge_contract_real_jpeg_and_range(settings, video):
    with TestClient(create_app(replace(settings, analyzer="ml.stub:analyze"))) as client:
        job_id = submit(client, video)
        pending = client.get(f"/api/v1/jobs/{job_id}", headers=HEADERS).json()
        assert pending == {"job_id": job_id, "status": "processing"}
        details, seen = wait_done(client, job_id)
        assert details["status"] == "done", details
        assert {"detect", "scene", "verify", "done"} <= seen
        assert details["violations"][0]["rule"] is None
        JobDetails.model_validate(details)
        judge = client.get(f"/api/v1/jobs/{job_id}", headers=HEADERS).json()
        assert set(judge) == {"job_id", "status", "verdict", "violations"}
        violation = judge["violations"][0]
        assert set(violation) == {"type", "timecode_sec", "description", "evidence_frames"}
        frame = violation["evidence_frames"][0]
        assert set(frame) == {"timestamp_sec", "image_base64"}
        assert base64.b64decode(frame["image_base64"]).startswith(b"\xff\xd8")
        full = client.get(details["preview_url"])
        partial = client.get(details["preview_url"], headers={"Range": "bytes=0-99"})
        assert full.status_code == 200
        assert partial.status_code == 206
        assert partial.content == full.content[:100]
        assert partial.headers["content-range"] == f"bytes 0-99/{len(full.content)}"
        assert client.get(details["preview_url"], headers={"Range": "bytes=99999999-"}).status_code == 416


async def test_six_jobs_max_three_concurrent(settings, video):
    app = create_app(replace(settings, analyzer="ml.stub:analyze"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test",
                                     headers=HEADERS) as client:
            started = time.monotonic()
            responses = await asyncio.gather(*[
                client.post("/api/v1/analyze", files={"file": (video.name, video.read_bytes())}) for _ in range(6)
            ])
            assert all(r.status_code == 202 for r in responses)
            ids = [r.json()["job_id"] for r in responses]
            await asyncio.wait_for(app.state.queue.queue.join(), timeout=35)
            rows = [app.state.store.get(job_id) for job_id in ids]
            assert all(row["status"] == "done" for row in rows)
            events = sorted([(row["started_at"], 1) for row in rows] +
                            [(row["finished_at"], -1) for row in rows])
            active = peak = 0
            for _, delta in events:
                active += delta
                peak = max(peak, active)
            assert peak == 3
            assert time.monotonic() - started < 35


def test_restart_recovers_unfinished_and_keeps_results(settings, video):
    app = create_app(replace(settings, analyzer="ml.stub:analyze"))
    with TestClient(app) as client:
        job_id = submit(client, video)
        time.sleep(.6)
    assert app.state.store.get(job_id)["status"] == "processing"
    with TestClient(create_app(settings)) as client:
        details, _ = wait_done(client, job_id)
        assert details["status"] == "done"
        assert details["verdict"] == "no_violation"
    with TestClient(create_app(settings)) as client:
        assert client.get(f"/api/v1/jobs/{job_id}", headers=HEADERS).json()["violations"] == []


def test_timeout_kills_tree_and_next_job_runs(settings, video):
    app = create_app(replace(settings, analyzer="tests.analyzers:hanging", job_timeout_s=3))
    with TestClient(app) as client:
        job_id = submit(client, video)
        details, _ = wait_done(client, job_id)
        assert details["status"] == "failed"
        assert "3 с" in details["error"]
        pids = (settings.data_dir / "uploads" / f"{job_id}.pids").read_text().split(",")
        assert all(not psutil.pid_exists(int(pid)) for pid in pids)
        assert client.get(f"/api/v1/jobs/{job_id}", headers=HEADERS).json() == {
            "job_id": job_id, "status": "failed"}
        app.state.queue.settings = settings
        second = submit(client, video)
        assert wait_done(client, second)[0]["status"] == "done"


@pytest.mark.parametrize("analyzer", ["broken", "inconsistent"])
def test_pipeline_failure_does_not_kill_worker(settings, video, analyzer):
    app = create_app(replace(settings, analyzer=f"tests.analyzers:{analyzer}", workers=1))
    with TestClient(app) as client:
        job_id = submit(client, video)
        assert wait_done(client, job_id)[0]["status"] == "failed"
        app.state.queue.settings = settings
        job_id = submit(client, video)
        assert wait_done(client, job_id)[0]["status"] == "done"


def test_frontend_reference_models():
    from pathlib import Path
    for path in Path("docs/frontend").glob("mock_details*.json"):
        JobDetails.model_validate(json.loads(path.read_text(encoding="utf-8")))


def test_hevc_mov_becomes_h264_faststart(settings, video, tmp_path):
    source = tmp_path / "hevc.mov"
    subprocess.run([settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
                    "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1", str(source)],
                   check=True, capture_output=True, timeout=20)
    with TestClient(create_app(settings)) as client:
        job_id = submit(client, source)
        details, _ = wait_done(client, job_id)
        assert details["status"] == "done"
        preview = settings.data_dir / "previews" / f"{job_id}.mp4"
        output = subprocess.run([settings.ffprobe, "-v", "error", "-select_streams", "v:0",
                                 "-show_entries", "stream=codec_name,pix_fmt", "-of", "json", str(preview)],
                                capture_output=True, check=True, timeout=10)
        stream = json.loads(output.stdout)["streams"][0]
        assert stream == {"codec_name": "h264", "pix_fmt": "yuv420p"}
        content = preview.read_bytes()
        assert content.index(b"moov") < content.index(b"mdat")


@pytest.mark.parametrize("job_timeout,expected_budget", [(280, 240), (20, None)])
def test_external_ml_serializers_budget_and_environment(settings, video, job_timeout, expected_budget):
    configured = replace(settings, analyzer="tests.analyzers:ml_contract", job_timeout_s=job_timeout,
                         vlm_model="Qwen/Qwen3-VL-4B-Instruct", vlm_base_url="http://localhost:8001/v1")
    with TestClient(create_app(configured)) as client:
        job_id = submit(client, video)
        details, _ = wait_done(client, job_id)
        assert details["status"] == "done", details
        assert details["degraded"] is False
        assert details["processing_sec"] == .125
        assert details["timeline"] == {"bag_on_desk": [[0, 1]]}
        assert details["preview_url"] == f"/previews/{job_id}.mp4"
        jury = client.get(f"/api/v1/jobs/{job_id}", headers=HEADERS).json()
        assert jury == {"job_id": job_id, "status": "done", "verdict": "no_violation", "violations": []}
        observed = json.loads((settings.data_dir / "uploads" / f"{job_id}.contract.json").read_text())
        if expected_budget is None:
            assert 0 < observed["deadline_s"] < job_timeout
        else:
            assert observed["deadline_s"] == expected_budget
        assert observed["base_url"] == configured.vlm_base_url
        assert observed["model"] == configured.vlm_model
