"""Procedure/action checks from one questionnaire per 4-frame window (2 s step).
Many violations in the case are actions, not objects: a door left open, cash counted by hand without
the counting machine. Rules picked on 40 videos: +7 finds for +6 alarms on clean videos (acc 70 -> 72.5 %)."""
from __future__ import annotations

from ml.catalog import load_catalog
from ml.outsider import window_starts
from ml.rules import Candidate
from ml.video import sample_frames
from ml.vlm import map_parallel

MIN_TIME_LEFT = 60.0
DOOR_STREAK = 3  # one or two windows = someone walking in; three (~6 s) = left open
# Prompt, schema and token limit are verbatim from the validated experiment (VLM cache keys).
FIELDS = {
    "cashier_counts_cash_by_hand": "the cashier flips, fans or counts banknotes in her hands, or holds notes up to the light",
    "cash_in_counting_machine": "banknotes are placed into or run through the black counting machine on the desk",
    "courier_with_bag": "a cash courier with a green collection bag is in the room",
    "courier_leaves": "the courier (or a person who brought a bag) walks out through the door",
    "bag_opened": "the cashier opens, cuts or unseals the green bag or takes cash out of it",
    "door_left_open": "the glass entrance door of the room stands open",
    "cashier_holds_phone": "the cashier holds a smartphone in her hand",
    "other_reaches_cashier_side": "a person other than the cashier reaches over the desk to the counting machine, cash or the cashier's side",
    "client_hands_cash": "a client hands banknotes to the cashier",
    "cash_given_to_client": "the cashier hands banknotes to a client or a client takes cash from the desk",
}
# "what" is capped: an uncapped description hit max_tokens and cut the JSON (6 of 12 windows on X-1).
SCHEMA = {"type": "object", "properties": {**{k: {"type": "boolean"} for k in FIELDS},
                                           "what": {"type": "string", "maxLength": 160}},
          "required": [*FIELDS, "what"]}
PROMPT = ("Four frames in time order ({times}) from overhead CCTV of a bank cashier room. The cashier sits at the desk in front of the "
          "laptop; clients and couriers come to the opposite side of the desk. For each item answer true only if it happens in THESE frames:\n"
          + "\n".join(f"- {k}: {v}." for k, v in FIELDS.items()) + "\nThen briefly say what is visible.")


def ask_windows(client, video_path, duration: float, workers: int = 8) -> list[dict]:
    def one(s):
        frames = sample_frames(video_path, [s + k for k in range(4)])
        times = ", ".join(f"t={t:.0f}s" for t, _ in frames)
        ans = client.ask_json([im for _, im in frames], PROMPT.format(times=times), SCHEMA, max_tokens=500)
        ans = ans if isinstance(ans, dict) else {}
        return {"t": round(s, 1), **{k: bool(ans.get(k)) for k in FIELDS}}
    return map_parallel(one, window_starts(duration), workers)


def _last_streak(windows, key, n):
    """Start of the last run of >= n flagged windows. An early run is usually someone just walking in;
    on 40 videos the last run sits closer to the labelled moment (Х-4, Х-18, Х-30)."""
    found, run = None, 0
    for i, w in enumerate(windows):
        run = run + 1 if w[key] else 0
        if run == n:
            found = windows[i - n + 1]["t"]
    return found


def rules_from_windows(windows) -> list[Candidate]:
    cat, out = load_catalog(), []
    t = _last_streak(windows, "door_left_open", DOOR_STREAK)
    if t is not None:
        out.append(Candidate("door_left_open", t + 1.5, t + 2.0 * DOOR_STREAK, float(cat["door_left_open"]["confidence"])))
    hand = [w["t"] for w in windows if w["cashier_counts_cash_by_hand"]]
    if hand and not any(w["cash_in_counting_machine"] for w in windows):
        conf = max(float(cat["banknote_check_skipped"]["confidence"]), 0.6)
        out.append(Candidate("banknote_check_skipped", hand[0] + 1.5, hand[0] + 4.0, conf))
    return out


def actions_hook(cands, scene, client, video_path, time_left):
    if time_left < MIN_TIME_LEFT:
        return cands
    return cands + rules_from_windows(ask_windows(client, video_path, scene.duration))
