from ml.actions import FIELDS, actions_hook, rules_from_windows


def _w(t, **on):
    return {"t": t, **{k: False for k in FIELDS}, **on}


def _types(cands):
    return [(c.type_id, c.t) for c in cands]


def test_door_open_three_windows_in_a_row():
    ws = [_w(0), _w(2, door_left_open=True), _w(4, door_left_open=True), _w(6, door_left_open=True), _w(8)]
    assert _types(rules_from_windows(ws)) == [("door_left_open", 3.5)]


def test_door_open_two_windows_is_not_enough():
    # 40 videos: a door open for one or two windows is routine (someone walks in)
    ws = [_w(0, door_left_open=True), _w(2, door_left_open=True), _w(4), _w(6, door_left_open=True)]
    assert rules_from_windows(ws) == []


def test_hand_counting_without_machine():
    ws = [_w(0), _w(2, cashier_counts_cash_by_hand=True), _w(4)]
    assert _types(rules_from_windows(ws)) == [("banknote_check_skipped", 3.5)]


def test_hand_counting_with_machine_is_clean():
    ws = [_w(0, cashier_counts_cash_by_hand=True), _w(2, cash_in_counting_machine=True)]
    assert rules_from_windows(ws) == []


def test_hook_skips_when_time_is_short(tiny_video, fake_vlm_cls):
    class S: duration = 8.0
    client = fake_vlm_cls(lambda i, p: {k: True for k in FIELDS} | {"what": "x"})
    assert actions_hook(["x"], S(), client, tiny_video, 30.0) == ["x"] and client.calls == 0


def test_hook_asks_windows_and_adds_finds(tiny_video, fake_vlm_cls):
    class S: duration = 8.0
    client = fake_vlm_cls(lambda i, p: {k: k == "door_left_open" for k in FIELDS} | {"what": "door open"})
    out = actions_hook([], S(), client, tiny_video, 100.0)
    assert [c.type_id for c in out] == ["door_left_open"] and client.calls == 3


def test_door_uses_the_last_open_streak():
    # a streak at the very start is usually someone just walking in; the later one is the event
    on = {"door_left_open": True}
    ws = [_w(0, **on), _w(2, **on), _w(4, **on), _w(6), _w(8, **on), _w(10, **on), _w(12, **on), _w(14)]
    assert _types(rules_from_windows(ws)) == [("door_left_open", 9.5)]
