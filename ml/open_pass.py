from __future__ import annotations

import numpy as np

from ml.catalog import load_catalog
from ml.rules import Candidate
from ml.video import sample_frames
from ml.vlm import map_parallel

_PROMPT = ("Four frames in time order from overhead CCTV of a bank cashier room. Does the bank cashier clearly "
           "violate cash-handling or security discipline here? Known types: {types}. If a known type is clearly "
           "visible, return its id. If a different clear violation is visible, return \"other\" and describe it "
           "in one Russian sentence in note. If nothing clearly violates the rules, return \"none\". "
           "Do not guess about things not visible.")


def open_pass(cands, scene, client, video_path, time_left, win: float = 8.0, workers: int = 8):
    if time_left < 90:
        return cands
    cat = load_catalog()
    ids = [k for k in cat if k != "other_security_risk"]
    schema = {"type": "object", "properties": {"violation": {"type": "string", "enum": ids + ["other", "none"]},
                                               "note": {"type": "string"}}, "required": ["violation", "note"]}
    prompt = _PROMPT.format(types=", ".join(f"{k} ({cat[k]['title']})" for k in ids))

    def one(s):
        frames = sample_frames(video_path, [s + win * k / 4 for k in range(4)])
        ans = client.ask_json([im for _, im in frames], prompt, schema, max_tokens=120)
        return float(s), ans if isinstance(ans, dict) else None

    out = list(cands)
    for s, ans in map_parallel(one, list(np.arange(0.0, max(scene.duration - 1.0, 0.01), win)), workers):
        if not ans or ans.get("violation") in (None, "none"):
            continue
        type_id = "other_security_risk" if ans["violation"] == "other" else ans["violation"]
        if type_id not in cat or any(c.type_id == type_id and abs(c.t - s) < 5 for c in out):
            continue
        out.append(Candidate(type_id, s, s + win, float(cat[type_id]["confidence"]) - 0.1, note=ans.get("note", "")))
    return out
