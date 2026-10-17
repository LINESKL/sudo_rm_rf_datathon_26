from __future__ import annotations

import numpy as np

from ml.catalog import load_catalog
from ml.rules import Candidate
from ml.video import sample_frames
from ml.vlm import map_parallel

STEPS = ["client_hands_over_cash", "id_document_check", "counting_by_hand", "counting_machine",
         "banknote_detector_check", "cash_to_safe", "cash_to_client", "bag_handover", "bag_opened",
         "courier_leaves", "none"]
STEP_SCHEMA = {"type": "object",
               "properties": {"steps": {"type": "array", "items": {"type": "string", "enum": STEPS}}},
               "required": ["steps"]}
_PROMPT = ("Four frames in time order from overhead CCTV of a bank cashier room. Which of these actions happen "
           "in this short window? client_hands_over_cash: client gives banknotes to the cashier; "
           "id_document_check: cashier takes or inspects an ID card/document; counting_by_hand; "
           "counting_machine: banknotes are put into the counting machine; banknote_detector_check: banknotes "
           "are checked on a small detector device; cash_to_safe; cash_to_client; bag_handover: a courier hands "
           "a green collection bag; bag_opened: cashier opens/cuts the bag; courier_leaves: the courier walks out. "
           "Return all that apply, or [\"none\"].")


def _conf(type_id: str) -> float:
    return float(load_catalog()[type_id]["confidence"])


def label_windows(client, video_path, duration, win: float = 4.0, workers: int = 8):
    starts = list(np.arange(0.0, max(duration - 1.0, 0.01), win))

    def one(s):
        frames = sample_frames(video_path, [s + win * k / 4 for k in range(4)])
        ans = client.ask_json([im for _, im in frames], _PROMPT, STEP_SCHEMA, max_tokens=80)
        steps = set(ans.get("steps") or []) - {"none"} if isinstance(ans, dict) else set()
        return float(s), steps

    return map_parallel(one, starts, workers)


def _first(windows, step, a=-1e9, b=1e9):
    return next((t for t, s in windows if step in s and a <= t <= b), None)


def check_procedures(windows) -> list[Candidate]:
    out = []
    t_cash = _first(windows, "client_hands_over_cash")
    if t_cash is not None and _first(windows, "id_document_check", t_cash - 8, t_cash + 8) is None:
        out.append(Candidate("id_check_skipped", t_cash, t_cash + 4, _conf("id_check_skipped")))
    counts = [t for t in (_first(windows, "counting_by_hand"), _first(windows, "counting_machine")) if t is not None]
    if counts and _first(windows, "banknote_detector_check") is None and _first(windows, "counting_machine") is None:
        t_count = min(counts)
        out.append(Candidate("banknote_check_skipped", t_count, t_count + 4, _conf("banknote_check_skipped")))
    t_bag = _first(windows, "bag_handover")
    if t_bag is not None:
        t_leave = _first(windows, "courier_leaves", t_bag, t_bag + 6)
        t_open = _first(windows, "bag_opened", t_bag)
        if t_leave is not None and t_open is not None and t_open > t_leave:
            out.append(Candidate("bag_acceptance_violation", t_leave, t_open + 4, _conf("bag_acceptance_violation")))
    return out


def procedures_hook(cands, scene, client, video_path, time_left):
    return cands + check_procedures(label_windows(client, video_path, scene.duration))
