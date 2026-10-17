from __future__ import annotations

import time

from ml.catalog import fmt_t, load_catalog, norm_for
from ml.rules import RULES, Candidate, run_rules
from ml.sampling import choose_times, motion_score
from ml.sensor import sense
from ml.timeline import Scene
from ml.types import AnalysisResult, Evidence, Violation
from ml.video import low_res_stream, probe, sample_frames, to_jpeg_b64
from ml.vlm import VLMClient

STAGE_HOOKS: list = []  # (cands, scene, client, video_path, time_left) -> cands

from ml.verify import verify  # noqa: E402

STAGE_HOOKS.append(verify)

from ml.procedures import procedures_hook  # noqa: E402

STAGE_HOOKS.insert(0, procedures_hook)

from ml.open_pass import open_pass  # noqa: E402

STAGE_HOOKS.insert(1, open_pass)


def _evidence_times(c: Candidate, duration: float) -> list[float]:
    raw = [c.t, (c.t + min(c.t_end, duration)) / 2, min(c.t_end, duration) - 0.3]
    out = []
    for t in raw:
        t = min(max(0.0, t), duration)
        if all(abs(t - o) >= 0.5 for o in out):
            out.append(t)
    return out[:3]


def to_violation(c: Candidate, video_path, duration: float) -> Violation:
    entry = load_catalog()[c.type_id]
    frames = sample_frames(video_path, _evidence_times(c, duration))
    return Violation(
        type_id=c.type_id, title=entry["title"],
        timecode_sec=c.t, timecode_end_sec=min(c.t_end, duration), confidence=c.confidence,
        observed=entry["observed"].format(t=fmt_t(c.t), note=c.note), why=entry["why"],
        rule=norm_for(entry),
        evidence=[Evidence(t, to_jpeg_b64(img)) for t, img in frames])


def analyze(video_path, deadline_s: float = 240.0, on_progress=None, client=None, workers: int = 8) -> AnalysisResult:
    started = time.monotonic()
    progress = on_progress or (lambda stage, value: None)
    client = client or VLMClient()

    def left() -> float:
        return deadline_s - (time.monotonic() - started)

    progress("decode", 0.0)
    duration, _ = probe(video_path)
    ts, small = low_res_stream(video_path)
    times = choose_times(duration, ts, motion_score(small))
    frames = sample_frames(video_path, times)

    progress("detect", 0.2)
    progress("scene", 0.3)
    samples = sense(client, frames, workers=workers)
    degraded = len(samples) < max(1, len(frames) // 2)
    scene = Scene(samples, duration)
    cands = run_rules(scene)

    progress("verify", 0.7)
    for hook in STAGE_HOOKS:
        if left() < 40:
            degraded = True
            break
        cands = hook(cands, scene, client, video_path, left())

    violations = [to_violation(c, video_path, duration) for c in sorted(cands, key=lambda c: c.t)]
    progress("done", 1.0)
    return AnalysisResult(duration_sec=duration, violations=violations, timeline=scene.timeline_json(),
                          rules_checked=len(RULES), processing_sec=time.monotonic() - started,
                          degraded=degraded)
