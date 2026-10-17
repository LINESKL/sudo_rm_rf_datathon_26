from PIL import Image

from ml.sensor import STATE_SCHEMA, sense

STATE = {"cashier_present": True, "cashier_at_workplace": True, "cashier_holding_phone": False, "cashier_eating_or_drinking": False,
         "laptop_screen": "app_visible", "safe_door_open": "no", "key_in_safe_lock": "no",
         "cash_on_desk": False, "collection_bag_on_desk": False, "personal_items_on_desk": False,
         "other_person_on_cashier_side": False, "people_count": 1}

def test_schema_requires_all_keys():
    assert set(STATE_SCHEMA["required"]) == set(STATE)

def test_sense_skips_failed_frames(fake_vlm_cls):
    vlm = fake_vlm_cls(lambda imgs, p: None if imgs[0].size == (9, 9) else STATE)  # frame order is coarse-to-fine
    frames = [(0.0, Image.new("RGB", (8, 8))), (0.5, Image.new("RGB", (9, 9))), (1.0, Image.new("RGB", (8, 8)))]
    out = sense(vlm, frames, workers=1)
    assert [t for t, _ in out] == [0.0, 1.0]

def test_sense_drops_answers_missing_keys(fake_vlm_cls):
    vlm = fake_vlm_cls(lambda imgs, p: {"cashier_present": True})
    assert sense(vlm, [(0.0, Image.new("RGB", (8, 8)))], workers=1) == []



def test_coarse_to_fine_order_covers_the_video_first():
    from ml.sensor import coarse_to_fine
    order = coarse_to_fine(9)
    assert sorted(order) == list(range(9)) and set(order[:3]) == {0, 4, 8}


def test_sense_stops_at_deadline_but_keeps_order(fake_vlm_cls):
    import time
    from ml.sensor import sense
    from tests.test_timeline import _st
    frames = [(float(i), object()) for i in range(6)]
    late = sense(fake_vlm_cls(lambda i, p: _st()), frames, workers=1, stop_at=time.monotonic() - 1)
    assert late == []
    full = sense(fake_vlm_cls(lambda i, p: _st()), frames, workers=2, stop_at=time.monotonic() + 60)
    assert [t for t, _ in full] == [float(i) for i in range(6)]
