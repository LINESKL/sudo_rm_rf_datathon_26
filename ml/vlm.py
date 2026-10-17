from __future__ import annotations

import json
import os
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
        self._lock = Lock()

    def ask_json(self, images, prompt: str, schema: dict, max_tokens: int = 400) -> dict | None:
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
                answer = json.loads(r.json()["choices"][0]["message"]["content"])
            Draft202012Validator(schema).validate(answer)
            return answer
        except (requests.RequestException, ValueError, KeyError, IndexError, TypeError, ValidationError):
            with self._lock:
                self.failures += 1
            return None


def map_parallel(fn, items, workers: int = 8) -> list:
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(fn, items))
