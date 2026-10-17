"""Web UI works without an API key (case FAQ 27: no auth in the UI); the jury API keeps the key."""
import time

from fastapi.testclient import TestClient

from backend.app.main import create_app


def test_ui_routes_need_no_key_and_api_still_does(settings, video):
    with TestClient(create_app(settings)) as client:
        with video.open("rb") as content:
            created = client.post("/ui/v1/analyze", files={"file": (video.name, content)})
        assert created.status_code == 200, created.text
        job_id = created.json()["job_id"]
        until = time.monotonic() + 25
        while time.monotonic() < until:
            details = client.get(f"/ui/v1/jobs/{job_id}/details")
            assert details.status_code == 200
            if details.json()["status"] in ("done", "failed"):
                break
            time.sleep(0.2)
        assert details.json()["status"] == "done"
        assert client.get(f"/ui/v1/jobs/{job_id}").status_code == 200
        assert client.get(f"/api/v1/jobs/{job_id}").status_code == 401


def test_ui_upload_size_is_still_capped(settings, video):
    small = settings.__class__(**{**settings.__dict__, "max_upload_bytes": 10})
    with TestClient(create_app(small)) as client:
        response = client.post("/ui/v1/analyze", content=b"x" * (3 * 1024 * 1024),
                               headers={"Content-Type": "multipart/form-data; boundary=x"})
        assert response.status_code == 400


def test_ui_routes_stay_out_of_the_public_schema(settings):
    with TestClient(create_app(settings)) as client:
        assert not any(path.startswith("/ui/") for path in client.get("/openapi.json").json()["paths"])
