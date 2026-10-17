from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from eval.labels import load_labels
from eval.metrics import score
from ml import analyze


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    only = {s.strip().replace("X", "Х") for s in a.only.split(",") if s.strip()}
    rows = []
    for lab in load_labels(a.labels, a.videos):
        if only and lab["name"] not in only:
            continue
        t0 = time.monotonic()
        try:
            res = analyze(lab["path"])
            details = res.to_details(lab["name"], "")
            verdict, times = res.verdict, [v.timecode_sec for v in res.violations]
            if res.degraded:
                details["error"] = "Incomplete ML analysis (degraded)"
                verdict, times = "error", []
        except Exception as e:  # прогон не должен падать из-за одного видео
            details, verdict, times = {"error": repr(e)}, "error", []
        sec = time.monotonic() - t0
        (out / f"{lab['name']}.json").write_text(json.dumps(details, ensure_ascii=False, indent=1), encoding="utf-8")
        rows.append(lab | {"pred_verdict": verdict, "pred_times": times, "sec": sec,
                           "pred_types": [v["type_id"] for v in details.get("violations", [])]})
        print(f"{lab['name']}: label={lab['violation']} {lab['times']} -> {verdict} {times} ({sec:.0f}s)", flush=True)
    s = score(rows)
    lines = ["# Eval report", "",
             *(f"- **{k}**: {v:.3f}" if isinstance(v, float) else f"- **{k}**: {v}" for k, v in s.items()), "",
             "| video | label | t | pred | t_pred | types | sec |", "|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['name']} | {'V' if r['violation'] else '-'} | {r['times']} | {r['pred_verdict']} "
                     f"| {[round(t, 1) for t in r['pred_times']]} | {', '.join(r['pred_types'])} | {r['sec']:.0f} |")
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    (out / "rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(s, indent=1))


if __name__ == "__main__":
    main()
