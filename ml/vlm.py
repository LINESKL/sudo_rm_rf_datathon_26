from __future__ import annotations

import hashlib
import json
import re
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

import requests
from jsonschema import Draft202012Validator, ValidationError

from ml.video import to_jpeg_b64


class VLMClient:
    def __init__(self, base_url: str | None = None, model: str | None = None, timeout: float = 60):
        self.base_url = (base_url or os.getenv("VLM_BASE_URL", "http://localhost:8001/v1")).rstrip("/")
        self.model = model or os.getenv("VLM_MODEL", "Qwen/Qwen3-VL-8B-Instruct")
        self.timeout = timeout
        self.failures = 0
        self.calls = 0
        self._lock = Lock()

    def _cache_path(self, images, prompt, schema, max_tokens):
        """Disk cache for experiments (VLM_CACHE_DIR). Answers are deterministic (temperature 0),
        so re-running rules/thresholds needs no GPU. Never set in production."""
        root = os.getenv("VLM_CACHE_DIR")
        if not root:
            return None
        ids = [im.info.get("src") or hashlib.sha1(im.tobytes()).hexdigest() for im in images]
        key = json.dumps([self.model, prompt, schema, max_tokens, ids], sort_keys=True, ensure_ascii=False)
        return os.path.join(root, hashlib.sha256(key.encode()).hexdigest() + ".json")

    def ask_json(self, images, prompt: str, schema: dict, max_tokens: int = 400) -> dict | None:
        with self._lock:
            self.calls += 1
        cache = self._cache_path(images, prompt, schema, max_tokens)
        if cache and os.path.exists(cache):
            with open(cache, encoding="utf-8") as f:
                return json.load(f)
        if cache and os.getenv("VLM_CACHE_ONLY") == "1":
            return None  # offline replay: a cache miss behaves like an unavailable VLM
        answer = self._ask(images, prompt, schema, max_tokens)
        if cache and answer is not None:
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            tmp = f"{cache}.{os.getpid()}.{threading.get_ident()}.tmp"  # unique per writer: same key may race
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(answer, f, ensure_ascii=False)
            os.replace(tmp, cache)
        return answer

    def _ask(self, images, prompt: str, schema: dict, max_tokens: int) -> dict | None:
        content = [{"type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{to_jpeg_b64(im)}"}} for im in images]
        content.append({"type": "text", "text": prompt})
        body = {
            "model": self.model, "temperature": 0, "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": content}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}},
            "chat_template_kwargs": {"enable_thinking": False},
        }
        try:
            # Each parallel call owns its session. Do not send video frames via
            # environment proxies or follow redirects away from the chosen VLM.
            with requests.Session() as session:
                session.trust_env = False
                r = session.post(f"{self.base_url}/chat/completions", json=body,
                                 timeout=self.timeout, allow_redirects=False)
                if r.status_code != 200:
                    raise requests.RequestException(f"VLM returned HTTP {r.status_code}")
                text = r.json()["choices"][0]["message"]["content"]
            try:
                answer = json.loads(text)
            except ValueError:
                answer = salvage(text, schema)  # cut at max_tokens inside the free-text field
                if answer is None:
                    raise
            Draft202012Validator(schema).validate(answer)
            return answer
        except (requests.RequestException, ValueError, KeyError, IndexError, TypeError, ValidationError):
            with self._lock:
                self.failures += 1
            return None


def salvage(text: str, schema: dict) -> dict | None:
    """Read flags/enums/numbers from JSON cut at max_tokens (free text comes last and gets cut).
    Free-text fields become "". Returns None if any other required field is missing."""
    out = {}
    for key, spec in schema.get("properties", {}).items():
        kind = spec.get("type")
        if kind == "boolean":
            m = re.search(rf'"{key}"\s*:\s*(true|false)', text)
            value = None if m is None else m.group(1) == "true"
        elif kind == "integer":
            m = re.search(rf'"{key}"\s*:\s*(-?\d+)', text)
            value = None if m is None else int(m.group(1))
        elif kind == "string" and "enum" in spec:
            m = re.search(rf'"{key}"\s*:\s*"([^"]*)"', text)
            value = m.group(1) if m and m.group(1) in spec["enum"] else None
        elif kind == "string":
            value = ""
        else:
            value = None
        if value is not None:
            out[key] = value
    found = any(v != "" for v in out.values())  # garbage with no recognisable field is not an answer
    return out if found and set(schema.get("required", [])) <= set(out) else None


def map_parallel(fn, items, workers: int = 8) -> list:
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(fn, items))
