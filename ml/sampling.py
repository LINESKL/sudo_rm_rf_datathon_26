from __future__ import annotations

import numpy as np


def motion_score(frames: np.ndarray) -> np.ndarray:
    if len(frames) == 0:
        return np.zeros(0)
    diff = np.abs(np.diff(frames.astype(np.int16), axis=0)).mean(axis=(1, 2))
    return np.concatenate([[0.0], diff])


def choose_times(duration: float, motion_ts: list[float], motion: np.ndarray, budget: int = 160) -> list[float]:
    base_step = 1.0 if duration > 90 else 0.5
    times = set(np.round(np.arange(0.0, duration, base_step), 2).tolist()) or {0.0}
    if len(motion):
        thr = max(float(np.percentile(motion, 90)), float(np.mean(motion)) * 2, 1.0)
        for t, m in zip(motion_ts, motion):
            if m >= thr:
                times.update(np.round(np.arange(max(0.0, t - 2), min(duration, t + 2), 0.25), 2).tolist())
    ordered = sorted(t for t in times if t < max(duration, 0.01))
    if len(ordered) > budget:
        idx = np.linspace(0, len(ordered) - 1, budget).round().astype(int)
        ordered = sorted({ordered[i] for i in idx})
    return ordered
