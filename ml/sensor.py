from __future__ import annotations

from ml.vlm import map_parallel

_YNU = {"type": "string", "enum": ["yes", "no", "unknown"]}

STATE_SCHEMA = {
    "type": "object",
    "properties": {
        "cashier_present": {"type": "boolean"},
        "cashier_at_workplace": {"type": "boolean"},
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

STATE_PROMPT = """Overhead CCTV frame of a bank cashier room.
WHO IS THE CASHIER: the cashier is the person sitting in front of the OPEN LAPTOP SCREEN, on the same side of the desk as the screen (she looks at the screen). Clients and cash couriers are on the OPPOSITE side of the desk: they face the cashier and see only the back of the laptop. A person facing the camera across the desk from the laptop screen is a CLIENT, not the cashier. Never treat a client as the cashier.
Answer strictly about what is visible in THIS frame:
- cashier_present: the cashier is anywhere in the room.
- cashier_at_workplace: the cashier is seated or standing right at her desk, within arm's reach of the laptop; false if she has walked away (to the door, the safe, elsewhere) or left the room.
- cashier_holding_phone: the CASHIER clearly holds a smartphone in her hand (a client's phone or wallet does not count).
- cashier_eating_or_drinking: the CASHIER is visibly bringing food or a cup/bottle to her mouth right now (a cup standing on the desk does not count).
- laptop_screen: app_visible = an application, document or spreadsheet is open; lock_screen = wallpaper/lock screen; dark_or_off = black screen with lid open; closed = lid closed.
- safe_door_open / key_in_safe_lock: the small metal safe near the desk.
- cash_on_desk: banknotes or cash bundles lying on the desk.
- collection_bag_on_desk: a (green) cash collection bag lying on the desk.
- personal_items_on_desk: handbag, backpack, coat or jacket on the desk.
- other_person_on_cashier_side: a SECOND person stands behind or right beside the cashier on HER side of the desk. Clients sitting or standing on the opposite side of the desk do NOT count. If unsure, answer false.
- people_count: number of people visible.
Return JSON only."""


def sense(client, frames, workers: int = 8) -> list[tuple[float, dict]]:
    required = set(STATE_SCHEMA["required"])

    def one(item):
        t, img = item
        ans = client.ask_json([img], STATE_PROMPT, STATE_SCHEMA, max_tokens=300)
        return (t, ans) if isinstance(ans, dict) and required <= set(ans) else None

    return [r for r in map_parallel(one, frames, workers) if r is not None]
