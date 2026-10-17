from __future__ import annotations

from dataclasses import dataclass

from ml.catalog import load_catalog

LEAVE_MIN = 3.0


@dataclass
class Candidate:
    type_id: str
    t: float
    t_end: float
    confidence: float
    note: str = ""


def _conf(type_id: str) -> float:
    return float(load_catalog()[type_id]["confidence"])


def _leaves(scene):
    first = scene.samples[0][0] if scene.samples else 0.0
    return [(a, b) for a, b in scene.intervals["cashier_absent"] if a > first + 0.01 and b - a >= LEAVE_MIN]


def _on_leave(type_id, signal, min_frac=0.6):
    def rule(scene):
        return [Candidate(type_id, a, b, _conf(type_id))
                for a, b in _leaves(scene) if scene.frac(signal, a, b) >= min_frac]
    return rule


def _presence(type_id, signal, min_dur):
    def rule(scene):
        return [Candidate(type_id, a, b, _conf(type_id))
                for a, b in scene.intervals[signal] if b - a >= min_dur]
    return rule


def _cash_unattended(scene):
    out = []
    for a, b in scene.intervals["valuables_on_desk"]:
        for la, lb in scene.intervals["cashier_absent"]:
            s, e = max(a, la), min(b, lb)
            if e - s >= LEAVE_MIN:
                out.append(Candidate("cash_unattended", s, e, _conf("cash_unattended")))
    return out


def _safe_unsecured(scene):
    out = []
    for la, lb in _leaves(scene):
        if scene.frac("safe_open", la, lb) >= 0.5 or scene.frac("key_in_lock", la, lb) >= 0.5:
            out.append(Candidate("safe_unsecured", la, lb, _conf("safe_unsecured")))
    return out


RULES = {
    "workstation_unlocked": _on_leave("workstation_unlocked", "screen_unlocked"),
    "cash_unattended": _cash_unattended,
    "safe_unsecured": _safe_unsecured,
    "personal_items": _presence("personal_items", "personal_items", 3.0),
    "eating_drinking": _presence("eating_drinking", "eating", 1.0),
    "phone_use": _presence("phone_use", "phone", 2.0),
    "outsider_cashier_zone": _presence("outsider_cashier_zone", "outsider_in_cashier_zone", 1.5),
}


def run_rules(scene) -> list[Candidate]:
    out = []
    for rule in RULES.values():
        kept = []
        for c in sorted(rule(scene), key=lambda c: c.t):
            if len(kept) < 2 and all(abs(c.t - k.t) >= 5.0 for k in kept):
                kept.append(c)
        out += kept
    return sorted(out, key=lambda c: c.t)
