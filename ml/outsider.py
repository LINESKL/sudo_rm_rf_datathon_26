"""Outsider on the cashier's side: 4-frame windows every 2 s. A single frame cannot tell
who stands where; motion across frames can (40 videos: per-frame flag found 0 of 6)."""
from __future__ import annotations

import numpy as np

from ml.catalog import load_catalog
from ml.rules import Candidate
from ml.verify import VERIFY_SCHEMA
from ml.video import sample_frames
from ml.vlm import map_parallel

STEP = 2.0
MAX_WINDOWS = 30   # long videos: wider step instead of blowing the 5-minute limit
MIN_TIME_LEFT = 60.0
_PROMPT = ("Four frames in time order ({times}) from overhead CCTV of a bank cashier room. The cashier is the person "
           "sitting at the desk in front of the open laptop; clients sit or stand on the OPPOSITE side of the desk. "
           "Question: does any OTHER person (not the cashier) come onto the cashier's side of the desk - standing behind "
           "the cashier, right beside her chair, or reaching over to the counting machine or cash on her side? "
           "A client sitting or standing on the client side, or a person only at the door, is NO. "
           "Answer yes, no or unclear and briefly describe what is visible.")


def window_starts(duration: float) -> list[float]:
    span = max(duration - 2.0, 0.1)
    step = max(STEP, span / MAX_WINDOWS)
    return [float(s) for s in np.arange(0.0, span, step)]


def find_outsider(client, video_path, duration: float, workers: int = 8) -> list[Candidate]:
    def one(s):
        frames = sample_frames(video_path, [s + k for k in range(4)])
        times = ", ".join(f"t={t:.0f}s" for t, _ in frames)
        ans = client.ask_json([im for _, im in frames], _PROMPT.format(times=times), VERIFY_SCHEMA)
        return float(s), isinstance(ans, dict) and ans.get("answer") == "yes"

    hits = [s for s, yes in map_parallel(one, window_starts(duration), workers) if yes]
    if not hits:
        return []
    conf = float(load_catalog()["outsider_cashier_zone"]["confidence"])
    return [Candidate("outsider_cashier_zone", hits[0] + 1.5, hits[0] + 4.0, max(conf, 0.6))]


def outsider_hook(cands, scene, client, video_path, time_left):
    if time_left < MIN_TIME_LEFT:
        return cands
    return cands + find_outsider(client, video_path, scene.duration)
