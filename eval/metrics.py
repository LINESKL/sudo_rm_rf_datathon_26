from __future__ import annotations


def score(rows: list[dict], tol: float = 2.0) -> dict:
    pos = [r for r in rows if r["violation"]]
    neg = [r for r in rows if not r["violation"]]

    def pred(r):
        return r["pred_verdict"] == "violation"

    labels = [(t, r) for r in pos for t in r["times"]]
    hits = sum(r["pred_verdict"] == "violation" and any(abs(t - p) <= tol for p in r["pred_times"])
               for t, r in labels)
    secs = [r["sec"] for r in rows] or [0]

    def hit_rate(t_tol):
        return sum(pred(r) and any(abs(t - p) <= t_tol for p in r["pred_times"]) for t, r in labels) / max(1, len(labels))

    pos_events = [(p, r) for r in pos if pred(r) for p in r["pred_times"]]
    matched = sum(any(abs(p - t) <= 5.0 for t in r["times"]) for p, r in pos_events)
    events = {
        **{f"hit@{k}s": hit_rate(k) for k in (1, 2, 5)},
        "event_precision@5s": matched / max(1, len(pos_events)),
        "fp_events_per_clean": sum(len(r["pred_times"]) for r in neg if pred(r)) / max(1, len(neg)),
    }
    return events | {
        "n": len(rows),
        "errors": sum(r["pred_verdict"] not in ("violation", "no_violation") for r in rows),
        "accuracy": sum(r["pred_verdict"] == ("violation" if r["violation"] else "no_violation")
                        for r in rows) / max(1, len(rows)),
        "recall": sum(pred(r) for r in pos) / max(1, len(pos)),
        "fp_clean": sum(pred(r) for r in neg) / max(1, len(neg)),
        "timecode_hit": hits / max(1, len(labels)),
        "mean_sec": sum(secs) / len(secs),
        "max_sec": max(secs),
    }
