"""Berth finding: size fit, best fit, live holds other yachts can see, race safety, confirm, admin board."""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.conftest import ADMIN, DB

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL not set")
DXB = "MARINA-DXB-001"
DATES = {"arrive": "2031-03-01", "depart": "2031-03-05"}


def owner_with_yacht(client, name, email, yacht, loa, beam):
    r = client.post("/auth/signup", json={"name": name, "email": email, "password": "Mooring2031"})
    assert r.status_code == 201, r.text
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    client.patch(f"/admin/users/{r.json()['user']['id']}", headers=ADMIN, json={"status": "active"})
    h = {"Authorization": f"Bearer {client.get('/auth/me', headers=h).json()['token']}"}
    y = client.post("/yachts", headers=h, json={"name": yacht, "flag": "UAE", "loa_m": loa, "beam_m": beam,
                                                 "home_marina_id": DXB, "documents": []})
    assert y.status_code == 201, y.text
    return h, y.json()["id"]


@pytest.fixture(scope="module")
def fleet(client):
    return {
        "a": owner_with_yacht(client, "Hana Ali", "hana.berth@example.com", "Dhow Spirit", 28, 6.9),
        "b": owner_with_yacht(client, "Ben Cole", "ben.berth@example.com", "Gulf Titan", 45, 9.4),
        "c": owner_with_yacht(client, "Chen Wu", "chen.berth@example.com", "Little Pearl", 18, 5.0),
    }


def avail(client, who, **kw):
    h, y = who
    r = client.get("/berths/availability", headers=h, params={"marina_id": DXB, "yacht_id": y, **DATES, **kw})
    assert r.status_code == 200, r.text
    return {b["code"]: b for b in r.json()["berths"]}


def test_fit_and_best_fit(client, fleet):
    a = avail(client, fleet["a"])
    assert a["C214"]["state"] == "too_small" and "28 m long" in a["C214"]["fit"]["reasons"][0]
    assert a["C210"]["state"] == "too_small"
    best = [c for c, b in a.items() if b.get("best_fit")]
    assert best == ["B130"]                        # 30 m berth for a 28 m yacht: least wasted space
    assert a["B130"]["fit"]["spare_loa_m"] == 2 and not a["B130"]["fit"]["snug"]
    b = avail(client, fleet["b"])
    assert [c for c, x in b.items() if x.get("best_fit")] == ["A044"]
    assert b["B132"]["state"] == "too_small"       # 40 m berth, 45 m yacht


def test_hold_is_visible_to_other_yachts_and_blocks_them(client, fleet):
    (ha, ya), (hc, yc) = fleet["a"], fleet["c"]
    bid = avail(client, fleet["a"])["B130"]["id"]
    r = client.post(f"/berths/{bid}/hold", headers=ha, json={"yacht_id": ya, **DATES})
    assert r.status_code == 201, r.text
    hold_a = r.json()["hold_id"]
    mine = avail(client, fleet["a"])["B130"]
    assert mine["state"] == "held_by_you" and mine["hold_id"] == hold_a
    theirs = avail(client, fleet["c"])["B130"]
    assert theirs["state"] == "held" and theirs["held_by"] == "another yacht (28 m)" and theirs["held_until"]
    assert theirs["hold_id"] is None               # never reveals whose hold it is
    clash = client.post(f"/berths/{bid}/hold", headers=hc, json={"yacht_id": yc, **DATES})
    assert clash.status_code == 409 and "Another yacht is holding berth B130" in clash.json()["detail"]
    # non-overlapping dates are fine
    later = client.post(f"/berths/{bid}/hold", headers=hc, json={"yacht_id": yc, "arrive": "2031-03-05", "depart": "2031-03-07"})
    assert later.status_code == 201
    client.delete(f"/berths/holds/{later.json()['hold_id']}", headers=hc)
    # a direct booking cannot jump the queue either
    jump = client.post("/bookings/berth", headers=hc, json={"ref": "BK-90001", "yacht_id": yc, "berth_id": bid, **DATES})
    assert jump.status_code == 409
    # someone else's yacht: no
    assert client.post(f"/berths/{bid}/hold", headers=hc, json={"yacht_id": ya, **DATES}).status_code == 403
    # too big for the berth: refused whatever is asked
    hb, yb = fleet["b"]
    small = avail(client, fleet["b"])["C214"]["id"]
    tb = client.post(f"/berths/{small}/hold", headers=hb, json={"yacht_id": yb, **DATES})
    assert tb.status_code == 422 and "does not fit" in tb.json()["detail"]


