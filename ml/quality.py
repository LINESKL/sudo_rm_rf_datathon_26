"""Camera health from the low-res stream we already decode: no extra VLM calls.

Bad frames (too dark/bright, exposure jumps, frozen stream) must not turn into "cashier left"."""
from __future__ import annotations

import numpy as np

DARK, BRIGHT = 25, 235   # mean grey level
JUMP = 35                # exposure change between consecutive thumbnails
FREEZE_SEC = 2.0         # identical thumbnails for this long = frozen feed
PAD = 1.0                # seconds of margin around a bad moment


def _merge(intervals):
    out = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return [(round(a, 2), round(b, 2)) for a, b in out]


def degraded_intervals(ts: list[float], frames: np.ndarray) -> list[tuple[float, float]]:
    if len(ts) == 0:
        return []
    f = frames.astype(np.int16)
    mean = f.mean(axis=(1, 2))
    bad = [(t - PAD, t + PAD) for t, m in zip(ts, mean) if m < DARK or m > BRIGHT]
    bad += [(ts[i] - PAD, ts[i] + PAD) for i in range(1, len(ts)) if abs(mean[i] - mean[i - 1]) > JUMP]
    still = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2)) < 0.2
    start = None
    for i, s in enumerate(list(still) + [False]):
        if s and start is None:
            start = i
        elif not s and start is not None:
            if ts[i] - ts[start] >= FREEZE_SEC:
                bad.append((ts[start], ts[i]))
            start = None
    return _merge(bad)


def mark_degraded(samples, intervals):
    """Override the VLM's visibility for samples inside bad camera intervals."""
    out = []
    for t, s in samples:
        if any(a <= t <= b for a, b in intervals):
            s = s | {"workplace_visible": "degraded"}
        out.append((t, s))
    return out
