import numpy as np

from ml.quality import degraded_intervals, mark_degraded


def _frames(values):
    return np.stack([np.full((4, 4), v, np.uint8) for v in values])


def test_dark_and_overexposed_frames_are_degraded():
    ts = [i / 4 for i in range(12)]
    vals = [120] * 4 + [5] * 4 + [250] * 4
    iv = degraded_intervals(ts, _frames(vals))
    assert iv and iv[0][0] <= 1.0 and iv[-1][1] >= 2.75


def test_exposure_jump_is_degraded_around_the_jump():
    ts = [i / 4 for i in range(20)]
    vals = [100] * 10 + [170] * 10  # sudden +70 at t=2.5 s
    iv = degraded_intervals(ts, _frames(vals))
    assert any(a <= 2.5 <= b for a, b in iv)


def test_frozen_stream_is_degraded():
    ts = [i / 4 for i in range(20)]
    rng = np.random.default_rng(0)
    frames = rng.integers(60, 200, (20, 4, 4), dtype=np.uint8)
    frames[8:20] = frames[8]  # identical frames for 3 s
    iv = degraded_intervals(ts, frames)
    assert any(a <= 3.0 and b >= 4.5 for a, b in iv)


def test_normal_video_has_no_degraded_intervals():
    ts = [i / 4 for i in range(20)]
    rng = np.random.default_rng(1)
    assert degraded_intervals(ts, rng.integers(90, 160, (20, 4, 4), dtype=np.uint8)) == []


def test_mark_degraded_overrides_visibility():
    samples = [(1.0, {"workplace_visible": "visible"}), (5.0, {"workplace_visible": "visible"})]
    out = mark_degraded(samples, [(0.5, 2.0)])
    assert out[0][1]["workplace_visible"] == "degraded" and out[1][1]["workplace_visible"] == "visible"
