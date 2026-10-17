from ml.catalog import fmt_t, load_catalog, norm_for

def test_catalog_entries_complete():
    cat = load_catalog()
    for type_id in ("workstation_unlocked", "cash_unattended", "safe_unsecured", "personal_items",
                    "eating_drinking", "phone_use", "outsider_cashier_zone",
                    "banknote_check_skipped", "id_check_skipped", "bag_acceptance_violation"):
        e = cat[type_id]
        assert e["title"] and e["observed"] and e["why"] and e["verify_question"]
        assert "{t}" in e["observed"]

def test_unverified_norm_is_hidden():
    assert norm_for({"norm": {"document": "d", "point": "p", "quote": "q", "url": "u", "verified": False}}) is None
    n = norm_for({"norm": {"document": "d", "point": "p", "quote": "q", "url": "u", "verified": True}})
    assert n == {"document": "d", "point": "p", "quote": "q", "url": "u"}
    assert norm_for({"norm": None}) is None

def test_fmt_t():
    assert fmt_t(8.6) == "8,6"
    assert fmt_t(68.04) == "68,0"


def test_norm_without_optional_point_or_quote():
    assert norm_for({"norm": {"verified": True, "document": "d", "url": "u"}}) == {
        "document": "d", "url": "u", "point": None, "quote": None}
