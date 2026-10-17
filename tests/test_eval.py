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
