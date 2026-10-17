from __future__ import annotations

from functools import cache
from pathlib import Path

import yaml

_PATH = Path(__file__).with_name("catalog.yaml")


@cache
def load_catalog() -> dict[str, dict]:
    data = yaml.safe_load(_PATH.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def norm_for(entry: dict) -> dict | None:
    norm = entry.get("norm")
    if not norm or not norm.get("verified"):
        return None
    return {k: norm[k] for k in ("document", "point", "quote", "url")}


def fmt_t(t: float) -> str:
    return f"{t:.1f}".replace(".", ",")
