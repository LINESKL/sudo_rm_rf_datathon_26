from ml.pipeline import analyze
from tests.test_timeline import _st

def _leaving_vlm(fake_vlm_cls):
    calls = {"n": 0}
    def by_order(imgs, prompt):
        calls["n"] += 1
        return _st() if calls["n"] <= 4 else _st(cashier_present=False, cashier_at_workplace=False)
    return fake_vlm_cls(by_order)

def test_analyze_detects_unlocked_leave(tiny_video, fake_vlm_cls):
    stages = []
    r = analyze(tiny_video, client=_leaving_vlm(fake_vlm_cls), on_progress=lambda s, v: stages.append(s), workers=1)
    assert r.verdict == "violation"
    v = [x for x in r.violations if x.type_id == "workstation_unlocked"][0]
    assert 1 <= len(v.evidence) <= 3
    assert all(0 <= e.timestamp_sec <= r.duration_sec for e in v.evidence)
    assert "Норматив:" in v.description()
    assert stages[0] == "decode" and stages[-1] == "done"

def test_analyze_clean(tiny_video, fake_vlm_cls):
    r = analyze(tiny_video, client=fake_vlm_cls(lambda i, p: _st()), workers=1)
    assert r.verdict == "no_violation" and r.rules_checked > 0
    assert set(r.to_jury("j")) == {"job_id", "status", "verdict", "violations"}

def test_analyze_vlm_down_raises(tiny_video, fake_vlm_cls):
    import pytest
    with pytest.raises(RuntimeError, match="degraded"):
        analyze(tiny_video, client=fake_vlm_cls(lambda i, p: None), workers=1)


def test_min_confidence_filters(tiny_video, fake_vlm_cls, monkeypatch):
    import ml.pipeline as p
    monkeypatch.setattr(p, "MIN_CONFIDENCE", 0.99)
    assert p.analyze(tiny_video, client=_leaving_vlm(fake_vlm_cls), workers=1).verdict == "no_violation"


def test_open_pass_not_in_default_stages():
    from ml.open_pass import open_pass
    from ml.pipeline import STAGE_HOOKS
    assert open_pass not in STAGE_HOOKS