def test_database_refuses_two_active_holds(client, fleet):
    from app.db import engine
    (_, ya), (_, yc) = fleet["a"], fleet["c"]
    with engine.begin() as c:
        bid = c.execute(text("SELECT id FROM berths WHERE code='A050'")).scalar()
        uid = c.execute(text("SELECT id FROM users WHERE email='hana.berth@example.com'")).scalar()
        c.execute(text("INSERT INTO berth_holds (berth_id,yacht_id,user_id,arrive,depart,expires_at) "
                       "VALUES (:b,:y,:u,'2031-06-01','2031-06-04', now() + interval '5 min')"), {"b": bid, "y": ya, "u": uid})
    with pytest.raises(IntegrityError):
        with engine.begin() as c:
            c.execute(text("INSERT INTO berth_holds (berth_id,yacht_id,user_id,arrive,depart,expires_at) "
                           "VALUES (:b,:y,:u,'2031-06-03','2031-06-06', now() + interval '5 min')"), {"b": bid, "y": yc, "u": uid})


def test_switching_berth_releases_old_hold_then_confirm(client, fleet):
    (ha, ya), (hc, yc) = fleet["a"], fleet["c"]
    codes = avail(client, fleet["a"])
    r = client.post(f"/berths/{codes['B132']['id']}/hold", headers=ha, json={"yacht_id": ya, **DATES})
    assert r.status_code == 201
    assert avail(client, fleet["c"])["B130"]["state"] == "available"   # A's old hold was released
    ok = client.post(f"/berths/holds/{r.json()['hold_id']}/confirm", headers=ha, json={"ref": "BK-HOLD01"})
    assert ok.status_code == 201 and ok.json()["status"] == "escrowed" and ok.json()["amount_usd"] == 1100 * 4
    assert avail(client, fleet["a"])["B132"]["state"] == "booked_by_you"
    assert avail(client, fleet["c"])["B132"]["state"] == "booked"
    again = client.post(f"/berths/holds/{r.json()['hold_id']}/confirm", headers=ha, json={"ref": "BK-HOLD02"})
    assert again.status_code == 409
    # an expired hold cannot be confirmed
    h2 = client.post(f"/berths/{codes['B130']['id']}/hold", headers=hc, json={"yacht_id": yc, **DATES}).json()["hold_id"]
    from app.db import engine
    with engine.begin() as c:
        c.execute(text("UPDATE berth_holds SET expires_at = now() - interval '1 min' WHERE id=:i"), {"i": h2})
    late = client.post(f"/berths/holds/{h2}/confirm", headers=hc, json={"ref": "BK-LATE01"})
    assert late.status_code == 409 and "ran out" in late.json()["detail"]
    assert avail(client, fleet["a"])["B130"]["state"] == "available"


def test_admin_board(client, fleet, admin_bearer):
    assert client.get("/admin/berths/board", params={"marina_id": DXB}).status_code == 401
    board = client.get("/admin/berths/board", headers=admin_bearer, params={"marina_id": DXB, "day": "2031-03-02"}).json()
    b = {x["code"]: x for x in board["berths"]}
    assert b["B132"]["state"] == "booked" and b["B132"]["booking"]["yacht"] == "Dhow Spirit" and b["B132"]["use_pct"] == 70
    assert board["counts"]["booked"] >= 1 and len(board["berths"]) == 8
