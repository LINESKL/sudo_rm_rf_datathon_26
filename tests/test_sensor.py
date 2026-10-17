from PIL import Image

from ml.sensor import STATE_SCHEMA, sense

STATE = {"cashier_present": True, "cashier_holding_phone": False, "cashier_eating_or_drinking": False,
         "laptop_screen": "app_visible", "safe_door_open": "no", "key_in_safe_lock": "no",
         "cash_on_desk": False, "collection_bag_on_desk": False, "personal_items_on_desk": False,
         "other_person_on_cashier_side": False, "people_count": 1}

def test_schema_requires_all_keys():
    assert set(STATE_SCHEMA["required"]) == set(STATE)

def test_sense_skips_failed_frames(fake_vlm_cls):
    answers = iter([STATE, None, STATE])
    vlm = fake_vlm_cls(lambda imgs, p: next(answers))
    frames = [(t, Image.new("RGB", (8, 8))) for t in (0.0, 0.5, 1.0)]
    out = sense(vlm, frames, workers=1)
    assert [t for t, _ in out] == [0.0, 1.0]

def test_sense_drops_answers_missing_keys(fake_vlm_cls):
    vlm = fake_vlm_cls(lambda imgs, p: {"cashier_present": True})
    assert sense(vlm, [(0.0, Image.new("RGB", (8, 8)))], workers=1) == []
