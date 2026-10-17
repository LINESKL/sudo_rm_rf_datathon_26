from ml.open_pass import open_pass
from ml.rules import Candidate
from ml.timeline import Scene

def test_open_pass_adds_other_and_dedupes(tiny_video, fake_vlm_cls):
    vlm = fake_vlm_cls(lambda i, p: {"violation": "other", "note": "Кассир передаёт ключ клиенту."})
    out = open_pass([], Scene([], 4.0), vlm, tiny_video, 200.0)
    assert len(out) == 1 and out[0].type_id == "other_security_risk" and "ключ" in out[0].note

def test_open_pass_skips_known_nearby(tiny_video, fake_vlm_cls):
    vlm = fake_vlm_cls(lambda i, p: {"violation": "phone_use", "note": "x"})
    existing = [Candidate("phone_use", 1.0, 2.0, 0.7)]
    assert open_pass(existing, Scene([], 4.0), vlm, tiny_video, 200.0) == existing

def test_open_pass_ignores_malformed(tiny_video, fake_vlm_cls):
    vlm = fake_vlm_cls(lambda i, p: {"cashier_present": True})
    assert open_pass([], Scene([], 4.0), vlm, tiny_video, 200.0) == []

def test_open_pass_skipped_when_late(tiny_video, fake_vlm_cls):
    vlm = fake_vlm_cls(lambda i, p: {"violation": "other", "note": "x"})
    assert open_pass([], Scene([], 4.0), vlm, tiny_video, 30.0) == []
