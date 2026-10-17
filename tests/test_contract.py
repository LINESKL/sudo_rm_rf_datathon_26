import base64
from copy import deepcopy
from io import BytesIO

import pytest
from PIL import Image
from pydantic import ValidationError
from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.schemas import JobOutput
from backend.app.store import Store
from tests.test_api import HEADERS


def image_b64(format="JPEG"):
    stream = BytesIO()
    Image.new("RGB", (8, 8), "red").save(stream, format=format)
    return base64.b64encode(stream.getvalue()).decode()


def payload(count=1, rule=None):
    violations = [{
        "type": "Новый тип события", "timecode_sec": .123, "description": "Наблюдение. Требуется проверка.",
        "evidence_frames": [{"timestamp_sec": .123, "image_base64": image_b64()}],
    } for _ in range(count)]
    return {
        "jury": {"job_id": "1" * 32, "status": "done", "verdict": "violation" if count else "no_violation",
                 "violations": deepcopy(violations)},
        "details": {"job_id": "1" * 32, "status": "done", "verdict": "violation" if count else "no_violation",
                    "duration_sec": 1, "progress": {"stage": "done", "value": 1}, "preview_url": None,
                    "violations": [dict(v, type_id="new_type", timecode_end_sec=.8, confidence=.7,
                                        confidence_level="medium", observed="Описание наблюдения.",
                                        why="Объяснение для проверки.", rule=rule) for v in violations]},
    }


@pytest.mark.parametrize("count", [0, 1, 4])
@pytest.mark.parametrize("rule", [None, {"document": "Источник без точного пункта", "url": "https://example.org/source"}])
def test_zero_one_many_events_both_http_projections(settings, video, count, rule):
    app = create_app(settings)
    with TestClient(app) as client:
        output = JobOutput.model_validate(payload(count, rule))
        store = app.state.store
        store.create(output.jury.job_id, video, 1)
        store.start(output.jury.job_id)
        store.finish(output.jury.job_id, output)
        jury = client.get(f"/api/v1/jobs/{output.jury.job_id}", headers=HEADERS).json()
        details = client.get(f"/api/v1/jobs/{output.jury.job_id}/details", headers=HEADERS).json()
        assert jury["verdict"] == details["verdict"]
        assert len(jury["violations"]) == len(details["violations"]) == count
        for simple, rich in zip(jury["violations"], details["violations"]):
            assert simple == {key: rich[key] for key in simple}
            assert simple["timecode_sec"] == .123
            if rule:
                assert rich["rule"]["point"] is None and rich["rule"]["quote"] is None
            else:
                assert rich["rule"] is None


@pytest.mark.parametrize("case", ["false_clean", "empty_violation", "projection", "blank_description", "blank_why",
                                  "png", "truncated", "no_frames", "four_frames", "time_outside", "bad_timeline",
                                  "timeline_without_duration", "unsafe_url"])
def test_invalid_ml_results_are_rejected(case):
    data = payload()
    simple, rich = data["jury"]["violations"][0], data["details"]["violations"][0]
    if case == "false_clean":
        data["jury"]["verdict"] = data["details"]["verdict"] = "no_violation"
    elif case == "empty_violation":
        data["jury"]["violations"] = data["details"]["violations"] = []
    elif case == "projection":
        rich["description"] = "Противоречащий результат"
    elif case == "blank_description":
        simple["description"] = rich["description"] = "  "
    elif case == "blank_why":
        rich["why"] = ""
    elif case in ("png", "truncated"):
        value = image_b64("PNG") if case == "png" else "/9j/"
        simple["evidence_frames"][0]["image_base64"] = rich["evidence_frames"][0]["image_base64"] = value
    elif case in ("no_frames", "four_frames"):
        frames = [] if case == "no_frames" else [simple["evidence_frames"][0]] * 4
        simple["evidence_frames"] = rich["evidence_frames"] = frames
    elif case == "time_outside":
        simple["evidence_frames"][0]["timestamp_sec"] = rich["evidence_frames"][0]["timestamp_sec"] = 2
    elif case in ("bad_timeline", "timeline_without_duration"):
        data["details"]["timeline"] = {"state": [[.8, .2]]}
        if case == "timeline_without_duration":
            del data["details"]["duration_sec"]
    elif case == "unsafe_url":
        rich["rule"] = {"document": "Источник", "url": "javascript:alert(1)"}
    with pytest.raises(ValidationError):
        JobOutput.model_validate(data)


def test_source_duration_is_checked_when_serializer_omits_it(settings, video):
    data = payload()
    del data["details"]["duration_sec"]
    for violation in (data["jury"]["violations"][0], data["details"]["violations"][0]):
        violation["evidence_frames"][0]["timestamp_sec"] = 2
    result = JobOutput.model_validate(data)
    store = Store(settings.data_dir / "jobs.db")
    store.initialize()
    store.create(result.jury.job_id, video, 1)
    store.start(result.jury.job_id)
    with pytest.raises(ValidationError):
        store.finish(result.jury.job_id, result)
    assert store.get(result.jury.job_id)["status"] == "processing"
