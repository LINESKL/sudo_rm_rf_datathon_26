from ml.rules import Candidate
from ml.verify import verify
import pytest

def test_verify_filters(tiny_video, fake_vlm_cls):
    answers = {"phone_use": "no", "personal_items": "yes", "eating_drinking": "unclear"}
    def responder(imgs, prompt):
        for k, q in (("phone_use", "smartphone"), ("personal_items", "handbag"), ("eating_drinking", "mouth")):
            if q in prompt:
                return {"answer": answers[k], "what_is_visible": "x"}
    cands = [Candidate("phone_use", 1.0, 2.0, 0.7), Candidate("personal_items", 1.0, 3.0, 0.75),
             Candidate("eating_drinking", 1.0, 2.0, 0.7)]
    out = {c.type_id: c for c in verify(cands, None, fake_vlm_cls(responder), tiny_video, 100.0)}
    assert "phone_use" not in out
    assert abs(out["personal_items"].confidence - 0.9) < 1e-9
    # unclear after 3 votes is not a confirmation: it must fall below MIN_CONFIDENCE
    from ml.pipeline import MIN_CONFIDENCE
    assert "eating_drinking" in out and out["eating_drinking"].confidence < MIN_CONFIDENCE

def test_verify_vlm_none_keeps(tiny_video, fake_vlm_cls):
    c = [Candidate("phone_use", 1.0, 2.0, 0.7)]
    assert verify(c, None, fake_vlm_cls(lambda i, p: None), tiny_video, 100.0) == c


@pytest.mark.parametrize("type_id", ["id_check_skipped", "banknote_check_skipped"])
def test_performed_check_disproves_skipped_check(tiny_video, fake_vlm_cls, type_id):
    cands = [Candidate(type_id, 1, 4, .5)]
    for answer in ("yes", "no"):
        client = fake_vlm_cls(lambda i, p: {"answer": answer, "what_is_visible": "fixture"})
        result = verify(cands, None, client, tiny_video, 100)
        assert bool(result) is (answer == "no")
