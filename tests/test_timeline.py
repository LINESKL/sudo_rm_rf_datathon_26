from ml.timeline import Scene, smooth
from ml.types import TIMELINE_LABELS

def _st(**kw):
    base = {"cashier_present": True, "cashier_at_workplace": True, "cashier_holding_phone": False, "cashier_eating_or_drinking": False,
            "laptop_screen": "app_visible", "safe_door_open": "no", "key_in_safe_lock": "no",
            "cash_on_desk": False, "collection_bag_on_desk": False, "personal_items_on_desk": False,
            "other_person_on_cashier_side": False, "people_count": 1}
    return base | kw

def test_smooth_removes_single_flicker():
    pts = [(i * 0.5, v) for i, v in enumerate([0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1])]
    assert smooth(pts, 6.0) == [(3.0, 6.0)]

def test_smooth_merges_small_gaps_and_drops_short():
    pts = [(i * 0.5, v) for i, v in enumerate([1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0])]
    assert smooth(pts, 6.0, min_dur=1.0) == [(0.0, 4.5)]

def test_scene_absent_interval_and_frac():
    samples = [(i * 0.5, _st(cashier_present=i < 10)) for i in range(20)]
    sc = Scene(samples, 10.0)
    assert sc.intervals["cashier_absent"] == [(5.0, 10.0)]
    assert sc.frac("screen_unlocked", 5.0, 10.0) == 1.0
    assert sc.frac("phone", 50.0, 60.0) == 0.0

def test_timeline_json_keys():
    sc = Scene([(0.0, _st()), (0.5, _st())], 1.0)
    assert set(sc.timeline_json()) == set(TIMELINE_LABELS)

def test_empty_scene():
    sc = Scene([], 2.0)
    assert sc.intervals["cashier_absent"] == []
