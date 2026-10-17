"""Unlocked workstation: on every leave, find the laptop once (grounding) and classify its zoomed screen.
The per-frame flag took a Windows lock-screen wallpaper for an open app; a zoomed crop does not
(40 videos: "document" only on Х-11 and Х-28, both violations; every clean twin is lock/black/closed)."""
from __future__ import annotations

from PIL import Image

from ml.catalog import load_catalog
from ml.rules import Candidate, _leaves
from ml.video import sample_frames

# Prompts, schemas and token limits are kept verbatim from the validated experiment (cache keys).
BOX_SCHEMA = {"type": "object",
              "properties": {"laptop": {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4},
                             "safe": {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4}},
              "required": ["laptop", "safe"]}
GROUND = ("Overhead CCTV of a bank cashier room. Give bounding boxes [x1,y1,x2,y2] in 0-1000 normalized coordinates of "
          "(laptop) the laptop on the cashier's desk including its screen, and (safe) the safe / metal cabinet where cash is kept.")
SCREEN_SCHEMA = {"type": "object", "properties": {"screen": {"type": "string", "enum": [
    "document_or_spreadsheet", "lock_screen_wallpaper", "black_or_off", "closed_or_not_visible"]}}, "required": ["screen"]}
SCREEN_Q = ("Zoomed crop of a laptop. What does its screen show? document_or_spreadsheet: a mostly white or light application window "
            "with rows, cells, text or toolbars. lock_screen_wallpaper: a full-screen photo or landscape picture (Windows lock screen), "
            "possibly with a big clock. black_or_off: a dark screen. closed_or_not_visible: lid closed or screen not visible.")


def crop(img: Image.Image, box, pad: float = 0.15) -> Image.Image:
    W, H = img.size
    x1, y1, x2, y2 = [v / 1000 for v in box]
    px, py = (x2 - x1) * pad, (y2 - y1) * pad
    left, top = max(0, int((x1 - px) * W)), max(0, int((y1 - py) * H))
    right, bottom = min(W, int((x2 + px) * W)), min(H, int((y2 + py) * H))
    c = img.crop((left, top, max(right, left + 1), max(bottom, top + 1)))
    s = min(3.0, 560 / max(c.size))
    c = c.resize((max(28, int(c.width * s)), max(28, int(c.height * s))), Image.LANCZOS)
    c.info["src"] = img.info.get("src", "") + f"#{box}"
    return c


def screen_hook(cands, scene, client, video_path, time_left):
    leaves = _leaves(scene)
    if not leaves or not scene.samples:
        return cands
    first = sample_frames(video_path, [scene.samples[0][0]])[0][1]
    boxes = client.ask_json([first], GROUND, BOX_SCHEMA, max_tokens=80)
    if not isinstance(boxes, dict) or "laptop" not in boxes:
        return cands
    conf = float(load_catalog()["workstation_unlocked"]["confidence"])
    out = []
    for a, b in leaves:
        answers = [client.ask_json([crop(im, boxes["laptop"])], SCREEN_Q, SCREEN_SCHEMA, max_tokens=30)
                   for _, im in sample_frames(video_path, [a + 1.0, min(b, a + 3.0)])]
        if all(isinstance(x, dict) and x.get("screen") == "document_or_spreadsheet" for x in answers):
            out.append(Candidate("workstation_unlocked", a, b, max(conf, 0.75)))
            break
    return cands + out
