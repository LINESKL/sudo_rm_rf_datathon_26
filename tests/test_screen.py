from PIL import Image

from ml.screen import crop, screen_hook
from tests.test_rules import _scene
from tests.test_timeline import _st

LEAVE = [_st()] * 10 + [_st(cashier_present=False)] * 10  # leave at 5.0 s


def _vlm(fake_vlm_cls, screen):
    def responder(imgs, prompt):
        if "bounding boxes" in prompt:
            return {"laptop": [400, 400, 600, 500], "safe": [0, 0, 100, 100]}
        if "What does its screen show" in prompt:
            return {"screen": screen}
    return fake_vlm_cls(responder)


def test_document_on_screen_during_leave(tiny_video, fake_vlm_cls):
    c = screen_hook([], _scene(LEAVE), _vlm(fake_vlm_cls, "document_or_spreadsheet"), tiny_video, 100.0)
    assert [(x.type_id, x.t) for x in c] == [("workstation_unlocked", 5.0)]


def test_lock_screen_during_leave_is_clean(tiny_video, fake_vlm_cls):
    assert screen_hook([], _scene(LEAVE), _vlm(fake_vlm_cls, "lock_screen_wallpaper"), tiny_video, 100.0) == []


def test_no_leave_no_calls(tiny_video, fake_vlm_cls):
    client = _vlm(fake_vlm_cls, "document_or_spreadsheet")
    assert screen_hook(["x"], _scene([_st()] * 20), client, tiny_video, 100.0) == ["x"] and client.calls == 0


def test_crop_stays_inside_image():
    img = Image.new("RGB", (464, 848))
    c = crop(img, [950, 950, 1000, 1000])
    assert c.width >= 28 and c.height >= 28
