import requests
from PIL import Image

from ml.vlm import VLMClient, map_parallel

class _Resp:
    def __init__(self, content): self._c = content
    def raise_for_status(self): pass
    def json(self): return {"choices": [{"message": {"content": self._c}}]}

def test_ask_json_parses(monkeypatch):
    sent = {}
    def fake_post(url, json=None, timeout=None):
        sent.update(json); return _Resp('{"ok": true}')
    monkeypatch.setattr(requests, "post", fake_post)
    r = VLMClient("http://x/v1", "m").ask_json([Image.new("RGB", (8, 8))], "q", {"type": "object"})
    assert r == {"ok": True}
    content = sent["messages"][0]["content"]
    assert content[0]["type"] == "image_url" and content[-1] == {"type": "text", "text": "q"}
    assert sent["response_format"]["type"] == "json_schema"

def test_ask_json_bad_json_returns_none(monkeypatch):
    monkeypatch.setattr(requests, "post", lambda *a, **k: _Resp("not json"))
    assert VLMClient("http://x/v1", "m").ask_json([], "q", {}) is None

def test_ask_json_network_error_returns_none(monkeypatch):
    def boom(*a, **k): raise requests.ConnectionError("down")
    monkeypatch.setattr(requests, "post", boom)
    assert VLMClient("http://x/v1", "m").ask_json([], "q", {}) is None

def test_map_parallel_keeps_order():
    assert map_parallel(lambda x: x * 2, [3, 1, 2], workers=3) == [6, 2, 4]
