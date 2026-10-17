from __future__ import annotations

from ml.vlm import map_parallel

_YNU = {"type": "string", "enum": ["yes", "no", "unknown"]}

STATE_SCHEMA = {
    "type": "object",
    "properties": {
        "cashier_present": {"type": "boolean"},
        "cashier_holding_phone": {"type": "boolean"},
        "cashier_eating_or_drinking": {"type": "boolean"},
        "laptop_screen": {"type": "string",
                          "enum": ["app_visible", "lock_screen", "dark_or_off", "closed", "not_visible"]},
        "safe_door_open": _YNU,
        "key_in_safe_lock": _YNU,
        "cash_on_desk": {"type": "boolean"},
        "collection_bag_on_desk": {"type": "boolean"},
        "personal_items_on_desk": {"type": "boolean"},
        "other_person_on_cashier_side": {"type": "boolean"},
        "people_count": {"type": "integer", "minimum": 0},
    },
}
STATE_SCHEMA["required"] = list(STATE_SCHEMA["properties"])

STATE_PROMPT = """Overhead CCTV frame of a bank cashier room. The CASHIER is the bank employee who works at the desk with the laptop and the cash counting machine. Clients and cash couriers sit or stand on the opposite (client) side of the desk.
Answer strictly about what is visible in THIS frame:
- cashier_present: the cashier is in the room at or near the cashier's workplace.
- cashier_holding_phone: the cashier (not a client) holds a smartphone.
- cashier_eating_or_drinking: the cashier is eating or holding a cup/drink to the mouth.
- laptop_screen: app_visible = an application, document or spreadsheet is open; lock_screen = wallpaper/lock screen; dark_or_off = black screen with lid open; closed = lid closed.
- safe_door_open / key_in_safe_lock: the small metal safe near the desk.
- cash_on_desk: banknotes or cash bundles lying on the desk.
- collection_bag_on_desk: a (green) cash collection bag lying on the desk.
- personal_items_on_desk: handbag, backpack, coat or jacket on the desk.
- other_person_on_cashier_side: someone other than the cashier is on the cashier's side of the desk.
- people_count: number of people visible.
Return JSON only."""


def sense(client, frames, workers: int = 8) -> list[tuple[float, dict]]:
    required = set(STATE_SCHEMA["required"])

    def one(item):
        t, img = item
        ans = client.ask_json([img], STATE_PROMPT, STATE_SCHEMA, max_tokens=300)
        return (t, ans) if isinstance(ans, dict) and required <= set(ans) else None

    return [r for r in map_parallel(one, frames, workers) if r is not None]
