from __future__ import annotations

import time

from ml.catalog import fmt_t, load_catalog, norm_for
from ml.quality import degraded_intervals, mark_degraded
from ml.rules import RULES, Candidate, run_rules
from ml.sampling import choose_times, motion_score
from ml.sensor import sense
from ml.timeline import Scene
from ml.types import AnalysisResult, Evidence, Violation
from ml.video import low_res_stream, probe, sample_frames, to_jpeg_b64
from ml.vlm import VLMClient

MIN_CONFIDENCE = 0.5  # открытый проход без подтверждения (0.3–0.45) не проходит

STAGE_HOOKS: list = []  # (cands, scene, client, video_path, time_left) -> cands

from ml.actions import actions_hook  # noqa: E402
from ml.outsider import outsider_hook  # noqa: E402
from ml.screen import screen_hook  # noqa: E402
from ml.verify import verify  # noqa: E402

# Order = value per GPU second: under load the later hooks are skipped by the deadline.
# verify (few calls) -> door/counting actions (most finds) -> zoomed screen/desk -> outsider windows (fewest).
STAGE_HOOKS.extend([verify, actions_hook, screen_hook, outsider_hook])

# ponytail: procedure windows (ml/procedures.py) are off — 0 finds on 40 videos, a third of the GPU load.
# ponytail: open pass (ml/open_pass.py) is off — on 32 videos it produced only false positives.


def too_many_failures(failures: int, calls: int) -> bool:
    """A few failed VLM answers out of dozens do not make the analysis incomplete."""
    return failures > max(2, 0.1 * calls)


def sensor_stop(started: float, deadline_s: float) -> float:
    """The frame sensor gets 37.5 % of the budget (90 of 240 s): idle it needs 20–40 s,
    under load the window checks after it need the rest."""
    return started + deadline_s * 0.375


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
    failures_before = getattr(client, "failures", 0)
    calls_before = getattr(client, "calls", 0)

    def left() -> float:
        return deadline_s - (time.monotonic() - started)

    progress("decode", 0.0)
    duration, _ = probe(video_path)
    ts, small = low_res_stream(video_path)
    times = choose_times(duration, ts, motion_score(small))
    frames = sample_frames(video_path, times)

    progress("detect", 0.2)
    progress("scene", 0.3)
    samples = sense(client, frames, workers=workers, stop_at=sensor_stop(started, deadline_s))
    if frames and not samples:
        raise RuntimeError("VLM unavailable: no frame could be analysed (degraded)")
    degraded = not samples or len(samples) != len(frames)
    samples = mark_degraded(samples, degraded_intervals(ts, small))
    scene = Scene(samples, duration)
    cands = run_rules(scene)

    progress("verify", 0.7)
    for hook in STAGE_HOOKS:
        if left() < 40:
            degraded = True
            break
        cands = hook(cands, scene, client, video_path, left())

    cands = [c for c in cands if c.confidence >= MIN_CONFIDENCE]
    violations = [to_violation(c, video_path, duration) for c in sorted(cands, key=lambda c: c.t)]
    failed = getattr(client, "failures", 0) - failures_before
    degraded |= too_many_failures(failed, getattr(client, "calls", 0) - calls_before) or left() <= 0
    progress("done", 1.0)
    return AnalysisResult(duration_sec=duration, violations=violations, timeline=scene.timeline_json(),
                          rules_checked=len(RULES), processing_sec=time.monotonic() - started,
                          degraded=degraded)
