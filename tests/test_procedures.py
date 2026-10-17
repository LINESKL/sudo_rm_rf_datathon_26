from ml.procedures import check_procedures

def _types(c): return {x.type_id: x.t for x in c}

def test_id_check_skipped():
    w = [(0.0, {"client_hands_over_cash"}), (4.0, {"counting_machine"})]
    assert _types(check_procedures(w)) == {"id_check_skipped": 0.0}

def test_id_checked_ok():
    w = [(0.0, {"id_document_check"}), (4.0, {"client_hands_over_cash", "counting_machine"})]
    assert check_procedures(w) == []

def test_banknote_check_skipped():
    w = [(0.0, {"id_document_check", "client_hands_over_cash"}), (4.0, {"counting_by_hand"})]
    assert "banknote_check_skipped" in _types(check_procedures(w))

def test_bag_acceptance():
    w = [(0.0, {"bag_handover"}), (4.0, {"courier_leaves"}), (8.0, {"bag_opened"})]
    assert _types(check_procedures(w)) == {"bag_acceptance_violation": 4.0}

def test_bag_ok_courier_stays():
    w = [(0.0, {"bag_handover"}), (4.0, {"bag_opened"}), (12.0, {"courier_leaves"})]
    assert check_procedures(w) == []
