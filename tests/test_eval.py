import openpyxl

from eval.labels import load_labels, norm_name, parse_ts
from eval.metrics import score

def test_parse_ts():
    assert parse_ts("22 секунда") == 22.0
    assert parse_ts("1минута 8 секунда") == 68.0
    assert parse_ts(None) is None and parse_ts("") is None

def test_norm_name():
    assert norm_name("X-1.mov") == "Х-1" and norm_name("Х-12") == "Х-12"

def test_load_labels_merges_duplicates(tmp_path, tiny_video):
    vids = tmp_path / "videos"; vids.mkdir()
    for n in ("Х-4.mov", "Х-47.mov", "X-1.mov"):
        (vids / n).write_bytes(tiny_video.read_bytes() if n != "X-1.mov" else b"other")
    wb = openpyxl.Workbook(); ws = wb.active
    ws.append(["наименование файла", "таймстемп", "нарушение / без нарушения"])
    ws.append(["Х-4", "57 секунда", "нарушение"]); ws.append(["Х-47", "1минута 8 секунда", "нарушение"])
    ws.append(["X-1", "22 секунда", "нарушение"])
    xlsx = tmp_path / "l.xlsx"; wb.save(xlsx)
    rows = {r["name"]: r for r in load_labels(xlsx, vids)}
    assert set(rows) == {"Х-4", "Х-1"} and rows["Х-4"]["times"] == [57.0, 68.0]

def test_score():
    rows = [
        {"name": "a", "violation": True, "times": [10.0], "pred_verdict": "violation", "pred_times": [11.5], "sec": 50},
        {"name": "b", "violation": True, "times": [5.0], "pred_verdict": "no_violation", "pred_times": [], "sec": 40},
        {"name": "c", "violation": False, "times": [], "pred_verdict": "violation", "pred_times": [3.0], "sec": 30},
        {"name": "d", "violation": False, "times": [], "pred_verdict": "no_violation", "pred_times": [], "sec": 20},
    ]
    s = score(rows)
    assert s["accuracy"] == 0.5 and s["recall"] == 0.5 and s["fp_clean"] == 0.5
    assert s["timecode_hit"] == 0.5 and s["max_sec"] == 50


def test_error_is_not_a_correct_clean_prediction():
    rows = [{"violation": False, "times": [], "pred_verdict": "error", "pred_times": [], "sec": 1}]
    assert score(rows)["accuracy"] == 0 and score(rows)["errors"] == 1


def test_degraded_eval_is_delivered_and_flagged(tmp_path, monkeypatch):
    import json
    import sys
    from eval import run_eval
    from ml.types import AnalysisResult

    monkeypatch.setattr(sys, "argv", ["eval", "--videos", "unused", "--labels", "unused", "--out", str(tmp_path)])
    monkeypatch.setattr(run_eval, "load_labels", lambda *a: [
        {"name": "Х-1", "path": "unused", "violation": False, "times": []}])
    monkeypatch.setattr(run_eval, "analyze", lambda *a: AnalysisResult(8, [], {}, 8, degraded=True))
    run_eval.main()
    rows = json.loads((tmp_path / "rows.json").read_text(encoding="utf-8"))
    # Same as the API: the jury receives the verdict; the row records it was incomplete.
    assert rows[0]["pred_verdict"] == "no_violation" and rows[0]["degraded"] is True
    assert score(rows)["accuracy"] == 1


def test_run_eval_jobs_runs_videos_concurrently(tmp_path, monkeypatch):
    import threading
    import time as _t

    import eval.run_eval as run_eval
    from ml.types import AnalysisResult

    labels = [{"name": f"Х-{i}", "path": f"/v/{i}.mov", "violation": False, "times": []} for i in range(4)]
    monkeypatch.setattr(run_eval, "load_labels", lambda x, v: labels)
    active, peak, lock = [0], [0], threading.Lock()

    def fake_analyze(path):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        _t.sleep(0.2)
        with lock:
            active[0] -= 1
        return AnalysisResult(duration_sec=1.0, violations=[], timeline={}, rules_checked=1)

    monkeypatch.setattr(run_eval, "analyze", fake_analyze)
    monkeypatch.setattr("sys.argv", ["run_eval", "--videos", "v", "--labels", "l", "--out", str(tmp_path), "--jobs", "3"])
    run_eval.main()
    import json
    assert len(json.loads((tmp_path / "rows.json").read_text())) == 4
    assert peak[0] >= 2
