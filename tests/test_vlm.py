import requests
import pytest
from PIL import Image

from ml.vlm import VLMClient, map_parallel

class _Resp:
    status_code = 200
    def __init__(self, content): self._c = content
    def raise_for_status(self): pass
    def json(self): return {"choices": [{"message": {"content": self._c}}]}

def test_ask_json_parses(monkeypatch):
    sent = {}
    def fake_post(self, url, json=None, timeout=None, allow_redirects=None):
        assert self.trust_env is False and allow_redirects is False
        sent.update(json); return _Resp('{"ok": true}')
    monkeypatch.setattr(requests.Session, "post", fake_post)
    r = VLMClient("http://x/v1", "m").ask_json([Image.new("RGB", (8, 8))], "q", {"type": "object"})
    assert r == {"ok": True}
    content = sent["messages"][0]["content"]
    assert content[0]["type"] == "image_url" and content[-1] == {"type": "text", "text": "q"}
    assert sent["response_format"]["type"] == "json_schema"

def test_ask_json_bad_json_returns_none(monkeypatch):
    monkeypatch.setattr(requests.Session, "post", lambda *a, **k: _Resp("not json"))
    assert VLMClient("http://x/v1", "m").ask_json([], "q", {}) is None

def test_ask_json_network_error_returns_none(monkeypatch):
    def boom(*a, **k): raise requests.ConnectionError("down")
    monkeypatch.setattr(requests.Session, "post", boom)
    assert VLMClient("http://x/v1", "m").ask_json([], "q", {}) is None

def test_map_parallel_keeps_order():
    assert map_parallel(lambda x: x * 2, [3, 1, 2], workers=3) == [6, 2, 4]


@pytest.mark.parametrize("content", ['{"ok": "false"}', '{}', '[]', 'null'])
def test_invalid_schema_counts_failure(monkeypatch, content):
    monkeypatch.setattr(requests.Session, "post", lambda *a, **k: _Resp(content))
    client = VLMClient("http://x/v1", "m")
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
    assert client.ask_json([], "q", schema) is None
    assert client.failures == 1


def test_redirect_counts_failure(monkeypatch):
    response = _Resp('{"ok": true}')
    response.status_code = 307
    monkeypatch.setattr(requests.Session, "post", lambda *a, **k: response)
    client = VLMClient("http://x/v1", "m")
    assert client.ask_json([], "q", {}) is None
    assert client.failures == 1


def test_cache_hits_skip_the_network(monkeypatch, tmp_path):
    posts = []
    monkeypatch.setattr(requests.Session, "post", lambda self, *a, **k: posts.append(1) or _Resp('{"ok": 1}'))
    monkeypatch.setenv("VLM_CACHE_DIR", str(tmp_path))
    img = Image.new("RGB", (8, 8)); img.info["src"] = "v@10@464"
    c = VLMClient("http://x/v1", "m")
    assert c.ask_json([img], "q", {}) == {"ok": 1}
    assert c.ask_json([img], "q", {}) == {"ok": 1}
    assert len(posts) == 1
    assert c.ask_json([img], "other prompt", {}) == {"ok": 1} and len(posts) == 2


def test_cache_only_mode_never_calls_network(monkeypatch, tmp_path):
    def boom(self, *a, **k): raise AssertionError("network used")
    monkeypatch.setattr(requests.Session, "post", boom)
    monkeypatch.setenv("VLM_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("VLM_CACHE_ONLY", "1")
    assert VLMClient("http://x/v1", "m").ask_json([], "q", {}) is None


def test_cache_survives_concurrent_identical_requests(monkeypatch, tmp_path):
    import time
    from concurrent.futures import ThreadPoolExecutor

    def slow_post(self, *a, **k):
        time.sleep(0.05)
        return _Resp('{"ok": 1}')
    monkeypatch.setattr(requests.Session, "post", slow_post)
    monkeypatch.setenv("VLM_CACHE_DIR", str(tmp_path))
    img = Image.new("RGB", (8, 8)); img.info["src"] = "same@1@464"
    c = VLMClient("http://x/v1", "m")
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda _: c.ask_json([img], "q", {}), range(8)))
    assert results == [{"ok": 1}] * 8
