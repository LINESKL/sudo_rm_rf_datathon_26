from __future__ import annotations

import hashlib
import re
from pathlib import Path

import openpyxl


def parse_ts(text) -> float | None:
    if not text:
        return None
    m = re.search(r"(?:(\d+)\s*минут\w*)?\s*(\d+)\s*секунд", str(text))
    return float(int(m.group(1) or 0) * 60 + int(m.group(2))) if m else None


def norm_name(name: str) -> str:
    return Path(str(name).strip()).stem.replace("X", "Х")


def load_labels(xlsx, videos_dir) -> list[dict]:
    files = {norm_name(p.name): p for p in Path(videos_dir).glob("*.mov")}
    ws = openpyxl.load_workbook(xlsx).active
    by_hash: dict[str, dict] = {}
    for name, ts, label in ws.iter_rows(min_row=2, values_only=True):
        if not name:
            continue
        name = norm_name(name)
        path = files.get(name)
        if path is None:
            continue
        h = hashlib.md5(path.read_bytes()).hexdigest()
        row = by_hash.setdefault(h, {"name": name, "path": str(path), "violation": False, "times": []})
        if str(label).strip().startswith("нарушение"):
            row["violation"] = True
            t = parse_ts(ts)
            if t is not None and t not in row["times"]:
                row["times"].append(t)
    return sorted(by_hash.values(), key=lambda r: r["name"])
