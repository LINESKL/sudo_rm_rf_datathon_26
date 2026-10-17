from __future__ import annotations


def score(rows: list[dict], tol: float = 2.0) -> dict:
    pos = [r for r in rows if r["violation"]]
    neg = [r for r in rows if not r["violation"]]

    def pred(r):
        return r["pred_verdict"] == "violation"

    labels = [(t, r) for r in pos for t in r["times"]]
    hits = sum(any(abs(t - p) <= tol for p in r["pred_times"]) for t, r in labels)
    secs = [r["sec"] for r in rows] or [0]
    return {
        "n": len(rows),
        "accuracy": sum(pred(r) == r["violation"] for r in rows) / max(1, len(rows)),
        "recall": sum(pred(r) for r in pos) / max(1, len(pos)),
        "fp_clean": sum(pred(r) for r in neg) / max(1, len(neg)),
        "timecode_hit": hits / max(1, len(labels)),
        "mean_sec": sum(secs) / len(secs),
        "max_sec": max(secs),
    }
