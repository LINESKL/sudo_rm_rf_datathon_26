from ml.rules import run_rules
from ml.timeline import Scene
from tests.test_timeline import _st

def _scene(states, step=0.5):
    return Scene([(i * step, s) for i, s in enumerate(states)], len(states) * step)

def _types(cands): return {c.type_id for c in cands}

def test_unlocked_on_leave():
    st = [_st()] * 10 + [_st(cashier_present=False)] * 10
    c = [x for x in run_rules(_scene(st)) if x.type_id == "workstation_unlocked"]
    assert len(c) == 1 and c[0].t == 5.0

def test_locked_screen_on_leave_is_clean():
    st = [_st()] * 10 + [_st(cashier_present=False, laptop_screen="lock_screen")] * 10
    assert not _types(run_rules(_scene(st))) & {"workstation_unlocked", "workstation_left_open"}

def test_absent_from_start_is_not_leave():
    st = [_st(cashier_present=False)] * 10 + [_st()] * 10
    assert "workstation_unlocked" not in _types(run_rules(_scene(st)))

def test_cash_unattended():
    st = [_st(cash_on_desk=True, laptop_screen="closed")] * 10 + \
         [_st(cashier_present=False, cash_on_desk=True, laptop_screen="closed")] * 10
    c = [x for x in run_rules(_scene(st)) if x.type_id == "cash_unattended"]
    assert c and c[0].t == 5.0

def test_client_phone_does_not_trigger_and_cashier_phone_does():
    assert "phone_use" not in _types(run_rules(_scene([_st(people_count=2)] * 10)))
    assert "phone_use" in _types(run_rules(_scene([_st()] * 4 + [_st(cashier_holding_phone=True)] * 8)))

def test_personal_items_eating_outsider():
    t = _types(run_rules(_scene([_st(personal_items_on_desk=True, cashier_eating_or_drinking=True,
                                     other_person_on_cashier_side=True)] * 10)))
    assert {"personal_items", "eating_drinking", "outsider_cashier_zone"} <= t

def test_clean_video_no_candidates():
    assert run_rules(_scene([_st()] * 20)) == []


def test_walking_away_inside_room_counts_as_leave():
    st = [_st()] * 10 + [_st(cashier_at_workplace=False)] * 10  # still in room, away from desk
    c = [x for x in run_rules(_scene(st)) if x.type_id == "workstation_unlocked"]
    assert len(c) == 1 and c[0].t == 5.0
