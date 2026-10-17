"""Real ML code and runner; only the local OpenAI-compatible VLM is simulated."""
import json
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.schemas import JobOutput
from tests.test_api import HEADERS, submit, wait_done
from tests.test_sensor import STATE


@pytest.fixture
def vlm_server():
    state = {"mode": "clean", "calls": []}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            properties = body["response_format"]["json_schema"]["schema"]["properties"]
            stage = next(iter(properties))
            state["calls"].append((self.path, body["model"], stage))
            if state["mode"] == "down" or (state["mode"] == "partial" and stage == "steps"):
                self.send_error(503)
                return
            if "cashier_present" in properties:
                answer = STATE | {"cashier_holding_phone": state["mode"] in ("phone", "partial_phone")}
            elif "steps" in properties:
                answer = {"steps": ["none"]}
            elif "violation" in properties:
                answer = {"violation": "none", "note": ""}
            else:
                answer = {"answer": "yes", "what_is_visible": "Controlled test fixture"}
            if state["mode"] == "invalid" or (state["mode"] == "partial_phone" and stage == "answer"):
                answer = {"unexpected": True}
            payload = json.dumps({"choices": [{"message": {"content": json.dumps(answer)}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state["url"] = f"http://127.0.0.1:{server.server_port}/v1"
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize("mode", ["clean", "phone", "down", "invalid", "partial", "partial_phone"])
def test_real_pipeline_through_api(settings, tiny_video, vlm_server, monkeypatch, mode):
    # Worker must receive binaries from Settings, not depend on parent env/PATH.
    monkeypatch.delenv("FFMPEG_BIN", raising=False)
    monkeypatch.delenv("FFPROBE_BIN", raising=False)
    vlm_server["mode"] = mode
    configured = replace(settings, analyzer="ml:analyze", vlm_base_url=vlm_server["url"],
                         vlm_model="integration-fixture", workers=1, job_timeout_s=180)
    with TestClient(create_app(configured)) as client:
        job_id = submit(client, tiny_video)
        details, _ = wait_done(client, job_id, timeout=120)
        jury = client.get(f"/api/v1/jobs/{job_id}", headers=HEADERS).json()
        if mode in ("clean", "phone"):
            assert details["status"] == "done", details
            JobOutput(jury=jury, details=details)
            assert details["degraded"] is False
            assert jury["verdict"] == ("violation" if mode == "phone" else "no_violation")
            if mode == "phone":
                assert details["violations"][0]["type_id"] == "phone_use"
                assert details["violations"][0]["rule"]["url"].startswith("https://")
            assert client.get(details["preview_url"], headers={"Range": "bytes=0-99"}).status_code == 206
            assert {"cashier_present", "steps", "violation"} <= {c[2] for c in vlm_server["calls"]}
        else:
            assert jury == {"job_id": job_id, "status": "failed"}, details
            assert "degraded" in (settings.data_dir / "logs" / f"{job_id}.log").read_text()
            # Same backend worker and analyzer recover when VLM recovers.
            vlm_server["mode"] = "clean"
            recovered, _ = wait_done(client, submit(client, tiny_video), timeout=120)
            assert recovered["status"] == "done", recovered
        assert vlm_server["calls"]
        assert all(path == "/v1/chat/completions" and model == "integration-fixture"
                   for path, model, _ in vlm_server["calls"])
