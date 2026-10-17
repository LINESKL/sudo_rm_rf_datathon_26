from ml.rules import run_rules
from ml.timeline import Scene
from tests.test_timeline import _st

def _scene(states, step=0.5):
    return Scene([(i * step, s) for i, s in enumerate(states)], len(states) * step)

def _types(cands): return {c.type_id for c in cands}

def test_leave_found_and_screen_left_to_ml_screen():
    st = [_st()] * 10 + [_st(cashier_present=False)] * 10
    c = [x for x in run_rules(_scene(st)) if x.type_id == "cash_unattended"]
    assert len(c) == 1 and c[0].t == 5.0
    assert "workstation_unlocked" not in _types(run_rules(_scene(st)))  # frame flag mistook lock wallpaper

def test_locked_screen_on_leave_is_clean():
    st = [_st()] * 10 + [_st(cashier_present=False, laptop_screen="lock_screen")] * 10
    assert not _types(run_rules(_scene(st))) & {"workstation_unlocked", "workstation_left_open"}

def test_absent_from_start_is_not_leave():
    st = [_st(cashier_present=False)] * 10 + [_st()] * 10
    assert "cash_unattended" not in _types(run_rules(_scene(st)))

def test_every_leave_is_a_cash_unattended_candidate():
    # frame-level cash/bag flags miss small objects; the verifier decides on the leave frames
    st = [_st(laptop_screen="closed")] * 10 + [_st(cashier_present=False, laptop_screen="closed")] * 10
    c = [x for x in run_rules(_scene(st)) if x.type_id == "cash_unattended"]
    assert c and c[0].t == 5.0

def test_phone_and_outsider_are_not_frame_rules():
    # 40 videos: frame phone flag gave 4 false alarms per hit; outsider is found by ml.outsider windows
    st = [_st()] * 4 + [_st(cashier_holding_phone=True, other_person_on_cashier_side=True, people_count=2)] * 10
    assert not _types(run_rules(_scene(st))) & {"phone_use", "outsider_cashier_zone"}

def test_personal_items_eating_outsider():
    t = _types(run_rules(_scene([_st(personal_items_on_desk=True, cashier_eating_or_drinking=True,
                                     other_person_on_cashier_side=True, people_count=2)] * 10)))
    assert {"personal_items", "eating_drinking"} <= t

def test_clean_video_no_candidates():
    assert run_rules(_scene([_st()] * 20)) == []


def test_walking_away_inside_room_counts_as_leave():
    st = [_st()] * 10 + [_st(cashier_at_workplace=False)] * 10  # still in room, away from desk
    c = [x for x in run_rules(_scene(st)) if x.type_id == "cash_unattended"]
    assert len(c) == 1 and c[0].t == 5.0


def test_dark_screen_on_leave_is_clean():
    st = [_st()] * 10 + [_st(cashier_at_workplace=False, laptop_screen="dark_or_off")] * 10
    assert not _types(run_rules(_scene(st))) & {"workstation_unlocked"}


def test_eating_needs_2s():
    brief = [_st()] * 4 + [_st(cashier_eating_or_drinking=True)] * 3 + [_st()] * 4
    assert "eating_drinking" not in _types(run_rules(_scene(brief)))


def test_leave_requires_visible_workplace():
    # VLM says "not at workplace" but the workplace itself is occluded/degraded: not a leave
    st = [_st()] * 10 + [_st(cashier_at_workplace=False, workplace_visible="occluded")] * 10
    assert "cash_unattended" not in _types(run_rules(_scene(st)))
