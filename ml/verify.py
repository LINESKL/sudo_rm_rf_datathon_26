from __future__ import annotations

from dataclasses import replace

from ml.catalog import load_catalog
from ml.video import sample_frames
from ml.vlm import map_parallel

VERIFY_SCHEMA = {
    "type": "object",
    "properties": {"answer": {"type": "string", "enum": ["yes", "no", "unclear"]},
                   "what_is_visible": {"type": "string"}},
    "required": ["answer", "what_is_visible"],
}

UNCLEAR_CONFIDENCE = 0.4  # below pipeline.MIN_CONFIDENCE: unverified finds are not reported

_PROMPT = ("Frames from overhead CCTV of a bank cashier room, in time order ({times}).\n"
           "Question: {q}\nAnswer yes, no or unclear and briefly describe what is visible.")


def _ask(client, frames, question):
    times = ", ".join(f"t={t:.1f}s" for t, _ in frames)
    ans = client.ask_json([im for _, im in frames], _PROMPT.format(times=times, q=question), VERIFY_SCHEMA)
    return ans.get("answer") if isinstance(ans, dict) else None


def verify(cands, scene, client, video_path, time_left, workers: int = 4):
    cat = load_catalog()

    def one(c):
        q = cat[c.type_id]["verify_question"].format(note=c.note)
        frames = sample_frames(video_path, [c.t - 1.0, c.t + 0.5, c.t + 2.0, min(c.t_end, c.t + 4.0)])
        ans = _ask(client, frames, q)
        if ans == "unclear":
            # Not a confirmation. Re-asking is pointless at temperature 0 (same answer every time).
            return replace(c, confidence=min(c.confidence, UNCLEAR_CONFIDENCE))
        violation_answer = cat[c.type_id].get("violation_answer", "yes")
        if ans in ("yes", "no") and ans != violation_answer:
            return None
        if ans == violation_answer:
            return replace(c, confidence=min(0.95, c.confidence + 0.15))
        return c

    return [c for c in map_parallel(one, cands, workers) if c is not None]
