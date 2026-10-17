import numpy as np

from ml.sampling import choose_times, motion_score

def test_motion_score():
    f = np.zeros((4, 2, 2), np.uint8); f[2] = 100
    s = motion_score(f)
    assert s[0] == 0 and s[2] == 100 and s[3] == 100

def test_base_rate_short_video():
    ts = [i / 4 for i in range(40)]
    times = choose_times(10.0, ts, np.zeros(40))
    assert times[0] == 0.0 and len(times) == 20
    assert times == sorted(set(times))

def test_densify_around_spike():
    ts = [i / 4 for i in range(80)]
    m = np.zeros(80); m[40] = 50.0  # всплеск на 10 с
    times = choose_times(20.0, ts, m)
    near = [t for t in times if 8.0 <= t <= 12.0]
    assert len(near) >= 15

def test_budget_and_long_video():
    ts = [i / 4 for i in range(600)]
    times = choose_times(150.0, ts, np.random.default_rng(0).random(600) * 50, budget=160)
    assert len(times) <= 160 and times[-1] <= 150.0

def test_tiny_video():
    assert choose_times(0.3, [0.0], np.zeros(1)) == [0.0]
