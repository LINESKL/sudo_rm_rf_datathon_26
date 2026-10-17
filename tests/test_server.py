"""Real TCP server: abrupt death/recovery and the public load-test CLI."""
import json
import os
import socket
import subprocess
import sys
import time

import httpx

from backend.app.lock import queue_lock
from backend.app.queue import kill_process_tree


def test_queue_lock_rejects_second_owner(tmp_path):
    import pytest
    path = tmp_path / "queue.lock"
    with queue_lock(path):
        with pytest.raises(RuntimeError, match="already used"):
            with queue_lock(path):
                pass
    with queue_lock(path):
        pass


def test_hard_restart_and_loadtest(settings, video, tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    env = dict(os.environ, API_KEY=settings.api_key, DATA_DIR=str(settings.data_dir),
               FFMPEG_BIN=settings.ffmpeg, FFPROBE_BIN=settings.ffprobe,
               ANALYZER="ml.stub:analyze", PYTHONIOENCODING="utf-8", VLLM_ENABLED="0")
    log = (tmp_path / "server.log").open("wb")
    servers = []

    def start():
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app.main:create_app",
                                    "--factory", "--host", "127.0.0.1", "--port", str(port)],
                                   env=env, stdout=log, stderr=log)
        servers.append(process)
        for _ in range(100):
            assert process.poll() is None, (tmp_path / "server.log").read_text()
            try:
                if httpx.get(url + "/health", timeout=2, trust_env=False).status_code == 200:
                    return process
            except httpx.HTTPError:
                pass
            time.sleep(.1)
        raise AssertionError("Server did not start")

    try:
        first = start()
        with httpx.Client(base_url=url, headers={"X-API-Key": settings.api_key}, trust_env=False) as client:
            with video.open("rb") as stream:
                response = client.post("/api/v1/analyze", files={"file": (video.name, stream)})
            assert response.status_code == 202
            job_id = response.json()["job_id"]
            marker = settings.data_dir / "results" / f"{job_id}.pid"
            for _ in range(50):
                if marker.exists():
                    break
                time.sleep(.1)
            old_runner = json.loads(marker.read_text())
            # On Windows venv python.exe is a launcher; terminate the actual uvicorn
            # interpreter while deliberately leaving its analysis child alive.
            import psutil
            candidates = [psutil.Process(first.pid), *psutil.Process(first.pid).children(recursive=True)]
            server_processes = [p for p in candidates if "uvicorn" in p.cmdline()]
            for proc in reversed(server_processes):
                proc.kill()
            first.wait(timeout=10)
            start()
            for _ in range(150):
                result = client.get(f"/api/v1/jobs/{job_id}").json()
                if result["status"] != "processing":
                    break
                time.sleep(.1)
            assert result["status"] == "done"
            assert not psutil.pid_exists(old_runner["pid"])
        output = tmp_path / "loadtest"
        completed = subprocess.run([sys.executable, "deploy/loadtest.py", "--url", url,
                                    "--output", str(output), str(video)], env=env,
                                   capture_output=True, timeout=40)
        assert completed.returncode == 0, completed.stdout.decode("utf-8", errors="replace")
        report = json.loads((output / "summary.json").read_text(encoding="utf-8"))
        assert report["mode"] == "stub" and report["passed"]
        assert len(report["results"]) == 6
        assert all(item["elapsed_sec"] < 30 for item in report["results"])
    finally:
        for server in servers:
            if server.poll() is None:
                kill_process_tree(server.pid)
                server.wait(timeout=10)
        log.close()
