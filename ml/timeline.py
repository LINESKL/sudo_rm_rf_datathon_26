from __future__ import annotations

from ml.types import TIMELINE_LABELS

SIGNALS = {
    "cashier_present": lambda s: s["cashier_present"],
    "cashier_absent": lambda s: not s["cashier_present"],
    "screen_unlocked": lambda s: s["laptop_screen"] == "app_visible",
    "screen_open_dark": lambda s: s["laptop_screen"] == "dark_or_off",
    "laptop_open": lambda s: s["laptop_screen"] in ("app_visible", "dark_or_off"),
    "cash_on_desk": lambda s: s["cash_on_desk"],
    "bag_on_desk": lambda s: s["collection_bag_on_desk"],
    "valuables_on_desk": lambda s: s["cash_on_desk"] or s["collection_bag_on_desk"],
    "safe_open": lambda s: s["safe_door_open"] == "yes",
    "key_in_lock": lambda s: s["key_in_safe_lock"] == "yes",
    "personal_items": lambda s: s["personal_items_on_desk"],
    "phone": lambda s: s["cashier_holding_phone"],
    "eating": lambda s: s["cashier_eating_or_drinking"],
    "outsider_in_cashier_zone": lambda s: s["other_person_on_cashier_side"],
}


def smooth(points, duration: float, window: int = 3, min_dur: float = 1.0, gap: float = 1.0):
    if not points:
        return []
    ts = [t for t, _ in points]
    vals = [bool(v) for _, v in points]
    half = window // 2
    sm = [sum(vals[max(0, i - half): i + half + 1]) * 2 > len(vals[max(0, i - half): i + half + 1])
          for i in range(len(vals))]
    ends = ts[1:] + [duration]
    raw = []
    for t, end, v in zip(ts, ends, sm):
        if not v:
            continue
        if raw and t - raw[-1][1] <= gap:
            raw[-1] = (raw[-1][0], end)
        else:
            raw.append((t, end))
    return [(round(a, 2), round(b, 2)) for a, b in raw if b - a >= min_dur]


class Scene:
    def __init__(self, samples, duration: float):
        self.samples = sorted(samples, key=lambda x: x[0])
        self.duration = duration
        self.intervals = {name: smooth([(t, fn(s)) for t, s in self.samples], duration)
                          for name, fn in SIGNALS.items()}

    def frac(self, signal: str, a: float, b: float) -> float:
        fn = SIGNALS[signal]
        vals = [fn(s) for t, s in self.samples if a <= t <= b]
        return sum(vals) / len(vals) if vals else 0.0

    def timeline_json(self) -> dict[str, list[list[float]]]:
        return {k: [list(iv) for iv in self.intervals.get(k, [])] for k in TIMELINE_LABELS}
