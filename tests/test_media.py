import time
from dataclasses import replace

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.media import COOKIE_NAME, grant
from tests.test_api import HEADERS, submit, wait_done


def test_preview_cookie_is_private_scoped_expiring_and_refreshable(settings, video):
    with TestClient(create_app(settings)) as client:
        job_id = submit(client, video)
        details, _ = wait_done(client, job_id)
        url = details["preview_url"]
        response = client.get(f"/api/v1/jobs/{job_id}/details", headers=HEADERS)
        cookie = response.headers["set-cookie"]
        assert "HttpOnly" in cookie and "SameSite=strict" in cookie
        assert f"Path={url}" in cookie and "Max-Age=900" in cookie
        assert settings.api_key not in cookie and "?" not in url
        assert response.headers["cache-control"] == "no-store"
        assert client.get(url).status_code == 200
        assert client.head(url).status_code == 200
        assert client.get(url, headers={"Range": "bytes=0-99"}).status_code == 206
        assert client.get(f"/api/v1/jobs/{job_id}/details").status_code == 401  # media grant is not an API key
        client.cookies.clear()
        for method in (client.get, client.head):
            assert method(url).status_code == 401
        assert client.get(url + "?api_key=" + settings.api_key).status_code == 401
        assert client.get(url, headers=HEADERS).status_code == 200
        for token in (grant(settings.api_key, job_id, int(time.time()) - 1),
                      grant(settings.api_key, "another-job", int(time.time()) + 900),
                      grant(settings.api_key, job_id, int(time.time()) + 900)[:-1] + "x",
                      "invalid", "9" * 5000 + "." + "a" * 64):
            assert client.get(url, headers={"Cookie": f"{COOKIE_NAME}={token}"}).status_code == 401
        assert client.get("/previews/" + "0" * 32 + ".mp4", headers=HEADERS).status_code == 404
        assert client.get("/previews/bad.mp4", headers=HEADERS).status_code == 404
        assert client.get(f"/api/v1/jobs/{job_id}/details", headers=HEADERS).status_code == 200
        assert client.get(url).status_code == 200  # authenticated details renews access


def test_media_grant_stays_scoped_across_jobs_and_uses_secure_on_https(settings, video):
    with TestClient(create_app(replace(settings, media_cookie_secure=True)), base_url="https://testserver") as client:
        urls = []
        for _ in range(2):
            job_id = submit(client, video)
            details, _ = wait_done(client, job_id)
            response = client.get(f"/api/v1/jobs/{job_id}/details", headers=HEADERS)
            assert "Secure" in response.headers["set-cookie"]
            urls.append(details["preview_url"])
        assert all(client.get(url).status_code == 200 for url in urls)
        assert client.get(urls[0]).headers["cache-control"] == "no-store"
