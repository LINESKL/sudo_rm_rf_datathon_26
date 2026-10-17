from ml.outsider import find_outsider, outsider_hook


def test_first_yes_window_gives_one_candidate(tiny_video, fake_vlm_cls):
    # windows start every 2 s; the answer depends on which frames are sent
    def responder(imgs, prompt):
        return {"answer": "yes" if "t=4s" in prompt else "no", "what_is_visible": "man behind cashier"}
    c = find_outsider(fake_vlm_cls(responder), tiny_video, 8.0)
    assert [(x.type_id, x.t) for x in c] == [("outsider_cashier_zone", 3.5)]


def test_no_outsider(tiny_video, fake_vlm_cls):
    client = fake_vlm_cls(lambda i, p: {"answer": "no", "what_is_visible": "cashier alone"})
    assert find_outsider(client, tiny_video, 8.0) == []


def test_hook_keeps_earlier_candidates(tiny_video, fake_vlm_cls):
    class S: duration = 8.0
    client = fake_vlm_cls(lambda i, p: None)
    assert outsider_hook(["x"], S(), client, tiny_video, 100.0) == ["x"]


def test_window_budget(tiny_video, fake_vlm_cls):
    from ml.outsider import window_starts
    assert len(window_starts(200.0)) <= 30 and window_starts(8.0) == [0.0, 2.0, 4.0]
    class S: duration = 8.0
    client = fake_vlm_cls(lambda i, p: {"answer": "yes", "what_is_visible": "x"})
    assert outsider_hook([], S(), client, tiny_video, 30.0) == [] and client.calls == 0  # no time left
