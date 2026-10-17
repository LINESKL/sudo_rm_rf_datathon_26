from ml.types import AnalysisResult, Evidence, Violation, TIMELINE_LABELS

def _v(rule=None):
    return Violation(
        type_id="cash_unattended", title="Наличные или ценности оставлены без присмотра",
        timecode_sec=8.6, timecode_end_sec=14.0, confidence=0.8,
        observed="В 8,6 с кассир вышла, пачка денег на столе.",
        why="Деньги должны храниться в закрывающихся устройствах.",
        rule=rule, evidence=[Evidence(8.6, "AAA")])

def test_jury_dict_has_only_spec_keys():
    r = AnalysisResult(duration_sec=20.0, violations=[_v()], timeline={}, rules_checked=9)
    j = r.to_jury("abc")
    assert set(j) == {"job_id", "status", "verdict", "violations"}
    assert j["verdict"] == "violation"
    v = j["violations"][0]
    assert set(v) == {"type", "timecode_sec", "description", "evidence_frames"}
    assert set(v["evidence_frames"][0]) == {"timestamp_sec", "image_base64"}

def test_description_contains_norm_or_disclaimer():
    rule = {"document": "Постановление НБРК № 231", "point": "п. 20", "quote": "q", "url": "u"}
    assert "Постановление НБРК № 231, п. 20" in _v(rule).description()
    assert "Норматив не определён" in _v(None).description()

def test_no_violation_and_details_shape():
    r = AnalysisResult(duration_sec=5.0, violations=[], timeline={"cashier_present": [[0, 5]]}, rules_checked=9)
    assert r.to_jury("x")["verdict"] == "no_violation"
    d = r.to_details("x", "/previews/x.mp4")
    for key in ("status", "verdict", "progress", "stages", "duration_sec", "processing_sec",
                "rules_checked", "preview_url", "timeline", "timeline_labels", "violations"):
        assert key in d
    assert d["timeline_labels"] == TIMELINE_LABELS

def test_confidence_level():
    v = _v(); v.confidence = 0.4
    assert v.confidence_level == "low"
